// Jackpot: everyone deposits skins into one pot; a wheel picks a winner, with each cent
// of deposited value worth one ticket, and the winner takes every item.
//
//   waiting   deposits open, fewer than two players in yet (no timer)
//   open      two or more players: JP_TIMER_MS to go, deposits still open
//   spinning  the winning ticket is drawn and everyone's wheel spins to it
//   result    the winner is shown for JP_RESULT_MS, then a new round starts
//
// Deposited items leave the depositor's inventory at once and wait in jp_items (with
// the price they were valued at), so a restart hands them back.

import { randomInt } from "node:crypto";
import { JP_MAX_ITEMS, JP_MIN_DEPOSIT, JP_RESULT_MS, JP_SPIN_MS, JP_TIMER_MS } from "../../shared/game.js";
import { GameError, cents } from "../game.mjs";

const HISTORY = 10;

export class Jackpot {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ broadcast: (event: string, data: any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, io) {
    this.game = game;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS jp_items (
      uid TEXT PRIMARY KEY, round INTEGER NOT NULL, user_id INTEGER NOT NULL,
      item TEXT NOT NULL, value_cents INTEGER NOT NULL, at INTEGER NOT NULL)`);
    db.exec("CREATE TABLE IF NOT EXISTS jp_rounds (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO jp_items (uid, round, user_id, item, value_cents, at) VALUES (?, ?, ?, ?, ?, ?)"),
      all: db.prepare("SELECT * FROM jp_items"),
      clear: db.prepare("DELETE FROM jp_items WHERE round = ?"),
      drop: db.prepare("DELETE FROM jp_items WHERE uid = ?"),
      addRound: db.prepare("INSERT INTO jp_rounds (id, data) VALUES (?, ?)"),
      history: db.prepare("SELECT data FROM jp_rounds ORDER BY id DESC LIMIT ?"),
      lastRound: db.prepare("SELECT MAX(id) AS id FROM jp_rounds"),
    };
    this.history = this.q.history.all(HISTORY).map((r) => JSON.parse(r.data));
    this.round = (this.q.lastRound.get().id ?? 0) + 1;
    /** Deposits this round, in order: { userId, user, name, items: [owned], valueCents } */
    this.deposits = [];
    this.timers = [];
  }

  /** Give back items a restart left in the pot, then open a round. */
  start() {
    const byUser = new Map();
    for (const r of this.q.all.all()) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(JSON.parse(r.item));
      this.q.drop.run(r.uid);
    }
    for (const [userId, items] of byUser) this.#give(userId, items, "refund");
    this.#reset();
  }

  stop() {
    this.timers.forEach(clearTimeout);
  }

  #reset() {
    this.phase = "waiting";
    this.deposits = [];
    this.endsAt = null;
    this.spinAt = null;
    this.ticket = null;
    this.winner = null;
    this.#publish();
  }

  /** Put items (already owned objects) into an account. */
  #give(userId, items, why) {
    const { account } = this.game.act(userId, (a, changes) => {
      const fresh = items.map((it) => ({ ...it, source: why === "refund" ? it.source : "jackpot", obtainedAt: Date.now() }));
      a.inventory.unshift(...fresh);
      (changes.added ??= []).push(...fresh);
      return {};
    });
    this.io.toUser(userId, "account", account);
  }

  #players() {
    const map = new Map();
    for (const d of this.deposits) {
      const p = map.get(d.userId) ?? { userId: d.userId, user: d.user, name: d.name, valueCents: 0, items: [] };
      p.valueCents += d.valueCents;
      p.items.push(...d.items);
      map.set(d.userId, p);
    }
    return [...map.values()];
  }

  deposit(userId, body) {
    if (this.phase !== "waiting" && this.phase !== "open") throw new GameError("closed", "The wheel is spinning; wait for the next round");
    const uids = [...new Set((Array.isArray(body.uids) ? body.uids : []).map(String))];
    if (!uids.length || uids.length > JP_MAX_ITEMS) throw new GameError("bad_input", `Deposit 1 to ${JP_MAX_ITEMS} items at a time`);
    let deposit;
    const out = this.game.act(userId, (a, changes) => {
      const items = uids.map((uid) => a.inventory.find((it) => it.uid === uid));
      if (items.some((it) => !it)) throw new GameError("bad_input", "You don't own one of those items");
      this.game.checkUnlocked(a, uids);
      const values = items.map((it) => cents(this.game.priceOf(it)));
      const total = values.reduce((s, v) => s + v, 0);
      if (total < cents(JP_MIN_DEPOSIT)) throw new GameError("bad_input", `Deposit at least $${JP_MIN_DEPOSIT.toFixed(2)} worth`);
      a.inventory = a.inventory.filter((it) => !uids.includes(it.uid));
      changes.removed = uids;
      const now = Date.now();
      items.forEach((it, i) => this.q.add.run(it.uid, this.round, userId, JSON.stringify(it), values[i], now));
      deposit = { userId, user: a.username, name: a.displayName, items: items.map((it, i) => ({ ...it, valueCents: values[i] })), valueCents: total };
      return {};
    });
    this.deposits.push(deposit);
    // Second player in: start the clock.
    if (this.phase === "waiting" && this.#players().length >= 2) {
      this.phase = "open";
      this.endsAt = Date.now() + JP_TIMER_MS;
      this.timers = [setTimeout(() => this.#spin(), JP_TIMER_MS)];
    }
    this.#publish();
    return out;
  }

  /** Who's in the current pot (for the admin panel). */
  players() {
    return this.#players().map((p) => ({ userId: p.userId, user: p.user, name: p.name, value: p.valueCents / 100 }));
  }

  /** Maintenance: a pot that hasn't spun yet goes back to everyone in it. Returns how many players. */
  refundPending() {
    if ((this.phase !== "waiting" && this.phase !== "open") || !this.deposits.length) return 0;
    this.timers.forEach(clearTimeout);
    const players = this.#players();
    this.q.clear.run(this.round);
    for (const p of players) this.#give(p.userId, p.items.map(({ valueCents, ...it }) => it), "refund");
    this.#reset();
    return players.length;
  }

  /** Before anyone else has joined (no timer yet), take your items back out. */
  withdraw(userId) {
    if (this.phase !== "waiting") throw new GameError("closed", "The round has started; items stay in until it ends");
    const mine = this.deposits.filter((d) => d.userId === userId);
    if (!mine.length) throw new GameError("no_bet", "You have nothing in the pot");
    const items = mine.flatMap((d) => d.items.map(({ valueCents, ...it }) => it));
    items.forEach((it) => this.q.drop.run(it.uid));
    this.deposits = this.deposits.filter((d) => d.userId !== userId);
    this.#give(userId, items, "refund");
    this.#publish();
    return { account: this.game.view(userId) };
  }

  #spin() {
    const total = this.deposits.reduce((s, d) => s + d.valueCents, 0);
    this.ticket = randomInt(total);
    // The admin can hand this pot to someone in it: a random ticket of theirs wins.
    if (this.forced != null && this.deposits.some((d) => d.userId === this.forced)) {
      let start = 0;
      const ranges = [];
      for (const d of this.deposits) {
        if (d.userId === this.forced) ranges.push([start, d.valueCents]);
        start += d.valueCents;
      }
      const [s0, len] = ranges[randomInt(ranges.length)];
      this.ticket = s0 + randomInt(len);
    }
    this.forced = null;
    // The deposit holding that ticket wins; tickets run in deposit order.
    let acc = 0;
    const holder = this.deposits.find((d) => (acc += d.valueCents) > this.ticket);
    this.winner = holder.userId;
    this.phase = "spinning";
    this.spinAt = Date.now();
    this.timers = [setTimeout(() => this.#settle(total), JP_SPIN_MS)];
    this.#publish();
  }

  #settle(total) {
    const players = this.#players();
    const w = players.find((p) => p.userId === this.winner);
    const pot = this.deposits.flatMap((d) => d.items.map(({ valueCents, ...it }) => it));
    this.#give(w.userId, pot, "won");
    this.q.clear.run(this.round);
    for (const p of players) {
      const won = p.userId === w.userId;
      const { account } = this.game.act(p.userId, (a) => {
        this.game.noteGame(a, "jackpot", { stakeCents: p.valueCents, payoutCents: won ? total : 0, add: { won: won ? 1 : 0 } });
        return {};
      });
      if (!won) this.io.toUser(p.userId, "account", account);
    }
    // The winner's best item goes to the live feed (if it's worth it).
    const best = pot.reduce((x, y) => (this.game.priceOf(y) > this.game.priceOf(x) ? y : x));
    this.game.feed?.push({
      user: w.user,
      name: w.name,
      game: "jackpot",
      value: this.game.priceOf(best),
      stake: w.valueCents / 100,
      tier: this.game.item(best.itemId).tier,
      drop: { itemId: best.itemId, phase: best.phase, wear: best.wear, stattrak: best.stattrak },
      source: `${money(total)} pot`,
    });
    const entry = { round: this.round, user: w.user, name: w.name, pot: total / 100, chance: Math.round((w.valueCents / total) * 10000) / 100, items: pot.length };
    this.q.addRound.run(this.round, JSON.stringify(entry));
    this.history = [entry, ...this.history].slice(0, HISTORY);
    this.phase = "result";
    this.#publish();
    this.timers = [
      setTimeout(() => {
        this.round++;
        this.#reset();
      }, JP_RESULT_MS),
    ];
  }

  state() {
    const total = this.deposits.reduce((s, d) => s + d.valueCents, 0);
    const players = this.#players();
    return {
      round: this.round,
      phase: this.phase,
      endsAt: this.endsAt,
      spinAt: this.spinAt,
      total: total / 100,
      // In ticket order, so the wheel's segments match the draw.
      deposits: this.deposits.map((d) => ({ user: d.user, name: d.name, value: d.valueCents / 100 })),
      players: players.map((p) => ({
        user: p.user,
        name: p.name,
        value: p.valueCents / 100,
        chance: total ? p.valueCents / total : 0,
        items: p.items.map(({ uid, itemId, phase, wear, stattrak, valueCents }) => ({ uid, itemId, phase, wear, stattrak, value: valueCents / 100 })),
      })),
      // Only once the wheel spins:
      ticket: this.phase === "spinning" || this.phase === "result" ? this.ticket / 100 : null,
      winner: this.phase === "spinning" || this.phase === "result" ? players.find((p) => p.userId === this.winner)?.user : null,
      history: this.history,
    };
  }

  #publish() {
    this.io.broadcast("jackpot", this.state());
  }
}

const money = (c) => `$${(c / 100).toFixed(2)}`;

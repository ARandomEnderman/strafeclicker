// Case battles: 2–4 players open the same list of cases, one case per round. Whoever
// unboxed the most value in total takes every item; a tie is settled at random.
//
// Each player pays the full cost when they take a seat; the creator can fill empty
// seats with bots. Once the last seat fills, the server rolls every drop and hands the
// items to the winner straight away, then the browsers play it back round by round in
// sync (startAt + round × BATTLE_ROUND_MS). Players' balances and the feed are updated
// when the playback ends, so nothing is given away early.

import { randomInt } from "node:crypto";
import { BATTLE_MAX_ROUNDS, BATTLE_REEL_LEN, BATTLE_ROUND_MS, BATTLE_SIZES, battleReel } from "../../shared/game.js";
import { PERKS, perkValue } from "../../shared/game.js";
import { GameError, randomFloats, spendable } from "../game.mjs";

const BOT_NAMES = ["Bot Alpha", "Bot Bravo", "Bot Charlie"];
/** public: listed for everyone. friends: listed for the creator's friends. private: join by code only. */
const VISIBILITIES = ["public", "friends", "private"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_OPEN_PER_USER = 3;
const KEEP_DONE = 12;

export class Battles {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("../friends.mjs").Friends} friends
   * @param {{ broadcastPer: (event: string, data: (userId: number | null) => any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, friends, io) {
    this.game = game;
    this.friends = friends;
    this.io = io;
    db.exec("CREATE TABLE IF NOT EXISTS battles (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO battles (status, data) VALUES (?, ?)"),
      save: db.prepare("UPDATE battles SET status = ?, data = ? WHERE id = ?"),
      live: db.prepare("SELECT id, data FROM battles WHERE status IN ('waiting', 'running')"),
      done: db.prepare("SELECT id, data FROM battles WHERE status = 'done' ORDER BY id DESC LIMIT ?"),
    };
    /** id -> battle, for waiting, running and recently finished ones. */
    this.battles = new Map();
  }

  /** Refund battles a restart left waiting; running ones were already settled. */
  start() {
    for (const r of this.q.live.all()) {
      const b = { ...JSON.parse(r.data), id: r.id };
      if (b.status === "waiting") {
        for (const s of b.slots) if (s.userId) this.#refund(s.userId, b.costCents);
        b.status = "cancelled";
      } else b.status = "done";
      this.#save(b);
    }
    for (const r of this.q.done.all(KEEP_DONE).reverse()) this.battles.set(r.id, { ...JSON.parse(r.data), id: r.id });
  }

  #save(b) {
    const { id, ...data } = b;
    this.q.save.run(b.status, JSON.stringify(data), id);
  }

  #refund(userId, costCents) {
    const { account } = this.game.act(userId, (a) => {
      a.balanceCents += costCents;
      return {};
    });
    this.io.toUser(userId, "account", account);
  }

  #get(id) {
    const b = this.battles.get(Number(id));
    if (!b) throw new GameError("not_found", "No such battle", 404);
    return b;
  }

  #seated = (b, userId) => userId != null && b.slots.some((s) => s?.userId === userId);

  /** Whether a user may see (and so join) a battle. Private ones need the code. */
  #canSee(b, userId, code) {
    if (this.#seated(b, userId)) return true;
    const v = b.visibility ?? "public";
    if (v === "public") return true;
    if (v === "friends") return this.friends.areFriends(userId, b.creatorId);
    return code != null && String(code).toUpperCase() === b.code;
  }

  #newCode() {
    const live = new Set([...this.battles.values()].map((b) => b.code));
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      if (!live.has(code)) return code;
    }
  }

  create(userId, body) {
    const ids = Array.isArray(body.cases) ? body.cases.map(String) : [];
    const size = Number(body.size);
    const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : "public";
    if (!BATTLE_SIZES.includes(size)) throw new GameError("bad_input", "Pick 2, 3 or 4 players");
    if (!ids.length || ids.length > BATTLE_MAX_ROUNDS) throw new GameError("bad_input", `Pick 1 to ${BATTLE_MAX_ROUNDS} cases`);
    const open = [...this.battles.values()].filter((b) => b.status === "waiting" && b.creatorId === userId).length;
    if (open >= MAX_OPEN_PER_USER) throw new GameError("busy", `You can have ${MAX_OPEN_PER_USER} open battles at a time`);
    const costCents = ids.reduce((sum, id) => sum + this.game.caseCost(id).costCents, 0);

    let battle;
    const out = this.game.act(userId, (a) => {
      const max = perkValue(a.perks, "battleRounds");
      if (ids.length > max) {
        const more = PERKS.battleRounds.levels[a.perks.battleRounds + 1];
        throw new GameError("bad_input", `You can put up to ${max} cases in a battle${more ? `; Battle size in the upgrade tree raises that` : ""}`);
      }
      if (spendable(a) < costCents) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= costCents;
      battle = {
        status: "waiting",
        createdAt: Date.now(),
        creatorId: userId,
        creator: a.username,
        creatorName: a.displayName,
        cases: ids,
        size,
        costCents,
        caseCosts: ids.map((id) => this.game.caseCost(id).costCents),
        visibility,
        code: visibility === "private" ? this.#newCode() : null,
        slots: Array.from({ length: size }, (_, i) => (i === 0 ? { userId, user: a.username, name: a.displayName, bot: false } : null)),
      };
      const { lastInsertRowid } = this.q.add.run("waiting", JSON.stringify(battle));
      battle.id = Number(lastInsertRowid);
      return { id: battle.id };
    });
    this.battles.set(battle.id, battle);
    this.#publish();
    return out;
  }

  /** Join by id (public / friends battles) or by code (any battle, including private). */
  join(userId, body) {
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    const b = code ? [...this.battles.values()].find((x) => x.code === code && x.status === "waiting") : this.#get(body.id);
    if (!b) throw new GameError("not_found", "No open battle with that code", 404);
    if (!this.#canSee(b, userId, code)) throw new GameError("forbidden", b.visibility === "friends" ? `Only ${b.creator}'s friends can join` : "You need the code to join", 403);
    if (b.status !== "waiting") throw new GameError("closed", "This battle has already started");
    if (b.slots.some((s) => s?.userId === userId)) throw new GameError("busy", "You're already in this battle");
    const seat = b.slots.indexOf(null);
    if (seat < 0) throw new GameError("closed", "This battle is full");
    const out = this.game.act(userId, (a) => {
      if (spendable(a) < b.costCents) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= b.costCents;
      b.slots[seat] = { userId, user: a.username, name: a.displayName, bot: false };
      this.#save(b);
      return { id: b.id };
    });
    if (!b.slots.includes(null)) this.#run(b);
    else this.#publish();
    return out;
  }

  /** Creator only: fill the empty seats with bots and start. */
  bots(userId, body) {
    const b = this.#get(body.id);
    if (b.creatorId !== userId) throw new GameError("forbidden", "Only the creator can add bots", 403);
    if (b.status !== "waiting") throw new GameError("closed", "This battle has already started");
    let n = 0;
    b.slots = b.slots.map((s) => s ?? { userId: null, user: BOT_NAMES[n++], bot: true });
    this.#run(b);
    return { id: b.id, account: this.game.view(userId) };
  }

  /** Creator only, before it starts: everyone gets their money back. */
  cancel(userId, body) {
    const b = this.#get(body.id);
    if (b.creatorId !== userId) throw new GameError("forbidden", "Only the creator can cancel", 403);
    if (b.status !== "waiting") throw new GameError("closed", "This battle has already started");
    b.status = "cancelled";
    this.#save(b);
    this.battles.delete(b.id);
    for (const s of b.slots) if (s?.userId && s.userId !== userId) this.#refund(s.userId, b.costCents);
    const out = this.game.act(userId, (a) => {
      a.balanceCents += b.costCents;
      return {};
    });
    this.#publish();
    return out;
  }

  /** Every seat is taken: roll everything, settle, and start the playback clock. */
  #run(b) {
    const all = this.game.market.contents().cases;
    const cases = b.cases.map((id) => all.find((c) => c.id === id));
    b.rounds = cases.map((c) =>
      b.slots.map(() => {
        const drop = this.game.rollDrop(c);
        // The whole strip and its stopping point, so every viewer's reel is identical.
        const rand = randomFloats(2 * BATTLE_REEL_LEN + 1);
        let k = 0;
        const reel = battleReel(c, drop.itemId, () => rand[k++]);
        return { drop, value: this.game.priceOf(drop), reel };
      }),
    );
    b.totals = b.slots.map((_, i) => Math.round(b.rounds.reduce((sum, r) => sum + r[i].value, 0) * 100) / 100);
    const best = Math.max(...b.totals);
    const tied = b.totals.map((t, i) => (t === best ? i : -1)).filter((i) => i >= 0);
    b.winner = tied[tied.length > 1 ? randomInt(tied.length) : 0];
    b.status = "running";
    b.startAt = Date.now() + 1500; // a moment for everyone's page to switch over
    const endAt = b.startAt + b.rounds.length * BATTLE_ROUND_MS;
    this.#save(b);

    // Settle now (the items are the winner's from here on); show it when playback ends.
    const pot = b.rounds.flatMap((r) => r.map((x) => x.drop));
    const potCents = Math.round(b.totals.reduce((s, t) => s + t, 0) * 100);
    const accounts = new Map();
    b.slots.forEach((s, i) => {
      if (!s.userId) return;
      const won = i === b.winner;
      const { account } = this.game.act(s.userId, (a, changes) => {
        if (won) this.game.grant(a, changes, pot, "battle");
        this.game.noteGame(a, "battle", { stakeCents: b.costCents, payoutCents: won ? potCents : 0, add: { won: won ? 1 : 0 } });
        return {};
      });
      accounts.set(s.userId, account);
    });
    this.#publish();

    setTimeout(() => {
      b.status = "done";
      this.#save(b);
      // Fresh account, plus any achievements the result unlocked.
      for (const [uid, account] of accounts) this.io.toUser(uid, "account", { ...this.game.view(uid), ...(account.unlocked ? { unlocked: account.unlocked } : {}) });
      const w = b.slots[b.winner];
      if (!w.bot) {
        // The best item the winner takes home, against what its round's case cost.
        let best = null;
        b.rounds.forEach((r, ri) => r.forEach((x) => (!best || x.value > best.value) && (best = { ...x, ri })));
        const stake = (b.caseCosts?.[best.ri] ?? b.costCents / b.cases.length) / 100;
        this.game.feed?.push({ user: w.user, name: w.name ?? w.user, game: "battle", value: best.value, stake, tier: this.game.item(best.drop.itemId).tier, drop: best.drop, source: `${b.size}-player battle` });
      }
      this.#trim();
      this.#publish();
    }, endAt - Date.now()).unref();
  }

  #trim() {
    const done = [...this.battles.values()].filter((x) => x.status === "done").sort((x, y) => y.id - x.id);
    for (const x of done.slice(KEEP_DONE)) this.battles.delete(x.id);
  }

  /** Battles this user may see, newest first. */
  list(userId) {
    return [...this.battles.values()]
      .filter((b) => this.#canSee(b, userId, null))
      .sort((x, y) => y.id - x.id)
      .map((b) => publicBattle(b, this.#seated(b, userId)));
  }

  publish() {
    this.io.broadcastPer("battles", (userId) => this.list(userId));
  }

  #publish() {
    this.publish();
  }
}

const publicBattle = (b, seated) => ({
  id: b.id,
  status: b.status,
  visibility: b.visibility ?? "public",
  // Only people in the battle see its code (to pass it on).
  code: seated ? b.code : null,
  creator: b.creator,
  creatorName: b.creatorName ?? b.creator,
  cases: b.cases,
  size: b.size,
  cost: b.costCents / 100,
  slots: b.slots.map((s) => (s ? { user: s.user, name: s.name ?? s.user, bot: s.bot } : null)),
  createdAt: b.createdAt,
  startAt: b.startAt ?? null,
  rounds: b.status === "waiting" ? null : b.rounds,
  totals: b.status === "waiting" ? null : b.totals,
  winner: b.status === "waiting" ? null : b.winner,
});

// Coinflip: 1v1 with skins. The creator puts up items and picks T or CT; whoever joins
// puts up items worth 90–110% as much and gets the other side. The server flips as
// soon as both are in and the winner takes every item; browsers play the flip back on
// the same clock and inventories update when the coin lands.
//
// Against a bot (the creator can call one): win and you get your items back plus their
// value in cash; lose and the bot keeps them.
//
// Staked items leave the inventory at once and are kept with the flip, so a restart
// returns them. Visibility works like case battles: public, friends, or private (code).

import { randomInt } from "node:crypto";
import { FLIP_LEAD_MS, FLIP_MS } from "../../shared/game.js";
import { GameError, cents } from "../game.mjs";

const SIDES = ["t", "ct"];
const other = (s) => (s === "t" ? "ct" : "t");
const VISIBILITIES = ["public", "friends", "private"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ITEMS = 10;
const MATCH_MIN = 0.9;
const MATCH_MAX = 1.1;
const MIN_VALUE_CENTS = 10;
const MAX_OPEN_PER_USER = 5;
const KEEP_DONE = 15;
const BOT = { userId: null, user: "Bot", name: "Bot", bot: true };

export class Coinflip {
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
    db.exec("CREATE TABLE IF NOT EXISTS flips (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO flips (status, data) VALUES (?, ?)"),
      save: db.prepare("UPDATE flips SET status = ?, data = ? WHERE id = ?"),
      live: db.prepare("SELECT id, data FROM flips WHERE status IN ('waiting', 'flipping')"),
      done: db.prepare("SELECT id, data FROM flips WHERE status = 'done' ORDER BY id DESC LIMIT ?"),
    };
    /** id -> flip (waiting, flipping and recently finished) */
    this.flips = new Map();
  }

  /** Give back what a restart left staked; flips already flipping were settled. */
  start() {
    for (const r of this.q.live.all()) {
      const f = { ...JSON.parse(r.data), id: r.id };
      if (f.status === "waiting") {
        // Flips from before skins were cash; refund either.
        if (f.creator.items) this.#give(f.creator.userId, f.creator.items);
        else if (f.stakeCents) this.#refundCash(f.creator.userId, f.stakeCents);
        f.status = "cancelled";
      } else f.status = "done";
      this.#save(f);
    }
    for (const r of this.q.done.all(KEEP_DONE).reverse()) {
      const f = { ...JSON.parse(r.data), id: r.id };
      if (f.creator.items) this.flips.set(r.id, f);
    }
  }

  #save(f) {
    const { id, ...data } = f;
    this.q.save.run(f.status, JSON.stringify(data), id);
  }

  #give(userId, items, extraCents = 0) {
    const { account } = this.game.act(userId, (a, changes) => {
      this.game.receive(a, changes, items);
      a.balanceCents += extraCents;
      return {};
    });
    this.io.toUser(userId, "account", account);
    return account;
  }

  #refundCash(userId, c) {
    const { account } = this.game.act(userId, (a) => {
      a.balanceCents += c;
      return {};
    });
    this.io.toUser(userId, "account", account);
  }

  #get(id) {
    const f = this.flips.get(Number(id));
    if (!f) throw new GameError("not_found", "No such coinflip", 404);
    return f;
  }

  #inIt = (f, userId) => userId != null && (f.creator.userId === userId || f.joiner?.userId === userId);

  #canSee(f, userId, code) {
    if (this.#inIt(f, userId)) return true;
    if (f.visibility === "public") return true;
    if (f.visibility === "friends") return this.friends.areFriends(userId, f.creator.userId);
    return code != null && String(code).toUpperCase() === f.code;
  }

  #newCode() {
    const live = new Set([...this.flips.values()].map((f) => f.code));
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      if (!live.has(code)) return code;
    }
  }

  /** Take items for a stake, valued at current prices. */
  #stake(a, changes, uids) {
    const items = this.game.takeItems(a, changes, uids, MAX_ITEMS);
    const valued = items.map((it) => ({ ...it, valueCents: cents(this.game.priceOf(it)) }));
    return { items: valued, valueCents: valued.reduce((s, it) => s + it.valueCents, 0) };
  }

  create(userId, body) {
    const side = SIDES.includes(body.side) ? body.side : null;
    if (!side) throw new GameError("bad_input", "Pick T or CT");
    const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : "public";
    const open = [...this.flips.values()].filter((f) => f.status === "waiting" && f.creator.userId === userId).length;
    if (open >= MAX_OPEN_PER_USER) throw new GameError("busy", `You can have ${MAX_OPEN_PER_USER} open coinflips at a time`);
    let flip;
    const out = this.game.act(userId, (a, changes) => {
      const stake = this.#stake(a, changes, body.uids);
      if (stake.valueCents < MIN_VALUE_CENTS) throw new GameError("bad_input", "Put up at least $0.10 worth");
      flip = {
        status: "waiting",
        createdAt: Date.now(),
        creator: { userId, user: a.username, name: a.displayName, bot: false, ...stake },
        side,
        visibility,
        code: visibility === "private" ? this.#newCode() : null,
        joiner: null,
      };
      const { lastInsertRowid } = this.q.add.run("waiting", JSON.stringify(flip));
      flip.id = Number(lastInsertRowid);
      return { id: flip.id };
    });
    this.flips.set(flip.id, flip);
    this.publish();
    return out;
  }

  /** By id (public / friends flips) or by code (any, including private), with matching items. */
  join(userId, body) {
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    const f = code ? [...this.flips.values()].find((x) => x.code === code && x.status === "waiting") : this.#get(body.id);
    if (!f) throw new GameError("not_found", "No open coinflip with that code", 404);
    if (!this.#canSee(f, userId, code)) throw new GameError("forbidden", f.visibility === "friends" ? `Only ${f.creator.name}'s friends can join` : "You need the code to join", 403);
    if (f.status !== "waiting") throw new GameError("closed", "Someone already joined");
    if (f.creator.userId === userId) throw new GameError("busy", "That's your own coinflip. Call a bot to play it.");
    // Joining by code without items just finds the flip, so the page can pick items.
    if (code && !body.uids) return { id: f.id, account: this.game.view(userId) };
    const lo = Math.ceil(f.creator.valueCents * MATCH_MIN);
    const hi = Math.floor(f.creator.valueCents * MATCH_MAX);
    const out = this.game.act(userId, (a, changes) => {
      const stake = this.#stake(a, changes, body.uids);
      if (stake.valueCents < lo || stake.valueCents > hi) throw new GameError("bad_input", `Put up between $${(lo / 100).toFixed(2)} and $${(hi / 100).toFixed(2)} (yours: $${(stake.valueCents / 100).toFixed(2)})`);
      f.joiner = { userId, user: a.username, name: a.displayName, bot: false, ...stake };
      return { id: f.id };
    });
    this.#flip(f);
    return out;
  }

  /** Creator only: play it against a bot. */
  bot(userId, body) {
    const f = this.#get(body.id);
    if (f.creator.userId !== userId) throw new GameError("forbidden", "Only the creator can call a bot", 403);
    if (f.status !== "waiting") throw new GameError("closed", "Someone already joined");
    f.joiner = { ...BOT, items: [], valueCents: f.creator.valueCents };
    this.#flip(f);
    return { id: f.id, account: this.game.view(userId) };
  }

  cancel(userId, body) {
    const f = this.#get(body.id);
    if (f.creator.userId !== userId) throw new GameError("forbidden", "Only the creator can cancel", 403);
    if (f.status !== "waiting") throw new GameError("closed", "Someone already joined");
    f.status = "cancelled";
    this.#save(f);
    this.flips.delete(f.id);
    const account = this.#give(userId, strip(f.creator.items));
    this.publish();
    return { account };
  }

  /** Both seats taken: flip now, hand the items over when the coin lands. */
  #flip(f) {
    f.result = SIDES[randomInt(2)];
    // Against a bot the rig tilts the coin toward the bot's side.
    if (f.joiner.bot && Math.random() < this.game.rig("coinflipBot")) f.result = other(f.side);
    f.status = "flipping";
    f.startAt = Date.now() + FLIP_LEAD_MS;
    const winner = f.result === f.side ? f.creator : f.joiner;
    f.winner = winner === f.creator ? "creator" : "joiner";
    this.#save(f);
    this.publish();
    setTimeout(() => {
      const pot = [...strip(f.creator.items), ...strip(f.joiner.items)];
      const total = f.creator.valueCents + f.joiner.valueCents;
      for (const p of [f.creator, f.joiner]) {
        if (!p.userId) continue;
        const won = p === winner;
        // A win against a bot pays the bot's half in cash.
        if (won) this.#give(p.userId, pot, f.joiner.bot ? f.joiner.valueCents : 0);
        const { account } = this.game.act(p.userId, (a) => {
          this.game.noteGame(a, "coinflip", { stakeCents: p.valueCents, payoutCents: won ? total : 0, add: { won: won ? 1 : 0 } });
          return {};
        });
        if (!won) this.io.toUser(p.userId, "account", account);
      }
      if (!winner.bot && pot.length) {
        const best = pot.reduce((x, y) => (this.game.priceOf(y) > this.game.priceOf(x) ? y : x));
        this.game.feed?.push({ user: winner.user, name: winner.name, game: "coinflip", value: this.game.priceOf(best), stake: winner.valueCents / 100, tier: this.game.item(best.itemId).tier, drop: { itemId: best.itemId, phase: best.phase, wear: best.wear, stattrak: best.stattrak }, source: "Coinflip" });
      }
      f.status = "done";
      this.#save(f);
      const done = [...this.flips.values()].filter((x) => x.status === "done").sort((x, y) => y.id - x.id);
      for (const x of done.slice(KEEP_DONE)) this.flips.delete(x.id);
      this.publish();
    }, f.startAt + FLIP_MS - Date.now()).unref();
  }

  list(userId) {
    return [...this.flips.values()]
      .filter((f) => this.#canSee(f, userId, null))
      .sort((x, y) => y.id - x.id)
      .map((f) => publicFlip(f, this.#inIt(f, userId)));
  }

  publish() {
    this.io.broadcastPer("flips", (userId) => this.list(userId));
  }
}

/** Items as owned objects again (without the value they were staked at). */
const strip = (items = []) => items.map(({ valueCents, ...it }) => it);

const who = (p) =>
  p
    ? {
        user: p.user,
        name: p.name,
        bot: p.bot,
        value: p.valueCents / 100,
        items: (p.items ?? []).map(({ uid, itemId, phase, wear, stattrak, valueCents }) => ({ uid, itemId, phase, wear, stattrak, value: valueCents / 100 })),
      }
    : null;
const publicFlip = (f, inIt) => ({
  id: f.id,
  status: f.status,
  visibility: f.visibility,
  code: inIt ? f.code : null,
  creator: who(f.creator),
  joiner: who(f.joiner),
  side: f.side,
  value: f.creator.valueCents / 100,
  range: [Math.ceil(f.creator.valueCents * MATCH_MIN) / 100, Math.floor(f.creator.valueCents * MATCH_MAX) / 100],
  createdAt: f.createdAt,
  startAt: f.startAt ?? null,
  result: f.status === "waiting" ? null : f.result,
  winner: f.status === "waiting" ? null : f.winner,
});

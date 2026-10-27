// Coinflip: 1v1 for cash. The creator stakes an amount on T or CT; whoever joins
// matches it and takes the other side (or the creator calls a bot). The server flips
// as soon as both are in and pays the winner both stakes; browsers play the flip back
// on the same clock and balances update when the coin lands.
//
// Visibility works like case battles: public, friends only, or private (join code).

import { randomInt } from "node:crypto";
import { FLIP_LEAD_MS, FLIP_MS } from "../../shared/game.js";
import { GameError, spendable } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const SIDES = ["t", "ct"];
const other = (s) => (s === "t" ? "ct" : "t");
const VISIBILITIES = ["public", "friends", "private"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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

  /** Refund flips a restart left waiting; ones mid-flip were already settled. */
  start() {
    for (const r of this.q.live.all()) {
      const f = { ...JSON.parse(r.data), id: r.id };
      if (f.status === "waiting") {
        const { account } = this.game.act(f.creator.userId, (a) => {
          a.balanceCents += f.stakeCents;
          return {};
        });
        this.io.toUser(f.creator.userId, "account", account);
        f.status = "cancelled";
      } else f.status = "done";
      this.#save(f);
    }
    for (const r of this.q.done.all(KEEP_DONE).reverse()) this.flips.set(r.id, { ...JSON.parse(r.data), id: r.id });
  }

  #save(f) {
    const { id, ...data } = f;
    this.q.save.run(f.status, JSON.stringify(data), id);
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

  create(userId, body) {
    const side = SIDES.includes(body.side) ? body.side : null;
    if (!side) throw new GameError("bad_input", "Pick T or CT");
    const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : "public";
    const open = [...this.flips.values()].filter((f) => f.status === "waiting" && f.creator.userId === userId).length;
    if (open >= MAX_OPEN_PER_USER) throw new GameError("busy", `You can have ${MAX_OPEN_PER_USER} open coinflips at a time`);
    let flip;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      flip = {
        status: "waiting",
        createdAt: Date.now(),
        creator: { userId, user: a.username, name: a.displayName, bot: false },
        side,
        stakeCents: stake,
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

  /** By id (public / friends flips) or by code (any, including private). */
  join(userId, body) {
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    const f = code ? [...this.flips.values()].find((x) => x.code === code && x.status === "waiting") : this.#get(body.id);
    if (!f) throw new GameError("not_found", "No open coinflip with that code", 404);
    if (!this.#canSee(f, userId, code)) throw new GameError("forbidden", f.visibility === "friends" ? `Only ${f.creator.name}'s friends can join` : "You need the code to join", 403);
    if (f.status !== "waiting") throw new GameError("closed", "Someone already joined");
    if (f.creator.userId === userId) throw new GameError("busy", "That's your own coinflip. Call a bot to play it.");
    const out = this.game.act(userId, (a) => {
      if (spendable(a) < f.stakeCents) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= f.stakeCents;
      f.joiner = { userId, user: a.username, name: a.displayName, bot: false };
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
    f.joiner = BOT;
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
    const out = this.game.act(userId, (a) => {
      a.balanceCents += f.stakeCents;
      return {};
    });
    this.publish();
    return out;
  }

  /** Both seats taken: flip, settle now, and reveal when the coin lands. */
  #flip(f) {
    f.result = SIDES[randomInt(2)];
    // Against a bot the rig tilts the coin toward the bot's side.
    if (f.joiner.bot && Math.random() < this.game.rig("coinflipBot")) f.result = other(f.side);
    f.status = "flipping";
    f.startAt = Date.now() + FLIP_LEAD_MS;
    const winner = f.result === f.side ? f.creator : f.joiner;
    f.winner = winner === f.creator ? "creator" : "joiner";
    const accounts = new Map();
    for (const p of [f.creator, f.joiner]) {
      if (!p.userId) continue;
      const won = p === winner;
      const { account } = this.game.act(p.userId, (a) => {
        if (won) a.balanceCents += 2 * f.stakeCents;
        this.game.noteGame(a, "coinflip", { stakeCents: f.stakeCents, payoutCents: won ? 2 * f.stakeCents : 0, add: { won: won ? 1 : 0 } });
        return {};
      });
      accounts.set(p.userId, account);
    }
    this.#save(f);
    this.publish();
    setTimeout(() => {
      f.status = "done";
      this.#save(f);
      for (const [uid, account] of accounts) this.io.toUser(uid, "account", { ...this.game.view(uid), ...(account.unlocked ? { unlocked: account.unlocked } : {}) });
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

const who = (p) => (p ? { user: p.user, name: p.name, bot: p.bot } : null);
const publicFlip = (f, inIt) => ({
  id: f.id,
  status: f.status,
  visibility: f.visibility,
  code: inIt ? f.code : null,
  creator: who(f.creator),
  joiner: who(f.joiner),
  side: f.side,
  stake: f.stakeCents / 100,
  createdAt: f.createdAt,
  startAt: f.startAt ?? null,
  result: f.status === "waiting" ? null : f.result,
  winner: f.status === "waiting" ? null : f.winner,
});

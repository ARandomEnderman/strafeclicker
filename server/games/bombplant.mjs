// Bomb plant: one shared round for everyone. Bets are taken while the round is open;
// then the server draws where the bomb goes down (A or B) and how it ends (explodes or
// defused), and every browser plays the same round on the same clock.
//
// Stakes are debited when the bet is placed and kept in bp_bets, so a restart refunds
// whatever was on the table.

import { randomInt } from "node:crypto";
import { BP_BET_MS, BP_OUTCOMES, BP_PICKS, BP_RESULT_MS, BP_RUN_MS } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const HISTORY = 30;
const MAX_BETS_PER_ROUND = 30;

export class BombPlant {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ broadcast: (event: string, data: any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, io) {
    this.game = game;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS bp_bets (
      id INTEGER PRIMARY KEY, round INTEGER NOT NULL, user_id INTEGER NOT NULL, pick TEXT NOT NULL,
      stake_cents INTEGER NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.exec("CREATE TABLE IF NOT EXISTS bp_rounds (id INTEGER PRIMARY KEY, site TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO bp_bets (round, user_id, pick, stake_cents, status, at) VALUES (?, ?, ?, ?, 'open', ?)"),
      settle: db.prepare("UPDATE bp_bets SET status = ? WHERE round = ? AND user_id = ? AND status = 'open'"),
      unsettled: db.prepare("SELECT id, user_id, stake_cents FROM bp_bets WHERE status = 'open'"),
      refunded: db.prepare("UPDATE bp_bets SET status = 'refunded' WHERE id = ?"),
      refundRound: db.prepare("UPDATE bp_bets SET status = 'refunded' WHERE round = ? AND status = 'open'"),
      addRound: db.prepare("INSERT INTO bp_rounds (id, site, result, at) VALUES (?, ?, ?, ?)"),
      history: db.prepare("SELECT site, result FROM bp_rounds ORDER BY id DESC LIMIT ?"),
      lastRound: db.prepare("SELECT MAX(id) AS id FROM bp_rounds"),
    };
    this.history = this.q.history.all(HISTORY).map((r) => ({ site: r.site, result: r.result }));
    this.round = (this.q.lastRound.get().id ?? 0) + 1;
    /** Bets this round: { userId, user, name, pick, stakeCents } */
    this.bets = [];
    this.timers = [];
  }

  start() {
    for (const b of this.q.unsettled.all()) {
      const { account } = this.game.act(b.user_id, (a) => {
        a.balanceCents += b.stake_cents;
        this.q.refunded.run(b.id);
        return {};
      });
      this.io.toUser(b.user_id, "account", account);
    }
    this.#open();
  }

  stop() {
    this.timers.forEach(clearTimeout);
  }

  #open() {
    this.phase = "betting";
    this.outcome = null;
    this.startAt = Date.now() + BP_BET_MS;
    this.timers = [setTimeout(() => this.#run(), BP_BET_MS)];
    this.#publish();
  }

  #paid(o) {
    return this.bets.filter((b) => BP_PICKS[b.pick].wins(o)).reduce((s, b) => s + b.stakeCents * BP_PICKS[b.pick].pays, 0);
  }

  #run() {
    this.phase = "running";
    this.outcome = BP_OUTCOMES[randomInt(BP_OUTCOMES.length)];
    // The rig: that share of rounds end the way that pays the players least.
    if (this.bets.length && Math.random() < this.game.rig("bombplant")) {
      const least = Math.min(...BP_OUTCOMES.map((o) => this.#paid(o)));
      const pick = BP_OUTCOMES.filter((o) => this.#paid(o) === least);
      this.outcome = pick[randomInt(pick.length)];
    }
    this.startAt = Date.now();
    this.timers = [setTimeout(() => this.#settle(), BP_RUN_MS)];
    this.#publish();
  }

  #settle() {
    const o = this.outcome;
    const byUser = new Map();
    for (const b of this.bets) {
      if (!byUser.has(b.userId)) byUser.set(b.userId, []);
      byUser.get(b.userId).push(b);
    }
    for (const [userId, bets] of byUser) {
      const stake = bets.reduce((s, b) => s + b.stakeCents, 0);
      const payout = Math.floor(bets.filter((b) => BP_PICKS[b.pick].wins(o)).reduce((s, b) => s + b.stakeCents * BP_PICKS[b.pick].pays, 0));
      const { account } = this.game.act(userId, (a) => {
        a.balanceCents += payout;
        this.game.noteGame(a, "bombplant", { stakeCents: stake, payoutCents: payout });
        this.q.settle.run(payout > 0 ? "won" : "lost", this.round, userId);
        return {};
      });
      this.io.toUser(userId, "account", account);
    }
    this.q.addRound.run(this.round, o.site, o.result, Date.now());
    this.history = [o, ...this.history].slice(0, HISTORY);
    this.phase = "result";
    this.timers = [
      setTimeout(() => {
        this.round++;
        this.bets = [];
        this.#open();
      }, BP_RESULT_MS),
    ];
    this.#publish();
  }

  /** Maintenance: hand back every bet on a round that hasn't started. Returns how many. */
  refundPending() {
    if (this.phase !== "betting" || !this.bets.length) return 0;
    const byUser = new Map();
    for (const b of this.bets) byUser.set(b.userId, (byUser.get(b.userId) ?? 0) + b.stakeCents);
    for (const [userId, c] of byUser) {
      const { account } = this.game.act(userId, (a) => {
        a.balanceCents += c;
        return {};
      });
      this.io.toUser(userId, "account", account);
    }
    this.q.refundRound.run(this.round);
    const n = this.bets.length;
    this.bets = [];
    this.#publish();
    return n;
  }

  bet(userId, body) {
    if (this.phase !== "betting") throw new GameError("closed", "Bets are closed for this round");
    const pick = String(body.pick ?? "");
    if (!Object.hasOwn(BP_PICKS, pick)) throw new GameError("bad_input", "Pick a bet");
    if (this.bets.filter((b) => b.userId === userId).length >= MAX_BETS_PER_ROUND) throw new GameError("busy", "That's enough bets for one round");
    let bet;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      this.q.add.run(this.round, userId, pick, stake, Date.now());
      bet = { userId, user: a.username, name: a.displayName, pick, stakeCents: stake };
      return {};
    });
    this.bets.push(bet);
    this.#publish();
    return out;
  }

  state() {
    const totals = new Map();
    for (const b of this.bets) {
      const key = `${b.pick}|${b.userId}`;
      const t = totals.get(key) ?? { pick: b.pick, user: b.user, name: b.name, stake: 0 };
      t.stake += b.stakeCents / 100;
      totals.set(key, t);
    }
    return {
      round: this.round,
      phase: this.phase,
      startAt: this.startAt,
      // Only once the round is playing.
      outcome: this.phase === "betting" ? null : this.outcome,
      bets: [...totals.values()].map((t) => ({ ...t, stake: Math.round(t.stake * 100) / 100 })).sort((x, y) => y.stake - x.stake),
      history: this.history,
    };
  }

  #publish() {
    this.io.broadcast("bombplant", this.state());
  }
}

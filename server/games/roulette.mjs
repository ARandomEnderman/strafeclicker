// Roulette: one shared wheel. Bets are taken while the round is open, then the server
// draws a number and everyone's wheel spins to it, landing on the same spot at the
// same moment; winners are paid when it stops.
//
// Stakes are debited when the bet is placed and kept in rl_bets, so a restart refunds
// whatever was on the table.

import { randomInt } from "node:crypto";
import { ROULETTE_BET_MS, ROULETTE_COLORS, ROULETTE_PAYOUT, ROULETTE_RESULT_MS, ROULETTE_SPIN_MS, rouletteColor } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const HISTORY = 30;
/** Most bets one player can place in a round (each colour can be topped up). */
const MAX_BETS_PER_ROUND = 30;

export class Roulette {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ broadcast: (event: string, data: any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, io) {
    this.game = game;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS rl_bets (
      id INTEGER PRIMARY KEY, round INTEGER NOT NULL, user_id INTEGER NOT NULL, color TEXT NOT NULL,
      stake_cents INTEGER NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.exec("CREATE TABLE IF NOT EXISTS rl_rounds (id INTEGER PRIMARY KEY, number INTEGER NOT NULL, at INTEGER NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO rl_bets (round, user_id, color, stake_cents, status, at) VALUES (?, ?, ?, ?, 'open', ?)"),
      settle: db.prepare("UPDATE rl_bets SET status = ? WHERE round = ? AND user_id = ? AND status = 'open'"),
      unsettled: db.prepare("SELECT id, user_id, stake_cents FROM rl_bets WHERE status = 'open'"),
      refunded: db.prepare("UPDATE rl_bets SET status = 'refunded' WHERE id = ?"),
      refundRound: db.prepare("UPDATE rl_bets SET status = 'refunded' WHERE round = ? AND status = 'open'"),
      addRound: db.prepare("INSERT INTO rl_rounds (id, number, at) VALUES (?, ?, ?)"),
      history: db.prepare("SELECT number FROM rl_rounds ORDER BY id DESC LIMIT ?"),
      lastRound: db.prepare("SELECT MAX(id) AS id FROM rl_rounds"),
    };
    this.history = this.q.history.all(HISTORY).map((r) => r.number);
    this.round = (this.q.lastRound.get().id ?? 0) + 1;
    /** Bets this round: { userId, user, name, color, stakeCents } */
    this.bets = [];
    this.phase = "betting";
    this.timers = [];
  }

  /** Refund bets a restart left on the table, then start the loop. */
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
    this.number = null;
    this.spinAt = Date.now() + ROULETTE_BET_MS;
    this.timers = [setTimeout(() => this.#spin(), ROULETTE_BET_MS)];
    this.#publish();
  }

  #spin() {
    this.phase = "spinning";
    this.number = randomInt(15);
    // The rig: that share of spins land on the number that pays the players least.
    if (this.bets.length && Math.random() < this.game.rig("roulette")) {
      const paid = (n) => this.bets.filter((b) => b.color === rouletteColor(n)).reduce((s, b) => s + b.stakeCents * ROULETTE_PAYOUT[b.color], 0);
      const nums = [...Array(15).keys()];
      const least = Math.min(...nums.map(paid));
      const pick = nums.filter((n) => paid(n) === least);
      this.number = pick[randomInt(pick.length)];
    }
    // Where on the winning tile the marker stops (0–1), the same for everyone.
    this.stopAt = Math.round((0.1 + Math.random() * 0.8) * 1000) / 1000;
    this.spinAt = Date.now();
    this.timers = [setTimeout(() => this.#settle(), ROULETTE_SPIN_MS)];
    this.#publish();
  }

  #settle() {
    const color = rouletteColor(this.number);
    // One transaction per player, covering all their bets this round.
    const byUser = new Map();
    for (const b of this.bets) {
      if (!byUser.has(b.userId)) byUser.set(b.userId, []);
      byUser.get(b.userId).push(b);
    }
    for (const [userId, bets] of byUser) {
      const stake = bets.reduce((s, b) => s + b.stakeCents, 0);
      const payout = bets.filter((b) => b.color === color).reduce((s, b) => s + b.stakeCents * ROULETTE_PAYOUT[color], 0);
      const { account } = this.game.act(userId, (a) => {
        a.balanceCents += payout;
        this.game.noteGame(a, "roulette", { stakeCents: stake, payoutCents: payout, add: payout > 0 && color === "green" ? { greens: 1 } : {} });
        this.q.settle.run(payout > 0 ? "won" : "lost", this.round, userId);
        return {};
      });
      this.io.toUser(userId, "account", account);
    }
    this.q.addRound.run(this.round, this.number, Date.now());
    this.history = [this.number, ...this.history].slice(0, HISTORY);
    this.phase = "result";
    this.timers = [
      setTimeout(() => {
        this.round++;
        this.bets = [];
        this.#open();
      }, ROULETTE_RESULT_MS),
    ];
    this.#publish();
  }

  /** Maintenance: hand back every bet on a spin that hasn't started. Returns how many. */
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
    if (this.phase !== "betting") throw new GameError("closed", "Bets are closed for this spin");
    const color = String(body.color ?? "");
    if (!ROULETTE_COLORS.includes(color)) throw new GameError("bad_input", "Pick T, CT or green");
    if (this.bets.filter((b) => b.userId === userId).length >= MAX_BETS_PER_ROUND) throw new GameError("busy", "That's enough bets for one spin");
    let bet;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      this.q.add.run(this.round, userId, color, stake, Date.now());
      bet = { userId, user: a.username, name: a.displayName, color, stakeCents: stake };
      return {};
    });
    this.bets.push(bet);
    this.#publish();
    return out;
  }

  state() {
    // Each player's bets on a colour, added up.
    const totals = new Map();
    for (const b of this.bets) {
      const key = `${b.color}|${b.userId}`;
      const t = totals.get(key) ?? { color: b.color, user: b.user, name: b.name, stake: 0 };
      t.stake += b.stakeCents / 100;
      totals.set(key, t);
    }
    return {
      round: this.round,
      phase: this.phase,
      spinAt: this.spinAt,
      // Only once the wheel has started: the number it lands on and where.
      number: this.phase === "betting" ? null : this.number,
      stop: this.phase === "betting" ? null : this.stopAt,
      bets: [...totals.values()].map((t) => ({ ...t, stake: Math.round(t.stake * 100) / 100 })).sort((x, y) => y.stake - x.stake),
      history: this.history,
    };
  }

  #publish() {
    this.io.broadcast("roulette", this.state());
  }
}

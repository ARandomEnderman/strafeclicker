// Bot race: one shared round. Each round the five bots get fresh chances of winning,
// shown as odds (0.99 / chance). When betting closes the server picks the winner by
// those chances and scripts the whole race (every bot's path to the line), so every
// browser shows the same race; winners are paid when it ends.
//
// Stakes are debited when the bet is placed and kept in race_bets, so a restart
// refunds whatever was riding.

import { randomInt } from "node:crypto";
import { RACE_BET_MS, RACE_BOTS, RACE_RESULT_MS, RACE_RUN_MS, RACE_STEPS, pickWeighted } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const RTP = 0.99;
const HISTORY = 20;
const MAX_BETS_PER_ROUND = 20;

/** Fresh chances for a round: random "form" per bot, normalised, none below 6%. */
function drawChances() {
  const form = RACE_BOTS.map(() => 0.4 + Math.random() ** 1.6 * 2.6);
  const total = form.reduce((s, x) => s + x, 0);
  let p = form.map((x) => Math.max(0.06, x / total));
  const t2 = p.reduce((s, x) => s + x, 0);
  p = p.map((x) => x / t2);
  return p.map((x) => Math.round(x * 10000) / 10000);
}

const oddsOf = (p) => Math.floor((RTP / p) * 100) / 100;

/** Every bot's path: progress (0–1) at RACE_STEPS evenly spaced moments up to its finish. */
function script(winner) {
  const finish = RACE_BOTS.map((_, i) => (i === winner ? 8.5 + Math.random() * 0.8 : 9.6 + Math.random() * 1.3));
  // Losers can't finish before the winner.
  const w = finish[winner];
  finish.forEach((t, i) => i !== winner && t < w + 0.15 && (finish[i] = w + 0.15 + Math.random() * 0.4));
  const paths = finish.map(() => {
    // Uneven strides: some bursts, some slow patches, summing to the finish line.
    const strides = Array.from({ length: RACE_STEPS }, () => 0.5 + Math.random());
    const total = strides.reduce((s, x) => s + x, 0);
    let acc = 0;
    return strides.map((x) => Math.round(((acc += x) / total) * 1000) / 1000);
  });
  return { finish: finish.map((t) => Math.round(t * 1000)), paths };
}

export class Race {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ broadcast: (event: string, data: any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, io) {
    this.game = game;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS race_bets (
      id INTEGER PRIMARY KEY, round INTEGER NOT NULL, user_id INTEGER NOT NULL, bot INTEGER NOT NULL,
      stake_cents INTEGER NOT NULL, odds REAL NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.exec("CREATE TABLE IF NOT EXISTS race_rounds (id INTEGER PRIMARY KEY, winner INTEGER NOT NULL, odds REAL NOT NULL, at INTEGER NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO race_bets (round, user_id, bot, stake_cents, odds, status, at) VALUES (?, ?, ?, ?, ?, 'open', ?)"),
      settle: db.prepare("UPDATE race_bets SET status = ? WHERE round = ? AND user_id = ? AND status = 'open'"),
      unsettled: db.prepare("SELECT id, user_id, stake_cents FROM race_bets WHERE status = 'open'"),
      refunded: db.prepare("UPDATE race_bets SET status = 'refunded' WHERE id = ?"),
      refundRound: db.prepare("UPDATE race_bets SET status = 'refunded' WHERE round = ? AND status = 'open'"),
      addRound: db.prepare("INSERT INTO race_rounds (id, winner, odds, at) VALUES (?, ?, ?, ?)"),
      history: db.prepare("SELECT winner, odds FROM race_rounds ORDER BY id DESC LIMIT ?"),
      lastRound: db.prepare("SELECT MAX(id) AS id FROM race_rounds"),
    };
    this.history = this.q.history.all(HISTORY);
    this.round = (this.q.lastRound.get().id ?? 0) + 1;
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
    this.chances = drawChances();
    this.odds = this.chances.map(oddsOf);
    this.winner = null;
    this.race = null;
    this.startAt = Date.now() + RACE_BET_MS;
    this.timers = [setTimeout(() => this.#run(), RACE_BET_MS)];
    this.#publish();
  }

  #run() {
    this.winner = pickWeighted(this.chances.map((p, i) => [i, p]), Math.random());
    // The rig: that share of races go to the bot that costs the house least.
    if (this.bets.length && Math.random() < this.game.rig("race")) {
      const paid = (i) => this.bets.filter((b) => b.bot === i).reduce((s, b) => s + b.stakeCents * b.odds, 0);
      const least = Math.min(...RACE_BOTS.map((_, i) => paid(i)));
      const pick = RACE_BOTS.map((_, i) => i).filter((i) => paid(i) === least);
      this.winner = pick[randomInt(pick.length)];
    }
    // The admin can pick the next winner (once).
    if (this.forced != null) {
      this.winner = this.forced;
      this.forced = null;
    }
    this.race = script(this.winner);
    this.phase = "racing";
    this.startAt = Date.now();
    this.timers = [setTimeout(() => this.#settle(), RACE_RUN_MS)];
    this.#publish();
  }

  #settle() {
    const byUser = new Map();
    for (const b of this.bets) {
      if (!byUser.has(b.userId)) byUser.set(b.userId, []);
      byUser.get(b.userId).push(b);
    }
    for (const [userId, bets] of byUser) {
      const stake = bets.reduce((s, b) => s + b.stakeCents, 0);
      const payout = bets.filter((b) => b.bot === this.winner).reduce((s, b) => s + Math.floor(b.stakeCents * b.odds), 0);
      const { account } = this.game.act(userId, (a) => {
        a.balanceCents += payout;
        this.game.noteGame(a, "race", { stakeCents: stake, payoutCents: payout });
        this.q.settle.run(payout > 0 ? "won" : "lost", this.round, userId);
        return {};
      });
      this.io.toUser(userId, "account", account);
    }
    this.q.addRound.run(this.round, this.winner, this.odds[this.winner], Date.now());
    this.history = [{ winner: this.winner, odds: this.odds[this.winner] }, ...this.history].slice(0, HISTORY);
    this.phase = "result";
    this.#publish();
    this.timers = [
      setTimeout(() => {
        this.round++;
        this.bets = [];
        this.#open();
      }, RACE_RESULT_MS),
    ];
  }

  /** Maintenance: hand back every bet on a race that hasn't started. Returns how many. */
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
    if (this.phase !== "betting") throw new GameError("closed", "Betting is closed for this race");
    const bot = Math.floor(Number(body.bot));
    if (!(bot >= 0 && bot < RACE_BOTS.length)) throw new GameError("bad_input", "Pick a bot");
    if (this.bets.filter((b) => b.userId === userId).length >= MAX_BETS_PER_ROUND) throw new GameError("busy", "That's enough bets for one race");
    let bet;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      this.q.add.run(this.round, userId, bot, stake, this.odds[bot], Date.now());
      bet = { userId, user: a.username, name: a.displayName, bot, stakeCents: stake, odds: this.odds[bot] };
      return {};
    });
    this.bets.push(bet);
    this.#publish();
    return out;
  }

  state() {
    const totals = new Map();
    for (const b of this.bets) {
      const key = `${b.bot}|${b.userId}`;
      const t = totals.get(key) ?? { bot: b.bot, user: b.user, name: b.name, stake: 0 };
      t.stake += b.stakeCents / 100;
      totals.set(key, t);
    }
    return {
      round: this.round,
      phase: this.phase,
      startAt: this.startAt,
      odds: this.odds,
      chances: this.chances,
      // Once the race is on: who wins and every bot's scripted path.
      winner: this.phase === "betting" ? null : this.winner,
      race: this.phase === "betting" ? null : this.race,
      bets: [...totals.values()].map((t) => ({ ...t, stake: Math.round(t.stake * 100) / 100 })).sort((x, y) => y.stake - x.stake),
      history: this.history,
    };
  }

  #publish() {
    this.io.broadcast("race", this.state());
  }
}

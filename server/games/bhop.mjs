// B-hop: jump along a lane of tiles and cash out before one gives way.
//
// When a run starts the server decides which tile breaks (each jump is safe with the
// difficulty's probability) and keeps it in the database. The browser only learns it
// by landing on it, or when the run ends by cashing out. A run survives reloads and
// restarts: it stays open until it's lost or cashed out.

import { randomBytes } from "node:crypto";
import { BHOP_DIFFICULTIES, bhopMultiplier } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const uniform = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;

export class Bhop {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   */
  constructor(game, db) {
    this.game = game;
    db.exec(`CREATE TABLE IF NOT EXISTS bhop_runs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      difficulty TEXT NOT NULL, stake_cents INTEGER NOT NULL, step INTEGER NOT NULL,
      breaks_at INTEGER, started_at INTEGER NOT NULL)`);
    this.q = {
      get: db.prepare("SELECT * FROM bhop_runs WHERE user_id = ?"),
      add: db.prepare("INSERT INTO bhop_runs (user_id, difficulty, stake_cents, step, breaks_at, started_at) VALUES (?, ?, ?, 0, ?, ?)"),
      step: db.prepare("UPDATE bhop_runs SET step = ? WHERE user_id = ?"),
      end: db.prepare("DELETE FROM bhop_runs WHERE user_id = ?"),
    };
  }

  /** What the browser may see of a run (never where it breaks). */
  #view(r) {
    return r ? { difficulty: r.difficulty, stake: r.stake_cents / 100, step: r.step, mult: bhopMultiplier(r.difficulty, r.step) } : null;
  }

  /** Drop a run without paying anything (account reset). */
  forget(userId) {
    this.q.end.run(userId);
  }

  state(userId) {
    return this.game.act(userId, () => ({ run: this.#view(this.q.get.get(userId)) }));
  }

  start(userId, body) {
    const difficulty = String(body.difficulty ?? "");
    const d = Object.hasOwn(BHOP_DIFFICULTIES, difficulty) ? BHOP_DIFFICULTIES[difficulty] : null;
    if (!d) throw new GameError("bad_input", "Pick a difficulty");
    return this.game.act(userId, (a) => {
      if (this.q.get.get(userId)) throw new GameError("busy", "Finish your current run first");
      const stake = stakeCents(a, body.bet);
      // The first tile that gives way (1-based), or null if the whole lane holds.
      let breaksAt = null;
      for (let i = 1; i <= d.steps; i++) {
        if (uniform() >= d.p) {
          breaksAt = i;
          break;
        }
      }
      a.balanceCents -= stake;
      this.q.add.run(userId, difficulty, stake, breaksAt, Date.now());
      return { run: this.#view(this.q.get.get(userId)) };
    });
  }

  jump(userId) {
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "Start a run first");
      const step = r.step + 1;
      if (step === r.breaks_at) {
        this.q.end.run(userId);
        this.game.noteGame(a, "bhop", { stakeCents: r.stake_cents, payoutCents: 0, max: { bestJumps: r.step } });
        return { result: "fell", step, breaksAt: r.breaks_at, run: null };
      }
      const { steps } = BHOP_DIFFICULTIES[r.difficulty];
      if (step >= steps) {
        // End of the lane: cashed out automatically.
        return { result: "finished", ...this.#cashout(a, { ...r, step }), step };
      }
      this.q.step.run(step, userId);
      return { result: "landed", step, run: this.#view({ ...r, step }) };
    });
  }

  cashout(userId) {
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "No run to cash out");
      if (r.step === 0) {
        // Nothing jumped yet: just hand the stake back.
        this.q.end.run(userId);
        a.balanceCents += r.stake_cents;
        return { result: "cancelled", payout: r.stake_cents / 100, breaksAt: r.breaks_at, run: null };
      }
      return { result: "cashed", ...this.#cashout(a, r) };
    });
  }

  #cashout(a, r) {
    const mult = bhopMultiplier(r.difficulty, r.step);
    const payout = Math.floor(r.stake_cents * mult);
    this.q.end.run(a.id);
    a.balanceCents += payout;
    this.game.noteGame(a, "bhop", { stakeCents: r.stake_cents, payoutCents: payout, max: { bestJumps: r.step } });
    return { mult, payout: payout / 100, breaksAt: r.breaks_at, run: null };
  }
}

// Towers: an endless climb. On each floor the player picks a door; some doors hide a
// T. Each floor's Ts are drawn before you reach it (with the honest odds) and kept on the
// server; when the run ends, the next REVEAL floors you didn't reach are shown too, so
// you can see where the Ts would have been. A run is kept in the database until it's lost
// or cashed out, so it survives reloads and restarts.

import { randomInt } from "node:crypto";
import { TOWER_DIFFICULTIES, TOWER_MAX_MULT, towerMultiplier } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

/** Floors above the last one played that are shown once the run ends (the page shows 4). */
const REVEAL = 4;

export class Towers {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   */
  constructor(game, db) {
    this.game = game;
    db.exec(`CREATE TABLE IF NOT EXISTS tower_runs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      difficulty TEXT NOT NULL, stake_cents INTEGER NOT NULL,
      floors TEXT NOT NULL, started_at INTEGER NOT NULL)`);
    // The floors ahead, drawn in advance and never sent until the run is over.
    if (!db.prepare("PRAGMA table_info(tower_runs)").all().some((c) => c.name === "ahead")) db.exec("ALTER TABLE tower_runs ADD COLUMN ahead TEXT");
    this.q = {
      get: db.prepare("SELECT * FROM tower_runs WHERE user_id = ?"),
      add: db.prepare("INSERT INTO tower_runs (user_id, difficulty, stake_cents, floors, started_at) VALUES (?, ?, ?, '[]', ?)"),
      floors: db.prepare("UPDATE tower_runs SET floors = ?, ahead = ? WHERE user_id = ?"),
      end: db.prepare("DELETE FROM tower_runs WHERE user_id = ?"),
    };
  }

  /** A run as the browser sees it: every cleared floor (with where its Ts were). */
  #view(r) {
    if (!r) return null;
    const floors = JSON.parse(r.floors);
    return { difficulty: r.difficulty, stake: r.stake_cents / 100, floors, mult: towerMultiplier(r.difficulty, floors.length), next: towerMultiplier(r.difficulty, floors.length + 1) };
  }

  /** A random set of `ts` doors out of `doors`. */
  #draw(d) {
    const doors = Array.from({ length: d.doors }, (_, i) => i);
    for (let i = doors.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [doors[i], doors[j]] = [doors[j], doors[i]];
    }
    return doors.slice(0, d.ts).sort((x, y) => x - y);
  }

  /** The floors you didn't reach, for the end of a run: drawn now if they weren't yet. */
  #reveal(r) {
    const d = TOWER_DIFFICULTIES[r.difficulty];
    const ahead = JSON.parse(r.ahead ?? "[]");
    while (ahead.length < REVEAL) ahead.push(this.#draw(d));
    return ahead.slice(0, REVEAL);
  }

  forget(userId) {
    this.q.end.run(userId);
  }

  state(userId) {
    return this.game.act(userId, () => ({ run: this.#view(this.q.get.get(userId)) }));
  }

  start(userId, body) {
    const difficulty = String(body.difficulty ?? "");
    if (!Object.hasOwn(TOWER_DIFFICULTIES, difficulty)) throw new GameError("bad_input", "Pick a difficulty");
    return this.game.act(userId, (a) => {
      if (this.q.get.get(userId)) throw new GameError("busy", "Finish your current climb first");
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      this.q.add.run(userId, difficulty, stake, Date.now());
      return { run: this.#view(this.q.get.get(userId)) };
    });
  }

  pick(userId, body) {
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "Start a climb first");
      const d = TOWER_DIFFICULTIES[r.difficulty];
      const door = Math.floor(Number(body.door));
      if (!(door >= 0 && door < d.doors)) throw new GameError("bad_input", "No such door");
      // This floor's Ts, drawn in advance; keep the next floors drawn too.
      const ahead = JSON.parse(r.ahead ?? "[]");
      while (ahead.length < REVEAL + 1) ahead.push(this.#draw(d));
      let ts = ahead.shift();
      // The rig: that share of safe picks get a T moved behind them.
      if (!ts.includes(door) && Math.random() < this.game.rig("towers")) ts = [...ts.slice(1), door].sort((x, y) => x - y);
      const floors = JSON.parse(r.floors);
      floors.push({ door, ts });
      const rest = { ...r, floors: JSON.stringify(floors), ahead: JSON.stringify(ahead) };
      if (ts.includes(door)) {
        this.q.end.run(userId);
        this.game.noteGame(a, "towers", { stakeCents: r.stake_cents, payoutCents: 0, max: { bestFloor: floors.length - 1 } });
        return { result: "caught", floors, ahead: this.#reveal(rest), run: null };
      }
      // At the top multiplier there's nowhere further to go: cash out.
      if (towerMultiplier(r.difficulty, floors.length) >= TOWER_MAX_MULT) return { result: "top", ...this.#cashout(a, rest) };
      this.q.floors.run(JSON.stringify(floors), JSON.stringify(ahead), userId);
      return { result: "safe", floors, run: this.#view({ ...r, floors: JSON.stringify(floors) }) };
    });
  }

  cashout(userId) {
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "No climb to cash out");
      if (!JSON.parse(r.floors).length) {
        this.q.end.run(userId);
        a.balanceCents += r.stake_cents;
        return { result: "cancelled", payout: r.stake_cents / 100, ahead: this.#reveal(r), run: null };
      }
      return { result: "cashed", ...this.#cashout(a, r) };
    });
  }

  #cashout(a, r) {
    const floors = JSON.parse(r.floors);
    const mult = towerMultiplier(r.difficulty, floors.length);
    const payout = Math.floor(r.stake_cents * mult);
    this.q.end.run(a.id);
    a.balanceCents += payout;
    this.game.noteGame(a, "towers", { stakeCents: r.stake_cents, payoutCents: payout, max: { bestFloor: floors.length } });
    return { mult, payout: payout / 100, floors, ahead: this.#reveal(r), run: null };
  }
}

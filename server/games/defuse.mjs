// Defuse: a 5×5 grid hiding C4s. Reveal tiles one at a time and cash out before you
// hit a bomb. Bomb positions are drawn when the round starts and stay in the database;
// the browser only sees them after a bomb is hit or the round is cashed out. A round
// survives reloads and restarts.

import { randomInt } from "node:crypto";
import { DEFUSE_TILES, defuseMultiplier } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

export class Defuse {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   */
  constructor(game, db) {
    this.game = game;
    db.exec(`CREATE TABLE IF NOT EXISTS defuse_runs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      bombs INTEGER NOT NULL, mines TEXT NOT NULL, revealed TEXT NOT NULL,
      stake_cents INTEGER NOT NULL, started_at INTEGER NOT NULL)`);
    this.q = {
      get: db.prepare("SELECT * FROM defuse_runs WHERE user_id = ?"),
      add: db.prepare("INSERT INTO defuse_runs (user_id, bombs, mines, revealed, stake_cents, started_at) VALUES (?, ?, ?, '[]', ?, ?)"),
      reveal: db.prepare("UPDATE defuse_runs SET revealed = ? WHERE user_id = ?"),
      end: db.prepare("DELETE FROM defuse_runs WHERE user_id = ?"),
    };
  }

  /** What the browser may see of a round (never where the bombs are). */
  #view(r) {
    if (!r) return null;
    const revealed = JSON.parse(r.revealed);
    return {
      bombs: r.bombs,
      stake: r.stake_cents / 100,
      revealed,
      mult: defuseMultiplier(r.bombs, revealed.length),
      next: defuseMultiplier(r.bombs, revealed.length + 1),
    };
  }

  /** Drop a round without paying anything (account reset). */
  forget(userId) {
    this.q.end.run(userId);
  }

  state(userId) {
    return this.game.act(userId, () => ({ run: this.#view(this.q.get.get(userId)) }));
  }

  start(userId, body) {
    const bombs = Math.floor(Number(body.bombs));
    if (!(bombs >= 1 && bombs <= DEFUSE_TILES - 1)) throw new GameError("bad_input", `Pick 1 to ${DEFUSE_TILES - 1} bombs`);
    return this.game.act(userId, (a) => {
      if (this.q.get.get(userId)) throw new GameError("busy", "Finish your current round first");
      const stake = stakeCents(a, body.bet);
      // Fisher–Yates over the tiles; the first `bombs` get a C4.
      const tiles = Array.from({ length: DEFUSE_TILES }, (_, i) => i);
      for (let i = tiles.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
      }
      a.balanceCents -= stake;
      this.q.add.run(userId, bombs, JSON.stringify(tiles.slice(0, bombs).sort((x, y) => x - y)), stake, Date.now());
      return { run: this.#view(this.q.get.get(userId)) };
    });
  }

  reveal(userId, body) {
    const tile = Math.floor(Number(body.tile));
    if (!(tile >= 0 && tile < DEFUSE_TILES)) throw new GameError("bad_input", "No such tile");
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "Start a round first");
      const mines = JSON.parse(r.mines);
      const revealed = JSON.parse(r.revealed);
      if (revealed.includes(tile)) throw new GameError("bad_input", "Already revealed");
      // The rig: with that probability a safe pick gets a bomb moved under it (from
      // another hidden tile, so the count stays the same).
      const rig = this.game.rig("defuse");
      if (!mines.includes(tile) && rig > 0 && Math.random() < rig) {
        const from = mines[Math.floor(Math.random() * mines.length)];
        mines.splice(mines.indexOf(from), 1, tile);
        mines.sort((x, y) => x - y);
      }
      if (mines.includes(tile)) {
        this.q.end.run(userId);
        this.game.noteGame(a, "defuse", { stakeCents: r.stake_cents, payoutCents: 0, max: { bestTiles: revealed.length } });
        return { result: "boom", tile, mines, run: null };
      }
      revealed.push(tile);
      // Every safe tile found: cashed out automatically.
      if (revealed.length === DEFUSE_TILES - r.bombs) return { result: "cleared", tile, ...this.#cashout(a, { ...r, revealed: JSON.stringify(revealed) }) };
      this.q.reveal.run(JSON.stringify(revealed), userId);
      return { result: "safe", tile, run: this.#view({ ...r, revealed: JSON.stringify(revealed) }) };
    });
  }

  /**
   * Auto mode: a whole round in one go. The tiles are picked in the order given; the
   * round stops at the first bomb, or cashes out once all of them are safe. Same odds
   * (and rig) as picking them by hand.
   */
  auto(userId, body) {
    const bombs = Math.floor(Number(body.bombs));
    if (!(bombs >= 1 && bombs <= DEFUSE_TILES - 1)) throw new GameError("bad_input", `Pick 1 to ${DEFUSE_TILES - 1} bombs`);
    const picks = [...new Set((Array.isArray(body.tiles) ? body.tiles : []).map((t) => Math.floor(Number(t))))];
    if (!picks.length || picks.some((t) => !(t >= 0 && t < DEFUSE_TILES))) throw new GameError("bad_input", "Pick the tiles to reveal");
    if (picks.length > DEFUSE_TILES - bombs) throw new GameError("bad_input", `With ${bombs} bombs there are only ${DEFUSE_TILES - bombs} safe tiles`);
    return this.game.act(userId, (a) => {
      if (this.q.get.get(userId)) throw new GameError("busy", "Finish your current round first");
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      const tiles = Array.from({ length: DEFUSE_TILES }, (_, i) => i);
      for (let i = tiles.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
      }
      const mines = tiles.slice(0, bombs);
      const rig = this.game.rig("defuse");
      const revealed = [];
      for (const tile of picks) {
        // The rig, as for a hand pick: a bomb from a tile not picked yet moves under this one.
        if (!mines.includes(tile) && rig > 0 && Math.random() < rig) {
          const spare = mines.filter((m) => !revealed.includes(m));
          mines.splice(mines.indexOf(spare[Math.floor(Math.random() * spare.length)]), 1, tile);
        }
        if (mines.includes(tile)) {
          this.game.noteGame(a, "defuse", { stakeCents: stake, payoutCents: 0, max: { bestTiles: revealed.length } });
          return { result: "boom", tile, revealed, mines: mines.sort((x, y) => x - y), mult: 0, payout: 0, stake: stake / 100 };
        }
        revealed.push(tile);
      }
      const mult = defuseMultiplier(bombs, revealed.length);
      const payout = Math.floor(stake * mult);
      a.balanceCents += payout;
      this.game.noteGame(a, "defuse", { stakeCents: stake, payoutCents: payout, max: { bestTiles: revealed.length } });
      return { result: "cashed", revealed, mines: mines.sort((x, y) => x - y), mult, payout: payout / 100, stake: stake / 100 };
    });
  }

  cashout(userId) {
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "No round to cash out");
      if (JSON.parse(r.revealed).length === 0) {
        // Nothing revealed yet: hand the stake back.
        this.q.end.run(userId);
        a.balanceCents += r.stake_cents;
        return { result: "cancelled", payout: r.stake_cents / 100, mines: JSON.parse(r.mines), run: null };
      }
      return { result: "cashed", ...this.#cashout(a, r) };
    });
  }

  #cashout(a, r) {
    const revealed = JSON.parse(r.revealed);
    const mult = defuseMultiplier(r.bombs, revealed.length);
    const payout = Math.floor(r.stake_cents * mult);
    this.q.end.run(a.id);
    a.balanceCents += payout;
    this.game.noteGame(a, "defuse", { stakeCents: r.stake_cents, payoutCents: payout, max: { bestTiles: revealed.length } });
    return { mult, payout: payout / 100, mines: JSON.parse(r.mines), run: null };
  }
}

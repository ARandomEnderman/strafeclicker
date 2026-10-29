// Flashbang: a crash game with one global round that everyone plays together.
//
//   waiting  FB_INTERMISSION_MS after the last pop. Bets are placed for the next round.
//   running  the multiplier rises; players cash out before the flashbang pops.
//
// The crash point is drawn when the round starts and never leaves the server until the
// pop. Bets placed while a round runs (by anyone not riding it) go into the next round.
// Stakes are debited when the bet is placed and kept in fb_bets, so a restart refunds
// anything that was still riding.

import { randomBytes } from "node:crypto";
import { FB_AUTO_MIN, FB_INTERMISSION_MS, FB_MAX, fbMultiplierAt, fbTimeFor } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const HISTORY = 24;

/**
 * Crash point: P(>= x) = (0.99 - rig) / x, floored to cents, capped at FB_MAX. With no
 * rig that's a 1% edge; the rig adds to it (and to the share of instant pops).
 */
function drawCrash(rig = 0) {
  const r = randomBytes(6).readUIntBE(0, 6) / 2 ** 48; // uniform [0, 1)
  const keep = Math.max(0.01, 0.99 - rig);
  return Math.min(FB_MAX, Math.max(1, Math.floor((keep * 100) / (1 - r) + 1e-9) / 100));
}

export class Flashbang {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ broadcast: (event: string, data: any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, io) {
    this.game = game;
    this.db = db;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS fb_bets (
      id INTEGER PRIMARY KEY, round INTEGER NOT NULL, user_id INTEGER NOT NULL, stake_cents INTEGER NOT NULL,
      auto REAL, status TEXT NOT NULL, mult REAL, payout_cents INTEGER, at INTEGER NOT NULL)`);
    db.exec("CREATE TABLE IF NOT EXISTS fb_rounds (id INTEGER PRIMARY KEY, crash REAL NOT NULL, at INTEGER NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO fb_bets (round, user_id, stake_cents, auto, status, at) VALUES (?, ?, ?, ?, 'queued', ?)"),
      status: db.prepare("UPDATE fb_bets SET status = ?, mult = ?, payout_cents = ? WHERE id = ?"),
      open: db.prepare("UPDATE fb_bets SET status = 'open' WHERE round = ? AND status = 'queued'"),
      unsettled: db.prepare("SELECT id, user_id, stake_cents FROM fb_bets WHERE status IN ('queued', 'open')"),
      addRound: db.prepare("INSERT INTO fb_rounds (id, crash, at) VALUES (?, ?, ?)"),
      history: db.prepare("SELECT crash FROM fb_rounds ORDER BY id DESC LIMIT ?"),
      lastRound: db.prepare("SELECT MAX(id) AS id FROM fb_rounds"),
    };
    this.history = this.q.history.all(HISTORY).map((r) => r.crash);
    this.round = (this.q.lastRound.get().id ?? 0) + 1;
    /** Bets in the running round (or the upcoming one while waiting). */
    this.bets = [];
    /** Bets placed during a run, for the round after it. */
    this.next = [];
    this.phase = "waiting";
    this.startAt = null;
    this.crash = null;
    this.lastCrash = null;
    this.timers = [];
  }

  /** Refund bets a restart left hanging, then start the loop. */
  start() {
    for (const b of this.q.unsettled.all()) {
      this.game.act(b.user_id, (a) => {
        a.balanceCents += b.stake_cents;
        this.q.status.run("refunded", null, 0, b.id);
        return {};
      });
    }
    this.#wait();
  }

  stop() {
    this.timers.forEach(clearTimeout);
  }

  /** Admin: pop the running round now (at whatever it shows). Returns false if none. */
  popNow() {
    if (this.phase !== "running") return false;
    this.timers.forEach(clearTimeout);
    this.crash = Math.max(1, fbMultiplierAt(Date.now() - this.startAt));
    this.#pop();
    return true;
  }

  // ---------- round loop ----------

  #wait() {
    this.phase = "waiting";
    this.nextAt = Date.now() + FB_INTERMISSION_MS;
    this.timers = [setTimeout(() => this.#run(), FB_INTERMISSION_MS)];
    this.#publish();
  }

  #run() {
    this.phase = "running";
    // The admin can set where the next round pops (once); otherwise it's drawn.
    this.crash = this.forced ?? drawCrash(this.game.rig("flashbang"));
    this.forced = null;
    this.startAt = Date.now();
    this.q.open.run(this.round);
    for (const b of this.bets) b.status = "open";
    const crashAt = this.startAt + fbTimeFor(this.crash);
    this.timers = [setTimeout(() => this.#pop(), crashAt - Date.now())];
    // Auto cash-outs at or below the crash point pay exactly their target, on time.
    for (const b of this.bets) {
      if (b.auto != null && b.auto <= this.crash) this.timers.push(setTimeout(() => this.#settle(b, b.auto), this.startAt + fbTimeFor(b.auto) - Date.now()));
    }
    this.#publish();
  }

  #pop() {
    const crash = this.crash;
    // Reaching the cap isn't a pop: everyone still riding cashes out there.
    const maxed = crash >= FB_MAX;
    // An auto target equal to the crash point still wins, even if its timer hasn't fired.
    for (const b of this.bets) if (b.status === "open") this.#settle(b, maxed ? FB_MAX : b.auto != null && b.auto <= crash ? b.auto : null);
    this.q.addRound.run(this.round, crash, Date.now());
    this.history = [crash, ...this.history].slice(0, HISTORY);
    this.lastCrash = { round: this.round, crash, maxed, bets: this.bets.map(publicBet) };
    this.round++;
    this.bets = this.next;
    this.next = [];
    for (const b of this.bets) b.round = this.round;
    this.db.prepare("UPDATE fb_bets SET round = ? WHERE status = 'queued'").run(this.round);
    this.crash = null;
    this.startAt = null;
    this.#wait();
  }

  /** Pay out at `mult`, or lose if mult is null. */
  #settle(b, mult) {
    if (b.status !== "open") return;
    const payout = mult == null ? 0 : Math.floor(b.stakeCents * mult);
    const { account } = this.game.act(b.userId, (a) => {
      a.balanceCents += payout;
      this.game.noteGame(a, "flashbang", { stakeCents: b.stakeCents, payoutCents: payout });
      this.q.status.run(mult == null ? "lost" : "won", mult, payout, b.id);
      return {};
    });
    b.status = mult == null ? "lost" : "won";
    b.mult = mult;
    b.payoutCents = payout;
    this.io.toUser(b.userId, "account", account);
    if (mult != null) this.#publish();
    return account;
  }

  // ---------- player actions ----------

  /** Place a bet: into the coming round while waiting, else into the one after. */
  bet(userId, body) {
    const auto = body.auto == null || body.auto === "" ? null : Math.floor(Number(body.auto) * 100) / 100;
    if (auto != null && !(auto >= FB_AUTO_MIN && auto <= FB_MAX)) throw new GameError("bad_input", `Auto cash-out must be ${FB_AUTO_MIN}x to ${FB_MAX}x`);
    const target = this.phase === "waiting" ? this.bets : this.next;
    if (this.bets.some((b) => b.userId === userId && (b.status === "open" || b.status === "queued"))) {
      throw new GameError("busy", this.phase === "running" ? "Cash out of this round first" : "You've already bet on this round");
    }
    if (this.next.some((b) => b.userId === userId)) throw new GameError("busy", "You've already bet on the next round");
    let bet;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      const round = target === this.bets ? this.round : this.round + 1;
      const { lastInsertRowid } = this.q.add.run(round, userId, stake, auto, Date.now());
      bet = { id: Number(lastInsertRowid), round, userId, user: a.username, name: a.displayName, stakeCents: stake, auto, status: "queued", mult: null, payoutCents: 0 };
      return { round };
    });
    target.push(bet);
    this.#publish();
    return out;
  }

  /** Maintenance: hand back every bet that hasn't started riding (this round while waiting, and the next). */
  refundPending() {
    const pending = [...(this.phase === "waiting" ? this.bets : []), ...this.next].filter((b) => b.status === "queued");
    for (const b of pending) {
      const { account } = this.game.act(b.userId, (a) => {
        a.balanceCents += b.stakeCents;
        this.q.status.run("refunded", null, 0, b.id);
        return {};
      });
      this.io.toUser(b.userId, "account", account);
    }
    if (this.phase === "waiting") this.bets = this.bets.filter((b) => b.status !== "queued");
    this.next = [];
    if (pending.length) this.#publish();
    return pending.length;
  }

  /** Take back a bet that hasn't started riding yet. */
  cancel(userId) {
    const list = this.phase === "waiting" ? this.bets : this.next;
    const b = list.find((x) => x.userId === userId && x.status === "queued");
    if (!b) throw new GameError("no_bet", "No bet to cancel");
    const out = this.game.act(userId, (a) => {
      a.balanceCents += b.stakeCents;
      this.q.status.run("refunded", null, 0, b.id);
      return {};
    });
    list.splice(list.indexOf(b), 1);
    this.#publish();
    return out;
  }

  cashout(userId) {
    if (this.phase !== "running") throw new GameError("not_running", "The round hasn't started");
    const b = this.bets.find((x) => x.userId === userId && x.status === "open");
    if (!b) throw new GameError("no_bet", "You're not in this round");
    const mult = fbMultiplierAt(Date.now() - this.startAt);
    if (mult > this.crash) throw new GameError("too_late", "Too late, it popped");
    const account = this.#settle(b, mult);
    return { mult, payout: b.payoutCents / 100, account };
  }

  // ---------- what browsers see ----------

  state() {
    return {
      round: this.round,
      phase: this.phase,
      startAt: this.startAt,
      nextAt: this.phase === "waiting" ? this.nextAt : null,
      last: this.lastCrash,
      bets: this.bets.map(publicBet),
      next: this.next.map(publicBet),
      history: this.history,
    };
  }

  #publish() {
    this.io.broadcast("fb", this.state());
  }
}

const publicBet = (b) => ({ user: b.user, name: b.name ?? b.user, stake: b.stakeCents / 100, status: b.status, mult: b.mult, payout: b.payoutCents / 100 });

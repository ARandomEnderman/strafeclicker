// Bracket tournaments: 4 or 8 players, single elimination. The creator sets an entry
// fee and picks the game for every round of the bracket (quarter-finals, semis, final),
// mixing coinflips, high card, rock paper scissors and unbox duels. The champion takes
// every entry fee; there's no house cut. Bots can fill empty seats (a bot's fee is
// house money: if a bot wins, the house keeps the pot).
//
//   coinflip  the first-seeded player is T; the coin decides
//   highcard  each draws a card, higher rank wins (equal ranks draw again)
//   rps       best of 3, both pick at once (RPS_PICK_MS per round, random on timeout)
//   unbox     both open the chosen case (just to decide: nobody keeps the items);
//             the pricier drop wins
//
// Entry fees are debited on joining and kept with the bracket in brackets, so a
// restart refunds every bracket that hadn't finished.

import { randomInt } from "node:crypto";
import { BRACKET_GAMES, BRACKET_GAP_MS, BRACKET_SHOW_MS, BRACKET_SIZES, RPS_PICK_MS, RPS_REVEAL_MS, RPS_WINS } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const VISIBILITIES = ["public", "friends", "private"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HANDS = ["rock", "paper", "scissors"];
const BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = ["s", "h", "d", "c"];
const KEEP_DONE = 10;
const MAX_OPEN_PER_USER = 3;
const BOT_NAMES = ["Bot Alpha", "Bot Bravo", "Bot Charlie", "Bot Delta", "Bot Echo", "Bot Foxtrot", "Bot Golf"];

export class Brackets {
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
    db.exec("CREATE TABLE IF NOT EXISTS brackets (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO brackets (status, data) VALUES (?, ?)"),
      save: db.prepare("UPDATE brackets SET status = ?, data = ? WHERE id = ?"),
      live: db.prepare("SELECT id, data FROM brackets WHERE status IN ('waiting', 'running')"),
      done: db.prepare("SELECT id, data FROM brackets WHERE status = 'done' ORDER BY id DESC LIMIT ?"),
    };
    /** id -> bracket */
    this.brackets = new Map();
    this.timers = new Set();
  }

  start() {
    for (const r of this.q.live.all()) {
      const t = { ...JSON.parse(r.data), id: r.id };
      for (const p of t.players) if (p.userId) this.#credit(p.userId, t.feeCents);
      t.status = "cancelled";
      this.#save(t);
    }
    for (const r of this.q.done.all(KEEP_DONE).reverse()) this.brackets.set(r.id, { ...JSON.parse(r.data), id: r.id });
  }

  stop() {
    this.timers.forEach(clearTimeout);
  }

  #later(fn, ms) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  #save(t) {
    const { id, ...data } = t;
    this.q.save.run(t.status, JSON.stringify(data), id);
  }

  #credit(userId, c) {
    const { account } = this.game.act(userId, (a) => {
      a.balanceCents += c;
      return {};
    });
    this.io.toUser(userId, "account", account);
  }

  #get(id) {
    const t = this.brackets.get(Number(id));
    if (!t) throw new GameError("not_found", "No such bracket", 404);
    return t;
  }

  #seat = (t, userId) => (userId == null ? -1 : t.players.findIndex((p) => p.userId === userId));

  #canSee(t, userId, code) {
    if (this.#seat(t, userId) >= 0) return true;
    if (t.visibility === "public") return true;
    if (t.visibility === "friends") return this.friends.areFriends(userId, t.creatorId);
    return code != null && String(code).toUpperCase() === t.code;
  }

  #newCode() {
    const live = new Set([...this.brackets.values()].map((t) => t.code));
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      if (!live.has(code)) return code;
    }
  }

  // ---------- lobby ----------

  create(userId, body) {
    const size = Number(body.size);
    if (!BRACKET_SIZES.includes(size)) throw new GameError("bad_input", "Pick 4 or 8 players");
    const stageCount = Math.log2(size);
    const stages = Array.isArray(body.stages) ? body.stages.slice(0, stageCount) : [];
    if (stages.length !== stageCount) throw new GameError("bad_input", "Pick a game for every round");
    const clean = stages.map((s) => {
      const game = String(s?.game ?? "");
      if (!Object.hasOwn(BRACKET_GAMES, game)) throw new GameError("bad_input", "Unknown game");
      if (game !== "unbox") return { game };
      const { c } = this.game.caseCost(String(s.caseId ?? ""));
      return { game, caseId: c.id, caseName: c.name };
    });
    const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : "public";
    const open = [...this.brackets.values()].filter((t) => t.status === "waiting" && t.creatorId === userId).length;
    if (open >= MAX_OPEN_PER_USER) throw new GameError("busy", `You can have ${MAX_OPEN_PER_USER} open brackets at a time`);
    let t;
    const out = this.game.act(userId, (a) => {
      const fee = stakeCents(a, body.fee);
      a.balanceCents -= fee;
      t = {
        status: "waiting",
        createdAt: Date.now(),
        creatorId: userId,
        size,
        feeCents: fee,
        stages: clean,
        visibility,
        code: visibility === "private" ? this.#newCode() : null,
        players: [{ userId, user: a.username, name: a.displayName, bot: false }],
        rounds: [],
        champion: null,
      };
      t.id = Number(this.q.add.run("waiting", JSON.stringify(t)).lastInsertRowid);
      return { id: t.id };
    });
    this.brackets.set(t.id, t);
    this.publish();
    return out;
  }

  join(userId, body) {
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    const t = code ? [...this.brackets.values()].find((x) => x.code === code && x.status === "waiting") : this.#get(body.id);
    if (!t) throw new GameError("not_found", "No open bracket with that code", 404);
    if (!this.#canSee(t, userId, code)) throw new GameError("forbidden", t.visibility === "friends" ? "Only the creator's friends can join" : "You need the code to join", 403);
    if (t.status !== "waiting") throw new GameError("closed", "This bracket has already started");
    if (this.#seat(t, userId) >= 0) throw new GameError("busy", "You're already in");
    if (t.players.length >= t.size) throw new GameError("full", "It's full");
    const out = this.game.act(userId, (a) => {
      if (a.balanceCents - (a.lockedCents ?? 0) < t.feeCents) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= t.feeCents;
      t.players.push({ userId, user: a.username, name: a.displayName, bot: false });
      return { id: t.id };
    });
    if (t.players.length >= t.size) this.#begin(t);
    else {
      this.#save(t);
      this.publish();
    }
    return out;
  }

  /** Creator: fill the empty seats with bots and start. */
  bots(userId, body) {
    const t = this.#get(body.id);
    if (t.creatorId !== userId) throw new GameError("forbidden", "Only the creator can add bots", 403);
    if (t.status !== "waiting") throw new GameError("closed", "It has already started");
    let n = 0;
    while (t.players.length < t.size) t.players.push({ userId: null, user: null, name: BOT_NAMES[n++ % BOT_NAMES.length], bot: true });
    this.#begin(t);
    return { id: t.id, account: this.game.view(userId) };
  }

  /** Anyone but the creator can leave before it starts (fee back); the creator cancels it for everyone. */
  leave(userId, body) {
    const t = this.#get(body.id);
    if (t.status !== "waiting") throw new GameError("closed", "It has already started");
    const seat = this.#seat(t, userId);
    if (seat < 0) throw new GameError("not_in", "You're not in this bracket");
    if (t.creatorId === userId) {
      for (const p of t.players) if (p.userId) this.#credit(p.userId, t.feeCents);
      t.status = "cancelled";
      this.brackets.delete(t.id);
    } else {
      t.players.splice(seat, 1);
      this.#credit(userId, t.feeCents);
    }
    this.#save(t);
    this.publish();
    return { account: this.game.view(userId) };
  }

  // ---------- playing ----------

  #begin(t) {
    // Random seeding.
    for (let i = t.players.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [t.players[i], t.players[j]] = [t.players[j], t.players[i]];
    }
    t.status = "running";
    t.startedAt = Date.now();
    const first = [];
    for (let i = 0; i < t.size; i += 2) first.push({ a: i, b: i + 1, status: "pending", winner: null, result: null });
    t.rounds = [first];
    this.#runStage(t);
  }

  #runStage(t) {
    const stage = t.rounds.length - 1;
    const { game } = t.stages[stage];
    for (const m of t.rounds[stage]) {
      m.status = "playing";
      if (game === "rps") this.#rpsRound(t, m);
      else {
        this.#autoResult(t, m, t.stages[stage]);
        m.startAt = Date.now() + 600;
        this.#later(() => {
          m.status = "done";
          this.#maybeAdvance(t);
        }, 600 + BRACKET_SHOW_MS);
      }
    }
    this.#save(t);
    this.publish();
  }

  #autoResult(t, m, stage) {
    if (stage.game === "coinflip") {
      const side = randomInt(2) ? "t" : "ct";
      m.result = { side };
      m.winner = side === "t" ? m.a : m.b;
    } else if (stage.game === "highcard") {
      let ca, cb;
      do {
        ca = { r: RANKS[randomInt(13)], s: SUITS[randomInt(4)] };
        cb = { r: RANKS[randomInt(13)], s: SUITS[randomInt(4)] };
      } while (ca.r === cb.r);
      m.result = { cards: [ca, cb] };
      m.winner = RANKS.indexOf(ca.r) > RANKS.indexOf(cb.r) ? m.a : m.b;
    } else {
      const { c } = this.game.caseCost(stage.caseId);
      const drops = [this.game.rollDrop(c), this.game.rollDrop(c)];
      const values = drops.map((d) => this.game.priceOf(d));
      m.result = { drops: drops.map(({ itemId, phase, wear, stattrak }) => ({ itemId, phase, wear, stattrak })), values };
      m.winner = values[0] > values[1] ? m.a : values[1] > values[0] ? m.b : randomInt(2) ? m.a : m.b;
    }
  }

  #rpsRound(t, m) {
    m.rps ??= { score: [0, 0], rounds: [] };
    m.rps.phase = "picking";
    m.rps.deadline = Date.now() + RPS_PICK_MS;
    const picks = [null, null];
    // Bots pick at once.
    [m.a, m.b].forEach((p, i) => t.players[p].bot && (picks[i] = HANDS[randomInt(3)]));
    m.rps.rounds.push({ picks, winner: null });
    const round = m.rps.rounds.length;
    if (picks[0] && picks[1]) this.#rpsReveal(t, m);
    else this.#later(() => m.rps.rounds.length === round && m.rps.phase === "picking" && this.#rpsReveal(t, m), RPS_PICK_MS);
  }

  pick(userId, body) {
    const t = this.#get(body.id);
    const hand = String(body.hand ?? "");
    if (!HANDS.includes(hand)) throw new GameError("bad_input", "Pick rock, paper or scissors");
    const seat = this.#seat(t, userId);
    const m = t.status === "running" ? t.rounds.at(-1).find((x) => x.status === "playing" && (x.a === seat || x.b === seat)) : null;
    if (!m?.rps || m.rps.phase !== "picking") throw new GameError("closed", "Nothing to pick right now");
    const side = m.a === seat ? 0 : 1;
    const r = m.rps.rounds.at(-1);
    if (r.picks[side]) throw new GameError("done", "You've already picked");
    r.picks[side] = hand;
    if (r.picks[0] && r.picks[1]) this.#rpsReveal(t, m);
    else this.publish();
    return { account: this.game.view(userId) };
  }

  #rpsReveal(t, m) {
    const r = m.rps.rounds.at(-1);
    r.picks = r.picks.map((p) => p ?? HANDS[randomInt(3)]);
    const [x, y] = r.picks;
    r.winner = x === y ? null : BEATS[x] === y ? 0 : 1;
    if (r.winner != null) m.rps.score[r.winner]++;
    m.rps.phase = "reveal";
    m.rps.deadline = Date.now() + RPS_REVEAL_MS;
    const decided = m.rps.score.some((s) => s >= RPS_WINS) || m.rps.rounds.length >= 12;
    this.#save(t);
    this.publish();
    this.#later(() => {
      if (!decided) {
        this.#rpsRound(t, m);
        this.#save(t);
        return this.publish();
      }
      const [a, b] = m.rps.score;
      m.winner = a > b ? m.a : b > a ? m.b : randomInt(2) ? m.a : m.b;
      m.status = "done";
      m.rps.phase = null;
      this.#maybeAdvance(t);
    }, RPS_REVEAL_MS);
  }

  /** When every match of this round is over: the next round, or the champion. */
  #maybeAdvance(t) {
    const current = t.rounds.at(-1);
    if (current.some((m) => m.status !== "done")) {
      this.#save(t);
      return this.publish();
    }
    const winners = current.map((m) => m.winner);
    if (winners.length === 1) return this.#finish(t, winners[0]);
    const next = [];
    for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i], b: winners[i + 1], status: "pending", winner: null, result: null });
    t.rounds.push(next);
    this.#save(t);
    this.publish();
    this.#later(() => this.#runStage(t), BRACKET_GAP_MS);
  }

  #finish(t, champion) {
    t.champion = champion;
    t.status = "done";
    const pot = t.feeCents * t.size;
    t.players.forEach((p, i) => {
      if (!p.userId) return;
      const won = i === champion;
      const { account } = this.game.act(p.userId, (a) => {
        if (won) a.balanceCents += pot;
        this.game.noteGame(a, "bracket", { stakeCents: t.feeCents, payoutCents: won ? pot : 0, add: { won: won ? 1 : 0 } });
        return {};
      });
      this.io.toUser(p.userId, "account", account);
    });
    this.#save(t);
    const done = [...this.brackets.values()].filter((x) => x.status === "done").sort((x, y) => y.id - x.id);
    for (const x of done.slice(KEEP_DONE)) this.brackets.delete(x.id);
    this.publish();
  }

  // ---------- what browsers see ----------

  #view(t, userId) {
    const seat = this.#seat(t, userId);
    return {
      id: t.id,
      status: t.status,
      size: t.size,
      fee: t.feeCents / 100,
      pot: (t.feeCents * t.size) / 100,
      stages: t.stages,
      visibility: t.visibility,
      code: seat >= 0 ? t.code : null,
      mine: t.creatorId === userId,
      seat: seat >= 0 ? seat : null,
      players: t.players.map((p) => ({ user: p.user, name: p.name, bot: p.bot })),
      rounds: t.rounds.map((stage) =>
        stage.map((m) => ({
          a: m.a,
          b: m.b,
          status: m.status,
          // A match's result only once it starts playing on screen; RPS picks only once revealed (your own pick always).
          winner: m.status === "done" ? m.winner : null,
          result: m.status === "pending" ? null : m.result,
          startAt: m.startAt ?? null,
          rps: m.rps
            ? {
                score: m.rps.score,
                phase: m.rps.phase,
                deadline: m.rps.deadline,
                rounds: m.rps.rounds.map((r, i) => {
                  const open = i === m.rps.rounds.length - 1 && m.rps.phase === "picking";
                  const mySide = m.a === seat ? 0 : m.b === seat ? 1 : -1;
                  return open ? { picks: r.picks.map((p, s) => (s === mySide ? p : null)), picked: r.picks.map(Boolean), winner: null } : { picks: r.picks, picked: [true, true], winner: r.winner };
                }),
              }
            : null,
        })),
      ),
      champion: t.champion,
      createdAt: t.createdAt,
    };
  }

  list(userId) {
    return [...this.brackets.values()]
      .filter((t) => this.#canSee(t, userId, null))
      .sort((x, y) => y.id - x.id)
      .map((t) => this.#view(t, userId));
  }

  publish() {
    this.io.broadcastPer("brackets", (userId) => this.list(userId));
  }
}

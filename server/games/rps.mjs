// Rock paper scissors duels for balance, best of three (ties replay). Both players pick
// at the same time within RPS_PICK_MS; the server keeps the picks to itself until both
// are in (or time runs out, which picks at random for whoever hasn't), then shows them
// for RPS_REVEAL_MS before the next round. The winner takes both stakes; no house cut.
//
// The creator can call a bot instead of waiting for a player. Visibility works like
// coinflips: public, friends, or private (joined with a code).
//
// Stakes are debited on create / join and kept with the duel in rps_duels, so a restart
// refunds every duel that hadn't finished.

import { randomInt } from "node:crypto";
import { RPS_PICK_MS, RPS_REVEAL_MS, RPS_WINS } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const HANDS = ["rock", "paper", "scissors"];
const BEATS = { rock: "scissors", paper: "rock", scissors: "paper" };
const VISIBILITIES = ["public", "friends", "private"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_OPEN_PER_USER = 5;
/** After this many rounds (ties included) the leader wins, or a coin decides a dead heat. */
const MAX_ROUNDS = 12;
const KEEP_DONE = 15;
const BOT = { userId: null, user: "Bot", name: "Bot", bot: true };

export class Rps {
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
    db.exec("CREATE TABLE IF NOT EXISTS rps_duels (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO rps_duels (status, data) VALUES (?, ?)"),
      save: db.prepare("UPDATE rps_duels SET status = ?, data = ? WHERE id = ?"),
      live: db.prepare("SELECT id, data FROM rps_duels WHERE status IN ('waiting', 'playing')"),
      done: db.prepare("SELECT id, data FROM rps_duels WHERE status = 'done' ORDER BY id DESC LIMIT ?"),
    };
    /** id -> duel (open, playing and recently finished) */
    this.duels = new Map();
  }

  start() {
    for (const r of this.q.live.all()) {
      const d = { ...JSON.parse(r.data), id: r.id };
      for (const p of [d.creator, d.joiner]) if (p?.userId) this.#credit(p.userId, d.stakeCents);
      d.status = "cancelled";
      this.#save(d);
    }
    for (const r of this.q.done.all(KEEP_DONE).reverse()) this.duels.set(r.id, { ...JSON.parse(r.data), id: r.id });
  }

  stop() {
    for (const d of this.duels.values()) clearTimeout(d.timer);
  }

  #save(d) {
    const { id, timer, ...data } = d;
    this.q.save.run(d.status, JSON.stringify(data), id);
  }

  #credit(userId, c) {
    const { account } = this.game.act(userId, (a) => {
      a.balanceCents += c;
      return {};
    });
    this.io.toUser(userId, "account", account);
  }

  #get(id) {
    const d = this.duels.get(Number(id));
    if (!d) throw new GameError("not_found", "No such duel", 404);
    return d;
  }

  #inIt = (d, userId) => userId != null && (d.creator.userId === userId || d.joiner?.userId === userId);

  #canSee(d, userId, code) {
    if (this.#inIt(d, userId)) return true;
    if (d.visibility === "public") return true;
    if (d.visibility === "friends") return this.friends.areFriends(userId, d.creator.userId);
    return code != null && String(code).toUpperCase() === d.code;
  }

  #newCode() {
    const live = new Set([...this.duels.values()].map((d) => d.code));
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      if (!live.has(code)) return code;
    }
  }

  create(userId, body) {
    const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : "public";
    const open = [...this.duels.values()].filter((d) => d.status === "waiting" && d.creator.userId === userId).length;
    if (open >= MAX_OPEN_PER_USER) throw new GameError("busy", `You can have ${MAX_OPEN_PER_USER} open duels at a time`);
    let duel;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      duel = {
        status: "waiting",
        createdAt: Date.now(),
        stakeCents: stake,
        visibility,
        code: visibility === "private" ? this.#newCode() : null,
        creator: { userId, user: a.username, name: a.displayName, bot: false },
        joiner: null,
        rounds: [],
        score: [0, 0],
        winner: null,
      };
      const { lastInsertRowid } = this.q.add.run("waiting", JSON.stringify(duel));
      duel.id = Number(lastInsertRowid);
      return { id: duel.id };
    });
    this.duels.set(duel.id, duel);
    this.publish();
    return out;
  }

  /** By id (public / friends duels) or by code (any). */
  join(userId, body) {
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    const d = code ? [...this.duels.values()].find((x) => x.code === code && x.status === "waiting") : this.#get(body.id);
    if (!d) throw new GameError("not_found", "No open duel with that code", 404);
    if (!this.#canSee(d, userId, code)) throw new GameError("forbidden", d.visibility === "friends" ? `Only ${d.creator.name}'s friends can join` : "You need the code to join", 403);
    if (d.status !== "waiting") throw new GameError("closed", "Someone already joined");
    if (d.creator.userId === userId) throw new GameError("busy", "That's your own duel. Call a bot to play it.");
    const out = this.game.act(userId, (a) => {
      if (a.balanceCents - (a.lockedCents ?? 0) < d.stakeCents) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= d.stakeCents;
      d.joiner = { userId, user: a.username, name: a.displayName, bot: false };
      return { id: d.id };
    });
    this.#begin(d);
    return out;
  }

  bot(userId, body) {
    const d = this.#get(body.id);
    if (d.creator.userId !== userId) throw new GameError("forbidden", "Only the creator can call a bot", 403);
    if (d.status !== "waiting") throw new GameError("closed", "Someone already joined");
    d.joiner = { ...BOT };
    this.#begin(d);
    return { id: d.id, account: this.game.view(userId) };
  }

  cancel(userId, body) {
    const d = this.#get(body.id);
    if (d.creator.userId !== userId) throw new GameError("forbidden", "Only the creator can cancel", 403);
    if (d.status !== "waiting") throw new GameError("closed", "Someone already joined");
    d.status = "cancelled";
    this.#save(d);
    this.duels.delete(d.id);
    this.#credit(userId, d.stakeCents);
    this.publish();
    return { account: this.game.view(userId) };
  }

  /** A player's pick for the current round. */
  pick(userId, body) {
    const d = this.#get(body.id);
    const hand = String(body.hand ?? "");
    if (!HANDS.includes(hand)) throw new GameError("bad_input", "Pick rock, paper or scissors");
    if (d.status !== "playing" || d.phase !== "picking") throw new GameError("closed", "Not picking right now");
    const seat = d.creator.userId === userId ? 0 : d.joiner?.userId === userId ? 1 : -1;
    if (seat < 0) throw new GameError("forbidden", "You're not in this duel", 403);
    const round = d.rounds.at(-1);
    if (round.picks[seat]) throw new GameError("done", "You've already picked");
    round.picks[seat] = hand;
    if (d.joiner.bot && !round.picks[1]) round.picks[1] = this.#botHand(hand);
    if (round.picks[0] && round.picks[1]) {
      clearTimeout(d.timer);
      this.#reveal(d);
    } else this.publish();
    return { account: this.game.view(userId) };
  }

  /** The bot picks at random; the rig makes it pick the hand that beats yours that often. */
  #botHand(yours) {
    if (Math.random() < this.game.rig("rpsBot")) return Object.keys(BEATS).find((h) => BEATS[h] === yours);
    return HANDS[randomInt(3)];
  }

  #begin(d) {
    d.status = "playing";
    d.startedAt = Date.now();
    this.#nextRound(d);
  }

  #nextRound(d) {
    d.phase = "picking";
    d.deadline = Date.now() + RPS_PICK_MS;
    d.rounds.push({ picks: [null, null], winner: null });
    this.#save(d);
    d.timer = setTimeout(() => this.#reveal(d), RPS_PICK_MS);
    this.publish();
  }

  #reveal(d) {
    const round = d.rounds.at(-1);
    // Whoever ran out of time gets a random hand (a bot's is drawn as if against yours).
    if (!round.picks[0]) round.picks[0] = HANDS[randomInt(3)];
    if (!round.picks[1]) round.picks[1] = d.joiner.bot ? this.#botHand(round.picks[0]) : HANDS[randomInt(3)];
    const [x, y] = round.picks;
    round.winner = x === y ? null : BEATS[x] === y ? 0 : 1;
    if (round.winner != null) d.score[round.winner]++;
    d.phase = "reveal";
    d.deadline = Date.now() + RPS_REVEAL_MS;
    const decided = d.score.some((s) => s >= RPS_WINS) || d.rounds.length >= MAX_ROUNDS;
    this.#save(d);
    this.publish();
    d.timer = setTimeout(() => (decided ? this.#finish(d) : this.#nextRound(d)), RPS_REVEAL_MS);
  }

  #finish(d) {
    const [a, b] = d.score;
    d.winner = a > b ? 0 : b > a ? 1 : randomInt(2);
    d.status = "done";
    d.phase = null;
    d.deadline = null;
    const pot = d.stakeCents * 2;
    [d.creator, d.joiner].forEach((p, i) => {
      if (!p.userId) return;
      const won = d.winner === i;
      const { account } = this.game.act(p.userId, (acc) => {
        if (won) acc.balanceCents += pot;
        this.game.noteGame(acc, "rps", { stakeCents: d.stakeCents, payoutCents: won ? pot : 0, add: { won: won ? 1 : 0 } });
        return {};
      });
      this.io.toUser(p.userId, "account", account);
    });
    this.#save(d);
    const done = [...this.duels.values()].filter((x) => x.status === "done").sort((x, y) => y.id - x.id);
    for (const x of done.slice(KEEP_DONE)) this.duels.delete(x.id);
    this.publish();
  }

  #view(d, userId) {
    const seat = d.creator.userId === userId ? 0 : d.joiner?.userId === userId ? 1 : null;
    const rounds = d.rounds.map((r, i) => {
      const open = i === d.rounds.length - 1 && d.phase === "picking";
      // While a round is open only your own pick is shown; the other side just says whether they've picked.
      return open ? { picks: r.picks.map((p, s) => (s === seat ? p : null)), picked: r.picks.map(Boolean), winner: null } : { picks: r.picks, picked: [true, true], winner: r.winner };
    });
    const who = (p) => (p ? { user: p.user, name: p.name, bot: p.bot } : null);
    return {
      id: d.id,
      status: d.status,
      phase: d.phase ?? null,
      deadline: d.deadline ?? null,
      visibility: d.visibility,
      code: seat != null ? d.code : null,
      stake: d.stakeCents / 100,
      creator: who(d.creator),
      joiner: who(d.joiner),
      seat,
      rounds,
      score: d.score,
      winner: d.winner,
      createdAt: d.createdAt,
    };
  }

  list(userId) {
    return [...this.duels.values()]
      .filter((d) => this.#canSee(d, userId, null))
      .sort((x, y) => y.id - x.id)
      .map((d) => this.#view(d, userId));
  }

  publish() {
    this.io.broadcastPer("rps", (userId) => this.list(userId));
  }
}

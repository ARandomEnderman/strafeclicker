// Texas Hold'em sit-and-go tables, with lobbies like case battles.
//
// The creator picks the entry fee and the table size (2-6). Everyone who sits down pays the
// fee and gets HOLDEM_CHIPS chips; the creator can fill the empty seats with bots or start
// early with whoever is there. Blinds go up every HOLDEM_HANDS_PER_LEVEL hands. A player
// who runs out of chips is out; the last one with chips wins every entry fee (the house
// pays the bots' share, and keeps the pot if a bot wins). No rake.
//
// Each player has HOLDEM_TURN_MS to act; time out and you check if you can, else fold.
// Two timeouts in a row and you're "away": from then on you get AWAY_MS to act before
// it's done for you, until you act yourself again or press "I'm back". Leaving a game that's running forfeits it.
//
// Fees are debited on create / join and kept with the game in holdem_games, so a restart
// refunds every game that hadn't finished. Hole cards and the deck never leave the server
// until a showdown.

import { randomInt } from "node:crypto";
import {
  HOLDEM_BLINDS,
  HOLDEM_CHIPS,
  HOLDEM_HANDS_PER_LEVEL,
  HOLDEM_RESULT_MS,
  HOLDEM_SIZES,
  HOLDEM_STREET_MS,
  HOLDEM_TURN_MS,
  POKER_RANKS,
  POKER_SUITS,
  bestHand,
  compareScores,
} from "../../shared/game.js";
import { GameError, spendable } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const VISIBILITIES = ["public", "friends", "private"];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_OPEN_PER_USER = 3;
const KEEP_DONE = 10;
const AWAY_AFTER = 2;
const AWAY_MS = 6000;
const BOT_NAMES = ["Bot Ace", "Bot King", "Bot Queen", "Bot Jack", "Bot Ten"];

const rankOf = (c) => POKER_RANKS.indexOf(c.r) + 2;

function newDeck() {
  const d = [];
  for (const s of POKER_SUITS) for (const r of POKER_RANKS) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

export class Holdem {
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
    db.exec("CREATE TABLE IF NOT EXISTS holdem_games (id INTEGER PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO holdem_games (status, data) VALUES (?, ?)"),
      save: db.prepare("UPDATE holdem_games SET status = ?, data = ? WHERE id = ?"),
      live: db.prepare("SELECT id, data FROM holdem_games WHERE status IN ('waiting', 'playing')"),
      done: db.prepare("SELECT id, data FROM holdem_games WHERE status = 'done' ORDER BY id DESC LIMIT ?"),
    };
    /** id -> game (open, playing and recently finished) */
    this.games = new Map();
  }

  /** A restart refunds every game that hadn't finished. */
  start() {
    for (const r of this.q.live.all()) {
      const g = { ...JSON.parse(r.data), id: r.id };
      for (const p of g.players) if (p.userId) this.#credit(p.userId, g.feeCents);
      g.status = "cancelled";
      this.#save(g);
    }
    for (const r of this.q.done.all(KEEP_DONE).reverse()) this.games.set(r.id, { ...JSON.parse(r.data), id: r.id });
  }

  stop() {
    for (const g of this.games.values()) clearTimeout(g.timer);
  }

  // Only what a restart needs: who paid and how it ended (a running hand is refunded anyway).
  #save(g) {
    const { id, timer, hand, ...data } = g;
    this.q.save.run(g.status, JSON.stringify(data), id);
  }

  #credit(userId, c) {
    const { account } = this.game.act(userId, (a) => {
      a.balanceCents += c;
      return {};
    });
    this.io.toUser(userId, "account", account);
  }

  #get(id) {
    const g = this.games.get(Number(id));
    if (!g) throw new GameError("not_found", "No such game", 404);
    return g;
  }

  #seatOf = (g, userId) => (userId == null ? -1 : g.players.findIndex((p) => p.userId === userId));

  #canSee(g, userId, code) {
    if (this.#seatOf(g, userId) >= 0) return true;
    if (g.visibility === "public") return true;
    if (g.visibility === "friends") return this.friends.areFriends(userId, g.creatorId);
    return code != null && String(code).toUpperCase() === g.code;
  }

  #newCode() {
    const live = new Set([...this.games.values()].map((g) => g.code));
    for (;;) {
      const code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
      if (!live.has(code)) return code;
    }
  }

  #player(a) {
    return { userId: a.id, user: a.username, name: a.displayName, bot: false, chips: HOLDEM_CHIPS, out: false, place: null, away: 0 };
  }

  // ---------- lobby ----------

  create(userId, body) {
    const size = Number(body.size);
    if (!HOLDEM_SIZES.includes(size)) throw new GameError("bad_input", `Pick a table for ${HOLDEM_SIZES[0]} to ${HOLDEM_SIZES.at(-1)} players`);
    const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : "public";
    const open = [...this.games.values()].filter((g) => g.status === "waiting" && g.creatorId === userId).length;
    if (open >= MAX_OPEN_PER_USER) throw new GameError("busy", `You can have ${MAX_OPEN_PER_USER} open tables at a time`);
    let g;
    const out = this.game.act(userId, (a) => {
      const fee = stakeCents(a, body.bet);
      a.balanceCents -= fee;
      g = {
        status: "waiting",
        createdAt: Date.now(),
        feeCents: fee,
        size,
        visibility,
        code: visibility === "private" ? this.#newCode() : null,
        creatorId: userId,
        players: [this.#player(a)],
        handNo: 0,
        button: -1,
        winner: null,
        log: [],
      };
      const { lastInsertRowid } = this.q.add.run("waiting", JSON.stringify(g));
      g.id = Number(lastInsertRowid);
      return { id: g.id };
    });
    this.games.set(g.id, g);
    this.publish();
    return out;
  }

  /** By id (public / friends tables) or by code (any). */
  join(userId, body) {
    const code = body.code ? String(body.code).trim().toUpperCase() : null;
    const g = code ? [...this.games.values()].find((x) => x.code === code && x.status === "waiting") : this.#get(body.id);
    if (!g) throw new GameError("not_found", "No open table with that code", 404);
    if (!this.#canSee(g, userId, code)) throw new GameError("forbidden", g.visibility === "friends" ? "Only the creator's friends can join" : "You need the code to join", 403);
    if (g.status !== "waiting") throw new GameError("closed", "That game has already started");
    if (this.#seatOf(g, userId) >= 0) throw new GameError("busy", "You're already at this table");
    if (g.players.length >= g.size) throw new GameError("closed", "That table is full");
    const out = this.game.act(userId, (a) => {
      if (spendable(a) < g.feeCents) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= g.feeCents;
      g.players.push(this.#player(a));
      return { id: g.id };
    });
    this.#save(g);
    if (g.players.length >= g.size) this.#begin(g);
    else this.publish();
    return out;
  }

  /** The creator fills the empty seats with bots, and the game starts. */
  bots(userId, body) {
    const g = this.#get(body.id);
    if (g.creatorId !== userId) throw new GameError("forbidden", "Only the creator can add bots", 403);
    if (g.status !== "waiting") throw new GameError("closed", "The game has already started");
    let n = 0;
    while (g.players.length < g.size) g.players.push({ userId: null, user: BOT_NAMES[n], name: BOT_NAMES[n++], bot: true, chips: HOLDEM_CHIPS, out: false, place: null, away: 0 });
    this.#begin(g);
    return { id: g.id, account: this.game.view(userId) };
  }

  /** The creator starts with whoever has sat down (at least two). */
  startNow(userId, body) {
    const g = this.#get(body.id);
    if (g.creatorId !== userId) throw new GameError("forbidden", "Only the creator can start the game", 403);
    if (g.status !== "waiting") throw new GameError("closed", "The game has already started");
    if (g.players.length < 2) throw new GameError("bad_input", "You need at least one more player, or add bots");
    g.size = g.players.length;
    this.#begin(g);
    return { id: g.id, account: this.game.view(userId) };
  }

  /**
   * Before the start: the creator cancels (everyone is refunded) or a player gets up
   * (refunded). During the game: forfeit (your chips leave the table).
   */
  leave(userId, body) {
    const g = this.#get(body.id);
    const seat = this.#seatOf(g, userId);
    if (seat < 0) throw new GameError("forbidden", "You're not at this table", 403);
    if (g.status === "waiting") {
      if (g.creatorId === userId) {
        for (const p of g.players) if (p.userId) this.#credit(p.userId, g.feeCents);
        g.status = "cancelled";
        this.#save(g);
        this.games.delete(g.id);
      } else {
        g.players.splice(seat, 1);
        this.#credit(userId, g.feeCents);
        this.#save(g);
      }
      this.publish();
      return { account: this.game.view(userId) };
    }
    if (g.status !== "playing") throw new GameError("closed", "This game is over");
    const p = g.players[seat];
    if (p.out) throw new GameError("closed", "You're already out");
    this.#log(g, `${p.name} left the table`);
    const h = g.hand;
    const s = h?.seats[seat];
    if (s && !s.folded) {
      s.folded = true;
      s.last = "Left";
    }
    p.chips = 0;
    this.#bust(g, [seat]);
    if (h && h.phase === "betting") {
      if (h.toAct === seat) {
        clearTimeout(g.timer);
        h.toAct = this.#nextActor(h, seat);
      }
      this.#prompt(g);
    } else this.publish();
    return { account: this.game.view(userId) };
  }

  // ---------- the game ----------

  #begin(g) {
    g.status = "playing";
    g.startedAt = Date.now();
    g.button = randomInt(g.players.length);
    this.#log(g, `Game on: ${g.players.length} players, ${HOLDEM_CHIPS.toLocaleString("en-US")} chips each`);
    this.#save(g);
    this.#newHand(g);
  }

  #log(g, text) {
    g.log.push(text);
    if (g.log.length > 30) g.log.shift();
  }

  #live = (g) => g.players.map((p, i) => i).filter((i) => !g.players[i].out && g.players[i].chips > 0);

  /** The next seat after `from` (clockwise) that's still in the game. */
  #nextLive(g, from) {
    const n = g.players.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (!g.players[i].out && g.players[i].chips > 0) return i;
    }
    return -1;
  }

  #newHand(g) {
    const live = this.#live(g);
    // Only bots left: the one with the most chips wins without playing it out.
    if (live.length > 1 && !live.some((i) => g.players[i].userId)) {
      const lead = live.reduce((a, b) => (g.players[b].chips > g.players[a].chips ? b : a));
      for (const i of live) if (i !== lead) g.players[i].chips = 0;
      this.#bust(
        g,
        live.filter((i) => i !== lead),
      );
      return this.#finish(g);
    }
    if (live.length <= 1) return this.#finish(g);
    const level = Math.min(HOLDEM_BLINDS.length - 1, Math.floor(g.handNo / HOLDEM_HANDS_PER_LEVEL));
    const [sb, bb] = HOLDEM_BLINDS[level];
    if (g.handNo > 0 && g.handNo % HOLDEM_HANDS_PER_LEVEL === 0 && level < HOLDEM_BLINDS.length) this.#log(g, `Blinds up: ${sb}/${bb}`);
    g.handNo++;
    g.button = this.#nextLive(g, g.button);
    const headsUp = live.length === 2;
    const sbSeat = headsUp ? g.button : this.#nextLive(g, g.button);
    const bbSeat = this.#nextLive(g, sbSeat);
    const deck = newDeck();
    const h = {
      no: g.handNo,
      level,
      sb,
      bb,
      deck,
      board: [],
      street: "preflop",
      phase: "betting",
      currentBet: 0,
      minRaise: bb,
      toAct: -1,
      deadline: null,
      results: null,
      sbSeat,
      bbSeat,
      seats: g.players.map((p, i) => ({ inHand: live.includes(i), cards: [], bet: 0, total: 0, folded: !live.includes(i), allIn: false, acted: false, last: null })),
    };
    g.hand = h;
    for (const i of live) h.seats[i].cards = [deck.pop(), deck.pop()];
    this.#put(g, sbSeat, sb);
    h.seats[sbSeat].last = `Small blind ${Math.min(sb, h.seats[sbSeat].bet)}`;
    this.#put(g, bbSeat, bb);
    h.seats[bbSeat].last = `Big blind ${h.seats[bbSeat].bet}`;
    h.currentBet = Math.max(h.seats[sbSeat].bet, h.seats[bbSeat].bet, bb);
    h.toAct = this.#nextActor(h, bbSeat);
    this.#prompt(g);
  }

  /** Move up to `amount` chips from a player into the pot. */
  #put(g, seat, amount) {
    const p = g.players[seat];
    const s = g.hand.seats[seat];
    const x = Math.max(0, Math.min(amount, p.chips));
    p.chips -= x;
    s.bet += x;
    s.total += x;
    if (p.chips === 0) s.allIn = true;
    return x;
  }

  #canAct = (h, i) => h.seats[i].inHand && !h.seats[i].folded && !h.seats[i].allIn;

  /** Next seat after `from` that still has to act this street, or -1. */
  #nextActor(h, from) {
    const n = h.seats.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + k) % n;
      if (this.#canAct(h, i) && (!h.seats[i].acted || h.seats[i].bet < h.currentBet)) return i;
    }
    return -1;
  }

  #contenders = (h) => h.seats.map((s, i) => i).filter((i) => h.seats[i].inHand && !h.seats[i].folded);

  /** Ask the next player to act, or move the hand on when nobody has to. */
  #prompt(g) {
    const h = g.hand;
    clearTimeout(g.timer);
    const left = this.#contenders(h);
    if (left.length <= 1) return this.#award(g);
    const actors = h.seats.map((s, i) => i).filter((i) => this.#canAct(h, i));
    const done = h.toAct < 0 || actors.length === 0 || (actors.length === 1 && h.seats[actors[0]].bet >= h.currentBet);
    if (done) return this.#nextStreet(g);
    const p = g.players[h.toAct];
    const away = !p.bot && p.away >= AWAY_AFTER;
    h.deadline = Date.now() + (away ? AWAY_MS : HOLDEM_TURN_MS);
    const seat = h.toAct;
    const no = h.no;
    const street = h.street;
    const still = () => g.hand === h && h.no === no && h.street === street && h.toAct === seat && h.phase === "betting";
    if (p.bot) g.timer = setTimeout(() => still() && this.#safeMove(g, seat, this.#botMove(g, seat)), 900 + randomInt(1600));
    else if (away) g.timer = setTimeout(() => still() && this.#safeMove(g, seat, { move: "auto" }), AWAY_MS);
    else
      g.timer = setTimeout(() => {
        if (!still()) return;
        p.away++;
        this.#safeMove(g, seat, { move: "auto" });
      }, HOLDEM_TURN_MS);
    this.publish();
  }

  /** Back from being away: your turns get the full time again (the current one too). */
  back(userId, body) {
    const g = this.#get(body.id);
    const seat = this.#seatOf(g, userId);
    if (seat < 0) throw new GameError("forbidden", "You're not at this table", 403);
    g.players[seat].away = 0;
    const h = g.hand;
    if (g.status === "playing" && h?.phase === "betting" && h.toAct === seat) this.#prompt(g);
    else this.publish();
    return { account: this.game.view(userId) };
  }

  act(userId, body) {
    const g = this.#get(body.id);
    const seat = this.#seatOf(g, userId);
    if (seat < 0) throw new GameError("forbidden", "You're not at this table", 403);
    const h = g.hand;
    if (g.status !== "playing" || !h || h.phase !== "betting" || h.toAct !== seat) throw new GameError("not_your_turn", "It's not your turn");
    g.players[seat].away = 0;
    this.#move(g, seat, { move: String(body.move ?? ""), amount: Number(body.amount) });
    return { account: this.game.view(userId) };
  }

  /** A move made by a timer (a bot, or time running out): if it's not allowed, check or fold instead. */
  #safeMove(g, seat, m) {
    try {
      this.#move(g, seat, m);
    } catch (err) {
      if (!(err instanceof GameError) || m.move === "auto") throw err;
      this.#move(g, seat, { move: "auto" });
    }
  }

  /** One player's action: fold, check, call, raise (to `amount`, this street's total) or auto. */
  #move(g, seat, { move, amount }) {
    const h = g.hand;
    const p = g.players[seat];
    const s = h.seats[seat];
    const toCall = h.currentBet - s.bet;
    if (move === "auto") move = toCall > 0 ? "fold" : "check";
    // Not enough chips to raise over the current bet: that's a call (all-in).
    if (move === "raise" && s.bet + p.chips <= h.currentBet) move = "call";
    if (move === "fold") {
      s.folded = true;
      s.last = "Fold";
    } else if (move === "check") {
      if (toCall > 0) throw new GameError("bad_input", `You have to call ${toCall} or fold`);
      s.last = "Check";
    } else if (move === "call") {
      if (toCall <= 0) throw new GameError("bad_input", "Nothing to call, check instead");
      const x = this.#put(g, seat, toCall);
      s.last = s.allIn ? `All-in ${s.bet}` : `Call ${x}`;
    } else if (move === "raise") {
      const max = s.bet + p.chips;
      let to = Math.floor(amount);
      if (!(to > h.currentBet)) throw new GameError("bad_input", "Raise to more than the current bet");
      if (to >= max) to = max;
      else if (to < h.currentBet + h.minRaise) throw new GameError("bad_input", `Raise to at least ${h.currentBet + h.minRaise}`);
      const raiseBy = to - h.currentBet;
      this.#put(g, seat, to - s.bet);
      if (raiseBy >= h.minRaise) h.minRaise = raiseBy;
      h.currentBet = Math.max(h.currentBet, s.bet);
      s.last = s.allIn ? `All-in ${s.bet}` : `${toCall > 0 || h.street === "preflop" ? "Raise" : "Bet"} to ${s.bet}`;
      // Everyone else gets to answer the raise.
      for (const [i, x] of h.seats.entries()) if (i !== seat) x.acted = false;
    } else throw new GameError("bad_input", "Fold, check, call or raise");
    s.acted = true;
    h.toAct = this.#nextActor(h, seat);
    this.#prompt(g);
  }

  #nextStreet(g) {
    const h = g.hand;
    clearTimeout(g.timer);
    for (const s of h.seats) {
      s.bet = 0;
      s.acted = false;
    }
    h.currentBet = 0;
    h.minRaise = h.bb;
    h.toAct = -1;
    h.deadline = null;
    if (h.street === "river") return this.#showdown(g);
    const next = { preflop: "flop", flop: "turn", turn: "river" }[h.street];
    // A short pause, then the cards, then betting (or straight on when nobody can bet).
    h.phase = "dealing";
    this.publish();
    g.timer = setTimeout(() => {
      h.street = next;
      h.board.push(...h.deck.splice(-(next === "flop" ? 3 : 1)));
      for (const [i, s] of h.seats.entries()) if (this.#canAct(h, i)) s.last = null;
      h.phase = "betting";
      const actors = h.seats.map((s, i) => i).filter((i) => this.#canAct(h, i));
      if (actors.length < 2) {
        this.publish();
        g.timer = setTimeout(() => this.#nextStreet(g), HOLDEM_STREET_MS * 1.5);
        return;
      }
      h.toAct = this.#nextActor(h, g.button);
      this.#prompt(g);
    }, HOLDEM_STREET_MS);
  }

  /** Everyone else folded: the last player takes the pot without showing. */
  #award(g) {
    const h = g.hand;
    const [w] = this.#contenders(h);
    const pot = h.seats.reduce((x, s) => x + s.total, 0);
    g.players[w].chips += pot;
    h.results = { pots: [{ amount: pot, winners: [w], hand: null }], shown: [] };
    this.#log(g, `${g.players[w].name} takes ${pot.toLocaleString("en-US")}`);
    this.#endHand(g);
  }

  #showdown(g) {
    const h = g.hand;
    const contenders = this.#contenders(h);
    const scores = Object.fromEntries(contenders.map((i) => [i, bestHand([...h.seats[i].cards, ...h.board])]));
    // Side pots: one per all-in level, each won by the best hand among those who paid into it.
    const levels = [...new Set(h.seats.map((s) => s.total).filter((t) => t > 0))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lv of levels) {
      const amount = h.seats.reduce((x, s) => x + Math.max(0, Math.min(s.total, lv) - prev), 0);
      const eligible = contenders.filter((i) => h.seats[i].total >= lv);
      const last = pots.at(-1);
      if (last && last.eligible.join() === eligible.join()) last.amount += amount;
      else if (eligible.length) pots.push({ amount, eligible });
      else if (last) last.amount += amount;
      prev = lv;
    }
    const results = [];
    for (const pot of pots) {
      let best = null;
      let winners = [];
      for (const i of pot.eligible) {
        const c = best ? compareScores(scores[i].score, best) : 1;
        if (c > 0) ((best = scores[i].score), (winners = [i]));
        else if (c === 0) winners.push(i);
      }
      // Ties split; odd chips go to the first winner left of the button.
      const share = Math.floor(pot.amount / winners.length);
      let odd = pot.amount - share * winners.length;
      const order = [...winners].sort((a, b) => ((a - g.button + h.seats.length) % h.seats.length) - ((b - g.button + h.seats.length) % h.seats.length));
      for (const i of order) g.players[i].chips += share + (odd-- > 0 ? 1 : 0);
      results.push({ amount: pot.amount, winners, hand: scores[winners[0]].name });
      this.#log(g, `${winners.map((i) => g.players[i].name).join(" and ")} ${winners.length > 1 ? "split" : "wins"} ${pot.amount.toLocaleString("en-US")} with ${scores[winners[0]].name}`);
    }
    h.results = { pots: results, shown: contenders, hands: Object.fromEntries(contenders.map((i) => [i, scores[i].name])) };
    this.#endHand(g);
  }

  #endHand(g) {
    const h = g.hand;
    clearTimeout(g.timer);
    h.phase = "result";
    h.toAct = -1;
    h.deadline = Date.now() + HOLDEM_RESULT_MS;
    // Who's out of chips now: whoever started the hand with less places lower.
    const busted = g.players.map((p, i) => i).filter((i) => h.seats[i].inHand && g.players[i].chips === 0 && !g.players[i].out);
    this.#bust(g, busted);
    this.publish();
    g.timer = setTimeout(() => this.#newHand(g), HOLDEM_RESULT_MS);
  }

  /** Mark players out, placing them after everyone still in. */
  #bust(g, seats) {
    if (!seats.length) return;
    const stillIn = g.players.filter((p, i) => !p.out && !seats.includes(i)).length;
    const h = g.hand;
    const order = [...seats].sort((a, b) => (h?.seats[b].total ?? 0) - (h?.seats[a].total ?? 0));
    order.forEach((i, k) => {
      const p = g.players[i];
      p.out = true;
      p.place = stillIn + 1 + k;
      this.#log(g, `${p.name} is out in place ${p.place}`);
    });
  }

  #finish(g) {
    clearTimeout(g.timer);
    const [w] = this.#live(g);
    const winner = g.players[w] ?? g.players.find((p) => !p.out) ?? null;
    if (winner) winner.place = 1;
    g.winner = winner ? g.players.indexOf(winner) : null;
    g.status = "done";
    g.endedAt = Date.now();
    const pot = g.feeCents * g.players.length;
    for (const p of g.players) {
      if (!p.userId) continue;
      const won = p === winner;
      const { account } = this.game.act(p.userId, (a) => {
        if (won) a.balanceCents += pot;
        this.game.noteGame(a, "holdem", { stakeCents: g.feeCents, payoutCents: won ? pot : 0, add: { won: won ? 1 : 0 } });
        return {};
      });
      this.io.toUser(p.userId, "account", account);
    }
    if (winner) this.#log(g, `${winner.name} wins the game${winner.userId ? ` and ${(pot / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}` : ""}`);
    this.#save(g);
    const done = [...this.games.values()].filter((x) => x.status === "done").sort((x, y) => y.id - x.id);
    for (const x of done.slice(KEEP_DONE)) this.games.delete(x.id);
    this.publish();
  }

  // ---------- bots ----------

  /** How good a bot's hand looks, 0-1. */
  #strength(h, seat) {
    const hole = h.seats[seat].cards;
    if (!h.board.length) {
      const [a, b] = hole.map(rankOf).sort((x, y) => y - x);
      if (a === b) return 0.5 + a / 28;
      return ((a + b) / 28) * 0.75 + (hole[0].s === hole[1].s ? 0.06 : 0) + (a - b <= 2 ? 0.04 : 0);
    }
    const mine = bestHand([...hole, ...h.board]);
    const board = h.board.length >= 5 ? bestHand(h.board) : null;
    const cat = mine.score[0];
    // Only what the board shows on its own: barely worth anything.
    if (board && compareScores(board.score, mine.score) === 0) return 0.25;
    let s = [0.15, 0.42, 0.65, 0.75, 0.82, 0.86, 0.93, 0.97, 0.99][cat];
    if (cat === 1) {
      const pair = mine.score[1];
      const top = Math.max(...h.board.map(rankOf));
      if (!hole.some((c) => rankOf(c) === pair)) s = 0.25;
      else if (pair >= top) s += 0.12;
    }
    return s;
  }

  /**
   * A bot's decision. Its hand strength becomes a rough chance of winning (lower with
   * more opponents still in), which it weighs against the price of calling: call when
   * the pot pays enough, raise strong hands, now and then bet with nothing.
   */
  #botMove(g, seat) {
    const h = g.hand;
    const p = g.players[seat];
    const s = h.seats[seat];
    const toCall = Math.min(h.currentBet - s.bet, p.chips);
    const pot = h.seats.reduce((x, y) => x + y.total, 0);
    const str = Math.min(1, Math.max(0, this.#strength(h, seat) + (Math.random() - 0.5) * 0.12));
    const opponents = this.#contenders(h).length - 1;
    // Strength 0.2 (7-2 offsuit) is about a 1-in-3 shot heads-up; 1 (aces) about 85%.
    const headsUp = Math.min(0.88, Math.max(0.2, 0.3 + (str - 0.2) * 0.72));
    const equity = headsUp ** Math.max(1, opponents * 0.85);
    const needs = toCall / (pot + toCall || 1);
    // Raises in whole small blinds, like a person would.
    const raiseTo = (frac) => ({ move: "raise", amount: Math.max(h.currentBet + h.minRaise, Math.round((h.currentBet + Math.max(h.bb, pot * frac)) / h.sb) * h.sb) });
    const canRaise = p.chips > toCall && s.bet + p.chips > h.currentBet;
    const roll = Math.random();
    if (toCall === 0) {
      if (canRaise && equity > 0.6 && roll < 0.65) return raiseTo(0.6);
      if (canRaise && roll < 0.1) return raiseTo(0.5); // a bluff
      return { move: "check" };
    }
    if (canRaise && equity > 0.66 && roll < 0.5) return raiseTo(0.8);
    // Cheap to see more (a small raise, or the big blind defending): wider.
    const slack = toCall <= h.bb * 2 ? 0.08 : 0;
    if (equity + slack >= needs) return { move: "call" };
    if (roll < 0.04) return { move: "call" }; // the odd hero call
    return { move: "fold" };
  }

  // ---------- what browsers see ----------

  #view(g, userId) {
    const me = this.#seatOf(g, userId);
    const h = g.hand;
    const showdown = h?.phase === "result" && h.results?.shown.length;
    const players = g.players.map((p, i) => {
      const s = h?.seats[i];
      const visible = s?.cards.length && (i === me || (showdown && h.results.shown.includes(i)));
      return {
        user: p.user,
        name: p.name,
        bot: p.bot,
        chips: p.chips,
        out: p.out,
        place: p.place,
        away: p.away >= AWAY_AFTER,
        bet: s?.bet ?? 0,
        inHand: !!s?.inHand,
        folded: !!s?.folded,
        allIn: !!s?.allIn,
        last: s?.last ?? null,
        cards: visible ? s.cards : s?.inHand ? null : [],
        hand: showdown && h.results.hands?.[i] ? h.results.hands[i] : null,
      };
    });
    const mySeat = me >= 0 ? h?.seats[me] : null;
    const myTurn = !!h && h.phase === "betting" && h.toAct === me && me >= 0;
    return {
      id: g.id,
      status: g.status,
      size: g.size,
      fee: g.feeCents / 100,
      prize: (g.feeCents * (g.status === "waiting" ? g.size : g.players.length)) / 100,
      visibility: g.visibility,
      code: me >= 0 ? g.code : null,
      creator: g.players.find((p) => p.userId === g.creatorId)?.name ?? "?",
      mine: g.creatorId === userId,
      seat: me >= 0 ? me : null,
      players,
      winner: g.winner,
      handNo: g.handNo,
      button: g.button,
      log: g.log.slice(-8),
      hand: h
        ? {
            no: h.no,
            sb: h.sb,
            bb: h.bb,
            nextLevelIn: h.level < HOLDEM_BLINDS.length - 1 ? HOLDEM_HANDS_PER_LEVEL - ((h.no - 1) % HOLDEM_HANDS_PER_LEVEL) : null,
            board: h.board,
            street: h.street,
            phase: h.phase,
            pot: h.seats.reduce((x, s) => x + s.total, 0),
            toAct: h.toAct,
            deadline: h.deadline,
            currentBet: h.currentBet,
            results: h.phase === "result" ? h.results.pots.map((r) => ({ amount: r.amount, winners: r.winners, hand: r.hand })) : null,
            // Only for whoever's turn it is.
            you: myTurn
              ? {
                  toCall: Math.min(h.currentBet - mySeat.bet, g.players[me].chips),
                  minRaiseTo: Math.min(h.currentBet + h.minRaise, mySeat.bet + g.players[me].chips),
                  maxRaiseTo: mySeat.bet + g.players[me].chips,
                }
              : null,
          }
        : null,
      createdAt: g.createdAt,
    };
  }

  list(userId) {
    return [...this.games.values()]
      .filter((g) => this.#canSee(g, userId, null))
      .sort((x, y) => y.id - x.id)
      .map((g) => this.#view(g, userId));
  }

  publish() {
    this.io.broadcastPer("holdem", (userId) => this.list(userId));
  }
}

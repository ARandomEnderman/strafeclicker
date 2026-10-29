// Blackjack at shared tables of up to four players, against one dealer.
//
//   betting  starts with the first bet; BJ_BET_MS for others to sit down and bet
//   playing  everyone has two cards, the dealer one up and one down. All players act at
//            once (hit, stand, double on two cards) within BJ_PLAY_MS; anyone still
//            deciding when time is up stands.
//   dealer   the hole card is turned and the dealer draws to 17 (stands on all 17s),
//            one card every BJ_DEALER_CARD_MS, the same for everyone watching
//   result   payouts (blackjack 3:2, win 1:1, push returns the bet), then a new round
//
// There is one table for everyone, with no seat limit (past BJ_SEATS the page draws the
// extra players smaller). Bets join the hand while it's taking bets; once it's dealt, a
// bet is a pre-bet for the next hand (t.waiting) and can be taken back until then.
//
// The shoe (6 decks) and the hole card stay on the server. Stakes are debited when the
// bet is placed and kept in bj_bets, so a restart refunds a round that was in progress.

import { randomInt } from "node:crypto";
import { GameError, spendable } from "../game.mjs";
import { BJ_BET_MS, BJ_DEALER_CARD_MS, BJ_PLAY_MS, BJ_RESULT_MS } from "../../shared/game.js";
import { stakeCents } from "./bets.mjs";

const DECKS = 6;
const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["s", "h", "d", "c"];

/** Best total of a hand (aces count 11 when that doesn't bust) and whether it's soft. */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.r === "A") ((aces += 1), (total += 11));
    else total += ["J", "Q", "K"].includes(c.r) ? 10 : Number(c.r);
  }
  while (total > 21 && aces) ((total -= 10), aces--);
  return { total, soft: aces > 0 };
}
const isBlackjack = (cards) => cards.length === 2 && handValue(cards).total === 21;

function newShoe() {
  const shoe = [];
  for (let d = 0; d < DECKS; d++) for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

export class Blackjack {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ broadcastPer: (event: string, data: (userId: number | null) => any) => void, toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, io) {
    this.game = game;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS bj_bets (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, stake_cents INTEGER NOT NULL, status TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.q = {
      add: db.prepare("INSERT INTO bj_bets (user_id, stake_cents, status, at) VALUES (?, ?, 'open', ?)"),
      settle: db.prepare("UPDATE bj_bets SET status = ? WHERE id = ?"),
      addStake: db.prepare("UPDATE bj_bets SET stake_cents = stake_cents + ? WHERE id = ?"),
      unsettled: db.prepare("SELECT id, user_id, stake_cents FROM bj_bets WHERE status = 'open'"),
    };
    /** id -> table */
    this.tables = new Map();
    /** userId -> table id (where they sit or last sat) */
    this.at = new Map();
    this.nextId = 1;
  }

  start() {
    for (const b of this.q.unsettled.all()) {
      const { account } = this.game.act(b.user_id, (a) => {
        a.balanceCents += b.stake_cents;
        return {};
      });
      this.q.settle.run("refunded", b.id);
      this.io.toUser(b.user_id, "account", account);
    }
  }

  stop() {
    for (const t of this.tables.values()) clearTimeout(t.timer);
  }

  #newTable() {
    const t = { id: this.nextId++, round: 0, phase: "idle", seats: [], waiting: [], dealer: [], deadline: null, shoe: newShoe(), timer: null };
    this.tables.set(t.id, t);
    return t;
  }

  /** The one table everyone plays at. */
  #tableFor() {
    return this.tables.values().next().value ?? this.#newTable();
  }

  /** Start taking bets, with a deadline. */
  #openBetting(t) {
    t.phase = "betting";
    t.deadline = Date.now() + BJ_BET_MS;
    t.timer = setTimeout(() => this.#deal(t), BJ_BET_MS);
  }

  #draw(t) {
    if (t.shoe.length < (DECKS * 52) / 4) t.shoe = newShoe();
    return t.shoe.pop();
  }

  /** Maintenance: tables still taking bets give the stakes back and don't deal. Returns how many. */
  refundPending() {
    let n = 0;
    for (const t of this.tables.values()) {
      const seats = [...(t.phase === "betting" ? t.seats : []), ...t.waiting];
      if (!seats.length) continue;
      for (const s of seats) {
        const { account } = this.game.act(s.userId, (a) => {
          a.balanceCents += s.stakeCents;
          return {};
        });
        this.q.settle.run("refunded", s.betId);
        this.io.toUser(s.userId, "account", account);
        n++;
      }
      t.waiting = [];
      if (t.phase === "betting") this.#reset(t);
    }
    if (n) this.publish();
    return n;
  }

  // ---------- player actions ----------

  bet(userId, body) {
    const current = this.tables.get(this.at.get(userId));
    if (current?.waiting.some((s) => s.userId === userId)) throw new GameError("busy", "You're already in for the next hand");
    if (current?.seats.some((s) => s.userId === userId) && current.phase !== "result" && current.phase !== "idle") {
      if (current.phase !== "betting") throw new GameError("busy", "Finish this hand first");
      throw new GameError("busy", "You've already bet this round");
    }
    const t = this.#tableFor();
    // A table showing only your own last result starts the next round now; with others
    // there, the result stays up and you're in for the next hand.
    if (t.phase === "result" && t.seats.every((s) => s.userId === userId)) {
      this.#reset(t);
      t.seats = t.waiting;
      t.waiting = [];
    }
    let seat;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      const { lastInsertRowid } = this.q.add.run(userId, stake, Date.now());
      seat = { userId, user: a.username, name: a.displayName, betId: Number(lastInsertRowid), stakeCents: stake, cards: [], status: "betting", doubled: false, result: null, payoutCents: 0 };
      return {};
    });
    this.at.set(userId, t.id);
    if (t.phase === "idle") {
      t.seats.push(seat);
      this.#openBetting(t);
    } else if (t.phase === "betting") t.seats.push(seat);
    // Dealt already (or showing others' results): a pre-bet for the next hand.
    else t.waiting.push(seat);
    this.publish();
    return out;
  }

  /** Take back a bet before its hand is dealt (a pre-bet, or one in the betting window). */
  cancel(userId) {
    const t = this.tables.get(this.at.get(userId));
    const list = t?.waiting.some((s) => s.userId === userId) ? t.waiting : t?.phase === "betting" ? t.seats : null;
    const seat = list?.find((s) => s.userId === userId);
    if (!seat) throw new GameError("not_playing", "You have no bet waiting to be dealt");
    list.splice(list.indexOf(seat), 1);
    const out = this.game.act(userId, (a) => {
      a.balanceCents += seat.stakeCents;
      return {};
    });
    this.q.settle.run("refunded", seat.betId);
    // Nobody left to deal to: back to waiting for a first bet.
    if (t.phase === "betting" && !t.seats.length) this.#reset(t);
    this.publish();
    return out;
  }

  #seat(userId) {
    const t = this.tables.get(this.at.get(userId));
    const s = t?.seats.find((x) => x.userId === userId);
    if (!t || !s || t.phase !== "playing") throw new GameError("not_playing", "You're not in a hand right now");
    if (s.status !== "playing") throw new GameError("done", "Your hand is finished");
    return { t, s };
  }

  hit(userId) {
    const { t, s } = this.#seat(userId);
    s.cards.push(this.#draw(t));
    const v = handValue(s.cards).total;
    if (v > 21) s.status = "bust";
    else if (v === 21) s.status = "stood";
    this.#afterAction(t);
    return { account: this.game.view(userId) };
  }

  stand(userId) {
    const { t, s } = this.#seat(userId);
    s.status = "stood";
    this.#afterAction(t);
    return { account: this.game.view(userId) };
  }

  double(userId) {
    const { t, s } = this.#seat(userId);
    if (s.cards.length !== 2) throw new GameError("bad_input", "You can only double on your first two cards");
    const out = this.game.act(userId, (a) => {
      if (spendable(a) < s.stakeCents) throw new GameError("insufficient", "Not enough balance to double");
      a.balanceCents -= s.stakeCents;
      this.q.addStake.run(s.stakeCents, s.betId);
      return {};
    });
    s.stakeCents *= 2;
    s.doubled = true;
    s.cards.push(this.#draw(t));
    s.status = handValue(s.cards).total > 21 ? "bust" : "stood";
    this.#afterAction(t);
    return out;
  }

  // ---------- the round ----------

  #deal(t) {
    t.round++;
    t.phase = "playing";
    t.dealer = [];
    for (let k = 0; k < 2; k++) {
      for (const s of t.seats) s.cards.push(this.#draw(t));
      t.dealer.push(this.#draw(t));
    }
    for (const s of t.seats) s.status = isBlackjack(s.cards) ? "blackjack" : "playing";
    // Dealer blackjack ends the round at once (the dealer peeks, as at a real table).
    if (isBlackjack(t.dealer)) return this.#dealerPlays(t, true);
    t.deadline = Date.now() + BJ_PLAY_MS;
    t.timer = setTimeout(() => {
      for (const s of t.seats) if (s.status === "playing") s.status = "stood";
      this.#dealerPlays(t);
    }, BJ_PLAY_MS);
    this.#afterAction(t);
  }

  #afterAction(t) {
    if (t.phase === "playing" && t.seats.every((s) => s.status !== "playing")) {
      clearTimeout(t.timer);
      this.#dealerPlays(t);
    } else this.publish();
  }

  /** Turn the hole card and draw to 17, one card at a time. */
  #dealerPlays(t, peeked = false) {
    t.phase = "dealer";
    t.deadline = null;
    t.holeShown = true;
    this.publish();
    // Nobody left to beat (all bust): the dealer doesn't need to draw.
    const needed = !peeked && t.seats.some((s) => s.status !== "bust");
    const step = () => {
      const v = handValue(t.dealer);
      if (needed && v.total < 17) {
        t.dealer.push(this.#dealerCard(t));
        this.publish();
        t.timer = setTimeout(step, BJ_DEALER_CARD_MS);
      } else this.#settle(t);
    };
    t.timer = setTimeout(step, BJ_DEALER_CARD_MS);
  }

  /** The next dealer card; the rig lets the dealer pick the best of the next three. */
  #dealerCard(t) {
    if (Math.random() >= this.game.rig("blackjack")) return this.#draw(t);
    const options = [this.#draw(t), this.#draw(t), this.#draw(t)];
    const score = (c) => {
      const v = handValue([...t.dealer, c]).total;
      return v > 21 ? -1 : v;
    };
    options.sort((a, b) => score(b) - score(a));
    // The two not used go back on top of the shoe.
    t.shoe.push(options[2], options[1]);
    return options[0];
  }

  #settle(t) {
    const d = handValue(t.dealer).total;
    const dealerBj = isBlackjack(t.dealer);
    for (const s of t.seats) {
      const p = handValue(s.cards).total;
      let mult;
      if (s.status === "bust") mult = 0;
      else if (s.status === "blackjack") mult = dealerBj ? 1 : 2.5;
      else if (dealerBj) mult = 0;
      else if (d > 21 || p > d) mult = 2;
      else if (p === d) mult = 1;
      else mult = 0;
      s.result = mult === 2.5 ? "blackjack" : mult === 2 ? "win" : mult === 1 ? "push" : "lose";
      s.payoutCents = Math.floor(s.stakeCents * mult);
      const { account } = this.game.act(s.userId, (a) => {
        a.balanceCents += s.payoutCents;
        this.game.noteGame(a, "blackjack", { stakeCents: s.stakeCents, payoutCents: s.payoutCents, add: s.result === "blackjack" ? { blackjacks: 1 } : {} });
        return {};
      });
      this.q.settle.run(s.result, s.betId);
      this.io.toUser(s.userId, "account", account);
    }
    t.phase = "result";
    t.deadline = Date.now() + BJ_RESULT_MS;
    this.publish();
    t.timer = setTimeout(() => {
      this.#reset(t);
      // Whoever bet during the hand plays the next one.
      if (t.waiting.length) {
        t.seats = t.waiting;
        t.waiting = [];
        this.#openBetting(t);
      }
      this.publish();
    }, BJ_RESULT_MS);
  }

  #reset(t) {
    clearTimeout(t.timer);
    t.phase = "idle";
    t.seats = [];
    t.dealer = [];
    t.holeShown = false;
    t.deadline = null;
  }

  // ---------- what browsers see ----------

  /** The table this user should see; the hole card stays hidden until the dealer plays. */
  view(userId) {
    const busy = [...this.tables.values()].filter((x) => x.seats.length || x.waiting.length);
    // Someone who hasn't sat down yet watches the fullest table.
    // Your table while you're in its hand or waiting for the next; otherwise the busiest
    // one (so you see where everyone is), or your old one if nobody is playing.
    const mine = this.tables.get(this.at.get(userId));
    const inMine = mine && [...mine.seats, ...mine.waiting].some((x) => x.userId === userId);
    const t = inMine ? mine : (busy.sort((a, b) => b.seats.length + b.waiting.length - a.seats.length - a.waiting.length)[0] ?? mine);
    const open = busy.length;
    if (!t) return { table: null, tables: open };
    const showHole = t.holeShown || t.phase === "result";
    const dealer = t.dealer.map((c, i) => (i === 1 && !showHole ? null : c));
    return {
      tables: open,
      seated: t.seats.some((s) => s.userId === userId),
      queued: t.waiting.some((s) => s.userId === userId),
      table: {
        waiting: t.waiting.map((s) => ({ user: s.user, name: s.name, stake: s.stakeCents / 100 })),
        id: t.id,
        round: t.round,
        phase: t.phase,
        deadline: t.deadline,
        dealer,
        dealerTotal: dealer.every(Boolean) && dealer.length ? handValue(dealer).total : dealer[0] ? handValue([dealer[0]]).total : null,
        seats: t.seats.map((s) => ({
          user: s.user,
          name: s.name,
          stake: s.stakeCents / 100,
          cards: s.cards,
          total: s.cards.length ? handValue(s.cards).total : null,
          soft: s.cards.length ? handValue(s.cards).soft : false,
          status: s.status,
          doubled: s.doubled,
          result: s.result,
          payout: s.payoutCents / 100,
        })),
      },
    };
  }

  publish() {
    this.io.broadcastPer("bj", (userId) => this.view(userId));
  }
}

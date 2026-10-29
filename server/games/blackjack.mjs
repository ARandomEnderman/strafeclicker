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
// The shoe (6 decks) and the hole card stay on the server. Stakes are debited when the
// bet is placed and kept in bj_bets, so a restart refunds a round that was in progress.

import { randomInt } from "node:crypto";
import { GameError, spendable } from "../game.mjs";
import { BJ_BET_MS, BJ_DEALER_CARD_MS, BJ_PLAY_MS, BJ_RESULT_MS, BJ_SEATS } from "../../shared/game.js";
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
    const t = { id: this.nextId++, round: 0, phase: "idle", seats: [], dealer: [], deadline: null, shoe: newShoe(), timer: null };
    this.tables.set(t.id, t);
    return t;
  }

  /**
   * Seat a player at the table taking bets with the most other players (anyone can join
   * anyone), staying at their own table on a tie; a new table only when none has room.
   * Without this, two players who once landed at different tables would each keep
   * playing alone at their own.
   */
  #tableFor(userId) {
    const mine = this.tables.get(this.at.get(userId));
    const others = (t) => t.seats.filter((s) => s.userId !== userId).length;
    const open = [...this.tables.values()].filter(
      (t) => others(t) < BJ_SEATS && (t.phase === "idle" || t.phase === "betting" || (t === mine && t.phase === "result")),
    );
    if (!open.length) return this.#newTable();
    return open.reduce((best, t) => (others(t) > others(best) || (others(t) === others(best) && t === mine) ? t : best));
  }

  #draw(t) {
    if (t.shoe.length < (DECKS * 52) / 4) t.shoe = newShoe();
    return t.shoe.pop();
  }

  /** Maintenance: tables still taking bets give the stakes back and don't deal. Returns how many. */
  refundPending() {
    let n = 0;
    for (const t of this.tables.values()) {
      if (t.phase !== "betting") continue;
      for (const s of t.seats) {
        const { account } = this.game.act(s.userId, (a) => {
          a.balanceCents += s.stakeCents;
          return {};
        });
        this.q.settle.run("refunded", s.betId);
        this.io.toUser(s.userId, "account", account);
        n++;
      }
      this.#reset(t);
    }
    if (n) this.publish();
    return n;
  }

  // ---------- player actions ----------

  bet(userId, body) {
    const current = this.tables.get(this.at.get(userId));
    if (current?.seats.some((s) => s.userId === userId) && current.phase !== "result" && current.phase !== "idle") {
      if (current.phase !== "betting") throw new GameError("busy", "Finish this hand first");
      throw new GameError("busy", "You've already bet this round");
    }
    const t = this.#tableFor(userId);
    // A table showing last round's result starts the next round now.
    if (t.phase === "result") this.#reset(t);
    let seat;
    const out = this.game.act(userId, (a) => {
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      const { lastInsertRowid } = this.q.add.run(userId, stake, Date.now());
      seat = { userId, user: a.username, name: a.displayName, betId: Number(lastInsertRowid), stakeCents: stake, cards: [], status: "betting", doubled: false, result: null, payoutCents: 0 };
      return {};
    });
    t.seats.push(seat);
    this.at.set(userId, t.id);
    if (t.phase === "idle") {
      t.phase = "betting";
      t.deadline = Date.now() + BJ_BET_MS;
      t.timer = setTimeout(() => this.#deal(t), BJ_BET_MS);
    }
    // A full table doesn't wait out the timer.
    if (t.seats.length >= BJ_SEATS) {
      clearTimeout(t.timer);
      this.#deal(t);
    } else this.publish();
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

  /** The table this user sits (or last sat) at; the hole card stays hidden until the dealer plays. */
  view(userId) {
    const busy = [...this.tables.values()].filter((x) => x.seats.length);
    // Someone who hasn't sat down yet watches the fullest table.
    const t = this.tables.get(this.at.get(userId)) ?? busy.sort((a, b) => b.seats.length - a.seats.length)[0];
    const open = busy.length;
    if (!t) return { table: null, tables: open };
    const showHole = t.holeShown || t.phase === "result";
    const dealer = t.dealer.map((c, i) => (i === 1 && !showHole ? null : c));
    return {
      tables: open,
      seated: t.seats.some((s) => s.userId === userId),
      table: {
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

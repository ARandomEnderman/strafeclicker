// Video poker (Jacks or Better). The deal debits the bet and shuffles a fresh 52-card
// deck on the server; the hand and the rest of the deck are kept in poker_runs, so a
// reload or restart picks the hand up where it was. The draw replaces the cards not
// held from the top of that deck and pays by POKER_HANDS.

import { randomInt } from "node:crypto";
import { POKER_RANKS, POKER_SUITS, pokerHand } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

const HAND_ORDER = ["royal", "straightFlush", "quads", "fullHouse", "flush", "straight", "trips", "twoPair", "jacks"];
/** Higher is better; a non-paying hand is 0. */
const strength = (cards) => {
  const h = pokerHand(cards);
  return h ? HAND_ORDER.length - HAND_ORDER.indexOf(h.id) : 0;
};

function shuffledDeck() {
  const deck = [];
  for (const s of POKER_SUITS) for (const r of POKER_RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export class Poker {
  /**
   * @param {import("../game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   */
  constructor(game, db) {
    this.game = game;
    db.exec(`CREATE TABLE IF NOT EXISTS poker_runs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      stake_cents INTEGER NOT NULL, hand TEXT NOT NULL, deck TEXT NOT NULL, started_at INTEGER NOT NULL)`);
    this.q = {
      get: db.prepare("SELECT * FROM poker_runs WHERE user_id = ?"),
      add: db.prepare("INSERT INTO poker_runs (user_id, stake_cents, hand, deck, started_at) VALUES (?, ?, ?, ?, ?)"),
      end: db.prepare("DELETE FROM poker_runs WHERE user_id = ?"),
    };
  }

  #view(r) {
    return r ? { stake: r.stake_cents / 100, hand: JSON.parse(r.hand) } : null;
  }

  forget(userId) {
    this.q.end.run(userId);
  }

  state(userId) {
    return this.game.act(userId, () => ({ run: this.#view(this.q.get.get(userId)) }));
  }

  deal(userId, body) {
    return this.game.act(userId, (a) => {
      if (this.q.get.get(userId)) throw new GameError("busy", "Finish this hand first");
      const stake = stakeCents(a, body.bet);
      a.balanceCents -= stake;
      const deck = shuffledDeck();
      this.q.add.run(userId, stake, JSON.stringify(deck.slice(0, 5)), JSON.stringify(deck.slice(5)), Date.now());
      return { run: this.#view(this.q.get.get(userId)) };
    });
  }

  /** `hold`: five booleans, true for each card to keep. */
  draw(userId, body) {
    const hold = Array.isArray(body.hold) ? body.hold.slice(0, 5).map(Boolean) : [];
    while (hold.length < 5) hold.push(false);
    return this.game.act(userId, (a) => {
      const r = this.q.get.get(userId);
      if (!r) throw new GameError("no_run", "Deal a hand first");
      const hand = JSON.parse(r.hand);
      const deck = JSON.parse(r.deck);
      const fill = (from) => {
        let k = from;
        return hand.map((c, i) => (hold[i] ? c : deck[k++]));
      };
      let final = fill(0);
      // The rig: that share of draws also try the next cards in the deck and keep the worse hand.
      const replaced = hold.filter((x) => !x).length;
      if (replaced && Math.random() < this.game.rig("poker")) {
        const other = fill(replaced);
        if (strength(other) < strength(final)) final = other;
      }
      const result = pokerHand(final);
      const payout = result ? r.stake_cents * result.pay : 0;
      this.q.end.run(userId);
      a.balanceCents += payout;
      this.game.noteGame(a, "poker", { stakeCents: r.stake_cents, payoutCents: payout, add: result?.id === "royal" ? { royals: 1 } : {} });
      return { hand: final, held: hold, result: result?.id ?? null, payout: payout / 100, run: null };
    });
  }
}

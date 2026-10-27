// Shared bet validation for the casino games.

import { BET_MAX, BET_MIN } from "../../shared/game.js";
import { GameError, cents, spendable } from "../game.mjs";

/** Validate a bet (USD) against the account and return it in cents. Doesn't debit it. */
export function stakeCents(a, bet) {
  const c = cents(Number(bet));
  if (!(c >= cents(BET_MIN) && c <= cents(BET_MAX))) throw new GameError("bad_bet", `Bets are $${BET_MIN} to $${BET_MAX.toLocaleString("en-US")}`);
  if (c > spendable(a)) throw new GameError("insufficient", "Not enough balance");
  return c;
}

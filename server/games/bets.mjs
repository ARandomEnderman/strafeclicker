// Shared bet validation for the casino games.

import { BET_MIN, perkValue } from "../../shared/game.js";
import { GameError, cents, spendable } from "../game.mjs";

/** Validate a bet (USD) against the account (and its max bet upgrade) and return it in cents. Doesn't debit it. */
export function stakeCents(a, bet) {
  const c = cents(Number(bet));
  const max = perkValue(a.perks, "maxBet");
  if (!Number.isFinite(c) || c < cents(BET_MIN)) throw new GameError("bad_bet", `Bets start at $${BET_MIN}`);
  if (c > cents(max)) throw new GameError("bad_bet", `Your max bet is $${max.toLocaleString("en-US")}. Raise it in the upgrade tree.`);
  if (c > spendable(a)) throw new GameError("insufficient", "Not enough balance");
  return c;
}

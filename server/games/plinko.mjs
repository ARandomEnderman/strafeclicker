// Plinko: the server picks the ball's path (one fair coin per row), the browser
// only animates it.

import { randomBytes } from "node:crypto";
import { PLINKO_DROP_MS, PLINKO_TABLES } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

/** @param {import("../game.mjs").Game} game */
export function plinko(game, userId, body) {
  const rows = Number(body.rows);
  const risk = String(body.risk ?? "");
  const table = PLINKO_TABLES[rows]?.[risk];
  if (!table || !Object.hasOwn(PLINKO_TABLES[rows], risk)) throw new GameError("bad_input", "Pick 8, 12 or 16 rows and a risk level");
  return game.act(userId, (a, changes) => {
    const stake = stakeCents(a, body.bet);
    const bits = randomBytes(rows);
    // 0 = left, 1 = right at each row; the slot is the number of right bounces.
    const path = Array.from(bits, (b) => b & 1);
    const slot = path.reduce((s, b) => s + b, 0);
    const mult = table[slot];
    const payout = Math.floor(stake * mult);
    a.balanceCents += payout - stake;
    // The winnings are only spendable once the ball has landed on screen.
    // (A little longer than the animation, to cover the response's trip to the browser.)
    game.lock(a, payout, PLINKO_DROP_MS(rows) + 250);
    game.noteGame(a, "plinko", { stakeCents: stake, payoutCents: payout });
    game.announce(changes, a, "plinko", payout / 100, stake / 100, { label: `${mult}x`, source: `${rows} rows, ${risk}` }, PLINKO_DROP_MS(rows));
    return { path, slot, mult, payout: payout / 100, stake: stake / 100 };
  });
}


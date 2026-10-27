// Keno on a 7×7 grid: the player picks tiles, the server draws KENO_DRAWS of the 49
// and pays by how many picks were hit. Instant: the browser only animates the reveal,
// and the winnings are spendable once it's done.

import { randomInt } from "node:crypto";
import { KENO_DRAWS, KENO_MAX_PICKS, KENO_REVEAL_MS, KENO_TABLES, KENO_TILES } from "../../shared/game.js";
import { GameError } from "../game.mjs";
import { stakeCents } from "./bets.mjs";

function draw() {
  const tiles = Array.from({ length: KENO_TILES }, (_, i) => i);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  return tiles.slice(0, KENO_DRAWS);
}

/** @param {import("../game.mjs").Game} game */
export function keno(game, userId, body) {
  const picks = [...new Set((Array.isArray(body.picks) ? body.picks : []).map(Number))];
  if (!picks.length || picks.length > KENO_MAX_PICKS || picks.some((t) => !Number.isInteger(t) || t < 0 || t >= KENO_TILES)) {
    throw new GameError("bad_input", `Pick 1 to ${KENO_MAX_PICKS} tiles`);
  }
  return game.act(userId, (a) => {
    const stake = stakeCents(a, body.bet);
    const hitsOf = (d) => d.filter((t) => picks.includes(t)).length;
    let drawn = draw();
    // The rig: that share of rounds are drawn twice and the worse draw counts.
    if (Math.random() < game.rig("keno")) {
      const again = draw();
      if (hitsOf(again) < hitsOf(drawn)) drawn = again;
    }
    const hits = hitsOf(drawn);
    const mult = KENO_TABLES[picks.length][hits] ?? 0;
    const payout = Math.floor(stake * mult);
    a.balanceCents += payout - stake;
    game.lock(a, payout, KENO_REVEAL_MS + 250);
    game.noteGame(a, "keno", { stakeCents: stake, payoutCents: payout, max: { bestHits: hits } });
    return { drawn, hits, mult, payout: payout / 100, stake: stake / 100 };
  });
}

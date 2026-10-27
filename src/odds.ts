import type { Case, Tier, WearKey } from "./types";
import { WEAR_BUCKETS } from "../shared/game.js";

// The rules themselves live in shared/game.js so the server rolls with exactly
// the odds the site shows.
export {
  BATTLE_MAX_ROUNDS,
  BATTLE_ROUND_MS,
  BATTLE_SIZES,
  BATTLE_SPIN_MS,
  BATTLE_WIN_AT,
  BHOP_DIFFICULTIES,
  DAILY_PRIZES,
  DAILY_SPIN_MS,
  DEFUSE_TILES,
  KENO_DRAWS,
  KENO_MAX_PICKS,
  KENO_REVEAL_MS,
  KENO_TABLES,
  KENO_TILES,
  FLIP_LEAD_MS,
  JP_MAX_ITEMS,
  JP_MIN_DEPOSIT,
  JP_SPIN_MS,
  JP_TIMER_MS,
  FLIP_MS,
  ROULETTE_BET_MS,
  ROULETTE_COLORS,
  ROULETTE_PAYOUT,
  ROULETTE_SPIN_MS,
  ROULETTE_WHEEL,
  BET_MAX,
  BET_MIN,
  CLICK_CPS_LIMIT,
  FB_AUTO_MIN,
  FB_GROWTH,
  FB_INTERMISSION_MS,
  FB_MAX,
  OFFLINE_CAP_HOURS,
  PERKS,
  PHASE_WEIGHTS,
  PLINKO_DROP_MS,
  PLINKO_RISKS,
  PLINKO_ROWS,
  PLINKO_TABLES,
  STATTRAK_ODDS,
  TIERS,
  TIER_ODDS,
  UPGRADE_MAX_CHANCE,
  UPGRADE_MAX_ITEMS,
  UPGRADE_MIN_CHANCE,
  UPGRADE_RTP,
  WEAR_BUCKETS,
  battleReel,
  bhopMultiplier,
  defuseMultiplier,
  rouletteColor,
  canStatTrak,
  clickEfficiency,
  clickRateAt,
  fbMultiplierAt,
  needsKey,
  perkValue,
  phaseEntries,
  pickTier,
  pickWeighted,
  priceKey,
  rateClicks,
  tierOdds,
  upgradeChance,
  variants,
} from "../shared/game.js";

export const TIER_INFO: Record<Tier, { label: string; color: string }> = {
  milspec: { label: "Mil-Spec", color: "#4b69ff" },
  restricted: { label: "Restricted", color: "#8847ff" },
  classified: { label: "Classified", color: "#d32ce6" },
  covert: { label: "Covert", color: "#eb4b4b" },
  gold: { label: "Rare Special", color: "#e4ae39" },
};

/** Stickers use the same colours under their own names. */
const STICKER_LABELS: Partial<Record<Tier, string>> = {
  milspec: "High Grade",
  restricted: "Remarkable",
  classified: "Exotic",
  covert: "Extraordinary",
};

export function tierLabel(c: Case, tier: Tier) {
  if (tier === "gold") return c.rareLabel;
  return (c.kind === "case" ? TIER_INFO[tier].label : STICKER_LABELS[tier]) ?? TIER_INFO[tier].label;
}

export const WEAR_NAME = Object.fromEntries(WEAR_BUCKETS.map((b) => [b.key, b.name])) as Record<WearKey, string>;

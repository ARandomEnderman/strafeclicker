import type { Case, Tier, WearKey } from "./types";
import { WEAR_BUCKETS } from "../shared/game.js";

// The rules themselves live in shared/game.js so the server rolls with exactly
// the odds the site shows.
export {
  CLICK_CPS_LIMIT,
  OFFLINE_CAP_HOURS,
  PERKS,
  PHASE_WEIGHTS,
  STATTRAK_ODDS,
  TIERS,
  TIER_ODDS,
  UPGRADE_MAX_CHANCE,
  UPGRADE_MAX_ITEMS,
  UPGRADE_MIN_CHANCE,
  UPGRADE_RTP,
  WEAR_BUCKETS,
  canStatTrak,
  clickEfficiency,
  clickRateAt,
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

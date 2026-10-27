import type { Tier, WearKey } from "./types";

/**
 * Official weapon case odds, as disclosed by Valve / Perfect World.
 * Every item inside a tier is equally likely.
 */
export const TIER_ODDS: Record<Tier, number> = {
  milspec: 0.7992,
  restricted: 0.1598,
  classified: 0.032,
  covert: 0.0064,
  gold: 0.0026,
};

export const TIERS: Tier[] = ["milspec", "restricted", "classified", "covert", "gold"];

export const TIER_INFO: Record<Tier, { label: string; color: string }> = {
  milspec: { label: "Mil-Spec", color: "#4b69ff" },
  restricted: { label: "Restricted", color: "#8847ff" },
  classified: { label: "Classified", color: "#d32ce6" },
  covert: { label: "Covert", color: "#eb4b4b" },
  gold: { label: "Rare Special", color: "#e4ae39" },
};

/** Chance that a StatTrak-eligible drop is StatTrak. Gloves are never StatTrak. */
export const STATTRAK_ODDS = 0.1;

/**
 * Float generation: pick a wear bucket by weight, pick a uniform value inside it,
 * then squash that into the skin's own [minFloat, maxFloat] range.
 * Weights are the community-measured distribution (Valve hasn't published one).
 */
export const WEAR_BUCKETS: { key: WearKey; name: string; min: number; max: number; weight: number }[] = [
  { key: "FN", name: "Factory New", min: 0.0, max: 0.07, weight: 0.03 },
  { key: "MW", name: "Minimal Wear", min: 0.07, max: 0.15, weight: 0.24 },
  { key: "FT", name: "Field-Tested", min: 0.15, max: 0.38, weight: 0.33 },
  { key: "WW", name: "Well-Worn", min: 0.38, max: 0.45, weight: 0.24 },
  { key: "BS", name: "Battle-Scarred", min: 0.45, max: 1.0, weight: 0.16 },
];

export function wearOf(float: number): WearKey {
  for (const b of WEAR_BUCKETS) if (float < b.max) return b.key;
  return "BS";
}

export const WEAR_NAME = Object.fromEntries(WEAR_BUCKETS.map((b) => [b.key, b.name])) as Record<WearKey, string>;

/**
 * Doppler-style phase weights. Valve doesn't publish these either; these are
 * community estimates. Unknown phase names fall back to weight 1.
 */
export const PHASE_WEIGHTS: Record<string, number> = {
  "Phase 1": 23.5,
  "Phase 2": 23.5,
  "Phase 3": 23.5,
  "Phase 4": 23.5,
  Ruby: 2,
  Sapphire: 2,
  "Black Pearl": 2,
  Emerald: 6,
};

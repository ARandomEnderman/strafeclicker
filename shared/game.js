// Game rules shared by the server (which rolls) and the browser (which only shows
// odds and expected values). Plain JS so Node can import it without a build step;
// types live in game.d.ts.

/**
 * Official weapon case odds, as disclosed by Valve / Perfect World. Each step up is
 * 1/5 as likely as the one below; sticker capsules use the same ladder over their
 * four rarities. Every item inside a tier is equally likely.
 */
export const TIER_ODDS = {
  milspec: 0.7992,
  restricted: 0.1598,
  classified: 0.032,
  covert: 0.0064,
  gold: 0.0026,
};

export const TIERS = ["milspec", "restricted", "classified", "covert", "gold"];

/** Chance that a StatTrak-eligible drop is StatTrak. Gloves are never StatTrak. */
export const STATTRAK_ODDS = 0.1;

/**
 * Float generation: pick a wear bucket by weight, pick a uniform value inside it,
 * then squash that into the skin's own [minFloat, maxFloat] range.
 * Weights are the community-measured distribution (Valve hasn't published one).
 */
export const WEAR_BUCKETS = [
  { key: "FN", name: "Factory New", min: 0.0, max: 0.07, weight: 0.03 },
  { key: "MW", name: "Minimal Wear", min: 0.07, max: 0.15, weight: 0.24 },
  { key: "FT", name: "Field-Tested", min: 0.15, max: 0.38, weight: 0.33 },
  { key: "WW", name: "Well-Worn", min: 0.38, max: 0.45, weight: 0.24 },
  { key: "BS", name: "Battle-Scarred", min: 0.45, max: 1.0, weight: 0.16 },
];

/**
 * Doppler-style phase weights. Valve doesn't publish these either; these are
 * community estimates. Unknown phase names fall back to weight 1.
 */
export const PHASE_WEIGHTS = {
  "Phase 1": 23.5,
  "Phase 2": 23.5,
  "Phase 3": 23.5,
  "Phase 4": 23.5,
  Ruby: 2,
  Sapphire: 2,
  "Black Pearl": 2,
  Emerald: 6,
};

/**
 * The upgrade tree: two branches bought with balance, one level at a time.
 * Level 0 is what every account starts with.
 */
export const PERKS = {
  multiOpen: {
    name: "Multi-open",
    unit: "cases at once",
    levels: [
      { value: 1, cost: 0 },
      { value: 2, cost: 10 },
      { value: 3, cost: 40 },
      { value: 4, cost: 150 },
      { value: 5, cost: 500 },
    ],
  },
  offlineIncome: {
    name: "Offline income",
    unit: "per hour away",
    levels: [
      { value: 0.25, cost: 0 },
      { value: 0.5, cost: 15 },
      { value: 1, cost: 60 },
      { value: 2, cost: 200 },
      { value: 4, cost: 600 },
    ],
  },
  clickPower: {
    name: "Click power",
    unit: "per click",
    levels: [
      { value: 0.05, cost: 0 },
      { value: 0.1, cost: 5 },
      { value: 0.2, cost: 25 },
      { value: 0.35, cost: 100 },
      { value: 0.5, cost: 300 },
      { value: 0.75, cost: 800 },
      { value: 1, cost: 2000 },
    ],
  },
};

export const NO_PERKS = { multiOpen: 0, clickPower: 0, offlineIncome: 0 };

/** Offline income only counts gaps of at least this long, and pays at most this many hours. */
export const OFFLINE_MIN_GAP_MS = 5 * 60_000;
export const OFFLINE_CAP_HOURS = 12;

/** Current value of a perk for an account's perk levels. */
export const perkValue = (perks, id) => PERKS[id].levels[perks?.[id] ?? 0].value;

/** Upgrader: chance = (your value / target price) × UPGRADE_RTP, kept inside these bounds. */
// ---------- clicker speed limit ----------
// Up to CLICK_CPS_LIMIT clicks per second pay full value. Past that, every click is worth
// e^(-CLICK_FALLOFF × excess): 12 cps pays 50%, 15 cps 18%, 20 cps 3%.
export const CLICK_CPS_LIMIT = 10;
export const CLICK_FALLOFF = Math.LN2 / 2;
/** Time constant (s) of the moving click-rate average. */
export const CLICK_RATE_TAU = 1;

export const clickEfficiency = (cps) => (cps <= CLICK_CPS_LIMIT ? 1 : Math.exp(-CLICK_FALLOFF * (cps - CLICK_CPS_LIMIT)));

/**
 * Rate a run of clicks. `state` is { rate, last } (the moving clicks/s average and the time of
 * the previous click, ms); `times` are click times in ms, oldest first. Each click is judged
 * by the rate around it, so a steady 10 cps pays in full. Returns the new state and `paid`,
 * the number of full-value clicks the run is worth.
 */
export function rateClicks(state, times) {
  let { rate, last } = state;
  let paid = 0;
  for (const t of times) {
    const decayed = last == null ? 0 : rate * Math.exp(-Math.max(0, t - last) / 1000 / CLICK_RATE_TAU);
    paid += clickEfficiency(decayed + 0.5 / CLICK_RATE_TAU);
    rate = decayed + 1 / CLICK_RATE_TAU;
    last = t;
  }
  return { rate, last, paid };
}

/** The moving clicks/s average at time `t`. */
export const clickRateAt = (state, t) => (state.last == null ? 0 : state.rate * Math.exp(-Math.max(0, t - state.last) / 1000 / CLICK_RATE_TAU));

export const UPGRADE_RTP = 0.9;
export const UPGRADE_MIN_CHANCE = 0.01;
export const UPGRADE_MAX_CHANCE = 0.8;
export const UPGRADE_MAX_ITEMS = 10;

export function upgradeChance(inputValue, targetPrice) {
  if (!(targetPrice > 0)) return 0;
  return (inputValue / targetPrice) * UPGRADE_RTP;
}

export function wearOf(float) {
  for (const b of WEAR_BUCKETS) if (float < b.max) return b.key;
  return "BS";
}

export const priceKey = (d) => `${d.itemId}|${d.phase ?? ""}|${d.wear ?? "-"}|${d.stattrak ? 1 : 0}`;

/** Weapon cases need a key; capsules don't. */
export const needsKey = (c) => c.kind === "case";

/** Tiers present in a case, with odds renormalised over the tiers it has. */
export function tierOdds(c) {
  const present = TIERS.filter((t) => c.contents[t].length > 0);
  const total = present.reduce((s, t) => s + TIER_ODDS[t], 0);
  return present.map((t) => [t, TIER_ODDS[t] / total]);
}

export function pickWeighted(entries, r) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of entries) {
    acc += w / total;
    if (r < acc) return v;
  }
  return entries[entries.length - 1][0];
}

export const pickTier = (c, r) => pickWeighted(tierOdds(c), r);

export const phaseEntries = (item) => (item.phases ?? []).map((p) => [p.name, PHASE_WEIGHTS[p.name] ?? 1]);

export const canStatTrak = (item) => item.stattrak && item.kind !== "gloves";

/**
 * Turn seven uniform floats into a concrete drop:
 * r[0] tier, r[1] item, r[2] phase, r[3] wear bucket, r[4] float in bucket, r[5] StatTrak, r[6] pattern seed.
 */
export function resolveDrop(c, getItem, r) {
  const pool = c.contents[pickTier(c, r[0])];
  const item = getItem(pool[Math.floor(r[1] * pool.length)]);
  const phase = item.phases ? pickWeighted(phaseEntries(item), r[2]) : null;

  let float = null;
  if (item.minFloat != null && item.maxFloat != null) {
    const bucket = pickWeighted(
      WEAR_BUCKETS.map((b) => [b, b.weight]),
      r[3],
    );
    const raw = bucket.min + r[4] * (bucket.max - bucket.min);
    float = item.minFloat + raw * (item.maxFloat - item.minFloat);
  }

  return {
    itemId: item.id,
    phase,
    float,
    wear: float == null ? null : wearOf(float),
    stattrak: canStatTrak(item) && r[5] < STATTRAK_ODDS,
    seed: item.kind === "sticker" ? null : Math.floor(r[6] * 1001),
  };
}

/** A random float that lands in `wear` and inside the item's own range. */
export function floatInWear(item, wear, r) {
  if (item.minFloat == null || item.maxFloat == null || wear == null) return null;
  const b = WEAR_BUCKETS.find((w) => w.key === wear);
  const lo = Math.max(item.minFloat, b.min);
  const hi = Math.min(item.maxFloat, b.max);
  return lo + r * (hi - lo);
}

/** Every priced variant of an item. */
export function variants(item) {
  const out = [];
  for (const phase of item.phases?.map((p) => p.name) ?? [null])
    for (const stattrak of canStatTrak(item) ? [false, true] : [false])
      for (const wear of item.wears.length ? item.wears : [null]) out.push({ itemId: item.id, phase, wear, stattrak });
  return out;
}

// ---------- bets (plinko, flashbang, b-hop) ----------

export const BET_MIN = 0.01;
export const BET_MAX = 10_000;

// ---------- plinko ----------
// Stake's multiplier tables. With a fair 50/50 bounce at every peg each one pays back
// about 99% on average (binomial odds per slot).

export const PLINKO_ROWS = [8, 12, 16];
export const PLINKO_RISKS = ["low", "medium", "high"];
export const PLINKO_TABLES = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
    high: [170, 24, 8.1, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8.1, 24, 170],
  },
  16: {
    low: [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};
/** How long the browser's ball takes to fall (ms), so the live feed can wait for it. */
export const PLINKO_DROP_MS = (rows) => 400 + rows * 190;

// ---------- flashbang (crash) ----------
// One global round at a time. The multiplier grows as e^(FB_GROWTH × ms) from 1.00x
// (2x after ~11.6 s, 10x after ~38 s) until the flashbang pops at the crash point.
// P(crash point >= x) = 0.99 / x, and cashing out at x wins when the crash point is at least
// x, so every target pays back 99% on average.

export const FB_GROWTH = 0.00006;
/** Time between a pop and the next round's start; bets are open throughout. */
export const FB_INTERMISSION_MS = 10_000;
export const FB_MAX = 1000;
export const FB_AUTO_MIN = 1.01;

/** Multiplier `ms` into a round, floored to cents. */
export const fbMultiplierAt = (ms) => Math.floor(Math.exp(FB_GROWTH * Math.max(0, ms)) * 100 + 1e-9) / 100;
/** Milliseconds into a round at which the multiplier reaches `x`. */
export const fbTimeFor = (x) => Math.log(x) / FB_GROWTH;

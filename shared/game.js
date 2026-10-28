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
  battleRounds: {
    name: "Battle size",
    unit: "cases per battle",
    levels: [
      { value: 5, cost: 0 },
      { value: 10, cost: 75 },
      { value: 15, cost: 250 },
      { value: 20, cost: 750 },
      { value: 25, cost: 1500 },
      { value: 30, cost: 3000 },
      { value: 35, cost: 5000 },
    ],
  },
  clickPower: {
    name: "Click power",
    unit: "per click",
    levels: [
      { value: 0.05, cost: 0 },
      { value: 0.1, cost: 25 },
      { value: 0.2, cost: 125 },
      { value: 0.35, cost: 500 },
      { value: 0.5, cost: 1500 },
      { value: 0.75, cost: 4000 },
      { value: 1, cost: 10000 },
    ],
  },
};

export const NO_PERKS = { multiOpen: 0, clickPower: 0, offlineIncome: 0, battleRounds: 0 };

/** Offline income only counts gaps of at least this long, and pays at most this many hours. */
export const OFFLINE_MIN_GAP_MS = 5 * 60_000;
export const OFFLINE_CAP_HOURS = 12;

/** Current value of a perk for an account's perk levels. */
export const perkValue = (perks, id) => PERKS[id].levels[perks?.[id] ?? 0].value;

/** Upgrader: chance = (your value / target price) × UPGRADE_RTP, kept inside these bounds. */
// ---------- clicker speed limit ----------
// Up to CLICK_CPS_LIMIT clicks per second pay full value. Past that, every click is worth
// e^(-CLICK_FALLOFF × excess): 14 cps pays 50%, 17 cps 18%, 22 cps 3%.
export const CLICK_CPS_LIMIT = 12;
export const CLICK_FALLOFF = Math.LN2 / 2;
/** Time constant (s) of the moving click-rate average. */
export const CLICK_RATE_TAU = 1;

export const clickEfficiency = (cps) => (cps <= CLICK_CPS_LIMIT ? 1 : Math.exp(-CLICK_FALLOFF * (cps - CLICK_CPS_LIMIT)));

/**
 * Rate a run of clicks. `state` is { rate, last } (the moving clicks/s average and the time of
 * the previous click, ms); `times` are click times in ms, oldest first. Each click is judged
 * by the rate around it, so a steady 12 cps pays in full. Returns the new state and `paid`,
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

// ---------- b-hop ----------
// A lane of tiles; one of them gives way. Each jump lands safely with probability `p`
// (independently), so after k safe jumps the multiplier is 0.99 / p^k: cashing out at
// any point pays back 99% on average.

export const BHOP_DIFFICULTIES = {
  easy: { name: "Easy", p: 0.9, steps: 24 },
  medium: { name: "Medium", p: 0.8, steps: 20 },
  hard: { name: "Hard", p: 0.6, steps: 15 },
  expert: { name: "Expert", p: 0.4, steps: 10 },
};
export const BHOP_RTP = 0.99;
export const bhopMultiplier = (difficulty, step) =>
  step <= 0 ? 1 : Math.floor((BHOP_RTP / Math.pow(BHOP_DIFFICULTIES[difficulty].p, step)) * 100 + 1e-9) / 100;

// ---------- case battles ----------

export const BATTLE_SIZES = [2, 3, 4];
/** Hard cap; how many cases a player can put in a battle comes from the battleRounds perk. */
export const BATTLE_MAX_ROUNDS = 35;
/** Each round: the reels spin for BATTLE_SPIN_MS, then a pause before the next. */
export const BATTLE_SPIN_MS = 4000;
export const BATTLE_ROUND_MS = 5500;

/** Battle reels: tiles per strip and the one the winning item sits on. */
export const BATTLE_REEL_LEN = 32;
export const BATTLE_WIN_AT = 27;
const BATTLE_FILLER_WEIGHT = { milspec: 1250, restricted: 250, classified: 50, covert: 10, gold: 2 };

/**
 * One battle reel, made by the server so every viewer sees the same strip: the item id
 * on each tile (the winner at BATTLE_WIN_AT) and where on the winning tile the marker
 * stops (0–1 from its top edge). `r` returns uniform floats in [0, 1).
 */
export function battleReel(c, winnerId, r) {
  const tiers = TIERS.filter((t) => c.contents[t]?.length).map((t) => [t, BATTLE_FILLER_WEIGHT[t]]);
  const ids = Array.from({ length: BATTLE_REEL_LEN }, (_, k) => {
    if (k === BATTLE_WIN_AT) return winnerId;
    const pool = c.contents[pickWeighted(tiers, r())];
    return pool[Math.floor(r() * pool.length)];
  });
  return { ids, stop: Math.round((0.15 + r() * 0.7) * 1000) / 1000 };
}

// ---------- defuse (mines) ----------
// A 5×5 grid with `bombs` C4s. After k safe tiles the multiplier is 0.99 divided by
// the chance of surviving k picks, C(25-b, k) / C(25, k): 99% back on average.

export const DEFUSE_TILES = 25;
export const DEFUSE_RTP = 0.99;
export function defuseMultiplier(bombs, k) {
  let m = DEFUSE_RTP;
  for (let i = 0; i < k; i++) m *= (DEFUSE_TILES - i) / (DEFUSE_TILES - bombs - i);
  return k <= 0 ? 1 : Math.floor(m * 100 + 1e-9) / 100;
}

// ---------- roulette ----------
// The classic CS-site wheel: 15 numbers, 0 is green (14x), 1–7 are T (2x) and 8–14 are
// CT (2x). One shared round: bets for ROULETTE_BET_MS, then a ROULETTE_SPIN_MS spin
// that everyone sees land on the same number, then the result for ROULETTE_RESULT_MS.

export const ROULETTE_COLORS = ["t", "ct", "green"];
export const ROULETTE_PAYOUT = { t: 2, ct: 2, green: 14 };
/** The order numbers sit in on the wheel's strip. */
export const ROULETTE_WHEEL = [1, 14, 2, 13, 3, 12, 4, 0, 11, 5, 10, 6, 9, 7, 8];
export const rouletteColor = (n) => (n === 0 ? "green" : n <= 7 ? "t" : "ct");
export const ROULETTE_BET_MS = 20_000;
export const ROULETTE_SPIN_MS = 6000;
export const ROULETTE_RESULT_MS = 3000;

// ---------- coinflip ----------

/** How long the coin spins (ms), after a short lead-in once the second player joins. */
export const FLIP_MS = 3500;
export const FLIP_LEAD_MS = 1200;

// ---------- jackpot ----------

/** Countdown once two players are in, the spin, and how long the winner is shown. */
export const JP_TIMER_MS = 45_000;
export const JP_SPIN_MS = 7000;
export const JP_RESULT_MS = 5000;
export const JP_MAX_ITEMS = 10; // per deposit
export const JP_MIN_DEPOSIT = 0.1; // USD

// ---------- daily spin ----------
// A free wheel once every DAILY_SPIN_EVERY_MS. Prizes are balance; weights set how
// often each comes up (about $2.27 a day on average).

export const DAILY_SPIN_EVERY_MS = 24 * 3_600_000;
export const DAILY_SPIN_MS = 5500;
export const DAILY_PRIZES = [
  { usd: 0.25, weight: 30 },
  { usd: 0.5, weight: 25 },
  { usd: 1, weight: 20 },
  { usd: 2, weight: 12 },
  { usd: 5, weight: 7 },
  { usd: 10, weight: 4 },
  { usd: 25, weight: 1.5 },
  { usd: 100, weight: 0.5 },
];

// ---------- keno ----------
// A 7×7 grid. Pick 1–10 tiles; the server draws KENO_DRAWS. KENO_TABLES[picks][hits] is
// the multiplier; each row pays back about 99% (hypergeometric odds).

export const KENO_TILES = 49;
export const KENO_DRAWS = 10;
export const KENO_MAX_PICKS = 10;
export const KENO_TABLES = {"1":[0,4.85],"2":[0,1.39,13.8],"3":[0,0.83,4.44,35.9],"4":[0,0.63,2.24,11.6,110],"5":[0,0,1.4,8.15,52.4,621],"6":[0,0,1,4.35,21.5,157,2341],"7":[0,0,0.79,2.68,11,60.9,553,10000],"8":[0,0,0,1.76,8.98,45,311,3648,10000],"9":[0,0,0,1.31,5.46,23.5,133,1156,10000,10000],"10":[0,0,0,1.02,3.58,13.6,65.7,461,5337,10000,10000]};
/** How long the browser takes to reveal the draw (ms). */
export const KENO_REVEAL_MS = 1600;

// ---------- towers ----------
// Climb as far as you like: each floor has `doors` doors and `ts` of them hide a T.
// After k safe floors the multiplier is 0.99 / p^k with p = (doors - ts) / doors.

export const TOWER_DIFFICULTIES = {
  easy: { name: "Easy", doors: 4, ts: 1 },
  medium: { name: "Medium", doors: 3, ts: 1 },
  hard: { name: "Hard", doors: 2, ts: 1 },
  expert: { name: "Expert", doors: 3, ts: 2 },
};
export const TOWER_MAX_MULT = 1_000_000;
export function towerMultiplier(difficulty, floors) {
  const d = TOWER_DIFFICULTIES[difficulty];
  const p = (d.doors - d.ts) / d.doors;
  return floors <= 0 ? 1 : Math.min(TOWER_MAX_MULT, Math.floor((0.99 / p ** floors) * 100 + 1e-9) / 100);
}

// ---------- bot race ----------
// Five bots race in one shared round. Each round they get new chances to win (shown as
// odds paying 0.99 / chance), bets are taken for RACE_BET_MS, the race runs for up to
// RACE_RUN_MS, then the result shows for RACE_RESULT_MS.

export const RACE_BOTS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"];
export const RACE_BET_MS = 20_000;
export const RACE_RUN_MS = 11_000;
export const RACE_RESULT_MS = 4000;
/** Progress checkpoints per bot path, evenly spaced in time over its finish time. */
export const RACE_STEPS = 24;

// ---------- Blackjack ----------
// Shared tables of up to BJ_SEATS players. Bets are taken for BJ_BET_MS after the first
// one, then everyone plays their hand at the same time within BJ_PLAY_MS, the dealer
// draws one card every BJ_DEALER_CARD_MS, and the result shows for BJ_RESULT_MS.

export const BJ_SEATS = 4;
export const BJ_BET_MS = 12_000;
export const BJ_PLAY_MS = 30_000;
export const BJ_DEALER_CARD_MS = 800;
export const BJ_RESULT_MS = 6000;

// ---------- Chat rain ----------
// A rain splits the rainer's own money evenly among everyone else online. How big the
// effect on everyone's screen is goes by log10 of the amount: $1–9 is level 0, $10–99
// level 1, ... $100,000 and up level 5.

export const RAIN_LEVELS = ["Drizzle", "Shower", "Downpour", "Storm", "Thunderstorm", "Monsoon"];
export const rainLevel = (usd) => Math.max(0, Math.min(RAIN_LEVELS.length - 1, Math.floor(Math.log10(Math.max(1, usd)))));
export const CHAT_MAX_LEN = 200;

// ---------- Video poker (Jacks or Better, 9/6) ----------
// Deal five, hold any, draw once. Pays are what comes back per $1 bet (the bet included).
// With perfect play this table pays back 99.54%.

export const POKER_HANDS = [
  { id: "royal", name: "Royal flush", pay: 800 },
  { id: "straightFlush", name: "Straight flush", pay: 50 },
  { id: "quads", name: "Four of a kind", pay: 25 },
  { id: "fullHouse", name: "Full house", pay: 9 },
  { id: "flush", name: "Flush", pay: 6 },
  { id: "straight", name: "Straight", pay: 4 },
  { id: "trips", name: "Three of a kind", pay: 3 },
  { id: "twoPair", name: "Two pair", pay: 2 },
  { id: "jacks", name: "Jacks or better", pay: 1 },
];
export const POKER_RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
export const POKER_SUITS = ["s", "h", "d", "c"];

/** The paying hand five cards ({ r, s }) make, or null. */
export function pokerHand(cards) {
  const v = cards.map((c) => POKER_RANKS.indexOf(c.r) + 2).sort((a, b) => a - b);
  const flush = cards.every((c) => c.s === cards[0].s);
  const wheel = v.join() === "2,3,4,5,14";
  const straight = wheel || v.every((x, i) => i === 0 || x === v[i - 1] + 1);
  const counts = {};
  for (const x of v) counts[x] = (counts[x] ?? 0) + 1;
  const groups = Object.entries(counts)
    .map(([rank, n]) => ({ rank: Number(rank), n }))
    .sort((a, b) => b.n - a.n || b.rank - a.rank);
  let id = null;
  if (straight && flush) id = v[0] === 10 ? "royal" : "straightFlush";
  else if (groups[0].n === 4) id = "quads";
  else if (groups[0].n === 3 && groups[1].n === 2) id = "fullHouse";
  else if (flush) id = "flush";
  else if (straight) id = "straight";
  else if (groups[0].n === 3) id = "trips";
  else if (groups[0].n === 2 && groups[1].n === 2) id = "twoPair";
  else if (groups[0].n === 2 && groups[0].rank >= 11) id = "jacks";
  return id ? POKER_HANDS.find((x) => x.id === id) : null;
}

// ---------- Bomb plant ----------
// One shared round: the T plants at A or B, then the CTs retake and the bomb either
// explodes or is defused, four equally likely outcomes. Bet on the site, on how it ends,
// or on both at once. Bets are taken for BP_BET_MS, the round plays for BP_RUN_MS (the
// same on every screen), then the result shows for BP_RESULT_MS.

export const BP_BET_MS = 20_000;
export const BP_RUN_MS = 10_000;
export const BP_RESULT_MS = 4000;
/** Inside the round (ms): the T reaches the site, the bomb is planted, the round ends. */
export const BP_ARRIVE_MS = 3000;
export const BP_PLANT_MS = 4200;
export const BP_END_MS = 8800;
export const BP_PICKS = {
  A: { label: "A site", pays: 1.98, wins: (o) => o.site === "A" },
  B: { label: "B site", pays: 1.98, wins: (o) => o.site === "B" },
  boom: { label: "Explodes", pays: 1.98, wins: (o) => o.result === "boom" },
  defuse: { label: "Defused", pays: 1.98, wins: (o) => o.result === "defuse" },
  "A-boom": { label: "A + explodes", pays: 3.96, wins: (o) => o.site === "A" && o.result === "boom" },
  "A-defuse": { label: "A + defused", pays: 3.96, wins: (o) => o.site === "A" && o.result === "defuse" },
  "B-boom": { label: "B + explodes", pays: 3.96, wins: (o) => o.site === "B" && o.result === "boom" },
  "B-defuse": { label: "B + defused", pays: 3.96, wins: (o) => o.site === "B" && o.result === "defuse" },
};
export const BP_OUTCOMES = [
  { site: "A", result: "boom" },
  { site: "A", result: "defuse" },
  { site: "B", result: "boom" },
  { site: "B", result: "defuse" },
];

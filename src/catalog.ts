import type { Case, Catalog, Drop, Item, PriceTable, Tier } from "./types";
import { PHASE_WEIGHTS, STATTRAK_ODDS, TIERS, TIER_ODDS, WEAR_BUCKETS, wearOf } from "./odds";

let catalog: Catalog;

export async function loadCatalog(): Promise<Catalog> {
  const res = await fetch(`${import.meta.env.BASE_URL}data/catalog.json`);
  if (!res.ok) throw new Error(`catalog.json: HTTP ${res.status}`);
  catalog = await res.json();
  return catalog;
}

export const getCatalog = () => catalog;
export const getItem = (id: string): Item => catalog.items[id];
export const getCase = (id: string): Case | undefined => catalog.cases.find((c) => c.id === id);
export const openCost = (c: Case) => round2(c.price + catalog.keyPrice);

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Tiers present in a case, with odds renormalised if a tier is empty (some early cases). */
export function tierOdds(c: Case): [Tier, number][] {
  const present = TIERS.filter((t) => c.contents[t].length > 0);
  const total = present.reduce((s, t) => s + TIER_ODDS[t], 0);
  return present.map((t) => [t, TIER_ODDS[t] / total]);
}

function pickWeighted<T>(entries: [T, number][], r: number): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of entries) {
    acc += w / total;
    if (r < acc) return v;
  }
  return entries[entries.length - 1][0];
}

export function pickTier(c: Case, r: number): Tier {
  return pickWeighted(tierOdds(c), r);
}

function phaseEntries(item: Item): [string, number][] {
  return (item.phases ?? []).map((p) => [p.name, PHASE_WEIGHTS[p.name] ?? 1]);
}

/**
 * Turn eight uniform floats into a concrete drop:
 * r[0] tier, r[1] item, r[2] phase, r[3] wear bucket, r[4] float in bucket, r[5] StatTrak, r[6] seed.
 */
export function resolveDrop(c: Case, r: number[]): Drop {
  const tier = pickTier(c, r[0]);
  const pool = c.contents[tier];
  const item = getItem(pool[Math.floor(r[1] * pool.length)]);
  const phase = item.phases ? pickWeighted(phaseEntries(item), r[2]) : null;

  let float: number | null = null;
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
    stattrak: item.stattrak && item.kind !== "gloves" && r[5] < STATTRAK_ODDS,
    seed: Math.floor(r[6] * 1001),
  };
}

function priceTable(item: Item, phase: string | null): PriceTable {
  if (item.phases) return (item.phases.find((p) => p.name === phase) ?? item.phases[0]).prices;
  return item.prices ?? {};
}

export function priceOf(d: Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">): number {
  const table = priceTable(getItem(d.itemId), d.phase);
  const row = table[d.wear ?? "-"] ?? Object.values(table)[0];
  if (!row) return 0;
  return (d.stattrak ? row[1] : null) ?? row[0];
}

/** Expected market value of one item drawn from this item's distribution. */
function itemEV(item: Item): number {
  const phases: [string | null, number][] = item.phases ? phaseEntries(item) : [[null, 1]];
  const phaseTotal = phases.reduce((s, [, w]) => s + w, 0);
  const stChance = item.stattrak && item.kind !== "gloves" ? STATTRAK_ODDS : 0;

  // Probability of each wear given the item's float range.
  const wearProb = new Map<string, number>();
  if (item.minFloat == null || item.maxFloat == null) wearProb.set("-", 1);
  else {
    const span = item.maxFloat - item.minFloat;
    for (const b of WEAR_BUCKETS) {
      // Raw bucket [b.min, b.max) maps to final [lo, hi); split it by the wear boundaries it crosses.
      const lo = item.minFloat + b.min * span;
      const hi = item.minFloat + b.max * span;
      for (const w of WEAR_BUCKETS) {
        const overlap = Math.max(0, Math.min(hi, w.max) - Math.max(lo, w.min));
        if (overlap > 0 && hi > lo) wearProb.set(w.key, (wearProb.get(w.key) ?? 0) + (b.weight * overlap) / (hi - lo));
      }
    }
  }

  let ev = 0;
  for (const [phase, pw] of phases) {
    for (const [wear, p] of wearProb) {
      const base = { itemId: item.id, phase, wear: wear === "-" ? null : (wear as Drop["wear"]) };
      const v = (1 - stChance) * priceOf({ ...base, stattrak: false }) + stChance * priceOf({ ...base, stattrak: true });
      ev += (pw / phaseTotal) * p * v;
    }
  }
  return ev;
}

const evCache = new Map<string, number>();
export function caseEV(c: Case): number {
  if (!evCache.has(c.id)) {
    let ev = 0;
    for (const [tier, p] of tierOdds(c)) {
      const pool = c.contents[tier];
      ev += (p / pool.length) * pool.reduce((s, id) => s + itemEV(getItem(id)), 0);
    }
    evCache.set(c.id, ev);
  }
  return evCache.get(c.id)!;
}

/** Lowest and highest market price an item can sell for. */
export function priceRange(item: Item): [number, number] {
  const tables = item.phases ? item.phases.map((p) => p.prices) : [item.prices ?? {}];
  const all = tables.flatMap((t) => Object.values(t).flatMap((row) => (row ?? []).filter((v): v is number => v != null)));
  return [Math.min(...all), Math.max(...all)];
}

export function imageOf(d: Pick<Drop, "itemId" | "phase">): string {
  const item = getItem(d.itemId);
  return item.phases?.find((p) => p.name === d.phase)?.image ?? item.image;
}

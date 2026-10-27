import type { Case, Catalog, Drop, Item, Prices } from "./types";
import { STATTRAK_ODDS, WEAR_BUCKETS, canStatTrak, needsKey, phaseEntries, priceKey, tierOdds, variants } from "./odds";

let catalog: Catalog;
let prices: Prices = {};
let pricesVersion = 0;

export async function loadCatalog(): Promise<Catalog> {
  const [cat, p] = await Promise.all([getJson<Catalog>("/api/catalog"), getJson<PricesResponse>("/api/prices")]);
  catalog = cat;
  applyPrices(p);
  return catalog;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

interface PricesResponse {
  version: number;
  full: boolean;
  prices: Prices;
}

/** Pull whatever changed since our version. Returns false if we were already current. */
export async function refreshPrices(serverVersion: number): Promise<boolean> {
  if (serverVersion === pricesVersion) return false;
  applyPrices(await getJson<PricesResponse>(`/api/prices?since=${pricesVersion}`));
  return true;
}

function applyPrices(p: PricesResponse) {
  prices = p.full ? p.prices : { ...prices, ...p.prices };
  pricesVersion = p.version;
  evCache.clear();
}

export const getCatalog = () => catalog;
export const getItem = (id: string): Item => catalog.items[id];
export const getCase = (id: string): Case | undefined => catalog.cases.find((c) => c.id === id);
/** Market price of the container itself; null when it has no listing (then it can't be opened). */
export const casePrice = (c: Case): number | null => prices[`case|${c.id}`] ?? null;
export const keyCost = (c: Case) => (needsKey(c) ? catalog.keyPrice : 0);
export const openCost = (c: Case) => round2((casePrice(c) ?? 0) + keyCost(c));
/** Containers that can be opened right now. */
export const openableCases = () => catalog.cases.filter((c) => casePrice(c) != null);

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function priceOf(d: Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">): number {
  return prices[priceKey(d)] ?? 0;
}

/** Expected market value of one item drawn from this item's distribution. */
function itemEV(item: Item): number {
  const phases: [string | null, number][] = item.phases ? phaseEntries(item) : [[null, 1]];
  const phaseTotal = phases.reduce((s, [, w]) => s + w, 0);
  const stChance = canStatTrak(item) ? STATTRAK_ODDS : 0;

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
  const all = variants(item).map(priceOf);
  return [Math.min(...all), Math.max(...all)];
}

export function imageOf(d: Pick<Drop, "itemId" | "phase">): string {
  const item = getItem(d.itemId);
  return item.phases?.find((p) => p.name === d.phase)?.image ?? item.image;
}

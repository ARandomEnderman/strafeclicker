import type { Case, Catalog, Drop, Item, Prices } from "./types";
import { needsKey, priceKey, variants } from "./odds";

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
}

export const getCatalog = () => catalog;
export const getItem = (id: string): Item => catalog.items[id];
export const getCase = (id: string): Case | undefined => catalog.cases.find((c) => c.id === id);
/** Market price of the container itself; null when it has no listing (then it can't be opened). */
export const casePrice = (c: Case): number | null => prices[`case|${c.id}`] ?? null;
export const keyCost = (c: Case) => (needsKey(c) ? catalog.keyPrice : 0);
/** Percent off case openings while a case sale event runs (set by site.ts). */
let caseSale = 0;
export const setCaseSale = (pct: number) => (caseSale = pct);
export const caseSalePct = () => caseSale;
export const openCost = (c: Case) => round2((((casePrice(c) ?? 0) + keyCost(c)) * (100 - caseSale)) / 100);
/** What an opening costs without the sale. */
export const fullOpenCost = (c: Case) => round2((casePrice(c) ?? 0) + keyCost(c));
/** Containers that can be opened right now. */
export const openableCases = () => catalog.cases.filter((c) => casePrice(c) != null);

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function priceOf(d: Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">): number {
  return prices[priceKey(d)] ?? 0;
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

import type { OwnedItem, ServerStatus } from "./types";
import { priceOf, refreshPrices } from "./catalog";
import { getState } from "./state";

// The server decides when prices change; this module only listens.

let status: ServerStatus | null = null;
let connected = false;
/** server clock - local clock, so a wrong local clock can't skew the countdown. */
let clockOffset = 0;

export const getStatus = () => status;
export const isConnected = () => connected;
export const serverNow = () => Date.now() + clockOffset;

/** Value of every inventory item just before and just after one price update. */
export interface InventoryChange {
  items: { drop: OwnedItem; before: number; after: number }[];
}

const statusListeners = new Set<() => void>();
const priceListeners = new Set<(change: InventoryChange) => void>();
const pageListeners = new Set<() => void>();

export function onStatus(fn: () => void) {
  statusListeners.add(fn);
}
/** Fires after every price update that changed something. */
export function onPrices(fn: (change: InventoryChange) => void) {
  priceListeners.add(fn);
  return () => priceListeners.delete(fn);
}
/** Like onPrices, but dropped when the user navigates to another page. */
export function onPricesForPage(fn: () => void) {
  pageListeners.add(fn);
}
export function clearPageListeners() {
  pageListeners.clear();
}

let updating = Promise.resolve();

export function startLive() {
  const es = new EventSource("/api/events");
  es.addEventListener("status", (e) => {
    const s: ServerStatus = JSON.parse((e as MessageEvent).data);
    clockOffset = s.now - Date.now();
    status = s;
    connected = true;
    statusListeners.forEach((fn) => fn());
    updating = updating.then(() => pull(s.version)).catch((err) => console.error("price refresh failed", err));
  });
  es.addEventListener("error", () => {
    // EventSource reconnects by itself; just show that we're offline meanwhile.
    connected = false;
    statusListeners.forEach((fn) => fn());
  });
}

async function pull(version: number) {
  const inv = getState().inventory;
  const before = new Map(inv.map((it) => [it.uid, priceOf(it)]));
  if (!(await refreshPrices(version))) return;

  const change: InventoryChange = { items: [] };
  for (const it of getState().inventory) {
    const was = before.get(it.uid);
    if (was == null) continue; // opened while the update was in flight
    change.items.push({ drop: it, before: was, after: priceOf(it) });
  }

  priceListeners.forEach((fn) => fn(change));
  pageListeners.forEach((fn) => fn());
}

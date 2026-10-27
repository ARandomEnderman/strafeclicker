import type { OwnedItem, ServerStatus } from "./types";
import { priceOf, refreshPrices } from "./catalog";
import { getState, subscribe } from "./state";

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

// Each item's price when this browser last showed it, so the popup can also say
// how much the inventory moved while the tab was closed.
const SEEN_KEY = "strafeclicker:seen";

function loadSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSeen() {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(Object.fromEntries(getState().inventory.map((it) => [it.uid, priceOf(it)]))));
  } catch {
    // Storage unavailable: the popup just won't cover time away.
  }
}

function emit(change: InventoryChange) {
  saveSeen();
  priceListeners.forEach((fn) => fn(change));
  pageListeners.forEach((fn) => fn());
}

// Other server events (live feed, game rounds): name -> handlers.
let es: EventSource | null = null;
const eventHandlers = new Map<string, Set<(data: any) => void>>();

function attach(name: string) {
  es?.addEventListener(name, (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    eventHandlers.get(name)?.forEach((fn) => fn(data));
  });
}

/** Listen for a named server-sent event. Returns an unsubscribe function. */
export function onServerEvent<T>(name: string, fn: (data: T) => void) {
  let set = eventHandlers.get(name);
  if (!set) {
    eventHandlers.set(name, (set = new Set()));
    attach(name);
  }
  set.add(fn);
  return () => void set.delete(fn);
}

export function startLive() {
  const seen = loadSeen();
  const away = getState()
    .inventory.filter((it) => seen[it.uid] != null)
    .map((it) => ({ drop: it, before: seen[it.uid], after: priceOf(it) }));
  if (away.some((r) => r.before !== r.after)) emit({ items: away });
  else saveSeen();
  subscribe(saveSeen); // new and sold items

  es = new EventSource("/api/events");
  for (const name of eventHandlers.keys()) attach(name);
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

  emit(change);
}

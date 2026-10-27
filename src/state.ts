import type { Case, OwnedItem } from "./types";
import { getItem, openCost, priceOf, resolveDrop, round2 } from "./catalog";
import { randomHex, rollFloats, sha256Hex } from "./fair";

// Everything is play money, stored in this browser only.

const KEY = "strafeclicker:v1";
export const STARTING_BALANCE = 250;
export const TOP_UP = 100;

interface FairState {
  serverSeed: string;
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  /** Seeds that have been rotated out, revealed for verification. */
  revealed: { serverSeed: string; serverSeedHash: string; clientSeed: string; lastNonce: number }[];
}

interface State {
  balance: number;
  inventory: OwnedItem[];
  stats: { opened: number; spent: number; unboxedValue: number; best: { name: string; value: number } | null };
  fair: FairState;
}

let state: State;
const listeners = new Set<() => void>();

export const getState = () => state;
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode / storage full: keep going in memory.
  }
  listeners.forEach((fn) => fn());
}

async function freshFair(clientSeed = randomHex(8)): Promise<FairState> {
  const serverSeed = randomHex(32);
  return { serverSeed, serverSeedHash: await sha256Hex(serverSeed), clientSeed, nonce: 0, revealed: [] };
}

export async function initState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = JSON.parse(raw);
  } catch {
    // Corrupt or unavailable storage: start over.
  }
  state ??= {
    balance: STARTING_BALANCE,
    inventory: [],
    stats: { opened: 0, spent: 0, unboxedValue: 0, best: null },
    fair: await freshFair(),
  };
  save();
}

export function topUp() {
  state.balance = round2(state.balance + TOP_UP);
  save();
}

export async function resetAll() {
  localStorage.removeItem(KEY);
  state = undefined as unknown as State;
  await initState();
}

export class InsufficientFunds extends Error {}

/** Charge for a case and roll it. The item goes straight into the inventory. */
export async function openCase(c: Case): Promise<OwnedItem> {
  const cost = openCost(c);
  if (state.balance < cost) throw new InsufficientFunds();
  state.balance = round2(state.balance - cost);

  const f = state.fair;
  const nonce = f.nonce++;
  const drop = resolveDrop(c, await rollFloats(f.serverSeed, f.clientSeed, nonce));
  const owned: OwnedItem = {
    ...drop,
    uid: randomHex(8),
    caseId: c.id,
    openedAt: Date.now(),
    proof: { serverSeedHash: f.serverSeedHash, clientSeed: f.clientSeed, nonce },
  };
  state.inventory.unshift(owned);

  const value = priceOf(owned);
  state.stats.opened++;
  state.stats.spent = round2(state.stats.spent + cost);
  state.stats.unboxedValue = round2(state.stats.unboxedValue + value);
  if (!state.stats.best || value > state.stats.best.value) state.stats.best = { name: getItem(owned.itemId).name, value };
  save();
  return owned;
}

export function sell(uids: string[]) {
  const set = new Set(uids);
  let total = 0;
  state.inventory = state.inventory.filter((it) => {
    if (!set.has(it.uid)) return true;
    total += priceOf(it);
    return false;
  });
  state.balance = round2(state.balance + total);
  save();
  return round2(total);
}

/** Reveal the current server seed and start a new one. */
export async function rotateSeed(clientSeed?: string) {
  const f = state.fair;
  const next = await freshFair(clientSeed?.trim() || f.clientSeed);
  next.revealed = [
    { serverSeed: f.serverSeed, serverSeedHash: f.serverSeedHash, clientSeed: f.clientSeed, lastNonce: f.nonce - 1 },
    ...f.revealed,
  ].slice(0, 20);
  state.fair = next;
  save();
}

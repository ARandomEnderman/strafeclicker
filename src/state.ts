import type { Account, Case, Drop, OwnedItem } from "./types";
import { round2 } from "./catalog";
import { perkValue } from "./odds";
import type { PerkId } from "../shared/game.js";

// The server owns the account (balance, inventory, every roll). This module just
// mirrors what it last said and forwards actions to it.

let account: Account;
const listeners = new Set<() => void>();

export const getState = () => account;
export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function set(next: Account) {
  account = next;
  listeners.forEach((fn) => fn());
}

export class InsufficientFunds extends Error {}

export class ServerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Show an account the server sent earlier (see `defer` below). */
export const applyAccount = (a: Account) => set(a);

/**
 * POST an action. With `defer`, the new account isn't shown yet: the caller applies
 * it with applyAccount once its animation is done, so the result isn't spoiled early.
 */
async function post<T>(action: string, body: object = {}, defer = false): Promise<T & { account: Account }> {
  const res = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.error === "auth") onLoggedOut();
    if (data.account) set(data.account);
    if (data.error === "insufficient") throw new InsufficientFunds(data.message);
    throw new ServerError(data.error ?? "http", data.message ?? `HTTP ${res.status}`);
  }
  if (!defer && data.account) set(data.account);
  return data;
}

/** Called when the server says the session is gone (expired, logged out elsewhere). */
let onLoggedOut = () => {};
export const setLoggedOutHandler = (fn: () => void) => (onLoggedOut = fn);

/** Load the logged-in account. Returns false if nobody is logged in. */
export async function initState(): Promise<boolean> {
  const res = await fetch("/api/me");
  if (res.status === 401) return false;
  if (!res.ok) throw new Error(`/api/me: HTTP ${res.status}`);
  set(await res.json());
  return true;
}

export async function register(username: string, password: string) {
  await post("register", { username, password });
}

export async function login(username: string, password: string) {
  await post("login", { username, password });
}

export async function logout() {
  await flushClicks();
  await post("logout").catch(() => undefined);
  location.reload();
}

// ---------- clicker ----------
// Clicks are counted locally and sent in small batches; the server decides how
// many count (it caps clicks per second).

let pendingClicks = 0;
let flushing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** What one click is worth right now. */
export const clickValue = () => perkValue(account.perks, "clickPower");

/** Balance including clicks that haven't reached the server yet. */
export const displayBalance = () => round2(account.balance + pendingClicks * clickValue());

export function click() {
  pendingClicks++;
  listeners.forEach((fn) => fn());
  flushTimer ??= setTimeout(() => void flushClicks(), 250);
}

export async function flushClicks(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  await flushing;
  if (!pendingClicks) return;
  const n = pendingClicks;
  pendingClicks = 0;
  flushing = post("click", { clicks: n })
    .then(() => undefined)
    .catch((err) => console.error("click flush failed", err))
    .finally(() => (flushing = null));
  await flushing;
}

// ---------- actions ----------

/** Open `count` of a case at once (up to the multi-open perk). */
export async function openCases(c: Case, count: number): Promise<OwnedItem[]> {
  await flushClicks();
  return (await post<{ items: OwnedItem[] }>("open", { caseId: c.id, count })).items;
}

/** Buy the next level of a perk. */
export async function buyPerk(perk: PerkId) {
  await flushClicks();
  return (await post<{ level: number }>("perk", { perk })).level;
}

export async function sell(uids: string[]): Promise<number> {
  return (await post<{ sold: number }>("sell", { uids })).sold;
}

/** The returned account must be passed to applyAccount after the spin. */
export async function upgrade(uids: string[], target: Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">) {
  return post<{ won: boolean; chance: number; item: OwnedItem | null }>("upgrade", { uids, target }, true);
}

export async function resetAll() {
  await flushClicks();
  await post("reset");
}

import type { Account, Case, Drop, OwnedItem } from "./types";
import { round2 } from "./catalog";
import { clickEfficiency, clickRateAt, perkValue, rateClicks } from "./odds";
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

/** The account as the server last sent it, before hiding items still being revealed. */
let latest: Account;

function set(next: Account) {
  const { offline, unlocked, ...rest } = next;
  latest = rest;
  account = withoutHidden(rest);
  listeners.forEach((fn) => fn());
  if (offline && offline.earned > 0) onOffline(offline);
  if (unlocked?.length) setTimeout(() => onUnlocked(unlocked), Math.max(0, quietUntil - Date.now()));
}

// Items a page is still revealing (a case reel spinning) stay out of the inventory, its
// count and its value until the page calls the returned reveal function, whatever the
// server sends in the meantime.
const hiddenItems = new Set<string>();
const withoutHidden = (a: Account): Account =>
  hiddenItems.size ? { ...a, inventory: a.inventory.filter((it) => !hiddenItems.has(it.uid)) } : a;

export function hideItems(uids: string[]) {
  uids.forEach((u) => hiddenItems.add(u));
  if (latest) account = withoutHidden(latest);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    uids.forEach((u) => hiddenItems.delete(u));
    account = withoutHidden(latest);
    listeners.forEach((fn) => fn());
  };
}

// Pages with a reveal animation hold achievement toasts back until it's done, so a
// "Rare special" toast can't give away what the reel is about to land on.
let quietUntil = 0;
export const holdToastsFor = (ms: number) => (quietUntil = Date.now() + ms);

/** Called when the server just unlocked achievements. */
let onUnlocked: (ids: string[]) => void = () => {};
export const setUnlockedHandler = (fn: typeof onUnlocked) => (onUnlocked = fn);

/** Called when the server just paid offline income. */
let onOffline: (o: NonNullable<Account["offline"]>) => void = () => {};
export const setOfflineHandler = (fn: typeof onOffline) => (onOffline = fn);

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
// Clicks are counted locally and sent in small batches with their timestamps; the
// server decides what they're worth (past 10 per second each click pays less). The
// local rate below mirrors its maths so the balance shown is the one it will credit.

let pendingTimes: number[] = [];
/** Full-value clicks the pending ones are worth. */
let pendingPaid = 0;
let rate = { rate: 0, last: null as number | null };
let flushing: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** What one full-speed click is worth right now. */
/** A click frenzy event's multiplier (set from the site state). */
let clickBoost = 1;
export const setClickBoost = (x: number) => (clickBoost = x);
export const clickValue = () => perkValue(account.perks, "clickPower") * clickBoost;

/** Current clicks per second (moving average) and the share of a click's value it pays. */
export function clickSpeed() {
  const cps = clickRateAt(rate, Date.now());
  return { cps, efficiency: clickEfficiency(cps) };
}

/** Balance including clicks that haven't reached the server yet, minus payouts not revealed yet. */
export const displayBalance = () => round2(account.balance + pendingPaid * clickValue() - hiddenPayouts);

// Winnings the server has already credited but the page is still animating (a plinko
// ball in flight). Hidden from the balance until revealed.
let hiddenPayouts = 0;
function hidePayout(usd: number) {
  hiddenPayouts = round2(hiddenPayouts + usd);
  listeners.forEach((fn) => fn());
  let done = false;
  return () => {
    if (done) return;
    done = true;
    hiddenPayouts = round2(hiddenPayouts - usd);
    listeners.forEach((fn) => fn());
  };
}

/** Register one click; returns what it earned. */
export function click(): number {
  const t = Date.now();
  const next = rateClicks(rate, [t]);
  rate = { rate: next.rate, last: next.last };
  pendingTimes.push(t);
  pendingPaid += next.paid;
  listeners.forEach((fn) => fn());
  flushTimer ??= setTimeout(() => void flushClicks(), 250);
  return next.paid * clickValue();
}

export async function flushClicks(): Promise<void> {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  await flushing;
  if (!pendingTimes.length) return;
  const times = pendingTimes;
  pendingTimes = [];
  pendingPaid = 0;
  flushing = post("click", { clicks: times.length, times })
    .then(() => undefined)
    .catch((err) => console.error("click flush failed", err))
    .finally(() => (flushing = null));
  await flushing;
}

// ---------- actions ----------

export interface PlinkoResult {
  path: number[];
  slot: number;
  mult: number;
  payout: number;
  stake: number;
  /** Show the payout in the balance (call when the ball lands). */
  reveal: () => void;
}

export async function flashbangAction<T = object>(action: "bet" | "cancel" | "cashout", body: object = {}) {
  await flushClicks();
  return post<T>("flashbang", { action, ...body });
}

/** Collect an achievement's reward, or every ready one (no id). */
export async function claimAchievement(id?: string) {
  return post<{ claimed: string[]; reward: number }>("claim", { id });
}

export async function tradeAction<T>(action: "list" | "inventory" | "offer" | "accept" | "decline" | "cancel", body: object = {}) {
  await flushClicks();
  return post<T>("trade", { action, ...body });
}

export async function friendsAction(action: "list" | "request" | "accept" | "remove", username?: string) {
  return post<import("./friends").FriendLists>("friends", { action, username });
}

export interface Profile {
  user: string;
  name: string;
  joinedAt: number;
  relation: "self" | "friends" | "incoming" | "outgoing" | "none";
  stats: {
    opened: number;
    best: { name: string; value: number } | null;
    battlesWon: number;
    achievements: number;
    achievementsTotal: number;
    bestWin: { value: number; game: string; mult: number } | null;
    favourite: string | null;
  };
  /** Pinned items and banner colour, shown to everyone. */
  showcase: { banner: string; items: OwnedItem[] };
  /** Only for friends and yourself. */
  online?: boolean;
  balance?: number;
  inventoryValue?: number;
  itemCount?: number;
  inventory?: OwnedItem[];
}

export async function getProfile(username: string) {
  return (await post<{ profile: Profile }>("profile", { username })).profile;
}

export interface ClanMember {
  user: string;
  name: string;
  role: "owner" | "member";
  joinedAt: number;
  online: boolean;
}
export interface Clan {
  id: number;
  name: string;
  tag: string;
  open: boolean;
  createdAt: number;
  weekWagered: number;
  max: number;
  members: ClanMember[];
  myRole: "owner" | "member" | null;
  requested: boolean;
  requests: { user: string; name: string; at: number }[];
}
export interface ClanOverview {
  mine: Clan | null;
  board: { rank: number; id: number; name: string; tag: string; open: boolean; members: number; wagered: number }[];
  cost: number;
  max: number;
}
export async function clansAction<T>(action: string, body: object = {}) {
  return post<T>("clans", { action, ...body });
}

export async function setShowcase(uids: string[], banner: string) {
  return post("profile", { action: "showcase", uids, banner });
}

export async function renameMe(name: string) {
  return post("profile", { action: "rename", name });
}

export async function battleAction(action: "create" | "join" | "bots" | "cancel", body: object) {
  await flushClicks();
  return post<{ id: number }>("battle", { action, ...body });
}

export interface BhopRun {
  difficulty: string;
  stake: number;
  step: number;
  mult: number;
}
export interface BhopResult {
  result?: "landed" | "fell" | "finished" | "cashed" | "cancelled";
  step?: number;
  /** Revealed when the run ends: the tile that gives way (null if the lane held). */
  breaksAt?: number | null;
  mult?: number;
  payout?: number;
  run: BhopRun | null;
}

export async function bracketAction(action: "create" | "join" | "bots" | "leave" | "pick", body: object) {
  await flushClicks();
  return post<{ id: number }>("bracket", { action, ...body });
}

export async function rpsAction(action: "create" | "join" | "bot" | "cancel" | "pick", body: object) {
  await flushClicks();
  return post<{ id: number }>("rps", { action, ...body });
}

export async function coinflipAction(action: "create" | "join" | "bot" | "cancel", body: object) {
  await flushClicks();
  return post<{ id: number }>("coinflip", { action, ...body });
}

export async function jackpotAction(body: { uids?: string[]; action?: "withdraw" }) {
  await flushClicks();
  return post("jackpot", body);
}

export async function adminAction<T = Record<string, unknown>>(action: string, body: object = {}) {
  return post<T>("admin", { action, ...body });
}

/** The free daily spin. The prize shows in the balance once `reveal` is called. */
export async function dailySpin() {
  const r = await post<{ slot: number; prize: number }>("spin", {});
  return { ...r, reveal: hidePayout(r.prize) };
}

export interface PokerRun {
  stake: number;
  hand: import("../shared/game.js").PokerCard[];
}
export async function pokerDeal(bet: number) {
  await flushClicks();
  return post<{ run: PokerRun }>("poker", { action: "deal", bet });
}
export const pokerState = () => post<{ run: PokerRun | null }>("poker", { action: "state" });
/** The draw. The payout shows in the balance once `reveal` is called (after the cards flip). */
export async function pokerDraw(hold: boolean[]) {
  const r = await post<{ hand: PokerRun["hand"]; result: string | null; payout: number }>("poker", { action: "draw", hold });
  return { ...r, reveal: hidePayout(r.payout) };
}

export interface KenoResult {
  drawn: number[];
  hits: number;
  mult: number;
  payout: number;
  stake: number;
  reveal: () => void;
}
export async function playKeno(bet: number, picks: number[]): Promise<KenoResult> {
  await flushClicks();
  const r = await post<Omit<KenoResult, "reveal">>("keno", { bet, picks });
  return { ...r, reveal: hidePayout(r.payout) };
}

export const sendChat = (text: string, channel: "global" | "clan" = "global") => post("chat", { text, channel });
export const redeemPromo = (code: string) => post<{ reward: string }>("promo", { code });
export const claimMission = (id?: string) => post<{ reward: number }>("missions", { id });
export const getLeaderboard = <T>() => post<{ board: T }>("leaderboard");

export async function blackjackAction(action: "bet" | "hit" | "stand" | "double", bet?: number) {
  await flushClicks();
  return post("blackjack", { action, bet });
}

export async function bombPlantBet(pick: string, bet: number) {
  await flushClicks();
  return post("bombplant", { pick, bet });
}

export async function raceBet(bot: number, bet: number) {
  await flushClicks();
  return post("race", { bot, bet });
}

export async function rouletteBet(color: string, bet: number) {
  await flushClicks();
  return post("roulette", { color, bet });
}

export interface TowerFloor {
  door: number;
  ts: number[];
}
export interface TowerRun {
  difficulty: string;
  stake: number;
  floors: TowerFloor[];
  mult: number;
  next: number;
}
export interface TowerResult {
  result?: "safe" | "caught" | "top" | "cashed" | "cancelled";
  floors?: TowerFloor[];
  mult?: number;
  payout?: number;
  run: TowerRun | null;
}
export async function towersAction(action: "state" | "start" | "pick" | "cashout", body: object = {}) {
  await flushClicks();
  return post<TowerResult>("towers", { action, ...body });
}

export interface DefuseRun {
  bombs: number;
  stake: number;
  revealed: number[];
  mult: number;
  next: number;
}
export interface DefuseResult {
  result?: "safe" | "boom" | "cleared" | "cashed" | "cancelled";
  tile?: number;
  /** Where the bombs were; sent once the round is over. */
  mines?: number[];
  mult?: number;
  payout?: number;
  run: DefuseRun | null;
}

export async function defuseAction(action: "state" | "start" | "reveal" | "cashout" | "auto", body: object = {}) {
  await flushClicks();
  return post<DefuseResult>("defuse", { action, ...body });
}

export async function bhopAction(action: "state" | "start" | "jump" | "cashout", body: object = {}, defer = false) {
  await flushClicks();
  return post<BhopResult>("bhop", { action, ...body }, defer);
}

export async function dropPlinko(bet: number, rows: number, risk: string): Promise<PlinkoResult> {
  await flushClicks();
  const r = await post<Omit<PlinkoResult, "reveal">>("plinko", { bet, rows, risk });
  return { ...r, reveal: hidePayout(r.payout) };
}

/** Open `count` of a case at once (up to the multi-open perk). */
/**
 * Open `count` of a case. The new items stay hidden from the inventory (and its value)
 * until `reveal` is called, when the reel has landed.
 */
export async function openCases(c: Case, count: number): Promise<{ items: OwnedItem[]; reveal: () => void }> {
  await flushClicks();
  const r = await post<{ items: OwnedItem[] }>("open", { caseId: c.id, count }, true);
  const reveal = hideItems(r.items.map((it) => it.uid));
  set(r.account);
  return { items: r.items, reveal };
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
/** Stake items on a target. A won item stays hidden until `reveal`, when the dial stops. */
export async function upgrade(uids: string[], target: Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">) {
  const r = await post<{ won: boolean; chance: number; item: OwnedItem | null }>("upgrade", { uids, target }, true);
  const reveal = hideItems(r.item ? [r.item.uid] : []);
  set(r.account);
  return { ...r, reveal };
}

export async function resetAll() {
  await flushClicks();
  await post("reset");
}

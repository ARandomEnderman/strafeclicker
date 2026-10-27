import type { Case, Drop, Item, Tier, WearKey } from "../src/types";

type Variant = Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">;

export const TIER_ODDS: Record<Tier, number>;
export const TIERS: Tier[];
export const STATTRAK_ODDS: number;
export const WEAR_BUCKETS: { key: WearKey; name: string; min: number; max: number; weight: number }[];
export const PHASE_WEIGHTS: Record<string, number>;
export type PerkId = "multiOpen" | "clickPower" | "offlineIncome";
export type PerkLevels = Record<PerkId, number>;
export const PERKS: Record<PerkId, { name: string; unit: string; levels: { value: number; cost: number }[] }>;
export const NO_PERKS: PerkLevels;
export function perkValue(perks: PerkLevels | undefined, id: PerkId): number;
export const OFFLINE_MIN_GAP_MS: number;
export const OFFLINE_CAP_HOURS: number;
export const UPGRADE_RTP: number;
export const UPGRADE_MIN_CHANCE: number;
export const UPGRADE_MAX_CHANCE: number;
export const UPGRADE_MAX_ITEMS: number;

export function upgradeChance(inputValue: number, targetPrice: number): number;
export function wearOf(float: number): WearKey;
export function priceKey(d: Variant): string;
export function needsKey(c: Case): boolean;
export function tierOdds(c: Case): [Tier, number][];
export function pickWeighted<T>(entries: [T, number][], r: number): T;
export function pickTier(c: Case, r: number): Tier;
export function phaseEntries(item: Item): [string, number][];
export function canStatTrak(item: Item): boolean;
export function resolveDrop(c: Case, getItem: (id: string) => Item, r: number[]): Drop;
export function floatInWear(item: Item, wear: WearKey | null, r: number): number | null;
export function variants(item: Item): Variant[];

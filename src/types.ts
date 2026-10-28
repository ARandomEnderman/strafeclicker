export type Tier = "milspec" | "restricted" | "classified" | "covert" | "gold";
export type WearKey = "FN" | "MW" | "FT" | "WW" | "BS";

export interface Phase {
  name: string;
  image: string;
}

export interface Item {
  id: string;
  name: string;
  weapon: string;
  finish: string | null;
  kind: "weapon" | "knife" | "gloves" | "sticker";
  tier: Tier;
  color: string;
  minFloat: number | null;
  maxFloat: number | null;
  /** Wears this skin can come in; empty for vanilla knives. */
  wears: WearKey[];
  stattrak: boolean;
  paintIndex: string | null;
  pattern: string | null;
  image: string;
  phases?: Phase[];
}

export interface Case {
  id: string;
  /** Weapon cases need a key; sticker and autograph capsules don't. */
  kind: "case" | "capsule" | "autograph";
  name: string;
  image: string;
  released: string | null;
  rareLabel: string;
  contents: Record<Tier, string[]>;
}

export interface Catalog {
  sources: Record<string, string>;
  keyPrice: number;
  cases: Case[];
  items: Record<string, Item>;
}

/**
 * Flat price map from the server, USD:
 *   "<itemId>|<phase or ''>|<wear or '-'>|<0|1 StatTrak>" and "case|<caseId>"
 */
export type Prices = Record<string, number>;

export interface ServerStatus {
  now: number;
  version: number;
  lastUpdateAt: number | null;
  nextUpdateAt: number | null;
  intervalMs: number;
  changed: number;
  error: string | null;
}

/** A specific rolled instance of an item. */
export interface Drop {
  itemId: string;
  phase: string | null;
  float: number | null;
  wear: WearKey | null;
  stattrak: boolean;
  /** Paint seed 0–1000, decides pattern placement. Null for stickers. */
  seed: number | null;
}

export interface OwnedItem extends Drop {
  uid: string;
  /** Case id it came from, or "upgrade". */
  source: string;
  obtainedAt: number;
}

/** Everything the server lets the browser see about its account. */
export interface Account {
  username: string;
  /** The name other players see (defaults to the username). */
  displayName: string;
  /** Only on the "admin" account. */
  isAdmin?: boolean;
  /** When the next free daily spin is available (ms). */
  nextSpinAt: number;
  balance: number;
  /** Upgrade-tree levels, see PERKS in shared/game.js. */
  perks: { multiOpen: number; clickPower: number; offlineIncome: number; battleRounds: number; maxBet: number };
  /** Present once, right after offline income was paid out. */
  offline?: { earned: number; seconds: number };
  inventory: OwnedItem[];
  stats: {
    opened: number;
    spent: number;
    unboxedValue: number;
    best: { name: string; value: number } | null;
    clicks: number;
    upgrades: number;
    upgradesWon: number;
    tiers: Partial<Record<Tier, number>>;
    games: Record<string, { played: number; wagered: number; won: number; bestMult: number; [k: string]: number }>;
    offlineEarned: number;
  };
  /** Achievement id -> time unlocked (ms). */
  achievements: Record<string, number>;
  /** Achievement id -> time its reward was claimed (ms). */
  claimed: Record<string, number>;
  /** Present once, right after achievements were unlocked. */
  unlocked?: string[];
  /** Today's three daily missions. */
  missions: {
    resetsAt: number;
    list: { id: string; tier: number; label: string; progress: number; target: number; money: boolean; reward: number; done: boolean; claimed: boolean }[];
  };
}

/** An entry in the live big-wins feed. */
export interface Win {
  id: number;
  user: string;
  name?: string;
  game: "case" | "upgrader" | "plinko" | "flashbang" | "bhop" | "battle" | "jackpot";
  /** Payout, USD. */
  value: number;
  stake: number;
  mult: number | null;
  at: number;
  /** The item won, for item games. */
  drop?: { itemId: string; phase: string | null; wear: string | null; stattrak: boolean };
  /** Case name, or e.g. the multiplier hit. */
  source?: string;
  label?: string;
}

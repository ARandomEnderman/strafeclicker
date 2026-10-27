export type Tier = "milspec" | "restricted" | "classified" | "covert" | "gold";
export type WearKey = "FN" | "MW" | "FT" | "WW" | "BS";
/** "-" is the price key for items without wear (vanilla knives). */
export type PriceKey = WearKey | "-";
/** [normal, stattrak] in USD; stattrak is null when the item can't be StatTrak. */
export type PriceTable = Partial<Record<PriceKey, [number, number | null]>>;

export interface Phase {
  name: string;
  image: string;
  prices: PriceTable;
}

export interface Item {
  id: string;
  name: string;
  weapon: string;
  finish: string | null;
  kind: "weapon" | "knife" | "gloves";
  tier: Tier;
  color: string;
  minFloat: number | null;
  maxFloat: number | null;
  stattrak: boolean;
  paintIndex: string | null;
  pattern: string | null;
  image: string;
  prices?: PriceTable;
  phases?: Phase[];
}

export interface Case {
  id: string;
  name: string;
  image: string;
  released: string | null;
  price: number;
  rareLabel: string;
  contents: Record<Tier, string[]>;
}

export interface Catalog {
  generatedAt: string;
  sources: Record<string, string>;
  keyPrice: number;
  cases: Case[];
  items: Record<string, Item>;
}

/** A specific rolled instance of an item. */
export interface Drop {
  itemId: string;
  phase: string | null;
  float: number | null;
  wear: WearKey | null;
  stattrak: boolean;
  /** Paint seed 0–1000, decides pattern placement. */
  seed: number;
}

export interface OwnedItem extends Drop {
  uid: string;
  caseId: string;
  openedAt: number;
  /** Provably-fair proof for this roll. */
  proof: { serverSeedHash: string; clientSeed: string; nonce: number };
}

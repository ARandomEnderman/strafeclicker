// Case contents and market prices.
//
// Sources:
//   - Case contents + skin metadata: ByMykel/CSGO-API (community dump of the game files)
//   - Prices: Skinport public API, USD. Skinport allows 8 requests per 5 minutes and
//     refreshes its listings every ~5 minutes. The price used is the lowest current
//     listing ("starting at"); Skinport's suggested price barely moves intra-day, so
//     it's only the fallback for items with nothing listed.
//
// Prices travel as one flat map, key -> USD:
//   "<itemId>|<phase or ''>|<wear or '-'>|<0|1 StatTrak>"   e.g. "skin-abc|Ruby|FN|1"
//   "case|<caseId>"                                         the case itself

const CRATES_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json";
const SKINS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json";
const STICKERS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/stickers.json";
// The default listing and the tradable-only listing each cover items the other misses.
export const PRICE_URLS = {
  main: "https://api.skinport.com/v1/items?app_id=730&currency=USD",
  tradable: "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0",
};
const SALES_URL = "https://api.skinport.com/v1/sales/history?app_id=730&currency=USD";

// Price of a CS2 case key on the Steam store.
export const KEY_PRICE = 2.49;
export const SOURCES = { contents: "ByMykel/CSGO-API", prices: "Steam Market lowest listing (USD); Skinport for Doppler phases" };

const WEARS = [
  { key: "FN", name: "Factory New", min: 0.0, max: 0.07 },
  { key: "MW", name: "Minimal Wear", min: 0.07, max: 0.15 },
  { key: "FT", name: "Field-Tested", min: 0.15, max: 0.38 },
  { key: "WW", name: "Well-Worn", min: 0.38, max: 0.45 },
  { key: "BS", name: "Battle-Scarred", min: 0.45, max: 1.0 },
];

/** Sticker rarities sit on the same 1-in-5 ladder (High Grade, Remarkable, Exotic, Extraordinary). */
const STICKER_TIER_BY_RARITY = {
  rarity_rare: "milspec",
  rarity_mythical: "restricted",
  rarity_legendary: "classified",
  rarity_ancient: "covert",
  rarity_contraband: "covert",
};

const TIER_BY_RARITY = {
  rarity_rare_weapon: "milspec",
  rarity_mythical_weapon: "restricted",
  rarity_legendary_weapon: "classified",
  rarity_ancient_weapon: "covert",
};

export async function fetchJson(url) {
  // Skinport rejects requests that don't accept brotli.
  const res = await fetch(url, { headers: { "Accept-Encoding": "br" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export const round2 = (n) => Math.round(n * 100) / 100;
const slug = (s) =>
  s.normalize("NFKD").replace(/[★™]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function kindOf(skin) {
  const cat = skin.category?.id ?? "";
  if (cat.includes("gloves")) return "gloves";
  if (cat.includes("melee")) return "knife";
  return "weapon";
}

/** Wears an item can actually come in, given its float range. */
function wearsFor(skin) {
  if (skin.min_float == null || skin.max_float == null) return []; // vanilla knife: no wear
  return WEARS.filter((w) => skin.min_float < w.max && skin.max_float > w.min).map((w) => w.key);
}

function hashName(name, wearKey, st) {
  let base = name;
  if (st) base = name.startsWith("★ ") ? `★ StatTrak™ ${name.slice(2)}` : `StatTrak™ ${name}`;
  if (wearKey === "-") return base;
  return `${base} (${WEARS.find((w) => w.key === wearKey).name})`;
}

export const priceKey = (itemId, phase, wear, st) => `${itemId}|${phase ?? ""}|${wear ?? "-"}|${st ? 1 : 0}`;

/** Every priced variant of an item, grouped so wears of the same phase/StatTrak sit together in wear order. */
function variantGroups(item) {
  const groups = [];
  for (const phase of item.phases?.map((p) => p.name) ?? [""]) {
    for (const st of item.stattrak ? [0, 1] : [0]) {
      groups.push(
        (item.wears.length ? item.wears : ["-"]).map((wear) => ({
          key: priceKey(item.id, phase, wear, st),
          hashName: hashName(item.name, wear, st),
          version: phase,
        })),
      );
    }
  }
  return groups;
}

/** Every price key in the catalog with the Skinport name/version it's looked up by. */
export function allVariants(contents) {
  const out = Object.values(contents.items).flatMap((item) => variantGroups(item).flat());
  for (const c of contents.cases) out.push({ key: `case|${c.id}`, hashName: c.marketName, version: "" });
  return out;
}

export async function fetchContents() {
  const [crates, skins, stickers] = await Promise.all([fetchJson(CRATES_URL), fetchJson(SKINS_URL), fetchJson(STICKERS_URL)]);
  return buildContents(crates, skins, stickers);
}

const CAPSULE_TYPES = { "Sticker Capsule": "capsule", "Autograph Capsule": "autograph" };

/** Weapon cases, sticker/autograph capsules and everything in them, without prices. */
export function buildContents(crates, skins, stickers) {
  const skinById = new Map(skins.map((s) => [s.id, s]));
  const stickerById = new Map(stickers.map((s) => [s.id, s]));
  const items = {};

  function addItem(entries, tier) {
    // Doppler / Gamma Doppler phases arrive as separate entries with the same name.
    const skin = skinById.get(entries[0].id);
    const id = tier === "gold" ? `rare-${slug(skin.name)}` : entries[0].id;
    if (items[id]) return id;
    const [weapon, finish] = skin.name.replace(/^★ /, "").split(" | ");
    const item = {
      id,
      name: skin.name,
      weapon,
      finish: finish ?? null,
      kind: kindOf(skin),
      tier,
      color: tier === "gold" ? "#e4ae39" : skin.rarity.color,
      minFloat: skin.min_float,
      maxFloat: skin.max_float,
      wears: wearsFor(skin),
      stattrak: !!skin.stattrak,
      paintIndex: skin.paint_index ?? null,
      pattern: skin.pattern?.id ?? null,
      image: skin.image,
    };
    const phased = entries.map((e) => skinById.get(e.id)).filter((s) => s.phase);
    if (phased.length) item.phases = phased.map((s) => ({ name: s.phase, image: s.image }));
    items[id] = item;
    return id;
  }

  function addSticker(entry, tier) {
    if (items[entry.id]) return entry.id;
    const sticker = stickerById.get(entry.id);
    const name = sticker?.market_hash_name ?? `Sticker | ${entry.name}`;
    items[entry.id] = {
      id: entry.id,
      name,
      weapon: "Sticker",
      finish: name.split(" | ").slice(1).join(" | "),
      kind: "sticker",
      tier,
      color: entry.rarity.color,
      minFloat: null,
      maxFloat: null,
      wears: [],
      stattrak: false,
      paintIndex: null,
      pattern: null,
      image: sticker?.image ?? entry.image,
    };
    return entry.id;
  }

  const groupByName = (list) => {
    const groups = new Map();
    for (const e of list) {
      if (!groups.has(e.name)) groups.set(e.name, []);
      groups.get(e.name).push(e);
    }
    return [...groups.values()];
  };

  const cases = [];
  for (const crate of crates) {
    const kind = crate.type === "Case" ? "case" : CAPSULE_TYPES[crate.type];
    // Capsules without a market name (operation collections, unreleased majors) can't be priced.
    if (!kind || (kind !== "case" && !crate.market_hash_name)) continue;

    const contents = { milspec: [], restricted: [], classified: [], covert: [], gold: [] };
    if (kind === "case") {
      for (const group of groupByName(crate.contains)) {
        const tier = TIER_BY_RARITY[group[0].rarity.id];
        if (!tier) throw new Error(`Unknown rarity ${group[0].rarity.id} in ${crate.name}`);
        contents[tier].push(addItem(group, tier));
      }
      for (const group of groupByName(crate.contains_rare)) contents.gold.push(addItem(group, "gold"));
    } else {
      for (const entry of crate.contains) {
        const tier = STICKER_TIER_BY_RARITY[entry.rarity.id];
        if (!tier) throw new Error(`Unknown sticker rarity ${entry.rarity.id} in ${crate.name}`);
        contents[tier].push(addSticker(entry, tier));
      }
    }

    cases.push({
      id: slug(crate.name),
      kind,
      name: crate.name,
      marketName: crate.market_hash_name,
      image: crate.image,
      released: crate.first_sale_date?.replace(/\//g, "-") ?? null,
      rareLabel: crate.loot_list?.name ?? "★ Rare Special Item ★",
      contents,
    });
  }
  cases.sort((a, b) => (b.released ?? "").localeCompare(a.released ?? ""));
  return { keyPrice: KEY_PRICE, sources: SOURCES, cases, items };
}

/** "hash name|version" -> USD, first listing wins. */
export function indexListings(lists) {
  const index = new Map();
  for (const p of lists.flat()) {
    const key = `${p.market_hash_name}|${p.version ?? ""}`;
    const value = p.min_price ?? p.suggested_price;
    if (value != null && !index.has(key)) index.set(key, value);
  }
  return index;
}

/**
 * Flat price map for the whole catalog. A variant missing from the listings keeps
 * its `previous` price; one never seen at all is filled from the nearest wear.
 */
export function priceCatalog(contents, index, previous = {}) {
  const prices = {};
  let filled = 0;
  let unpriced = 0;
  const lookup = (v) => index.get(`${v.hashName}|${v.version}`) ?? previous[v.key] ?? null;

  for (const item of Object.values(contents.items)) {
    const groups = variantGroups(item);
    for (let g = 0; g < groups.length; g++) {
      const row = groups[g].map(lookup);
      for (let i = 0; i < row.length; i++) {
        if (row[i] != null) continue;
        let best = null;
        for (let d = 1; d < row.length && best == null; d++) best = row[i - d] ?? row[i + d] ?? null;
        // StatTrak group with no data at all: fall back to the non-StatTrak price.
        if (best == null && item.stattrak && g % 2 === 1) best = prices[groups[g - 1][i].key] ?? null;
        if (best == null) {
          unpriced++;
          best = 0.03; // Steam's minimum listing price
        } else filled++;
        row[i] = best;
      }
      groups[g].forEach((v, i) => (prices[v.key] = round2(row[i])));
    }
  }
  for (const c of contents.cases) {
    const p = index.get(`${c.marketName}|`) ?? previous[`case|${c.id}`];
    // A container with no listing has no price; the site won't sell it.
    if (p == null) unpriced++;
    else prices[`case|${c.id}`] = round2(p);
  }
  return { prices, filled, unpriced };
}

/**
 * Skinport's sale medians over the last 90 / 30 / 7 days / 24 hours, placed at the
 * middle of each window. Only used once, to give fresh price graphs some backstory.
 */
export async function fetchSalesBackfill(contents, now = Date.now()) {
  const sales = await fetchJson(SALES_URL);
  const byName = new Map(sales.map((s) => [`${s.market_hash_name}|${s.version ?? ""}`, s]));
  const DAY = 86_400_000;
  const windows = [
    ["last_90_days", now - 45 * DAY],
    ["last_30_days", now - 15 * DAY],
    ["last_7_days", now - 3.5 * DAY],
    ["last_24_hours", now - 0.5 * DAY],
  ];
  const points = windows.map(([, t]) => ({ t, changes: {} }));
  for (const v of allVariants(contents)) {
    const s = byName.get(`${v.hashName}|${v.version}`);
    if (!s) continue;
    windows.forEach(([field], i) => {
      const m = s[field]?.median ?? s[field]?.avg;
      if (m != null) points[i].changes[v.key] = round2(m);
    });
  }
  return points;
}

#!/usr/bin/env node
// Builds public/data/catalog.json: every CS2 weapon case, its real contents
// (rarity tiers, float ranges, StatTrak eligibility, Doppler phases) and a
// market price for every wear / StatTrak combination.
//
// Sources:
//   - Case contents + skin metadata: ByMykel/CSGO-API (community dump of the game files)
//   - Prices: Skinport public API (suggested price, USD, ~5 min cache)
//
// Usage: npm run data
// Offline: CRATES_FILE=… SKINS_FILE=… PRICES_FILE=a.json,b.json npm run data
// Behind an HTTP proxy (Node 22): NODE_USE_ENV_PROXY=1 npm run data

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "public/data/catalog.json");

const CRATES_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json";
const SKINS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json";
// The default listing and the tradable-only listing each cover items the other misses.
const PRICES_URLS = [
  "https://api.skinport.com/v1/items?app_id=730&currency=USD",
  "https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0",
];

// Price of a CS2 case key on the Steam store.
const KEY_PRICE = 2.49;

const WEARS = [
  { key: "FN", name: "Factory New", min: 0.0, max: 0.07 },
  { key: "MW", name: "Minimal Wear", min: 0.07, max: 0.15 },
  { key: "FT", name: "Field-Tested", min: 0.15, max: 0.38 },
  { key: "WW", name: "Well-Worn", min: 0.38, max: 0.45 },
  { key: "BS", name: "Battle-Scarred", min: 0.45, max: 1.0 },
];

const TIER_BY_RARITY = {
  rarity_rare_weapon: "milspec",
  rarity_mythical_weapon: "restricted",
  rarity_legendary_weapon: "classified",
  rarity_ancient_weapon: "covert",
};

async function load(file, url, init) {
  if (file) {
    console.log(`  read ${file}`);
    return JSON.parse(await readFile(file, "utf8"));
  }
  console.log(`  GET ${url}`);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

const round2 = (n) => Math.round(n * 100) / 100;
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
  if (!wearKey) return base;
  return `${base} (${WEARS.find((w) => w.key === wearKey).name})`;
}

async function main() {
  console.log("Fetching sources…");
  const priceFiles = process.env.PRICES_FILE?.split(",") ?? [];
  const [crates, skins, ...priceLists] = await Promise.all([
    load(process.env.CRATES_FILE, CRATES_URL),
    load(process.env.SKINS_FILE, SKINS_URL),
    // Skinport rejects requests that don't accept brotli.
    ...PRICES_URLS.map((url, i) => load(priceFiles[i], url, { headers: { "Accept-Encoding": "br" } })),
  ]);

  const skinById = new Map(skins.map((s) => [s.id, s]));
  const priceIndex = new Map(); // "hash name|version" -> USD
  for (const p of priceLists.flat()) {
    const key = `${p.market_hash_name}|${p.version ?? ""}`;
    const value = p.suggested_price ?? p.median_price ?? p.min_price;
    if (value != null && !priceIndex.has(key)) priceIndex.set(key, value);
  }
  const priceOf = (name, version = "") => priceIndex.get(`${name}|${version}`) ?? null;

  let filled = 0;
  let unpriced = 0;

  /** prices[wearKey or "-"] = [normal, stattrak|null] */
  function buildPrices(skin, phase) {
    const wears = wearsFor(skin);
    const keys = wears.length ? wears : ["-"];
    const out = {};
    for (const k of keys) {
      const wear = k === "-" ? null : k;
      out[k] = [priceOf(hashName(skin.name, wear, false), phase ?? ""), skin.stattrak ? priceOf(hashName(skin.name, wear, true), phase ?? "") : null];
    }
    // Fill gaps from the nearest wear that has a price (same StatTrak-ness).
    for (const col of skin.stattrak ? [0, 1] : [0]) {
      for (let i = 0; i < keys.length; i++) {
        if (out[keys[i]][col] != null) continue;
        let best = null;
        for (let d = 1; d < keys.length && best == null; d++) {
          best = out[keys[i - d]]?.[col] ?? out[keys[i + d]]?.[col] ?? null;
        }
        if (best == null && col === 1) best = out[keys[i]][0]; // no StatTrak data at all
        if (best == null) {
          unpriced++;
          best = 0.03; // Steam's minimum listing price
        } else filled++;
        out[keys[i]][col] = best;
      }
    }
    for (const k of keys) out[k] = out[k].map((v) => (v == null ? null : round2(v)));
    return out;
  }

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
      stattrak: !!skin.stattrak,
      paintIndex: skin.paint_index ?? null,
      pattern: skin.pattern?.id ?? null,
      image: skin.image,
    };
    const phased = entries.map((e) => skinById.get(e.id)).filter((s) => s.phase);
    if (phased.length) {
      item.phases = phased.map((s) => ({ name: s.phase, image: s.image, prices: buildPrices(s, s.phase) }));
    } else {
      item.prices = buildPrices(skin);
    }
    items[id] = item;
    return id;
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
    if (crate.type !== "Case") continue;
    const contents = { milspec: [], restricted: [], classified: [], covert: [], gold: [] };
    for (const group of groupByName(crate.contains)) {
      const tier = TIER_BY_RARITY[group[0].rarity.id];
      if (!tier) throw new Error(`Unknown rarity ${group[0].rarity.id} in ${crate.name}`);
      contents[tier].push(addItem(group, tier));
    }
    for (const group of groupByName(crate.contains_rare)) contents.gold.push(addItem(group, "gold"));

    const price = priceOf(crate.market_hash_name);
    if (price == null) unpriced++;
    cases.push({
      id: slug(crate.name),
      name: crate.name,
      image: crate.image,
      released: crate.first_sale_date?.replace(/\//g, "-") ?? null,
      price: round2(price ?? 0.03),
      rareLabel: crate.loot_list?.name ?? "★ Rare Special Item ★",
      contents,
    });
  }
  cases.sort((a, b) => (b.released ?? "").localeCompare(a.released ?? ""));

  const catalog = {
    generatedAt: new Date().toISOString(),
    sources: { contents: "ByMykel/CSGO-API", prices: "Skinport suggested price (USD)" },
    keyPrice: KEY_PRICE,
    cases,
    items,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(catalog));
  console.log(
    `Wrote ${cases.length} cases, ${Object.keys(items).length} items -> ${OUT}\n` +
      `  ${filled} prices interpolated from a neighbouring wear, ${unpriced} with no market data`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

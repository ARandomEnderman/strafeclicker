#!/usr/bin/env node
// Writes server/snapshot.json: case contents plus one full set of prices.
// The server falls back to it when GitHub is unreachable, and starts from its
// prices until the first live tick.
//
// Usage: npm run data
// Offline: CRATES_FILE=… SKINS_FILE=… PRICES_FILE=main.json,tradable.json npm run data
// Behind an HTTP proxy (Node 22): NODE_USE_ENV_PROXY=1 npm run data

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRICE_URLS, buildContents, fetchJson, indexListings, priceCatalog } from "../server/data.mjs";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../server/snapshot.json");
const CRATES_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/crates.json";
const SKINS_URL = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/skins.json";

async function load(file, url) {
  console.log(file ? `  read ${file}` : `  GET ${url}`);
  return file ? JSON.parse(await readFile(file, "utf8")) : fetchJson(url);
}

const priceFiles = process.env.PRICES_FILE?.split(",") ?? [];
const [crates, skins, main, tradable] = await Promise.all([
  load(process.env.CRATES_FILE, CRATES_URL),
  load(process.env.SKINS_FILE, SKINS_URL),
  load(priceFiles[0], PRICE_URLS.main),
  load(priceFiles[1], PRICE_URLS.tradable),
]);

const contents = buildContents(crates, skins);
const { prices, filled, unpriced } = priceCatalog(contents, indexListings([main, tradable]));
await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), contents, prices }));
console.log(
  `Wrote ${contents.cases.length} cases, ${Object.keys(contents.items).length} items, ${Object.keys(prices).length} prices -> ${OUT}\n` +
    `  ${filled} interpolated from a neighbouring wear, ${unpriced} with no market data`,
);

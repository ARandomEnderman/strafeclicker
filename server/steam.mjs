// Steam Community Market prices: the lowest current listing ("starting at", buyer's
// price including Steam's fee) for every CS2 market item, in USD.
//
// Steam has no bulk price API. Its market search returns 10 items per request, and
// there are ~35,000 CS2 items, so prices are collected continuously at a polite pace
// (one request every STEAM_INTERVAL_MS, 3 s by default):
//
//   - two requests out of three walk the whole market in name order, so every item is
//     refreshed every few hours;
//   - one in three searches for a "hot" item (a case, or a skin someone owns), so the
//     prices people actually look at stay minutes fresh.
//
// A 429 (rate limited) backs off, doubling each time up to 15 minutes. What's been
// collected is saved to steam-prices.json so a restart doesn't start from zero.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SEARCH = "https://steamcommunity.com/market/search/render/?appid=730&norender=1&currency=1&count=10";
const PAGE = 10;
const SAVE_EVERY_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export class SteamMarket {
  /**
   * @param {string} dir where steam-prices.json is kept
   * @param {{ hot: () => string[], log: (...a: any[]) => void, intervalMs?: number }} opts
   *   hot: base market names (e.g. "AK-47 | Redline") to keep especially fresh
   */
  constructor(dir, { hot, log, intervalMs = Number(process.env.STEAM_INTERVAL_MS) || 3000 }) {
    this.file = join(dir, "steam-prices.json");
    this.hot = hot;
    this.log = log;
    this.intervalMs = intervalMs;
    /** market hash name -> [usd, fetchedAt] */
    this.prices = new Map();
    this.start = 0; // sweep position
    this.total = null;
    this.hotQueue = [];
    this.n = 0;
    this.backoffMs = 0;
    this.lastSave = Date.now();
    this.sweeps = 0;
    this.stopped = false;
  }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8"));
      for (const [name, v] of Object.entries(saved.prices ?? {})) this.prices.set(name, v);
      this.start = saved.start ?? 0;
      this.log(`steam: ${this.prices.size} saved prices`);
    } catch (err) {
      if (err.code !== "ENOENT") this.log(`steam: couldn't read saved prices: ${err.message}`);
    }
    return this;
  }

  async #save() {
    const prices = Object.fromEntries(this.prices);
    await writeFile(`${this.file}.tmp`, JSON.stringify({ start: this.start, prices }));
    await rename(`${this.file}.tmp`, this.file);
    this.lastSave = Date.now();
  }

  /** Market hash name -> USD (lowest listing). */
  snapshot() {
    const out = new Map();
    for (const [name, [usd]] of this.prices) out.set(name, usd);
    return out;
  }

  run() {
    const loop = async () => {
      if (this.stopped) return;
      let wait = this.intervalMs;
      try {
        await this.#step();
        this.backoffMs = 0;
      } catch (err) {
        if (err.status === 429) {
          this.backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(60_000, this.backoffMs * 2));
          wait = this.backoffMs;
          this.log(`steam: rate limited, pausing ${Math.round(wait / 60_000)} min`);
        } else {
          wait = 30_000;
          this.log(`steam: ${err.message}`);
        }
      }
      if (Date.now() - this.lastSave > SAVE_EVERY_MS) await this.#save().catch((err) => this.log(`steam: save failed: ${err.message}`));
      this.timer = setTimeout(loop, wait);
      this.timer.unref?.();
    };
    void loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    return this.#save().catch(() => {});
  }

  async #step() {
    this.n++;
    if (this.n % 3 === 0) {
      if (!this.hotQueue.length) this.hotQueue = [...new Set(this.hot())];
      const name = this.hotQueue.shift();
      if (name) return this.#fetch(`&query=${encodeURIComponent(name)}&search_descriptions=0`);
    }
    if (this.total != null && this.start >= this.total) {
      this.start = 0;
      this.sweeps++;
      this.log(`steam: full sweep done (${this.prices.size} prices)`);
    }
    const got = await this.#fetch(`&start=${this.start}&sort_column=name&sort_dir=asc`);
    this.start += PAGE;
    return got;
  }

  async #fetch(params) {
    const res = await fetch(SEARCH + params, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const body = await res.json();
    if (!body.success) throw new Error("search failed");
    if (!params.includes("query=")) this.total = body.total_count;
    const now = Date.now();
    for (const r of body.results ?? []) {
      // Guard against Steam answering in another currency.
      if (!r.sell_listings || !r.sell_price || !String(r.sell_price_text ?? "").startsWith("$")) continue;
      this.prices.set(r.hash_name, [r.sell_price / 100, now]);
    }
    return body.results?.length ?? 0;
  }
}

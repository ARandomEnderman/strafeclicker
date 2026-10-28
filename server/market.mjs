// The marketplace: every player gets their own shop of MARKET_SLOTS skins that changes
// every MARKET_REFRESH_MS: three cheap skins, a sticker, two mid-range and two premium
// ($1,000+) skins; some slots are deals.
// Listings cost the live market price plus MARKET_FEE; a deal takes some or all of the fee
// off, but never goes below the market price (or buying to sell would print money).
//
// A shop isn't stored: it's drawn from a seed of (secret, player, window), so it's the
// same every time the player looks during that window. What they bought this window is
// kept in their stats so each slot sells once.

import { createHash, randomBytes } from "node:crypto";
import { floatInWear, priceKey } from "../shared/game.js";
import { GameError, cents, spendable } from "./game.mjs";

export const MARKET_REFRESH_MS = 5 * 60_000;
export const MARKET_FEE = 0.1;
/** Each slot: a price band (USD) and whether it sells stickers or skins (weapons, knives, gloves). */
const SLOTS = [
  [1, 50, false],
  [1, 50, false],
  [1, 50, false],
  [1, 500, true],
  [50, 1000, false],
  [50, 1000, false],
  [1000, Infinity, false],
  [1000, Infinity, false],
];
const POOL_CACHE_MS = 60_000;

/** A small deterministic generator from a hash (xorshift on 32 bits). */
function rng(seed) {
  let x = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

export class Market {
  /**
   * @param {import("./game.mjs").Game} game
   * @param {import("./settings.mjs").Settings} settings
   */
  constructor(game, settings) {
    this.game = game;
    // The seed secret lives in the settings so shops survive a restart.
    if (!settings.get("marketSeed")) settings.set("marketSeed", randomBytes(16).toString("hex"));
    this.secret = settings.get("marketSeed");
    this.pool = { at: 0, bands: [] };
  }

  /** Every priced variant, sorted into the slot bands. Rebuilt at most once a minute. */
  #bands() {
    if (Date.now() - this.pool.at < POOL_CACHE_MS) return this.pool.bands;
    const prices = this.game.market.prices();
    const bands = SLOTS.map(() => []);
    for (const item of Object.values(this.game.market.contents().items)) {
      const phases = item.phases ? item.phases.map((p) => p.name) : [null];
      const wears = item.wears.length ? item.wears : [null];
      for (const phase of phases)
        for (const wear of wears)
          for (const stattrak of item.stattrak && item.kind !== "gloves" ? [false, true] : [false]) {
            const v = { itemId: item.id, phase, wear, stattrak };
            const price = prices[priceKey(v)];
            if (!price) continue;
            const sticker = item.kind === "sticker";
            SLOTS.forEach(([lo, hi, stickers], i) => stickers === sticker && price >= lo && price < hi && bands[i].push(v));
          }
    }
    this.pool = { at: Date.now(), bands };
    return bands;
  }

  #window = (t = Date.now()) => Math.floor(t / MARKET_REFRESH_MS);

  /** The player's shop for a window: one variant per slot, and its discount. */
  #shop(userId, window) {
    const bands = this.#bands();
    return SLOTS.map((_, i) => {
      const r = rng(`${this.secret}:${userId}:${window}:${i}`);
      const band = bands[i];
      if (!band.length) return null;
      const v = band[Math.floor(r() * band.length)];
      // 40% of slots are deals: 3 to 10 points of the fee off (at best, the plain market price).
      const discount = r() < 0.4 ? Math.round((0.03 + r() * 0.07) * 100) / 100 : 0;
      return { slot: i, ...v, discount };
    });
  }

  #priced(o) {
    const value = this.game.priceOf(o);
    const list = Math.round(value * (1 + MARKET_FEE) * 100) / 100;
    return { ...o, value, list, price: Math.max(value, Math.round(value * (1 + MARKET_FEE - o.discount) * 100) / 100) };
  }

  view(userId) {
    const window = this.#window();
    const a = this.game.view(userId);
    const bought = new Set(this.#bought(userId, window));
    return {
      refreshAt: (window + 1) * MARKET_REFRESH_MS,
      slots: this.#shop(userId, window).map((o) => (o ? { ...this.#priced(o), sold: bought.has(o.slot) } : null)),
      account: a,
    };
  }

  #bought(userId, window) {
    const m = this.game.publicAccount(userId).stats.market;
    return m?.window === window ? m.bought : [];
  }

  buy(userId, body) {
    const window = this.#window();
    const slot = Math.floor(Number(body.slot));
    const o = this.#shop(userId, window)[slot];
    if (!o) throw new GameError("bad_input", "No such listing");
    return this.game.act(userId, (a, changes) => {
      const m = a.stats.market?.window === window ? a.stats.market : { window, bought: [] };
      if (m.bought.includes(slot)) throw new GameError("sold", "You already bought that one");
      const { price } = this.#priced(o);
      if (!(price > 0)) throw new GameError("unavailable", "That item has no price right now");
      const c = cents(price);
      if (spendable(a) < c) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= c;
      const item = this.game.item(o.itemId);
      const [owned] = this.game.grant(a, changes, [{ itemId: o.itemId, phase: o.phase, wear: o.wear, stattrak: o.stattrak, float: floatInWear(item, o.wear, Math.random()), seed: item.kind === "sticker" ? null : Math.floor(Math.random() * 1001) }], "market");
      m.bought.push(slot);
      a.stats.market = m;
      a.stats.marketSpentCents = (a.stats.marketSpentCents ?? 0) + c;
      return { item: owned, price };
    });
  }
}

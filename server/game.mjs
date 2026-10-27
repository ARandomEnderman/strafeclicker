// Accounts and every action that touches money. The server rolls everything; the
// browser only ever learns the outcome.

import { randomBytes, randomInt } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  NO_PERKS,
  PERKS,
  UPGRADE_MAX_CHANCE,
  UPGRADE_MAX_ITEMS,
  UPGRADE_MIN_CHANCE,
  canStatTrak,
  floatInWear,
  needsKey,
  perkValue,
  priceKey,
  resolveDrop,
  upgradeChance,
} from "../shared/game.js";

export const STARTING_BALANCE = 0;
/** Clicks: a bucket of 20 that refills at 15 per second, so autoclickers can't print money. */
const CLICK_BURST = 20;
const CLICKS_PER_SEC = 15;
const SAVE_DELAY_MS = 1000;

/** Money is kept in integer cents so thousands of $0.05 clicks never drift. */
const cents = (usd) => Math.round(usd * 100);

export class GameError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Uniform floats in [0, 1) from the OS CSPRNG. */
function randomFloats(n) {
  const buf = randomBytes(4 * n);
  return Array.from({ length: n }, (_, i) => buf.readUInt32BE(i * 4) / 2 ** 32);
}

function fresh(id) {
  return {
    id,
    createdAt: Date.now(),
    balanceCents: cents(STARTING_BALANCE),
    inventory: [],
    stats: { opened: 0, spentCents: 0, unboxedCents: 0, best: null, clicks: 0, upgrades: 0, upgradesWon: 0 },
    perks: { ...NO_PERKS },
    clickBucket: { tokens: CLICK_BURST, at: Date.now() },
  };
}

export class Game {
  /**
   * @param {string} file where accounts are persisted
   * @param {{ contents: () => any, prices: () => Record<string, number> }} market
   */
  constructor(file, market) {
    this.file = file;
    this.market = market;
    /** id -> account */
    this.accounts = new Map();
    this.saveTimer = null;
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      for (const a of JSON.parse(await readFile(this.file, "utf8"))) this.accounts.set(a.id, a);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return this;
  }

  #dirty() {
    this.saveTimer ??= setTimeout(() => this.flush().catch((e) => console.error("saving accounts failed", e)), SAVE_DELAY_MS);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify([...this.accounts.values()]));
    await rename(tmp, this.file);
  }

  /**
   * Existing account for this id, or a fresh one (with a new id) if it's unknown.
   * A fresh account is only written to disk once it does something.
   */
  account(id) {
    let a = id && this.accounts.get(id);
    if (!a) {
      a = fresh(randomBytes(24).toString("base64url"));
      this.accounts.set(a.id, a);
    }
    a.perks = { ...NO_PERKS, ...a.perks }; // accounts saved before a perk existed
    return a;
  }

  /** What the browser gets to see. */
  view(a) {
    const s = a.stats;
    return {
      balance: a.balanceCents / 100,
      perks: a.perks,
      inventory: a.inventory,
      stats: {
        opened: s.opened,
        spent: s.spentCents / 100,
        unboxedValue: s.unboxedCents / 100,
        best: s.best,
        clicks: s.clicks,
        upgrades: s.upgrades,
        upgradesWon: s.upgradesWon,
      },
    };
  }

  #price(variant) {
    return this.market.prices()[priceKey(variant)] ?? 0;
  }

  #item(id) {
    return this.market.contents().items[id];
  }

  #newOwned(drop, source) {
    return { ...drop, uid: randomBytes(8).toString("hex"), source, obtainedAt: Date.now() };
  }

  #noteBest(a, owned) {
    const value = this.#price(owned);
    if (!a.stats.best || value > a.stats.best.value) a.stats.best = { name: this.#item(owned.itemId).name, value };
  }

  click(a, requested) {
    const n = Math.max(0, Math.min(100, Math.floor(Number(requested) || 0)));
    const b = a.clickBucket;
    const now = Date.now();
    b.tokens = Math.min(CLICK_BURST, b.tokens + ((now - b.at) / 1000) * CLICKS_PER_SEC);
    b.at = now;
    const credited = Math.min(n, Math.floor(b.tokens));
    b.tokens -= credited;
    a.balanceCents += credited * cents(perkValue(a.perks, "clickPower"));
    a.stats.clicks += credited;
    if (credited) this.#dirty();
    return credited;
  }

  /** Open `count` of one case at once (up to the account's multi-open level). */
  open(a, caseId, count = 1) {
    const { cases, keyPrice } = this.market.contents();
    const c = cases.find((x) => x.id === caseId);
    if (!c) throw new GameError("unknown_case", "No such case", 404);
    const max = perkValue(a.perks, "multiOpen");
    const n = Math.floor(Number(count));
    if (!(n >= 1 && n <= max)) throw new GameError("bad_count", `You can open up to ${max} at once`);
    const casePrice = this.market.prices()[`case|${c.id}`];
    if (casePrice == null) throw new GameError("unavailable", "This container isn't on the market right now");
    const cost = (cents(casePrice) + (needsKey(c) ? cents(keyPrice) : 0)) * n;
    if (a.balanceCents < cost) throw new GameError("insufficient", "Not enough balance");

    const items = Array.from({ length: n }, () => this.#newOwned(resolveDrop(c, (id) => this.#item(id), randomFloats(7)), c.id));
    a.balanceCents -= cost;
    a.inventory.unshift(...items);
    a.stats.opened += n;
    a.stats.spentCents += cost;
    for (const owned of items) {
      a.stats.unboxedCents += cents(this.#price(owned));
      this.#noteBest(a, owned);
    }
    this.#dirty();
    return items;
  }

  /** Buy the next level of a perk in the upgrade tree. */
  buyPerk(a, id) {
    const perk = Object.hasOwn(PERKS, id) ? PERKS[id] : null;
    if (!perk) throw new GameError("unknown_perk", "No such upgrade", 404);
    const next = perk.levels[a.perks[id] + 1];
    if (!next) throw new GameError("maxed", `${perk.name} is already maxed`);
    if (a.balanceCents < cents(next.cost)) throw new GameError("insufficient", "Not enough balance");
    a.balanceCents -= cents(next.cost);
    a.perks[id]++;
    this.#dirty();
    return a.perks[id];
  }

  sell(a, uids) {
    const set = new Set(Array.isArray(uids) ? uids : []);
    let total = 0;
    a.inventory = a.inventory.filter((it) => {
      if (!set.has(it.uid)) return true;
      total += cents(this.#price(it));
      return false;
    });
    a.balanceCents += total;
    if (total) this.#dirty();
    return total / 100;
  }

  /** Stake inventory items on one pricier target. */
  upgrade(a, uids, target) {
    const picked = [...new Set(Array.isArray(uids) ? uids : [])];
    if (!picked.length || picked.length > UPGRADE_MAX_ITEMS) throw new GameError("bad_input", `Pick 1–${UPGRADE_MAX_ITEMS} items`);
    const inputs = picked.map((uid) => a.inventory.find((it) => it.uid === uid));
    if (inputs.some((it) => !it)) throw new GameError("bad_input", "You don't own one of those items");

    const item = this.#item(target?.itemId);
    if (!item) throw new GameError("bad_target", "Unknown target item");
    const variant = {
      itemId: item.id,
      phase: item.phases ? target.phase : null,
      wear: item.wears.length ? target.wear : null,
      stattrak: canStatTrak(item) && !!target.stattrak,
    };
    if (item.phases && !item.phases.some((p) => p.name === variant.phase)) throw new GameError("bad_target", "Unknown phase");
    if (item.wears.length && !item.wears.includes(variant.wear)) throw new GameError("bad_target", "That wear doesn't exist for this item");

    const targetCents = cents(this.#price(variant));
    const inputCents = inputs.reduce((s, it) => s + cents(this.#price(it)), 0);
    const chance = upgradeChance(inputCents, targetCents);
    if (!(chance >= UPGRADE_MIN_CHANCE && chance <= UPGRADE_MAX_CHANCE)) {
      throw new GameError("bad_chance", `Chance must be between ${UPGRADE_MIN_CHANCE * 100}% and ${UPGRADE_MAX_CHANCE * 100}%`);
    }

    const [roll, floatR] = randomFloats(2);
    const won = roll < chance;
    const gone = new Set(picked);
    a.inventory = a.inventory.filter((it) => !gone.has(it.uid));
    let owned = null;
    if (won) {
      owned = this.#newOwned(
        { ...variant, float: floatInWear(item, variant.wear, floatR), seed: item.kind === "sticker" ? null : randomInt(1001) },
        "upgrade",
      );
      a.inventory.unshift(owned);
      a.stats.upgradesWon++;
      this.#noteBest(a, owned);
    }
    a.stats.upgrades++;
    this.#dirty();
    return { won, chance, item: owned };
  }

  /** Wipe balance, inventory and stats, keeping the same id. */
  reset(a) {
    Object.assign(a, fresh(a.id));
    this.#dirty();
  }
}

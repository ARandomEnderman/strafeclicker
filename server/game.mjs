// Accounts and every action that touches money. The server rolls everything; the
// browser only ever learns the outcome. Each action loads the account, changes it
// and writes it back inside one SQLite transaction.

import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
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
import { tx } from "./db.mjs";

export const STARTING_BALANCE = 0;
/** Clicks: a bucket of 20 that refills at 15 per second, so autoclickers can't print money. */
const CLICK_BURST = 20;
const CLICKS_PER_SEC = 15;

/** Money is kept in integer cents so thousands of $0.05 clicks never drift. */
const cents = (usd) => Math.round(usd * 100);

const freshStats = () => ({ opened: 0, spentCents: 0, unboxedCents: 0, best: null, clicks: 0, upgrades: 0, upgradesWon: 0 });

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

const rowToItem = (r) => ({
  uid: r.uid,
  itemId: r.item_id,
  phase: r.phase,
  float: r.float,
  wear: r.wear,
  stattrak: !!r.stattrak,
  seed: r.seed,
  source: r.source,
  obtainedAt: r.obtained_at,
});

export class Game {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ contents: () => any, prices: () => Record<string, number> }} market
   */
  constructor(db, market) {
    this.db = db;
    this.market = market;
    /** userId -> click rate-limit bucket (in memory; resets harmlessly on restart) */
    this.clickBuckets = new Map();
    this.q = {
      user: db.prepare("SELECT id, username, balance_cents, perks, stats FROM users WHERE id = ?"),
      items: db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY obtained_at DESC, rowid DESC"),
      saveUser: db.prepare("UPDATE users SET balance_cents = ?, perks = ?, stats = ? WHERE id = ?"),
      addUser: db.prepare("INSERT INTO users (username, pass_hash, created_at, balance_cents, perks, stats) VALUES (?, ?, ?, ?, ?, ?)"),
      addItem: db.prepare(
        "INSERT INTO items (uid, user_id, item_id, phase, float, wear, stattrak, seed, source, obtained_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      dropItem: db.prepare("DELETE FROM items WHERE uid = ? AND user_id = ?"),
      dropItems: db.prepare("DELETE FROM items WHERE user_id = ?"),
      legacy: db.prepare("SELECT data FROM legacy_accounts WHERE id = ?"),
      dropLegacy: db.prepare("DELETE FROM legacy_accounts WHERE id = ?"),
      addLegacy: db.prepare("INSERT OR IGNORE INTO legacy_accounts (id, data) VALUES (?, ?)"),
      count: db.prepare("SELECT COUNT(*) AS n FROM users"),
    };
  }

  get userCount() {
    return this.q.count.get().n;
  }

  /**
   * Move anonymous accounts from the old accounts.json into the database so they can
   * be claimed when their owner registers. The file is renamed afterwards.
   */
  importLegacyFile(file) {
    let list;
    try {
      list = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return 0;
    }
    tx(this.db, () => list.forEach((a) => this.q.addLegacy.run(a.id, JSON.stringify(a))));
    renameSync(file, `${file}.imported`);
    return list.length;
  }

  /** New user; if their browser still has an anonymous account, it comes along. */
  createUser(username, passHash, legacyId) {
    return tx(this.db, () => {
      const legacy = legacyId ? this.q.legacy.get(legacyId) : null;
      const old = legacy ? JSON.parse(legacy.data) : null;
      const { lastInsertRowid } = this.q.addUser.run(
        username,
        passHash,
        Date.now(),
        old?.balanceCents ?? cents(STARTING_BALANCE),
        JSON.stringify({ ...NO_PERKS, ...old?.perks }),
        JSON.stringify({ ...freshStats(), ...old?.stats }),
      );
      const userId = Number(lastInsertRowid);
      if (old) {
        // Oldest first so they keep their order.
        for (const it of [...old.inventory].reverse()) this.#insertItem(userId, it);
        this.q.dropLegacy.run(legacyId);
      }
      return userId;
    });
  }

  #insertItem(userId, it) {
    this.q.addItem.run(it.uid, userId, it.itemId, it.phase, it.float, it.wear, it.stattrak ? 1 : 0, it.seed, it.source, it.obtainedAt);
  }

  #load(userId) {
    const r = this.q.user.get(userId);
    if (!r) throw new GameError("auth", "Please log in again", 401);
    return {
      id: r.id,
      username: r.username,
      balanceCents: r.balance_cents,
      perks: { ...NO_PERKS, ...JSON.parse(r.perks) },
      stats: { ...freshStats(), ...JSON.parse(r.stats) },
      inventory: this.q.items.all(r.id).map(rowToItem),
    };
  }

  #save(a, { added = [], removed = [] } = {}) {
    this.q.saveUser.run(a.balanceCents, JSON.stringify(a.perks), JSON.stringify(a.stats), a.id);
    for (const uid of removed) this.q.dropItem.run(uid, a.id);
    for (const it of [...added].reverse()) this.#insertItem(a.id, it);
  }

  /** Load the account, let fn change it, save it, all in one transaction. */
  #act(userId, fn) {
    return tx(this.db, () => {
      const a = this.#load(userId);
      const changes = {};
      const result = fn(a, changes);
      this.#save(a, changes);
      return { ...result, account: this.#view(a) };
    });
  }

  /** What the browser gets to see. */
  #view(a) {
    const s = a.stats;
    return {
      username: a.username,
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

  view(userId) {
    return this.#view(this.#load(userId));
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

  click(userId, requested) {
    return this.#act(userId, (a) => {
      const n = Math.max(0, Math.min(100, Math.floor(Number(requested) || 0)));
      const now = Date.now();
      const b = this.clickBuckets.get(a.id) ?? { tokens: CLICK_BURST, at: now };
      b.tokens = Math.min(CLICK_BURST, b.tokens + ((now - b.at) / 1000) * CLICKS_PER_SEC);
      b.at = now;
      const credited = Math.min(n, Math.floor(b.tokens));
      b.tokens -= credited;
      this.clickBuckets.set(a.id, b);
      a.balanceCents += credited * cents(perkValue(a.perks, "clickPower"));
      a.stats.clicks += credited;
      return { credited };
    });
  }

  /** Open `count` of one case at once (up to the account's multi-open level). */
  open(userId, caseId, count = 1) {
    return this.#act(userId, (a, changes) => {
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
      changes.added = items;
      a.stats.opened += n;
      a.stats.spentCents += cost;
      for (const owned of items) {
        a.stats.unboxedCents += cents(this.#price(owned));
        this.#noteBest(a, owned);
      }
      return { items };
    });
  }

  /** Buy the next level of a perk in the upgrade tree. */
  buyPerk(userId, id) {
    return this.#act(userId, (a) => {
      const perk = Object.hasOwn(PERKS, id) ? PERKS[id] : null;
      if (!perk) throw new GameError("unknown_perk", "No such upgrade", 404);
      const next = perk.levels[a.perks[id] + 1];
      if (!next) throw new GameError("maxed", `${perk.name} is already maxed`);
      if (a.balanceCents < cents(next.cost)) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= cents(next.cost);
      a.perks[id]++;
      return { level: a.perks[id] };
    });
  }

  sell(userId, uids) {
    return this.#act(userId, (a, changes) => {
      const set = new Set(Array.isArray(uids) ? uids : []);
      let total = 0;
      changes.removed = [];
      a.inventory = a.inventory.filter((it) => {
        if (!set.has(it.uid)) return true;
        total += cents(this.#price(it));
        changes.removed.push(it.uid);
        return false;
      });
      a.balanceCents += total;
      return { sold: total / 100 };
    });
  }

  /** Stake inventory items on one pricier target. */
  upgrade(userId, uids, target) {
    return this.#act(userId, (a, changes) => {
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
      changes.removed = picked;
      let owned = null;
      if (won) {
        owned = this.#newOwned(
          { ...variant, float: floatInWear(item, variant.wear, floatR), seed: item.kind === "sticker" ? null : randomInt(1001) },
          "upgrade",
        );
        a.inventory.unshift(owned);
        changes.added = [owned];
        a.stats.upgradesWon++;
        this.#noteBest(a, owned);
      }
      a.stats.upgrades++;
      return { won, chance, item: owned };
    });
  }

  /** Wipe balance, inventory, stats and perks; the login stays. */
  reset(userId) {
    return this.#act(userId, (a) => {
      this.q.dropItems.run(a.id);
      a.inventory = [];
      a.balanceCents = cents(STARTING_BALANCE);
      a.stats = freshStats();
      a.perks = { ...NO_PERKS };
      return {};
    });
  }
}

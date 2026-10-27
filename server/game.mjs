// Accounts and every action that touches money. The server rolls everything; the
// browser only ever learns the outcome. Each action loads the account, changes it
// and writes it back inside one SQLite transaction.

import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import {
  NO_PERKS,
  OFFLINE_CAP_HOURS,
  OFFLINE_MIN_GAP_MS,
  PERKS,
  clickEfficiency,
  rateClicks,
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
import { ACHIEVEMENTS, newlyMet } from "../shared/achievements.js";

export const STARTING_BALANCE = 0;
/** Most clicks one request can carry. */
const CLICK_BATCH_MAX = 100;
/** How far a client's click timeline may run ahead of real time (ms). */
const CLICK_CLOCK_SLACK = 300;

/** Money is kept in integer cents so thousands of $0.05 clicks never drift. */
export const cents = (usd) => Math.round(usd * 100);

/**
 * What an account can spend right now: its balance minus winnings that are credited but
 * still being revealed (a plinko ball in the air), so bets can't run ahead of the ball.
 */
export const spendable = (a) => a.balanceCents - (a.lockedCents ?? 0);

const freshStats = () => ({
  opened: 0,
  spentCents: 0,
  unboxedCents: 0,
  best: null,
  clicks: 0,
  upgrades: 0,
  upgradesWon: 0,
  /** Unboxed items per rarity tier. */
  tiers: {},
  /** Per game: { played, wageredCents, wonCents, bestMult, ... } */
  games: {},
  /** Achievement id -> time unlocked. */
  achievements: {},
  /** Achievement id -> time its reward was claimed. */
  claimed: {},
});

export class GameError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Uniform floats in [0, 1) from the OS CSPRNG. */
export function randomFloats(n) {
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

function loadStats(json) {
  const raw = JSON.parse(json);
  // Before rewards had to be claimed they were paid on unlock: count those as claimed.
  if (raw.achievements && !raw.claimed) raw.claimed = { ...raw.achievements };
  return { ...freshStats(), ...raw };
}

/** The parts of an owned item the feed needs to draw it. */
const dropOf = (it) => ({ itemId: it.itemId, phase: it.phase, wear: it.wear, stattrak: it.stattrak });

export class Game {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ contents: () => any, prices: () => Record<string, number> }} market
   * @param {import("./feed.mjs").Feed} [feed] where big wins are announced
   */
  constructor(db, market, feed) {
    this.db = db;
    this.market = market;
    this.feed = feed;
    /** userId -> click rate-limit bucket (in memory; resets harmlessly on restart) */
    this.clickBuckets = new Map();
    /** userId -> [{ cents, until }]: credited winnings not spendable until `until` (see spendable). */
    this.locks = new Map();
    this.q = {
      user: db.prepare("SELECT id, username, balance_cents, perks, stats, last_active FROM users WHERE id = ?"),
      items: db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY obtained_at DESC, rowid DESC"),
      saveUser: db.prepare("UPDATE users SET balance_cents = ?, perks = ?, stats = ?, last_active = ? WHERE id = ?"),
      addUser: db.prepare("INSERT INTO users (username, pass_hash, created_at, balance_cents, perks, stats, last_active) VALUES (?, ?, ?, ?, ?, ?, ?)"),
      addItem: db.prepare(
        "INSERT INTO items (uid, user_id, item_id, phase, float, wear, stattrak, seed, source, obtained_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ),
      dropItem: db.prepare("DELETE FROM items WHERE uid = ? AND user_id = ?"),
      itemByUid: db.prepare("SELECT * FROM items WHERE uid = ?"),
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
        Date.now(),
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
      lastActive: r.last_active,
      balanceCents: r.balance_cents,
      lockedCents: this.#lockedCents(r.id),
      perks: { ...NO_PERKS, ...JSON.parse(r.perks) },
      stats: loadStats(r.stats),
      inventory: this.q.items.all(r.id).map(rowToItem),
    };
  }

  #lockedCents(userId) {
    const now = Date.now();
    const live = (this.locks.get(userId) ?? []).filter((l) => l.until > now);
    if (live.length) this.locks.set(userId, live);
    else this.locks.delete(userId);
    return live.reduce((s, l) => s + l.cents, 0);
  }

  /** Hold back `amountCents` of an account's balance from spending for `ms`. */
  lock(a, amountCents, ms) {
    if (amountCents <= 0) return;
    const list = this.locks.get(a.id) ?? [];
    list.push({ cents: amountCents, until: Date.now() + ms });
    this.locks.set(a.id, list);
    a.lockedCents = (a.lockedCents ?? 0) + amountCents;
  }

  #save(a, { added = [], removed = [] } = {}) {
    this.q.saveUser.run(a.balanceCents, JSON.stringify(a.perks), JSON.stringify(a.stats), Date.now(), a.id);
    for (const uid of removed) this.q.dropItem.run(uid, a.id);
    for (const it of [...added].reverse()) this.#insertItem(a.id, it);
  }

  /**
   * Pay offline income for the time since the account was last active, if that gap was
   * long enough to count as being away. Capped at OFFLINE_CAP_HOURS.
   */
  #payOffline(a) {
    const now = Date.now();
    const gap = a.lastActive == null ? 0 : now - a.lastActive;
    if (gap < OFFLINE_MIN_GAP_MS) return null;
    const ms = Math.min(gap, OFFLINE_CAP_HOURS * 3_600_000);
    const earned = Math.floor((perkValue(a.perks, "offlineIncome") * 100 * ms) / 3_600_000);
    if (earned <= 0) return null;
    a.balanceCents += earned;
    a.stats.offlineCents = (a.stats.offlineCents ?? 0) + earned;
    return { earned: earned / 100, seconds: Math.round(ms / 1000) };
  }

  /**
   * Load the account, pay any offline income, let fn change it, save it: one transaction.
   * fn gets the account and a `changes` object: `added` / `removed` items, and `wins`
   * to announce in the live feed once the transaction has committed.
   */
  #act(userId, fn) {
    const changes = {};
    const out = tx(this.db, () => {
      const a = this.#load(userId);
      const offline = this.#payOffline(a);
      const result = fn(a, changes);
      const unlocked = this.#unlockAchievements(a);
      this.#save(a, changes);
      return { ...result, account: { ...this.#view(a), ...(offline ? { offline } : {}), ...(unlocked.length ? { unlocked } : {}) } };
    });
    for (const { win, delayMs } of changes.wins ?? []) this.feed?.push(win, delayMs);
    return out;
  }

  /**
   * Like #act, for two accounts in one transaction (a trade): fn(a, b, changesA,
   * changesB). Returns fn's result plus both account views.
   */
  actPair(idA, idB, fn) {
    return tx(this.db, () => {
      const a = this.#load(idA);
      const b = this.#load(idB);
      const ca = {};
      const cb = {};
      const result = fn(a, b, ca, cb);
      this.#unlockAchievements(a);
      this.#unlockAchievements(b);
      // Items keep their uid when they change hands, so both sides' outgoing rows go
      // before anything is inserted.
      for (const [acc, ch] of [[a, ca], [b, cb]]) for (const uid of ch.removed ?? []) this.q.dropItem.run(uid, acc.id);
      this.#save(a, { added: ca.added });
      this.#save(b, { added: cb.added });
      return { ...result, accounts: [this.#view(a), this.#view(b)] };
    });
  }

  /** Record newly met achievements (their rewards wait to be claimed). Returns the new ids. */
  #unlockAchievements(a) {
    const view = this.#view(a);
    const subject = { ...view, inventoryValue: a.inventory.reduce((sum, it) => sum + this.#price(it), 0) };
    const ids = newlyMet(subject, a.stats.achievements);
    const now = Date.now();
    for (const id of ids) a.stats.achievements[id] = now;
    return ids;
  }

  /** Collect the reward of one unlocked achievement, or of all of them (id omitted). */
  claim(userId, id) {
    return this.#act(userId, (a) => {
      const ready = ACHIEVEMENTS.filter((x) => a.stats.achievements[x.id] && !a.stats.claimed[x.id] && (id == null || x.id === id));
      if (!ready.length) throw new GameError("nothing", id == null ? "Nothing to claim" : "That reward isn't ready to claim");
      const now = Date.now();
      let total = 0;
      for (const x of ready) {
        a.stats.claimed[x.id] = now;
        total += cents(x.reward);
      }
      a.balanceCents += total;
      return { claimed: ready.map((x) => x.id), reward: total / 100 };
    });
  }

  /**
   * Book one round of a game in the account's stats.
   * @param {{ stakeCents: number, payoutCents: number, max?: Record<string, number>, add?: Record<string, number> }} r
   *   `max` fields keep the highest value seen (e.g. bestJumps), `add` fields are summed.
   */
  noteGame(a, game, { stakeCents, payoutCents, max = {}, add = {} }) {
    const st = (a.stats.games[game] ??= { played: 0, wageredCents: 0, wonCents: 0, bestMult: 0 });
    st.played++;
    st.wageredCents += stakeCents;
    st.wonCents += payoutCents;
    if (stakeCents > 0) st.bestMult = Math.max(st.bestMult, Math.round((payoutCents / stakeCents) * 100) / 100);
    for (const [k, v] of Object.entries(max)) st[k] = Math.max(st[k] ?? 0, v);
    for (const [k, v] of Object.entries(add)) st[k] = (st[k] ?? 0) + v;
  }

  /** For the other games (server/games/*): the same transaction wrapper. */
  act(userId, fn) {
    return this.#act(userId, fn);
  }

  /**
   * Offer an item win to the live feed once the transaction commits (the feed decides
   * whether it's worth showing). `stake` is what the case or upgrade cost, USD.
   */
  announce(changes, a, game, owned, stake, extra = {}, delayMs = 0) {
    const win = { user: a.username, game, value: this.#price(owned), stake, tier: this.#item(owned.itemId).tier, drop: dropOf(owned), ...extra };
    (changes.wins ??= []).push({ win, delayMs });
  }

  item(id) {
    return this.#item(id);
  }

  /** An owned item by uid, whoever has it (null if it's gone). */
  findItem(uid) {
    const r = this.q.itemByUid.get(uid);
    return r ? rowToItem(r) : null;
  }

  /** A case and what one opening costs (case + key), in cents; throws if it can't be opened. */
  caseCost(caseId) {
    const { cases, keyPrice } = this.market.contents();
    const c = cases.find((x) => x.id === caseId);
    if (!c) throw new GameError("unknown_case", "No such case", 404);
    const price = this.market.prices()[`case|${c.id}`];
    if (price == null) throw new GameError("unavailable", `${c.name} isn't on the market right now`);
    return { c, costCents: cents(price) + (needsKey(c) ? cents(keyPrice) : 0) };
  }

  /** Roll one drop from a case (not owned by anyone yet). */
  rollDrop(c) {
    return resolveDrop(c, (id) => this.#item(id), randomFloats(7));
  }

  /** Give drops to an account as new items, counting them like unboxed ones. */
  grant(a, changes, drops, source) {
    const items = drops.map((d) => this.#newOwned(d, source));
    a.inventory.unshift(...items);
    (changes.added ??= []).push(...items);
    for (const owned of items) {
      const tier = this.#item(owned.itemId).tier;
      a.stats.tiers[tier] = (a.stats.tiers[tier] ?? 0) + 1;
      this.#noteBest(a, owned);
    }
    return items;
  }

  /** Current price of an owned item or variant (USD, 0 if unpriced). */
  priceOf(variant) {
    return this.#price(variant);
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
        tiers: s.tiers,
        games: Object.fromEntries(
          Object.entries(s.games).map(([k, v]) => {
            const { wageredCents, wonCents, ...rest } = v;
            return [k, { ...rest, wagered: wageredCents / 100, won: wonCents / 100 }];
          }),
        ),
        offlineEarned: (s.offlineCents ?? 0) / 100,
      },
      achievements: s.achievements,
      claimed: s.claimed,
    };
  }

  /** Also marks the account active (and pays offline income), so it's a transaction too. */
  view(userId) {
    return this.#act(userId, () => ({})).account;
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

  /**
   * Credit a batch of clicks. Past CLICK_CPS_LIMIT clicks per second each click pays
   * exponentially less (see clickEfficiency). `times` are the client's click timestamps:
   * only their spacing is used, and the timeline may not run ahead of real time, so faking
   * them can't make clicks look slower than they arrived. Without valid times the batch
   * counts as spread over the time since the last one.
   */
  click(userId, requested, times) {
    return this.#act(userId, (a) => {
      const n = Math.max(0, Math.min(CLICK_BATCH_MAX, Math.floor(Number(requested) || 0)));
      if (!n) return { credited: 0, paid: 0 };
      const now = Date.now();
      let st = this.clickBuckets.get(a.id);
      if (!st || now - st.recv > 60_000) st = { rate: 0, last: null, skew: Infinity, recv: now, carry: 0 };
      const valid =
        Array.isArray(times) &&
        times.length === n &&
        times.every((t, i) => Number.isFinite(t) && t >= (i ? times[i - 1] : (st.last ?? -Infinity))) &&
        times[n - 1] - now <= st.skew + CLICK_CLOCK_SLACK;
      let paid;
      if (valid) {
        st.skew = Math.min(st.skew, times[n - 1] - now);
        ({ rate: st.rate, last: st.last, paid } = rateClicks(st, times));
      } else {
        const secs = Math.min(1, Math.max(0.1, (now - st.recv) / 1000));
        paid = n * clickEfficiency(n / secs);
        st = { rate: 0, last: null, skew: Infinity, carry: st.carry };
      }
      st.recv = now;
      // Fractions of a cent carry over to the next batch.
      const earned = paid * cents(perkValue(a.perks, "clickPower")) + st.carry;
      const credited = Math.floor(earned);
      st.carry = earned - credited;
      this.clickBuckets.set(a.id, st);
      a.balanceCents += credited;
      a.stats.clicks += n;
      return { credited: n, paid };
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
      if (spendable(a) < cost) throw new GameError("insufficient", "Not enough balance");

      const items = Array.from({ length: n }, () => this.#newOwned(resolveDrop(c, (id) => this.#item(id), randomFloats(7)), c.id));
      a.balanceCents -= cost;
      a.inventory.unshift(...items);
      changes.added = items;
      a.stats.opened += n;
      a.stats.spentCents += cost;
      for (const owned of items) {
        const tier = this.#item(owned.itemId).tier;
        a.stats.tiers[tier] = (a.stats.tiers[tier] ?? 0) + 1;
        a.stats.unboxedCents += cents(this.#price(owned));
        this.#noteBest(a, owned);
      }
      // Only the best of a multi-open goes to the feed, held back until the reel lands (6 s).
      const best = items.reduce((x, y) => (this.#price(y) > this.#price(x) ? y : x));
      this.announce(changes, a, "case", best, cost / n / 100, { source: c.name }, 6500);
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
      if (spendable(a) < cents(next.cost)) throw new GameError("insufficient", "Not enough balance");
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
        this.announce(changes, a, "upgrader", owned, inputCents / 100, {}, 4400);
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
      // Achievements stay unlocked so their rewards can't be farmed by resetting.
      a.stats = { ...freshStats(), achievements: a.stats.achievements, claimed: a.stats.claimed };
      a.perks = { ...NO_PERKS };
      return {};
    });
  }
}

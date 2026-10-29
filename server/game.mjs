// Accounts and every action that touches money. The server rolls everything; the
// browser only ever learns the outcome. Each action loads the account, changes it
// and writes it back inside one SQLite transaction.

import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, renameSync } from "node:fs";
import {
  NO_PERKS,
  offlinePerHour,
  rewardScale,
  streakReward,
  utcDay,
  OFFLINE_CAP_HOURS,
  OFFLINE_MIN_GAP_MS,
  PERKS,
  DAILY_PRIZES,
  DAILY_SPIN_EVERY_MS,
  DAILY_SPIN_MS,
  PROFILE_BANNERS,
  SHOWCASE_MAX,
  clickEfficiency,
  rateClicks,
  UPGRADE_MAX_CHANCE,
  UPGRADE_MAX_ITEMS,
  UPGRADE_MIN_CHANCE,
  canStatTrak,
  floatInWear,
  needsKey,
  perkValue,
  pickWeighted,
  priceKey,
  resolveDrop,
  upgradeChance,
} from "../shared/game.js";
import { MAX_BALANCE_CENTS, tx } from "./db.mjs";
import { ACHIEVEMENTS, newlyMet } from "../shared/achievements.js";
import { claimMissions, ensureMissions, missionsView, trackMissions } from "./missions.mjs";

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

/** How long bet history is kept. */
const BET_HISTORY_DAYS = 30;

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

const RARE_TIERS = new Set(["classified", "covert", "gold"]);

/** The parts of an owned item the feed needs to draw it. */
const dropOf = (it) => ({ itemId: it.itemId, phase: it.phase, wear: it.wear, stattrak: it.stattrak });

export class Game {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {{ contents: () => any, prices: () => Record<string, number> }} market
   * @param {import("./feed.mjs").Feed} [feed] where big wins are announced
   * @param {import("./settings.mjs").Settings} [settings] the admin's rig setting
   */
  constructor(db, market, feed, settings) {
    this.db = db;
    this.market = market;
    this.feed = feed;
    this.settings = settings;
    /** userId -> click rate-limit bucket (in memory; resets harmlessly on restart) */
    this.clickBuckets = new Map();
    /** userId -> [{ cents, until }]: credited winnings not spendable until `until` (see spendable). */
    this.locks = new Map();
    /** fn(a, event) for every bet, case opening and click batch (see track). */
    this.trackers = [];
    /** Admin overrides, used once: userId -> the drop their next case opening gives / whether their next upgrade wins. */
    this.forcedDrops = new Map();
    this.forcedUpgrades = new Map();
    // Bet history: every settled bet and case opening, kept for BET_HISTORY_DAYS.
    db.exec(`CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, game TEXT NOT NULL,
      stake_cents INTEGER NOT NULL, payout_cents INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS bets_user ON bets(user_id, id)");
    this.betQ = {
      add: db.prepare("INSERT INTO bets (user_id, game, stake_cents, payout_cents, n, at) VALUES (?, ?, ?, ?, ?, ?)"),
      recent: db.prepare("SELECT game, stake_cents, payout_cents, n, at FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT ?"),
      prune: db.prepare("DELETE FROM bets WHERE at < ?"),
    };
    this.betQ.prune.run(Date.now() - BET_HISTORY_DAYS * 86_400_000);
    setInterval(() => this.betQ.prune.run(Date.now() - BET_HISTORY_DAYS * 86_400_000), 3_600_000).unref();
    this.q = {
      user: db.prepare("SELECT id, username, display_name, created_at, balance_cents, perks, stats, last_active FROM users WHERE id = ?"),
      rename: db.prepare("UPDATE users SET display_name = ? WHERE id = ?"),
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
      displayName: r.display_name || r.username,
      createdAt: r.created_at,
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
    // Capped (see MAX_BALANCE_CENTS), and always a whole number of cents.
    a.balanceCents = Math.max(0, Math.min(MAX_BALANCE_CENTS, Math.round(a.balanceCents)));
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
    const earned = Math.floor((offlinePerHour(a.perks) * 100 * ms) / 3_600_000);
    if (earned <= 0) return null;
    a.balanceCents += earned;
    a.stats.offlineCents = (a.stats.offlineCents ?? 0) + earned;
    return { earned: earned / 100, seconds: Math.round(ms / 1000) };
  }

  /** The login streak: the first visit of each day (UTC) pays a bonus that grows each day in a row. */
  #payStreak(a) {
    const today = utcDay();
    const last = a.stats.streak;
    if (last?.day === today) return null;
    const days = last?.day === today - 1 ? last.days + 1 : 1;
    const earned = cents(streakReward(a.perks, days));
    a.stats.streak = { day: today, days };
    a.balanceCents += earned;
    a.stats.streakCents = (a.stats.streakCents ?? 0) + earned;
    return { days, earned: earned / 100 };
  }

  /**
   * Load the account, pay any offline income, let fn change it, save it: one transaction.
   * fn gets the account and a `changes` object: `added` / `removed` items, and `wins`
   * to announce in the live feed once the transaction has committed.
   */
  #act(userId, fn) {
    const changes = {};
    let acc = null;
    const out = tx(this.db, () => {
      const a = this.#load(userId);
      acc = a;
      const offline = this.#payOffline(a);
      const streakPaid = this.#payStreak(a);
      ensureMissions(a);
      const result = fn(a, changes);
      const unlocked = this.#unlockAchievements(a);
      this.#save(a, changes);
      return { ...result, account: { ...this.#view(a), ...(offline ? { offline } : {}), ...(streakPaid ? { streakPaid } : {}), ...(unlocked.length ? { unlocked } : {}) } };
    });
    for (const { win, delayMs } of changes.wins ?? []) this.feed?.push(win, delayMs);
    // Settled bets go to the live feed once they're saved (it shows the big wins and losses).
    for (const ev of acc?.feedBets ?? []) this.feed?.bet(acc.username, acc.displayName, ev);
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
    this.track(a, { type: "game", game, stakeCents, payoutCents });
  }

  /**
   * One bet settled, cases opened or clicks paid: counts towards daily missions and
   * the leaderboards. Called inside the account's transaction.
   * @param {{ type: "game" | "cases" | "clicks", game?: string, n?: number, stakeCents?: number, payoutCents?: number }} ev
   */
  track(a, ev) {
    trackMissions(a, ev);
    if ((ev.type === "game" || ev.type === "cases") && ev.stakeCents > 0) {
      this.betQ.add.run(a.id, ev.game, ev.stakeCents, ev.payoutCents, ev.n ?? 1, Date.now());
      (a.feedBets ??= []).push(ev);
    }
    // Cashback event: part of a losing bet's loss comes straight back.
    const cb = this.settings?.event("cashback");
    if (cb && ev.stakeCents > 0 && ev.payoutCents < ev.stakeCents) {
      const back = Math.floor(((ev.stakeCents - ev.payoutCents) * cb.value) / 100);
      a.balanceCents += back;
      a.stats.cashbackCents = (a.stats.cashbackCents ?? 0) + back;
    }
    // Lucky hour: a winning bet's profit gets a share on top.
    const lucky = this.settings?.event("luckyHour");
    if (lucky && ev.type === "game" && ev.stakeCents > 0 && ev.payoutCents > ev.stakeCents) {
      const bonus = Math.floor(((ev.payoutCents - ev.stakeCents) * lucky.value) / 100);
      a.balanceCents += bonus;
      a.stats.luckyCents = (a.stats.luckyCents ?? 0) + bonus;
    }
    // The biggest single win, for the profile.
    if (ev.stakeCents > 0 && ev.payoutCents > ev.stakeCents && ev.payoutCents > (a.stats.bestWin?.cents ?? 0)) {
      a.stats.bestWin = { cents: ev.payoutCents, game: ev.game, mult: Math.round((ev.payoutCents / ev.stakeCents) * 100) / 100 };
    }
    for (const fn of this.trackers) fn(a, ev);
  }

  /**
   * Everyone's custom look (username -> { c: avatar colour, s: symbols, b: banner, which
   * colours their name }), for every page.
   */
  looks() {
    if (!this.lookMap) {
      this.lookMap = {};
      for (const r of this.db.prepare("SELECT username, stats FROM users WHERE stats LIKE '%\"look\"%' OR stats LIKE '%\"banner\"%'").all()) {
        this.#noteLook(r.username, JSON.parse(r.stats));
      }
    }
    return this.lookMap;
  }
  #noteLook(username, stats) {
    const c = stats.look?.color ?? null;
    const s = stats.look?.symbols ?? null;
    const b = stats.showcase?.banner && stats.showcase.banner !== "default" ? stats.showcase.banner : null;
    if (c || s || b) this.lookMap[username] = { c, s, b };
    else delete this.lookMap[username];
  }

  /**
   * Profile look: avatar colour (#rrggbb, or null for the one picked from your name), up to
   * three symbols instead of your initial (letters, numbers, emoji), a short bio and the
   * banner colour.
   */
  setLook(userId, body) {
    const color = body.color == null || body.color === "" ? null : String(body.color);
    if (color != null && !/^#[0-9a-f]{6}$/i.test(color)) throw new GameError("bad_input", "Pick a colour");
    const raw = String(body.symbols ?? "")
      .replace(/[\p{C}\s]/gu, "")
      .slice(0, 32);
    const symbols = [...new Intl.Segmenter().segment(raw)].map((x) => x.segment);
    if (symbols.length > 3) throw new GameError("bad_input", "Up to three symbols");
    const bio = String(body.bio ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (bio.length > 160) throw new GameError("bad_input", "Keep the bio to 160 characters");
    const banner = PROFILE_BANNERS.includes(body.banner) ? body.banner : null;
    return this.#act(userId, (a) => {
      a.stats.look = { color: color?.toLowerCase() ?? null, symbols: symbols.join("") || null };
      a.stats.bio = bio || null;
      if (banner) a.stats.showcase = { uids: a.stats.showcase?.uids ?? [], banner };
      this.looks();
      this.#noteLook(a.username, a.stats);
      return {};
    });
  }

  setShowcase(userId, body) {
    return this.#act(userId, (a) => {
      const uids = [...new Set(Array.isArray(body.uids) ? body.uids.map(String) : [])];
      if (uids.length > SHOWCASE_MAX) throw new GameError("bad_input", `Pick up to ${SHOWCASE_MAX} items`);
      if (uids.some((uid) => !a.inventory.some((it) => it.uid === uid))) throw new GameError("bad_input", "You don't own one of those items");
      // The banner is set with the profile look now; older pages still send it here.
      const banner = PROFILE_BANNERS.includes(body.banner) ? body.banner : (a.stats.showcase?.banner ?? "default");
      a.stats.showcase = { uids, banner };
      this.looks();
      this.#noteLook(a.username, a.stats);
      return {};
    });
  }

  /** Collect the reward of one finished daily mission, or all of them (id omitted). */
  claimMission(userId, id) {
    return this.#act(userId, (a) => {
      const base = claimMissions(a, id);
      if (!base) throw new GameError("nothing", "Nothing to claim");
      const total = Math.round(base * (this.settings?.event("missionBoost")?.value ?? 1));
      a.balanceCents += total;
      a.stats.missionCents = (a.stats.missionCents ?? 0) + total;
      return { reward: total / 100 };
    });
  }

  /**
   * Change the name shown to other players (the username, used to log in and to be
   * added as a friend, stays). 1–24 characters; empty resets it to the username.
   */
  rename(userId, name) {
    const clean = String(name ?? "")
      .normalize("NFC")
      .replace(/[\p{C}]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
    if ([...clean].length > 24) throw new GameError("bad_input", "Display names are up to 24 characters");
    return this.#act(userId, (a) => {
      this.q.rename.run(clean || null, a.id);
      a.displayName = clean || a.username;
      return {};
    });
  }

  /** Account details other players may see (the caller decides how much of it). */
  publicAccount(userId) {
    const a = this.#load(userId);
    return {
      user: a.username,
      name: a.displayName,
      joinedAt: a.createdAt,
      balance: a.balanceCents / 100,
      inventory: a.inventory,
      inventoryValue: Math.round(a.inventory.reduce((s, it) => s + this.#price(it), 0) * 100) / 100,
      stats: a.stats,
    };
  }

  /**
   * The free daily spin. Returns the prize slot; the winnings can't be spent until the
   * wheel has stopped on screen.
   */
  dailySpin(userId) {
    return this.#act(userId, (a) => {
      const now = Date.now();
      const next = (a.stats.lastSpin ?? 0) + DAILY_SPIN_EVERY_MS;
      if (now < next) throw new GameError("not_yet", "Your next spin isn't ready yet");
      // The rig makes the bigger prizes (the top half) rarer.
      const rig = this.rig("dailySpin");
      const weights = DAILY_PRIZES.map((p, i) => [i, p.weight * (i >= DAILY_PRIZES.length / 2 ? 1 - rig : 1)]);
      const slot = pickWeighted(weights, randomFloats(1)[0]);
      const prize = cents(DAILY_PRIZES[slot].usd * rewardScale(a.perks));
      a.balanceCents += prize;
      a.stats.lastSpin = now;
      a.stats.spinCents = (a.stats.spinCents ?? 0) + prize;
      this.lock(a, prize, DAILY_SPIN_MS + 250);
      return { slot, prize: prize / 100 };
    });
  }

  /** How much the house tilts `game` (0–1), set in the admin panel. */
  rig(game) {
    return this.settings?.rig(game) ?? 0;
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
    const win = { user: a.username, name: a.displayName, game, value: this.#price(owned), stake, tier: this.#item(owned.itemId).tier, drop: dropOf(owned), ...extra };
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
    return { c, costCents: this.#onSale(cents(price) + (needsKey(c) ? cents(keyPrice) : 0)) };
  }

  /** A case opening's cost with a running case sale taken off. */
  #onSale(costCents) {
    const sale = this.settings?.event("caseSale")?.value ?? 0;
    return Math.round((costCents * (100 - sale)) / 100);
  }

  /** Roll one drop from a case (not owned by anyone yet). */
  rollDrop(c) {
    return resolveDrop(c, (id) => this.#item(id), randomFloats(7));
  }

  /** Put already-owned items (from a pot or escrow) into an account, keeping their uids. */
  receive(a, changes, items, source) {
    const fresh = items.map((it) => ({ ...it, ...(source ? { source } : {}), obtainedAt: Date.now() }));
    a.inventory.unshift(...fresh);
    (changes.added ??= []).push(...fresh);
    return fresh;
  }

  /** Throws if any of `uids` is locked (the owner locked it so nothing can sell or stake it). */
  checkUnlocked(a, uids) {
    const locked = new Set(a.stats.locked ?? []);
    if (uids.some((uid) => locked.has(uid))) throw new GameError("locked", "One of those items is locked. Unlock it in your inventory first.");
  }

  /** Lock or unlock items you own. */
  setLocked(userId, uids, locked) {
    return this.#act(userId, (a) => {
      const ids = (Array.isArray(uids) ? uids : []).map(String).filter((uid) => a.inventory.some((it) => it.uid === uid));
      const set = new Set((a.stats.locked ?? []).filter((uid) => a.inventory.some((it) => it.uid === uid)));
      for (const uid of ids) locked ? set.add(uid) : set.delete(uid);
      a.stats.locked = [...set];
      return { count: ids.length };
    });
  }

  /** Take items out of an account (they must all be there). Returns them. */
  takeItems(a, changes, uids, max) {
    const ids = [...new Set((Array.isArray(uids) ? uids : []).map(String))];
    if (!ids.length || ids.length > max) throw new GameError("bad_input", `Pick 1 to ${max} items`);
    this.checkUnlocked(a, ids);
    const items = ids.map((uid) => a.inventory.find((it) => it.uid === uid));
    if (items.some((it) => !it)) throw new GameError("bad_input", "You don't own one of those items");
    a.inventory = a.inventory.filter((it) => !ids.includes(it.uid));
    (changes.removed ??= []).push(...ids);
    return items;
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
      displayName: a.displayName,
      // The admin panel is only for the account named exactly "admin".
      ...(a.username === "admin" ? { isAdmin: true } : {}),
      balance: a.balanceCents / 100,
      perks: a.perks,
      inventory: s.locked?.length ? a.inventory.map((it) => (s.locked.includes(it.uid) ? { ...it, locked: true } : it)) : a.inventory,
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
      nextSpinAt: (s.lastSpin ?? 0) + DAILY_SPIN_EVERY_MS,
      // Days in a row, counting today (0 once a day was missed).
      streak: s.streak && s.streak.day >= utcDay() - 1 ? s.streak.days : 0,
      missions: missionsView(s.missions),
      achievements: s.achievements,
      claimed: s.claimed,
    };
  }

  /** Your last `limit` bets and case openings, newest first. */
  betHistory(userId, limit = 100) {
    return this.betQ.recent.all(userId, Math.min(500, Math.max(1, Number(limit) || 100))).map((r) => ({
      game: r.game,
      stake: r.stake_cents / 100,
      payout: r.payout_cents / 100,
      n: r.n,
      at: r.at,
    }));
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
      // Fractions of a cent carry over to the next batch. A click frenzy event multiplies it.
      const boost = this.settings?.event("clickBoost")?.value ?? 1;
      const earned = paid * cents(perkValue(a.perks, "clickPower")) * boost + st.carry;
      const credited = Math.floor(earned);
      st.carry = earned - credited;
      this.clickBuckets.set(a.id, st);
      a.balanceCents += credited;
      a.stats.clicks += n;
      this.track(a, { type: "clicks", n });
      return { credited: n, paid };
    });
  }

  /**
   * Open `count` of one case at once (up to the account's multi-open level). `fast` skips
   * the reel, which costs the Skip animation perk's multiple of the price.
   */
  open(userId, caseId, count = 1, fast = false) {
    return this.#act(userId, (a, changes) => {
      const { cases, keyPrice } = this.market.contents();
      const c = cases.find((x) => x.id === caseId);
      if (!c) throw new GameError("unknown_case", "No such case", 404);
      const max = perkValue(a.perks, "multiOpen");
      const n = Math.floor(Number(count));
      if (!(n >= 1 && n <= max)) throw new GameError("bad_count", `You can open up to ${max} at once`);
      const casePrice = this.market.prices()[`case|${c.id}`];
      if (casePrice == null) throw new GameError("unavailable", "This container isn't on the market right now");
      const skip = fast ? perkValue(a.perks, "skipAnimation") : 0;
      if (fast && !skip) throw new GameError("locked", "Unlock Skip animation in the upgrade tree first");
      const each = this.#onSale(cents(casePrice) + (needsKey(c) ? cents(keyPrice) : 0));
      const cost = each * n * (skip || 1);
      if (spendable(a) < cost) throw new GameError("insufficient", "Not enough balance");

      const rig = this.rig("cases");
      const roll = () => resolveDrop(c, (id) => this.#item(id), randomFloats(7));
      const forced = this.forcedDrops.get(a.id);
      this.forcedDrops.delete(a.id);
      const items = Array.from({ length: n }, (_, k) => {
        if (k === 0 && forced) return this.#newOwned(forced, c.id);
        let drop = roll();
        // The rig re-rolls that share of Classified-and-up drops.
        if (rig > 0 && RARE_TIERS.has(this.#item(drop.itemId).tier) && randomFloats(1)[0] < rig) drop = roll();
        return this.#newOwned(drop, c.id);
      });
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
      this.track(a, { type: "cases", game: "cases", n, stakeCents: cost, payoutCents: items.reduce((sum, it) => sum + cents(this.#price(it)), 0) });
      const best = items.reduce((x, y) => (this.#price(y) > this.#price(x) ? y : x));
      this.announce(changes, a, "case", best, each / 100, { source: c.name }, 6500);
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
      // A side branch: only once the level it grows from is owned.
      const req = perk.requires;
      if (req && (a.perks[req.perk] ?? 0) < req.level) throw new GameError("locked", `Unlock ${PERKS[req.perk].name} level ${req.level} first`);
      if (spendable(a) < cents(next.cost)) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= cents(next.cost);
      a.perks[id]++;
      return { level: a.perks[id] };
    });
  }

  sell(userId, uids) {
    return this.#act(userId, (a, changes) => {
      const set = new Set(Array.isArray(uids) ? uids : []);
      this.checkUnlocked(a, [...set]);
      let total = 0;
      changes.removed = [];
      a.inventory = a.inventory.filter((it) => {
        if (!set.has(it.uid)) return true;
        total += cents(this.#price(it));
        changes.removed.push(it.uid);
        return false;
      });
      // Sell bonus event: the house adds a share on top.
      total = Math.round((total * (100 + (this.settings?.event("sellBonus")?.value ?? 0))) / 100);
      a.balanceCents += total;
      return { sold: total / 100 };
    });
  }

  /** Stake inventory items on one pricier target. */
  /**
   * `zone` is where the win zone starts on the ring, in degrees clockwise from the top
   * (the player drags it around); it covers `chance` of the ring from there. The arrow's
   * landing angle is rolled here and sent back, and the upgrade wins when it's in the zone.
   */
  upgrade(userId, uids, target, zone) {
    return this.#act(userId, (a, changes) => {
      const picked = [...new Set(Array.isArray(uids) ? uids : [])];
      if (!picked.length || picked.length > UPGRADE_MAX_ITEMS) throw new GameError("bad_input", `Pick 1–${UPGRADE_MAX_ITEMS} items`);
      const inputs = picked.map((uid) => a.inventory.find((it) => it.uid === uid));
      if (inputs.some((it) => !it)) throw new GameError("bad_input", "You don't own one of those items");
      this.checkUnlocked(a, picked);

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

      const [roll, floatR, rigR, spotR] = randomFloats(4);
      const width = chance * 360;
      const start = Number.isFinite(Number(zone)) ? ((Number(zone) % 360) + 360) % 360 : 180 - width / 2;
      let land = roll * 360;
      let won = (((land - start) % 360) + 360) % 360 < width;
      // An admin override or the rig (which shrinks the real chance below the one shown)
      // picks the result instead; the arrow then lands somewhere that matches it.
      const forced = this.forcedUpgrades.get(a.id);
      this.forcedUpgrades.delete(a.id);
      const decided = forced ?? (won && rigR < this.rig("upgrader") ? false : won);
      if (decided !== won) {
        won = decided;
        land = won ? start + width * (0.1 + 0.8 * spotR) : start + width + (360 - width) * (0.05 + 0.9 * spotR);
      }
      land = Math.round((((land % 360) + 360) % 360) * 100) / 100;
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
      this.track(a, { type: "game", game: "upgrade", stakeCents: inputCents, payoutCents: won ? targetCents : 0 });
      return { won, chance, item: owned, land, zone: Math.round(start * 100) / 100 };
    });
  }

  /** Wipe balance, inventory, stats and perks; the login stays. */
  reset(userId) {
    return this.#act(userId, (a) => {
      this.q.dropItems.run(a.id);
      a.inventory = [];
      a.balanceCents = cents(STARTING_BALANCE);
      // Achievements stay unlocked so their rewards can't be farmed by resetting.
      a.stats = { ...freshStats(), achievements: a.stats.achievements, claimed: a.stats.claimed, missions: a.stats.missions };
      a.perks = { ...NO_PERKS };
      return {};
    });
  }
}

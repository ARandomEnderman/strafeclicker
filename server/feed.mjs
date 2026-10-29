// Live feed: the sidebar list every browser sees. Two kinds of entries:
//
// Items won (skins, stickers, knives, gloves) from cases, the upgrader, battles, jackpot
// and coinflip, when they're worth a look:
//   - knives, gloves and Covert / Extraordinary items, always;
//   - anything worth ANNOUNCE_USD or more;
//   - or at least ANNOUNCE_MULT times what its case cost, if worth ANNOUNCE_MULT_MIN_USD.
//
// Big bets from every game but plinko, measured against the typical bet on the site (a
// running geometric mean of stakes, so a few whales don't drag it up):
//   - a win whose profit is SIGNIFICANT times the typical bet (games that win items show
//     the item instead);
//   - a loss of SIGNIFICANT times the typical bet.
// Either way it has to be at least BIG_MIN_USD.
//
// On top of that, flood control: one entry per player every PER_USER_MS, and once
// BUSY_COUNT entries went out in the last minute only BUSY_USD+ items get through.
// Knives, gloves and items over HUGE_USD skip both limits.
//
// Kept in SQLite so a restart doesn't empty it. Entries can be held back for a few
// seconds so a case reel isn't spoiled by the feed before it lands.

const ANNOUNCE_USD = 25;
const ANNOUNCE_MULT = 10;
const ANNOUNCE_MULT_MIN_USD = 2;
const PER_USER_MS = 15_000;
const BUSY_COUNT = 8;
const BUSY_USD = 50;
const HUGE_USD = 100;
const KEEP = 40;
const SIGNIFICANT = 10;
const BIG_MIN_USD = 5;
/** How fast the typical bet follows new bets (about the last 100 bets count). */
const AVG_WEIGHT = 0.01;
/** Games whose wins already show as the item won. */
const ITEM_GAMES = new Set(["cases", "upgrade", "battle", "jackpot", "coinflip"]);
const SKIP_GAMES = new Set(["plinko"]);
/** Held back until the browser's animation has shown the result. */
const BET_DELAY_MS = { cases: 6500, upgrade: 4400, keno: 1600 };

/** @param {{ tier: string, value: number, stake: number }} w */
export function worthAnnouncing({ tier, value, stake }) {
  if (tier === "gold" || tier === "covert") return true;
  if (value >= ANNOUNCE_USD) return true;
  return stake > 0 && value >= ANNOUNCE_MULT * stake && value >= ANNOUNCE_MULT_MIN_USD;
}

export class Feed {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    db.exec("CREATE TABLE IF NOT EXISTS wins (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    // Older versions also announced plinko / flashbang / b-hop payouts (without a "kind").
    db.exec(`DELETE FROM wins WHERE data NOT LIKE '%"drop":%' AND data NOT LIKE '%"kind":%'`);
    this.db = db;
    /** log of the typical bet (USD); seeded from bet history on first use. */
    this.avgLog = null;
    this.q = {
      add: db.prepare("INSERT INTO wins (data) VALUES (?)"),
      recent: db.prepare("SELECT id, data FROM wins ORDER BY id DESC LIMIT ?"),
      trim: db.prepare("DELETE FROM wins WHERE id <= (SELECT id FROM wins ORDER BY id DESC LIMIT 1 OFFSET ?)"),
    };
    this.list = this.q.recent.all(KEEP).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
    this.listeners = new Set();
    /** username -> time of their last entry */
    this.lastByUser = new Map();
  }

  onWin(fn) {
    this.listeners.add(fn);
  }

  /** Newest first. */
  recent() {
    return this.list;
  }

  #floodOk(win, now) {
    if (win.tier === "gold" || win.value >= HUGE_USD) return true;
    if (now - (this.lastByUser.get(win.user) ?? 0) < PER_USER_MS) return false;
    const lastMinute = this.list.filter((w) => now - w.at < 60_000).length;
    return lastMinute < BUSY_COUNT || win.value >= BUSY_USD;
  }

  /**
   * Announce an item win, if it's worth it.
   * @param {{ user: string, game: string, value: number, stake: number, tier: string, drop: object, source?: string }} win
   * @param {number} delayMs hold it back this long (the client's animation)
   */
  push(win, delayMs = 0) {
    if (!win.drop || !worthAnnouncing(win)) return;
    this.#publish({ kind: "item", ...win }, delayMs);
  }

  /** The typical bet on the site right now, USD. */
  typical() {
    if (this.avgLog == null) {
      const rows = this.db.prepare("SELECT stake_cents FROM bets WHERE game != 'plinko' ORDER BY id DESC LIMIT 2000").all();
      this.avgLog = rows.length ? rows.reduce((s, r) => s + Math.log(r.stake_cents / 100), 0) / rows.length : 0;
    }
    return Math.exp(this.avgLog);
  }

  /**
   * A settled bet (see Game#track): goes in the feed if it's a big win or a big loss
   * next to the typical bet, which it then counts towards.
   * @param {{ game: string, stakeCents: number, payoutCents: number }} ev
   */
  bet(user, name, ev) {
    if (SKIP_GAMES.has(ev.game) || !(ev.stakeCents > 0)) return;
    const stake = ev.stakeCents / 100;
    const payout = ev.payoutCents / 100;
    const typical = this.typical();
    this.avgLog += AVG_WEIGHT * (Math.log(stake) - this.avgLog);
    const bar = Math.max(BIG_MIN_USD, SIGNIFICANT * typical);
    const profit = payout - stake;
    const mult = Math.round((payout / stake) * 100) / 100;
    const base = { user, name, game: ev.game, stake, mult, typical: Math.round(typical * 100) / 100 };
    if (profit >= bar && !ITEM_GAMES.has(ev.game)) this.#publish({ ...base, kind: "win", value: payout }, BET_DELAY_MS[ev.game] ?? 0);
    else if (-profit >= bar) this.#publish({ ...base, kind: "loss", value: -profit }, BET_DELAY_MS[ev.game] ?? 0);
  }

  #publish(win, delayMs) {
    const publish = () => {
      const now = Date.now();
      if (!this.#floodOk(win, now)) return;
      this.lastByUser.set(win.user, now);
      const entry = { ...win, mult: win.mult ?? (win.stake > 0 ? Math.round((win.value / win.stake) * 100) / 100 : null), at: now };
      const { lastInsertRowid } = this.q.add.run(JSON.stringify(entry));
      this.q.trim.run(KEEP - 1);
      const full = { ...entry, id: Number(lastInsertRowid) };
      this.list = [full, ...this.list].slice(0, KEEP);
      this.listeners.forEach((fn) => fn(full));
    };
    if (delayMs > 0) setTimeout(publish, delayMs).unref();
    else publish();
  }
}

// Live wins feed: the sidebar list every browser sees. Only items (skins, stickers,
// knives, gloves) are announced, and only ones worth a look:
//
//   - knives, gloves and Covert / Extraordinary items, always;
//   - anything worth ANNOUNCE_USD or more;
//   - or at least ANNOUNCE_MULT times what its case cost, if worth ANNOUNCE_MULT_MIN_USD.
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
    // Older versions also announced plinko / flashbang / b-hop payouts.
    db.exec(`DELETE FROM wins WHERE data NOT LIKE '%"drop":%'`);
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
    const publish = () => {
      const now = Date.now();
      if (!this.#floodOk(win, now)) return;
      this.lastByUser.set(win.user, now);
      const entry = { ...win, mult: win.stake > 0 ? Math.round((win.value / win.stake) * 100) / 100 : null, at: now };
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

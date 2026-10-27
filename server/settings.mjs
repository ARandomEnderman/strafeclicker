// Site-wide settings the admin can change at runtime, kept in SQLite.
//
//   rig          0–1: how much the house tilts games in its favour, on top of the
//                normal odds (0 = fair, the odds shown are the real odds).
//   rigGames     per-game overrides of rig: { plinko: 0.2, ... } (missing = use rig)
//   maintenance  true pauses all betting and opening; players see a banner
//   announcement a message shown to everyone (null for none)
//   lbPrizes     USD paid to the top wagerers when a day / week ends: { daily: [1st, 2nd, ...], weekly: [...] }
//   rainMin      smallest /rain allowed (USD)

const DEFAULTS = { rig: 0, rigGames: {}, maintenance: false, announcement: null, lbPrizes: { daily: [25, 10, 5], weekly: [100, 50, 25] }, rainMin: 1 };

/** Games the rig applies to (player-vs-player games have no house to favour). */
export const RIGGABLE = ["cases", "upgrader", "plinko", "flashbang", "roulette", "bhop", "defuse", "towers", "keno", "race", "blackjack", "coinflipBot", "dailySpin"];

export class Settings {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.q = {
      all: db.prepare("SELECT key, value FROM settings"),
      put: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    };
    this.values = { ...DEFAULTS };
    for (const r of this.q.all.all()) this.values[r.key] = JSON.parse(r.value);
    this.listeners = new Set();
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`unknown setting ${key}`);
    this.values[key] = value;
    this.q.put.run(key, JSON.stringify(value));
    this.listeners.forEach((fn) => fn(key, value));
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  /** The rig for one game, 0–1. */
  rig(game) {
    const own = this.values.rigGames?.[game];
    return Math.min(1, Math.max(0, own ?? this.values.rig ?? 0));
  }

  /** What every browser may know: the announcement and whether betting is paused. */
  public() {
    return { maintenance: !!this.values.maintenance, announcement: this.values.announcement ?? null };
  }
}

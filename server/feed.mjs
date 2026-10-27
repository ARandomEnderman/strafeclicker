// Live "big wins" feed: the sidebar list every browser sees. Kept in SQLite so a
// restart doesn't empty it. Wins can be held back for a few seconds so a case reel or
// a plinko ball isn't spoiled by the feed before it lands.

/** A win makes the feed if it paid at least 2x the stake and either this much (USD)... */
export const BIG_WIN_USD = 5;
/** ...or this multiple of the stake (worth at least BIG_WIN_MULT_MIN_USD). */
export const BIG_WIN_MULT = 10;
const BIG_WIN_MULT_MIN_USD = 0.5;
const KEEP = 40;

export function isBigWin(value, stake) {
  const mult = stake > 0 ? value / stake : Infinity;
  return mult >= 2 && (value >= BIG_WIN_USD || (mult >= BIG_WIN_MULT && value >= BIG_WIN_MULT_MIN_USD));
}

export class Feed {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    db.exec("CREATE TABLE IF NOT EXISTS wins (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
    this.q = {
      add: db.prepare("INSERT INTO wins (data) VALUES (?)"),
      recent: db.prepare("SELECT id, data FROM wins ORDER BY id DESC LIMIT ?"),
      trim: db.prepare("DELETE FROM wins WHERE id <= (SELECT id FROM wins ORDER BY id DESC LIMIT 1 OFFSET ?)"),
    };
    this.list = this.q.recent.all(KEEP).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
    this.listeners = new Set();
  }

  onWin(fn) {
    this.listeners.add(fn);
  }

  /** Newest first. */
  recent() {
    return this.list;
  }

  /**
   * @param {{ user: string, game: string, value: number, stake: number, drop?: object, label?: string }} win
   * @param {number} delayMs hold it back this long (the client's animation)
   */
  push(win, delayMs = 0) {
    const publish = () => {
      const entry = { ...win, mult: win.stake > 0 ? Math.round((win.value / win.stake) * 100) / 100 : null, at: Date.now() };
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

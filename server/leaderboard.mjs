// Leaderboards: most wagered and biggest win, per UTC day and per week (weeks start
// Monday 00:00 UTC), plus the richest players right now. When a day or week ends, the
// top wagerers are paid the prizes set in the admin panel.
//
// The admin account is left out: it can give itself anything.

import { priceKey } from "../shared/game.js";
import { ADMIN_USERNAME } from "./admin.mjs";
import { tx } from "./db.mjs";
import { dayKey, nextMidnight } from "./missions.mjs";

const DAY_MS = 86_400_000;
/** The Monday (UTC) that starts the week of `t`, as YYYY-MM-DD. */
const weekStart = (t) => {
  const d = new Date(t);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
};
const periodKey = (kind, t = Date.now()) => (kind === "daily" ? `d:${dayKey(t)}` : `w:${dayKey(weekStart(t))}`);
const periodEnds = (kind, t = Date.now()) => (kind === "daily" ? nextMidnight(t) : weekStart(t) + 7 * DAY_MS);
const SHOWN = 10;
const RICH_CACHE_MS = 60_000;

export class Leaderboard {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("./game.mjs").Game} game
   * @param {import("./settings.mjs").Settings} settings
   * @param {{ toUser: (id: number, e: string, d: any) => void, announce: (text: string) => void }} io
   */
  constructor(db, game, settings, io) {
    this.db = db;
    this.game = game;
    this.settings = settings;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS lb (
      period TEXT NOT NULL, user_id INTEGER NOT NULL,
      wagered_cents INTEGER NOT NULL DEFAULT 0,
      best_cents INTEGER NOT NULL DEFAULT 0, best_game TEXT, best_mult REAL,
      PRIMARY KEY (period, user_id))`);
    db.exec("CREATE TABLE IF NOT EXISTS lb_paid (period TEXT PRIMARY KEY, winners TEXT NOT NULL, at INTEGER NOT NULL)");
    this.q = {
      // SET expressions see the row as it was, so best_game / best_mult compare with the old best.
      note: db.prepare(`INSERT INTO lb (period, user_id, wagered_cents, best_cents, best_game, best_mult) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (period, user_id) DO UPDATE SET
          wagered_cents = wagered_cents + excluded.wagered_cents,
          best_game = CASE WHEN excluded.best_cents > best_cents THEN excluded.best_game ELSE best_game END,
          best_mult = CASE WHEN excluded.best_cents > best_cents THEN excluded.best_mult ELSE best_mult END,
          best_cents = MAX(best_cents, excluded.best_cents)`),
      wagered: db.prepare(`SELECT l.user_id, l.wagered_cents AS v, u.username, u.display_name FROM lb l JOIN users u ON u.id = l.user_id
        WHERE l.period = ? AND l.wagered_cents > 0 AND u.banned = 0 ORDER BY l.wagered_cents DESC, l.user_id LIMIT ?`),
      best: db.prepare(`SELECT l.user_id, l.best_cents AS v, l.best_game, l.best_mult, u.username, u.display_name FROM lb l JOIN users u ON u.id = l.user_id
        WHERE l.period = ? AND l.best_cents > 0 AND u.banned = 0 ORDER BY l.best_cents DESC, l.user_id LIMIT ?`),
      mine: db.prepare("SELECT wagered_cents, best_cents FROM lb WHERE period = ? AND user_id = ?"),
      rankWagered: db.prepare("SELECT COUNT(*) AS n FROM lb l JOIN users u ON u.id = l.user_id WHERE l.period = ? AND l.wagered_cents > ? AND u.banned = 0"),
      rankBest: db.prepare("SELECT COUNT(*) AS n FROM lb l JOIN users u ON u.id = l.user_id WHERE l.period = ? AND l.best_cents > ? AND u.banned = 0"),
      unpaid: db.prepare("SELECT DISTINCT period FROM lb WHERE period NOT IN (SELECT period FROM lb_paid)"),
      paid: db.prepare("INSERT OR IGNORE INTO lb_paid (period, winners, at) VALUES (?, ?, ?)"),
      lastPaid: db.prepare("SELECT winners FROM lb_paid WHERE period = ?"),
      users: db.prepare("SELECT id, username, display_name, balance_cents FROM users WHERE banned = 0 AND username != ?"),
      items: db.prepare("SELECT user_id, item_id, phase, wear, stattrak FROM items"),
    };
    this.rich = { at: 0, rows: [] };
    game.trackers.push((a, ev) => this.#note(a, ev));
  }

  start() {
    this.#settle();
    this.timer = setInterval(() => this.#settle(), 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  #note(a, ev) {
    if (a.username === ADMIN_USERNAME || !(ev.stakeCents > 0)) return;
    const win = ev.payoutCents > ev.stakeCents ? ev.payoutCents : 0;
    const mult = win ? Math.round((ev.payoutCents / ev.stakeCents) * 100) / 100 : null;
    for (const kind of ["daily", "weekly"]) this.q.note.run(periodKey(kind), a.id, ev.stakeCents, win, win ? ev.game : null, mult);
  }

  /** Pay the prizes of every finished day and week not paid yet. */
  #settle() {
    const current = new Set([periodKey("daily"), periodKey("weekly")]);
    for (const { period } of this.q.unpaid.all()) {
      if (current.has(period)) continue;
      const kind = period.startsWith("d:") ? "daily" : "weekly";
      const prizes = this.settings.get("lbPrizes")?.[kind] ?? [];
      const top = this.q.wagered.all(period, prizes.length);
      const winners = top.map((r, i) => ({ user: r.username, name: r.display_name || r.username, wagered: r.v / 100, prize: Number(prizes[i]) || 0 }));
      tx(this.db, () => this.q.paid.run(period, JSON.stringify(winners), Date.now()));
      top.forEach((r, i) => {
        const prize = Math.round((Number(prizes[i]) || 0) * 100);
        if (prize <= 0) return;
        const { account } = this.game.act(r.user_id, (a) => {
          a.balanceCents += prize;
          a.stats.lbCents = (a.stats.lbCents ?? 0) + prize;
          return {};
        });
        this.io.toUser(r.user_id, "account", account);
      });
      const paid = winners.filter((w) => w.prize > 0);
      if (paid.length) {
        const when = kind === "daily" ? "yesterday" : "last week";
        this.io.announce(`Most wagered ${when}: ${paid.map((w, i) => `${i + 1}. ${w.name} ($${w.prize.toLocaleString("en-US")})`).join(", ")}`);
      }
    }
  }

  /** Everyone's balance plus inventory value, refreshed at most once a minute. */
  #richest() {
    if (Date.now() - this.rich.at < RICH_CACHE_MS) return this.rich.rows;
    const prices = this.game.market.prices();
    const worth = new Map();
    for (const it of this.q.items.all()) {
      const v = prices[priceKey({ itemId: it.item_id, phase: it.phase, wear: it.wear, stattrak: !!it.stattrak })] ?? 0;
      worth.set(it.user_id, (worth.get(it.user_id) ?? 0) + v);
    }
    const rows = this.q.users
      .all(ADMIN_USERNAME)
      .map((u) => ({ userId: u.id, user: u.username, name: u.display_name || u.username, balance: u.balance_cents / 100, items: Math.round((worth.get(u.id) ?? 0) * 100) / 100 }))
      .map((r) => ({ ...r, value: Math.round((r.balance + r.items) * 100) / 100 }))
      .sort((a, b) => b.value - a.value);
    this.rich = { at: Date.now(), rows };
    return rows;
  }

  #row(r, i) {
    return { rank: i + 1, user: r.username, name: r.display_name || r.username, value: r.v / 100, ...(r.best_game ? { game: r.best_game, mult: r.best_mult } : {}) };
  }

  view(userId, username) {
    const prizes = this.settings.get("lbPrizes") ?? {};
    const out = {};
    for (const kind of ["daily", "weekly"]) {
      const period = periodKey(kind);
      const mine = username === ADMIN_USERNAME ? null : this.q.mine.get(period, userId);
      const last = this.q.lastPaid.get(periodKey(kind, kind === "daily" ? Date.now() - DAY_MS : Date.now() - 7 * DAY_MS));
      out[kind] = {
        endsAt: periodEnds(kind),
        prizes: prizes[kind] ?? [],
        wagered: this.q.wagered.all(period, SHOWN).map((r, i) => this.#row(r, i)),
        best: this.q.best.all(period, SHOWN).map((r, i) => this.#row(r, i)),
        me: mine
          ? {
              wagered: mine.wagered_cents / 100,
              wageredRank: mine.wagered_cents > 0 ? this.q.rankWagered.get(period, mine.wagered_cents).n + 1 : null,
              best: mine.best_cents / 100,
              bestRank: mine.best_cents > 0 ? this.q.rankBest.get(period, mine.best_cents).n + 1 : null,
            }
          : null,
        lastWinners: last ? JSON.parse(last.winners) : [],
      };
    }
    const rich = this.#richest();
    const myRich = rich.findIndex((r) => r.userId === userId);
    out.richest = {
      rows: rich.slice(0, SHOWN).map(({ userId: _, ...r }, i) => ({ rank: i + 1, ...r })),
      me: myRich >= 0 ? { rank: myRich + 1, value: rich[myRich].value } : null,
      updatedAt: this.rich.at,
    };
    return out;
  }
}

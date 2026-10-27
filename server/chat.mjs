// Global chat, with two commands:
//
//   /rain <amount>        split your own money evenly among everyone else online
//   /pay <user> <amount>  send money to one player (only the two of you see it)
//
// The last HISTORY messages are kept in memory and sent on connect; everything is also
// written to chat_messages. The admin can delete messages, clear the chat and mute players.

import { CHAT_MAX_LEN, rainLevel } from "../shared/game.js";
import { ADMIN_USERNAME } from "./admin.mjs";
import { GameError, cents, spendable } from "./game.mjs";

const HISTORY = 80;
/** At most BURST messages per BURST_MS, and one per MIN_GAP_MS. */
const BURST = 4;
const BURST_MS = 8000;
const MIN_GAP_MS = 600;

/** "$1,250.50", "1250.5", "1.2k" -> USD */
function parseAmount(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[$,]/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
}

export class Chat {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("./game.mjs").Game} game
   * @param {import("./settings.mjs").Settings} settings
   * @param {{ broadcastPer: (e: string, d: (userId: number | null) => any) => void, broadcast: (e: string, d: any) => void,
   *   toUser: (id: number, e: string, d: any) => void, onlineIds: () => Set<number> }} io
   */
  constructor(db, game, settings, io) {
    this.game = game;
    this.settings = settings;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY, user_id INTEGER, kind TEXT NOT NULL, text TEXT NOT NULL,
      data TEXT, at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`);
    this.q = {
      add: db.prepare("INSERT INTO chat_messages (user_id, kind, text, data, at) VALUES (?, ?, ?, ?, ?)"),
      recent: db.prepare(`SELECT m.*, u.username, u.display_name FROM chat_messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.deleted = 0 ORDER BY m.id DESC LIMIT ?`),
      del: db.prepare("UPDATE chat_messages SET deleted = 1 WHERE id = ?"),
      clear: db.prepare("UPDATE chat_messages SET deleted = 1 WHERE deleted = 0"),
      user: db.prepare("SELECT id, username, display_name, banned, muted_until FROM users WHERE id = ?"),
      byName: db.prepare("SELECT id, username, display_name, banned FROM users WHERE username = ? COLLATE NOCASE"),
      mute: db.prepare("UPDATE users SET muted_until = ? WHERE id = ?"),
    };
    this.recent = this.q.recent
      .all(HISTORY)
      .reverse()
      .map((r) => ({ id: r.id, userId: r.user_id, user: r.username, name: r.display_name || r.username, kind: r.kind, text: r.text, at: r.at, data: r.data ? JSON.parse(r.data) : {} }));
    /** userId -> recent send times */
    this.sent = new Map();
  }

  // ---------- what browsers see ----------

  #view(m, viewerId) {
    if (m.data.to && !m.data.to.includes(viewerId)) return null;
    const base = { id: m.id, kind: m.kind, user: m.user ?? null, name: m.name ?? null, text: m.text, at: m.at, admin: m.user === ADMIN_USERNAME };
    if (m.kind === "rain") {
      const yours = viewerId != null ? m.data.shares?.[viewerId] : undefined;
      return { ...base, amount: m.data.amount / 100, count: m.data.count, level: m.data.level, yours: yours == null ? null : yours / 100, mine: viewerId === m.userId };
    }
    if (m.kind === "pay") return { ...base, amount: m.data.amount / 100, toUser: m.data.toUser, toName: m.data.toName, fromMe: viewerId === m.userId };
    return base;
  }

  history(viewerId) {
    return this.recent.map((m) => this.#view(m, viewerId)).filter(Boolean);
  }

  #push(userId, user, kind, text, data = {}) {
    const at = Date.now();
    const { lastInsertRowid } = this.q.add.run(userId, kind, text, JSON.stringify(data), at);
    const m = { id: Number(lastInsertRowid), userId, user: user?.username ?? null, name: user ? user.display_name || user.username : null, kind, text, at, data };
    this.recent.push(m);
    if (this.recent.length > HISTORY) this.recent.shift();
    // Private messages go only to the people in them.
    if (data.to) for (const id of data.to) this.io.toUser(id, "chatmsg", this.#view(m, id));
    else this.io.broadcastPer("chatmsg", (id) => this.#view(m, id));
    return m;
  }

  /** A message from the site itself (leaderboard results and such). */
  system(text) {
    this.#push(null, null, "system", String(text).slice(0, 500));
  }

  // ---------- sending ----------

  send(userId, raw) {
    const text = String(raw ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) throw new GameError("bad_input", "Type a message");
    if (text.length > CHAT_MAX_LEN) throw new GameError("bad_input", `Messages are up to ${CHAT_MAX_LEN} characters`);
    const user = this.q.user.get(userId);
    if (user.muted_until && user.muted_until > Date.now()) {
      const mins = Math.ceil((user.muted_until - Date.now()) / 60_000);
      throw new GameError("muted", `You're muted for ${mins >= 60 * 24 * 365 ? "good" : mins > 90 ? `${Math.round(mins / 60)} more hours` : `${mins} more minute${mins === 1 ? "" : "s"}`}`);
    }
    this.#rateLimit(userId);

    if (text.startsWith("/")) {
      const [cmd, ...args] = text.slice(1).split(" ");
      const c = cmd.toLowerCase();
      if (c === "rain") return this.#rain(user, args[0]);
      if (c === "pay" || c === "tip") return this.#pay(user, args[0], args[1]);
      throw new GameError("bad_input", "Unknown command. Try /rain <amount> or /pay <user> <amount>");
    }
    this.#push(userId, user, "msg", text);
    return {};
  }

  #rateLimit(userId) {
    const now = Date.now();
    const times = (this.sent.get(userId) ?? []).filter((t) => now - t < BURST_MS);
    if (times.length >= BURST || (times.length && now - times.at(-1) < MIN_GAP_MS)) throw new GameError("slow_down", "Slow down a little");
    times.push(now);
    this.sent.set(userId, times);
  }

  #rain(user, rawAmount) {
    const usd = parseAmount(rawAmount);
    const min = Number(this.settings.get("rainMin")) || 1;
    if (!(usd >= min)) throw new GameError("bad_input", `Usage: /rain <amount>, at least $${min}`);
    const total = cents(usd);
    const ids = [...this.io.onlineIds()].filter((id) => id !== user.id && !this.q.user.get(id)?.banned);
    if (!ids.length) throw new GameError("nobody", "Nobody else is online to catch it");
    const each = Math.floor(total / ids.length);
    if (each < 1) throw new GameError("bad_input", `Rain at least $${(ids.length / 100).toFixed(2)} so everyone gets a cent`);

    // Debit first: this throws if the rainer can't afford it, before anyone is paid.
    const { account } = this.game.act(user.id, (a) => {
      if (spendable(a) < total) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= total;
      a.stats.rainedCents = (a.stats.rainedCents ?? 0) + total;
      return {};
    });
    // The cents that don't split evenly go to random catchers, one each.
    const shares = Object.fromEntries(ids.map((id) => [id, each]));
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    for (let i = 0; i < total - each * ids.length; i++) shares[shuffled[i]]++;
    for (const id of ids) {
      const { account: acc } = this.game.act(id, (a) => {
        a.balanceCents += shares[id];
        a.stats.caughtCents = (a.stats.caughtCents ?? 0) + shares[id];
        return {};
      });
      this.io.toUser(id, "account", acc);
    }
    const level = rainLevel(total / 100);
    this.#push(user.id, user, "rain", "", { amount: total, count: ids.length, level, shares });
    return { account, rain: { amount: total / 100, count: ids.length, level } };
  }

  #pay(user, rawName, rawAmount) {
    const usd = parseAmount(rawAmount);
    if (!rawName || !(usd >= 0.01)) throw new GameError("bad_input", "Usage: /pay <user> <amount>");
    const to = this.q.byName.get(String(rawName).replace(/^@/, ""));
    if (!to || to.banned) throw new GameError("not_found", "No such player");
    if (to.id === user.id) throw new GameError("bad_input", "You can't pay yourself");
    const amount = cents(usd);
    const { accounts } = this.game.actPair(user.id, to.id, (a, b) => {
      if (spendable(a) < amount) throw new GameError("insufficient", "Not enough balance");
      a.balanceCents -= amount;
      b.balanceCents += amount;
      a.stats.paidCents = (a.stats.paidCents ?? 0) + amount;
      return {};
    });
    this.io.toUser(to.id, "account", accounts[1]);
    this.#push(user.id, user, "pay", "", { amount, to: [user.id, to.id], toUser: to.username, toName: to.display_name || to.username });
    return { account: accounts[0] };
  }

  // ---------- admin ----------

  delete(id) {
    const n = Number(id);
    this.q.del.run(n);
    this.recent = this.recent.filter((m) => m.id !== n);
    this.io.broadcast("chatdel", { id: n });
    return { ok: true };
  }

  clear() {
    this.q.clear.run();
    this.recent = [];
    this.io.broadcastPer("chat", (id) => this.history(id));
    return { ok: true };
  }

  /** Mute for `minutes` (0 unmutes, -1 forever). */
  mute(username, minutes) {
    const u = this.q.byName.get(String(username ?? ""));
    if (!u) throw new GameError("not_found", "No such user", 404);
    const m = Number(minutes);
    this.q.mute.run(m === 0 ? null : m < 0 ? 8.64e15 : Date.now() + m * 60_000, u.id);
    return { ok: true };
  }
}

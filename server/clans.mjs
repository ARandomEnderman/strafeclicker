// Clans: a name and a 2–4 character tag shown before every member's name. A clan is
// open (anyone joins) or by request (the owner accepts). Members share a clan chat,
// and clans are ranked by what their members wagered this week.
//
// The owner leaving hands the clan to the longest-standing member; the last member
// leaving disbands it.

import { GameError, cents, spendable } from "./game.mjs";
import { tx } from "./db.mjs";
import { periodKey } from "./leaderboard.mjs";

export const CLAN_MAX_MEMBERS = 20;
export const CLAN_COST_USD = 25;
const TAG_RE = /^[A-Z0-9]{2,4}$/;
const NAME_RE = /^[\p{L}\p{N} _'-]{3,24}$/u;

export class Clans {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("./game.mjs").Game} game
   * @param {{ broadcast: (e: string, d: any) => void, toUser: (id: number, e: string, d: any) => void, isOnline: (id: number) => boolean,
   *   onMembership: (userId: number) => void }} io  onMembership: someone joined or left a clan (their clan chat changes)
   */
  constructor(db, game, io) {
    this.db = db;
    this.game = game;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS clans (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
      open INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS clan_members (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
      role TEXT NOT NULL, joined_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS clan_requests (
      clan_id INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, PRIMARY KEY (clan_id, user_id))`);
    this.q = {
      clan: db.prepare("SELECT * FROM clans WHERE id = ?"),
      add: db.prepare("INSERT INTO clans (name, tag, open, created_at) VALUES (?, ?, ?, ?)"),
      setOpen: db.prepare("UPDATE clans SET open = ? WHERE id = ?"),
      del: db.prepare("DELETE FROM clans WHERE id = ?"),
      byName: db.prepare("SELECT 1 FROM clans WHERE name = ? OR tag = ?"),
      member: db.prepare("SELECT * FROM clan_members WHERE user_id = ?"),
      members: db.prepare(`SELECT m.user_id, m.role, m.joined_at, u.username, u.display_name FROM clan_members m JOIN users u ON u.id = m.user_id
        WHERE m.clan_id = ? ORDER BY m.role = 'owner' DESC, m.joined_at`),
      count: db.prepare("SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?"),
      join: db.prepare("INSERT INTO clan_members (user_id, clan_id, role, joined_at) VALUES (?, ?, ?, ?)"),
      leave: db.prepare("DELETE FROM clan_members WHERE user_id = ?"),
      setRole: db.prepare("UPDATE clan_members SET role = ? WHERE user_id = ?"),
      requests: db.prepare(`SELECT r.user_id, r.at, u.username, u.display_name FROM clan_requests r JOIN users u ON u.id = r.user_id WHERE r.clan_id = ? ORDER BY r.at`),
      request: db.prepare("INSERT OR IGNORE INTO clan_requests (clan_id, user_id, at) VALUES (?, ?, ?)"),
      dropRequest: db.prepare("DELETE FROM clan_requests WHERE clan_id = ? AND user_id = ?"),
      dropRequestsOf: db.prepare("DELETE FROM clan_requests WHERE user_id = ?"),
      myRequests: db.prepare("SELECT clan_id FROM clan_requests WHERE user_id = ?"),
      userByName: db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE"),
      tags: db.prepare("SELECT u.username, c.tag FROM clan_members m JOIN users u ON u.id = m.user_id JOIN clans c ON c.id = m.clan_id"),
      board: db.prepare(`SELECT c.id, c.name, c.tag, c.open, COUNT(m.user_id) AS members, COALESCE(SUM(l.wagered_cents), 0) AS wagered
        FROM clans c JOIN clan_members m ON m.clan_id = c.id LEFT JOIN lb l ON l.user_id = m.user_id AND l.period = ?
        GROUP BY c.id ORDER BY wagered DESC, members DESC, c.id LIMIT 50`),
    };
  }

  /** username -> tag for every clan member (sent to browsers so names can show tags). */
  tags() {
    return Object.fromEntries(this.q.tags.all().map((r) => [r.username, r.tag]));
  }
  #changed(...userIds) {
    this.io.broadcast("tags", this.tags());
    for (const id of userIds) this.io.onMembership(id);
  }

  /** The clan id a user is in, or null. */
  clanOf(userId) {
    return this.q.member.get(userId)?.clan_id ?? null;
  }
  /** Ids of everyone in a clan. */
  memberIds(clanId) {
    return this.q.members.all(clanId).map((m) => m.user_id);
  }

  #mine(userId) {
    const m = this.q.member.get(userId);
    if (!m) throw new GameError("no_clan", "You're not in a clan");
    return m;
  }
  #owner(userId) {
    const m = this.#mine(userId);
    if (m.role !== "owner") throw new GameError("forbidden", "Only the clan owner can do that", 403);
    return m;
  }
  #userId(username) {
    const r = this.q.userByName.get(String(username ?? ""));
    if (!r) throw new GameError("not_found", "No such player", 404);
    return r.id;
  }

  create(userId, body) {
    const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
    const tag = String(body.tag ?? "").trim().toUpperCase();
    if (!NAME_RE.test(name)) throw new GameError("bad_input", "Clan names are 3–24 letters, digits, spaces, _ ' or -");
    if (!TAG_RE.test(tag)) throw new GameError("bad_input", "Tags are 2–4 letters or digits");
    if (this.q.member.get(userId)) throw new GameError("busy", "Leave your clan first");
    if (this.q.byName.get(name, tag)) throw new GameError("taken", "That name or tag is taken", 409);
    let id;
    const out = this.game.act(userId, (a) => {
      const cost = cents(CLAN_COST_USD);
      if (spendable(a) < cost) throw new GameError("insufficient", `Starting a clan costs $${CLAN_COST_USD}`);
      a.balanceCents -= cost;
      id = Number(this.q.add.run(name, tag, body.open === false ? 0 : 1, Date.now()).lastInsertRowid);
      this.q.join.run(userId, id, "owner", Date.now());
      this.q.dropRequestsOf.run(userId);
      return {};
    });
    this.#changed(userId);
    return { ...out, clan: this.view(id, userId) };
  }

  join(userId, body) {
    const c = this.q.clan.get(Number(body.id));
    if (!c) throw new GameError("not_found", "No such clan", 404);
    if (this.q.member.get(userId)) throw new GameError("busy", "Leave your clan first");
    if (this.q.count.get(c.id).n >= CLAN_MAX_MEMBERS) throw new GameError("full", "That clan is full");
    if (!c.open) {
      this.q.request.run(c.id, userId, Date.now());
      for (const m of this.q.members.all(c.id)) if (m.role === "owner") this.io.toUser(m.user_id, "clan", { requests: true });
      return { requested: true, clan: this.view(c.id, userId) };
    }
    tx(this.db, () => {
      this.q.join.run(userId, c.id, "member", Date.now());
      this.q.dropRequestsOf.run(userId);
    });
    this.#changed(userId);
    return { clan: this.view(c.id, userId) };
  }

  /** Owner: let a requester in, or turn them away. */
  answer(userId, body, accept) {
    const own = this.#owner(userId);
    const who = this.#userId(body.username);
    const pending = this.q.requests.all(own.clan_id).some((r) => r.user_id === who);
    if (!pending) throw new GameError("not_found", "No such request", 404);
    this.q.dropRequest.run(own.clan_id, who);
    if (accept) {
      if (this.q.member.get(who)) throw new GameError("busy", "They joined another clan meanwhile");
      if (this.q.count.get(own.clan_id).n >= CLAN_MAX_MEMBERS) throw new GameError("full", "Your clan is full");
      tx(this.db, () => {
        this.q.join.run(who, own.clan_id, "member", Date.now());
        this.q.dropRequestsOf.run(who);
      });
      this.#changed(who);
    }
    return { clan: this.view(own.clan_id, userId) };
  }

  leave(userId) {
    const m = this.#mine(userId);
    tx(this.db, () => {
      this.q.leave.run(userId);
      const rest = this.q.members.all(m.clan_id);
      if (!rest.length) this.q.del.run(m.clan_id);
      else if (m.role === "owner") this.q.setRole.run("owner", rest.sort((x, y) => x.joined_at - y.joined_at)[0].user_id);
    });
    this.#changed(userId);
    return { clan: null };
  }

  kick(userId, body) {
    const own = this.#owner(userId);
    const who = this.#userId(body.username);
    if (who === userId) throw new GameError("bad_input", "Use Leave to leave your own clan");
    if (this.clanOf(who) !== own.clan_id) throw new GameError("not_found", "They're not in your clan", 404);
    this.q.leave.run(who);
    this.#changed(who);
    this.io.toUser(who, "clan", { kicked: true });
    return { clan: this.view(own.clan_id, userId) };
  }

  settings(userId, body) {
    const own = this.#owner(userId);
    this.q.setOpen.run(body.open ? 1 : 0, own.clan_id);
    return { clan: this.view(own.clan_id, userId) };
  }

  // ---------- what browsers see ----------

  view(clanId, viewerId) {
    const c = this.q.clan.get(clanId);
    if (!c) throw new GameError("not_found", "No such clan", 404);
    const members = this.q.members.all(c.id);
    const me = members.find((m) => m.user_id === viewerId);
    const week = periodKey("weekly");
    const wagered = this.q.board.all(week).find((r) => r.id === c.id)?.wagered ?? 0;
    return {
      id: c.id,
      name: c.name,
      tag: c.tag,
      open: !!c.open,
      createdAt: c.created_at,
      weekWagered: wagered / 100,
      max: CLAN_MAX_MEMBERS,
      members: members.map((m) => ({ user: m.username, name: m.display_name || m.username, role: m.role, joinedAt: m.joined_at, online: this.io.isOnline(m.user_id) })),
      myRole: me?.role ?? null,
      requested: !me && this.q.myRequests.all(viewerId).some((r) => r.clan_id === c.id),
      // Only the owner sees who's asking to join.
      requests: me?.role === "owner" ? this.q.requests.all(c.id).map((r) => ({ user: r.username, name: r.display_name || r.username, at: r.at })) : [],
    };
  }

  /** The clans page: your clan (if any) and the weekly board. */
  overview(userId) {
    const mine = this.clanOf(userId);
    return {
      mine: mine ? this.view(mine, userId) : null,
      board: this.q.board.all(periodKey("weekly")).map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, tag: r.tag, open: !!r.open, members: r.members, wagered: r.wagered / 100 })),
      cost: CLAN_COST_USD,
      max: CLAN_MAX_MEMBERS,
    };
  }
}

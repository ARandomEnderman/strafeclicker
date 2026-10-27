// Friends: a request by username, accepted by the other side. Used for friends-only
// case battles (and to show who's online).

import { GameError } from "./game.mjs";

const MAX_FRIENDS = 200;

export class Friends {
  /** @param {import("node:sqlite").DatabaseSync} db */
  constructor(db) {
    // One row per pair, smaller id first.
    db.exec(`CREATE TABLE IF NOT EXISTS friends (
      user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL, requested_by INTEGER NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (user_a, user_b))`);
    this.q = {
      user: db.prepare("SELECT id, username FROM users WHERE username = ?"),
      get: db.prepare("SELECT * FROM friends WHERE user_a = ? AND user_b = ?"),
      add: db.prepare("INSERT INTO friends (user_a, user_b, status, requested_by, at) VALUES (?, ?, 'pending', ?, ?)"),
      accept: db.prepare("UPDATE friends SET status = 'accepted', at = ? WHERE user_a = ? AND user_b = ?"),
      remove: db.prepare("DELETE FROM friends WHERE user_a = ? AND user_b = ?"),
      of: db.prepare(`SELECT f.status, f.requested_by, u.id, u.username FROM friends f
        JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
        WHERE f.user_a = ? OR f.user_b = ? ORDER BY u.username COLLATE NOCASE`),
      count: db.prepare("SELECT COUNT(*) AS n FROM friends WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'"),
    };
  }

  #pair = (x, y) => (x < y ? [x, y] : [y, x]);

  areFriends(x, y) {
    if (x == null || y == null) return false;
    return this.q.get.get(...this.#pair(x, y))?.status === "accepted";
  }

  /** @param {(id: number) => boolean} online */
  list(userId, online = () => false) {
    const rows = this.q.of.all(userId, userId, userId);
    const pick = (r) => ({ user: r.username, online: online(r.id) });
    return {
      friends: rows.filter((r) => r.status === "accepted").map(pick),
      incoming: rows.filter((r) => r.status === "pending" && r.requested_by !== userId).map(pick),
      outgoing: rows.filter((r) => r.status === "pending" && r.requested_by === userId).map(pick),
    };
  }

  #other(userId, username) {
    const u = this.q.user.get(String(username ?? "").trim());
    if (!u) throw new GameError("not_found", "No user with that name", 404);
    if (u.id === userId) throw new GameError("bad_input", "That's you");
    return u;
  }

  /** Send a request (or accept theirs, if they already asked). Returns the other user's id. */
  request(userId, username) {
    const u = this.#other(userId, username);
    const pair = this.#pair(userId, u.id);
    const row = this.q.get.get(...pair);
    if (row?.status === "accepted") throw new GameError("busy", `You're already friends with ${u.username}`);
    if (row && row.requested_by === userId) throw new GameError("busy", "Request already sent");
    if (this.q.count.get(userId, userId).n >= MAX_FRIENDS) throw new GameError("busy", `Up to ${MAX_FRIENDS} friends`);
    if (row) this.q.accept.run(Date.now(), ...pair);
    else this.q.add.run(...pair, userId, Date.now());
    return u.id;
  }

  accept(userId, username) {
    const u = this.#other(userId, username);
    const pair = this.#pair(userId, u.id);
    const row = this.q.get.get(...pair);
    if (!row || row.status !== "pending" || row.requested_by === userId) throw new GameError("not_found", "No request from them");
    this.q.accept.run(Date.now(), ...pair);
    return u.id;
  }

  /** Decline, cancel or unfriend. */
  remove(userId, username) {
    const u = this.#other(userId, username);
    this.q.remove.run(...this.#pair(userId, u.id));
    return u.id;
  }
}

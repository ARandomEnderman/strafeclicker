// Trades between friends: an offer of some of your items (and/or cash) for some of
// theirs. Nothing is held while an offer is open; when it's accepted, everything is
// checked again and moved in one transaction, or the offer fails.

import { GameError, cents, spendable } from "./game.mjs";

const MAX_ITEMS = 20;
const MAX_OPEN_OUTGOING = 20;
const MAX_CASH = 1_000_000;
const KEEP_HISTORY = 20;

export class Trades {
  /**
   * @param {import("./game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("./friends.mjs").Friends} friends
   * @param {{ toUser: (userId: number, event: string, data: any) => void }} io
   */
  constructor(game, db, friends, io) {
    this.game = game;
    this.friends = friends;
    this.io = io;
    db.exec(`CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      give TEXT NOT NULL, get TEXT NOT NULL,
      give_cents INTEGER NOT NULL, get_cents INTEGER NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS trades_from ON trades(from_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS trades_to ON trades(to_id, status)");
    this.q = {
      user: db.prepare("SELECT id, username FROM users WHERE username = ?"),
      name: db.prepare("SELECT username, display_name FROM users WHERE id = ?"),
      items: db.prepare("SELECT * FROM items WHERE user_id = ? ORDER BY obtained_at DESC, rowid DESC"),
      add: db.prepare("INSERT INTO trades (from_id, to_id, give, get, give_cents, get_cents, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)"),
      get: db.prepare("SELECT * FROM trades WHERE id = ?"),
      status: db.prepare("UPDATE trades SET status = ?, updated_at = ? WHERE id = ?"),
      open: db.prepare("SELECT * FROM trades WHERE (from_id = ? OR to_id = ?) AND status = 'open' ORDER BY id DESC"),
      history: db.prepare("SELECT * FROM trades WHERE (from_id = ? OR to_id = ?) AND status != 'open' ORDER BY updated_at DESC LIMIT ?"),
      outgoing: db.prepare("SELECT COUNT(*) AS n FROM trades WHERE from_id = ? AND status = 'open'"),
    };
  }

  #friend(userId, username) {
    const u = this.q.user.get(String(username ?? "").trim());
    if (!u || u.id === userId) throw new GameError("not_found", "No such player");
    if (!this.friends.areFriends(userId, u.id)) throw new GameError("forbidden", `You can only trade with friends. Add ${u.username} first.`, 403);
    return u;
  }

  /** A friend's inventory, to pick items to ask for. */
  inventory(userId, username) {
    const u = this.#friend(userId, username);
    return { user: u.username, items: this.q.items.all(u.id).map(publicItem) };
  }

  offer(userId, body) {
    const u = this.#friend(userId, body.username);
    const give = uniqueIds(body.give);
    const get = uniqueIds(body.get);
    const giveCents = cashCents(body.giveCash);
    const getCents = cashCents(body.getCash);
    if (give.length > MAX_ITEMS || get.length > MAX_ITEMS) throw new GameError("bad_input", `Up to ${MAX_ITEMS} items on each side`);
    if (!give.length && !get.length) throw new GameError("bad_input", "Add at least one item");
    if (this.q.outgoing.get(userId).n >= MAX_OPEN_OUTGOING) throw new GameError("busy", `You can have ${MAX_OPEN_OUTGOING} offers waiting at a time`);
    const mine = new Set(this.q.items.all(userId).map((r) => r.uid));
    const theirs = new Set(this.q.items.all(u.id).map((r) => r.uid));
    if (give.some((x) => !mine.has(x))) throw new GameError("bad_input", "You don't own one of those items");
    if (get.some((x) => !theirs.has(x))) throw new GameError("bad_input", `${u.username} doesn't own one of those items any more`);
    const now = Date.now();
    this.q.add.run(userId, u.id, JSON.stringify(give), JSON.stringify(get), giveCents, getCents, now, now);
    this.#notify(userId, u.id);
    return this.list(userId);
  }

  accept(userId, id) {
    const t = this.#open(id);
    if (t.to_id !== userId) throw new GameError("forbidden", "That offer isn't to you", 403);
    const give = JSON.parse(t.give);
    const get = JSON.parse(t.get);
    let accounts;
    try {
      ({ accounts } = this.game.actPair(t.from_id, t.to_id, (from, to, cf, ct) => {
        const move = (src, dst, uids, cs, cd) => {
          const items = uids.map((uid) => src.inventory.find((it) => it.uid === uid));
          if (items.some((it) => !it)) throw new GameError("gone", `${src.username} no longer has every item in this offer`);
          if (uids.some((uid) => (src.stats.locked ?? []).includes(uid))) throw new GameError("locked", `${src.username} has locked one of the items in this offer`);
          src.inventory = src.inventory.filter((it) => !uids.includes(it.uid));
          const moved = items.map((it) => ({ ...it, source: "trade", obtainedAt: Date.now() }));
          dst.inventory.unshift(...moved);
          (cs.removed ??= []).push(...uids);
          (cd.added ??= []).push(...moved);
        };
        if (spendable(from) < t.give_cents) throw new GameError("gone", `${from.username} can't cover the cash in this offer any more`);
        if (spendable(to) < t.get_cents) throw new GameError("insufficient", "Not enough balance for the cash in this offer");
        move(from, to, give, cf, ct);
        move(to, from, get, ct, cf);
        from.balanceCents += t.get_cents - t.give_cents;
        to.balanceCents += t.give_cents - t.get_cents;
        return {};
      }));
    } catch (err) {
      if (err instanceof GameError && err.code === "gone") {
        this.q.status.run("failed", Date.now(), t.id);
        this.#notify(t.from_id, t.to_id);
      }
      throw err;
    }
    this.q.status.run("accepted", Date.now(), t.id);
    // Both players' inventories changed.
    this.io.toUser(t.from_id, "account", accounts[0]);
    this.io.toUser(t.to_id, "account", accounts[1]);
    this.#notify(t.from_id, t.to_id);
    return { ...this.list(userId), account: accounts[1] };
  }

  /** The recipient declines, or the sender takes the offer back. */
  close(userId, id) {
    const t = this.#open(id);
    if (t.from_id !== userId && t.to_id !== userId) throw new GameError("forbidden", "Not your offer", 403);
    this.q.status.run(t.from_id === userId ? "cancelled" : "declined", Date.now(), t.id);
    this.#notify(t.from_id, t.to_id);
    return this.list(userId);
  }

  #open(id) {
    const t = this.q.get.get(Number(id));
    if (!t) throw new GameError("not_found", "No such offer", 404);
    if (t.status !== "open") throw new GameError("closed", "That offer is no longer open");
    return t;
  }

  /** Open offers to and from the user, plus recent finished ones, with item details. */
  list(userId) {
    const view = (t) => {
      const owner = (uid) => this.game.findItem(uid);
      return {
        id: t.id,
        incoming: t.to_id === userId,
        from: this.q.name.get(t.from_id)?.username ?? "?",
        to: this.q.name.get(t.to_id)?.username ?? "?",
        fromName: displayOf(this.q.name.get(t.from_id)),
        toName: displayOf(this.q.name.get(t.to_id)),
        give: JSON.parse(t.give).map((uid) => owner(uid) ?? { uid, missing: true }),
        get: JSON.parse(t.get).map((uid) => owner(uid) ?? { uid, missing: true }),
        giveCash: t.give_cents / 100,
        getCash: t.get_cents / 100,
        status: t.status,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      };
    };
    return {
      open: this.q.open.all(userId, userId).map(view),
      history: this.q.history.all(userId, userId, KEEP_HISTORY).map(view),
    };
  }

  #notify(...userIds) {
    for (const id of userIds) this.io.toUser(id, "trades", this.list(id));
  }
}

const displayOf = (r) => r?.display_name || r?.username || "?";
const uniqueIds = (x) => [...new Set((Array.isArray(x) ? x : []).map(String))];

function cashCents(x) {
  const c = cents(Number(x) || 0);
  if (!(c >= 0 && c <= cents(MAX_CASH))) throw new GameError("bad_input", "Invalid cash amount");
  return c;
}

const publicItem = (r) => ({
  uid: r.uid,
  itemId: r.item_id,
  phase: r.phase,
  float: r.float,
  wear: r.wear,
  stattrak: !!r.stattrak,
  seed: r.seed,
});

// Promo codes: made in the admin panel, redeemed once per player. A code gives balance,
// an item, or both; it can be limited to a number of uses and can expire.

import { GameError, cents } from "./game.mjs";
import { makeDrop } from "./admin.mjs";
import { tx } from "./db.mjs";

const CODE_RE = /^[A-Z0-9_-]{3,24}$/;
const clean = (code) =>
  String(code ?? "")
    .trim()
    .toUpperCase();

export class Promos {
  /**
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("./game.mjs").Game} game
   */
  constructor(db, game) {
    this.db = db;
    this.game = game;
    db.exec(`CREATE TABLE IF NOT EXISTS promo_codes (
      code TEXT PRIMARY KEY, reward TEXT NOT NULL, max_uses INTEGER NOT NULL DEFAULT 0,
      uses INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS promo_uses (
      code TEXT NOT NULL, user_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (code, user_id))`);
    this.q = {
      get: db.prepare("SELECT * FROM promo_codes WHERE code = ?"),
      add: db.prepare("INSERT INTO promo_codes (code, reward, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"),
      del: db.prepare("DELETE FROM promo_codes WHERE code = ?"),
      delUses: db.prepare("DELETE FROM promo_uses WHERE code = ?"),
      all: db.prepare("SELECT * FROM promo_codes ORDER BY created_at DESC"),
      used: db.prepare("SELECT 1 FROM promo_uses WHERE code = ? AND user_id = ?"),
      use: db.prepare("INSERT INTO promo_uses (code, user_id, at) VALUES (?, ?, ?)"),
      bump: db.prepare("UPDATE promo_codes SET uses = uses + 1 WHERE code = ?"),
    };
  }

  #rewardText(reward) {
    const parts = [];
    if (reward.cents) parts.push(`$${(reward.cents / 100).toFixed(2)}`);
    if (reward.item) {
      const it = this.game.item(reward.item.itemId);
      parts.push(`${reward.item.stattrak ? "StatTrak " : ""}${it?.name ?? reward.item.itemId}${reward.item.wear ? ` (${reward.item.wear})` : ""}`);
    }
    return parts.join(" + ");
  }

  redeem(userId, code) {
    const c = clean(code);
    if (!c) throw new GameError("bad_input", "Enter a code");
    const row = this.q.get.get(c);
    // Same message for unknown, expired and used up, so codes can't be probed.
    if (!row || (row.expires_at && row.expires_at < Date.now()) || (row.max_uses && row.uses >= row.max_uses)) throw new GameError("bad_code", "That code isn't valid");
    if (this.q.used.get(c, userId)) throw new GameError("used", "You've already used that code");
    const reward = JSON.parse(row.reward);
    const out = this.game.act(userId, (a, changes) => {
      this.q.use.run(c, userId, Date.now());
      this.q.bump.run(c);
      if (reward.cents) a.balanceCents += reward.cents;
      if (reward.item) this.game.grant(a, changes, [makeDrop(this.game, reward.item)], "promo");
      return { reward: this.#rewardText(reward) };
    });
    return out;
  }

  // ---------- admin ----------

  create(body) {
    const code = clean(body.code);
    if (!CODE_RE.test(code)) throw new GameError("bad_input", "Codes are 3–24 letters, digits, - or _");
    if (this.q.get.get(code)) throw new GameError("bad_input", "That code already exists");
    const reward = {};
    const usd = Number(body.usd);
    if (usd > 0) reward.cents = cents(usd);
    if (body.item?.itemId) {
      const d = makeDrop(this.game, body.item);
      reward.item = { itemId: d.itemId, wear: d.wear, phase: d.phase, stattrak: d.stattrak };
    }
    if (!reward.cents && !reward.item) throw new GameError("bad_input", "Give the code some balance or an item");
    const maxUses = Math.max(0, Math.floor(Number(body.maxUses) || 0));
    const hours = Number(body.hours);
    const expires = hours > 0 ? Date.now() + hours * 3_600_000 : null;
    this.q.add.run(code, JSON.stringify(reward), maxUses, expires, Date.now());
    return { codes: this.list() };
  }

  remove(code) {
    const c = clean(code);
    tx(this.db, () => {
      this.q.del.run(c);
      this.q.delUses.run(c);
    });
    return { codes: this.list() };
  }

  list() {
    return this.q.all.all().map((r) => {
      const reward = JSON.parse(r.reward);
      return {
        code: r.code,
        reward: this.#rewardText(reward),
        uses: r.uses,
        maxUses: r.max_uses,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        active: !(r.expires_at && r.expires_at < Date.now()) && !(r.max_uses && r.uses >= r.max_uses),
      };
    });
  }
}

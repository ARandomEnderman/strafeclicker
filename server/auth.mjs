// Usernames, passwords and login sessions.

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { GameError } from "./game.mjs";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 64;
const SESSION_DAYS = 30;

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const MIN_PASSWORD = 8;

/** "scrypt$N$r$p$salt$hash", so the parameters can change later without breaking old hashes. */
async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(actual, expected);
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/**
 * Failed logins: at most 15 per IP every 10 minutes. Limited per IP rather than per
 * username, so nobody can lock someone else out by guessing at their name.
 */
const MAX_FAILURES = 15;
const FAIL_WINDOW_MS = 10 * 60_000;
const failures = new Map(); // ip -> timestamps of recent failures

function recentFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failures.set(ip, list);
  else failures.delete(ip);
  return list;
}

export class Auth {
  constructor(db, game) {
    this.db = db;
    this.game = game;
    this.q = {
      byName: db.prepare("SELECT id, pass_hash, banned FROM users WHERE username = ?"),
      nameOf: db.prepare("SELECT username FROM users WHERE id = ?"),
      // Banned accounts' sessions stop working at once.
      session: db.prepare("SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0"),
      addSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"),
      dropSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
      expire: db.prepare("DELETE FROM sessions WHERE expires_at <= ?"),
      setHash: db.prepare("UPDATE users SET pass_hash = ? WHERE id = ?"),
      dropAll: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
      dropOthers: db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?"),
    };
    this.q.expire.run(Date.now());
  }

  /** Returns a new session token (only its hash is stored). */
  #newSession(userId) {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.q.addSession.run(sha256(token), userId, now, now + SESSION_DAYS * 86_400_000);
    return token;
  }

  userForToken(token) {
    if (!token) return null;
    return this.q.session.get(sha256(token), Date.now())?.user_id ?? null;
  }

  usernameOf(userId) {
    return this.q.nameOf.get(userId)?.username ?? null;
  }

  logout(token) {
    if (token) this.q.dropSession.run(sha256(token));
  }

  #checkNew(password) {
    if (password.length < MIN_PASSWORD) throw new GameError("bad_password", `Password must be at least ${MIN_PASSWORD} characters`);
    if (password.length > 200) throw new GameError("bad_password", "Password is too long");
  }

  /** The player changes their own password (being logged in is enough); other devices get logged out. */
  async changePassword(userId, next, token) {
    next = String(next ?? "");
    this.#checkNew(next);
    this.q.setHash.run(await hashPassword(next), userId);
    this.q.dropOthers.run(userId, sha256(token ?? ""));
    return { ok: true };
  }

  /** The admin sets someone's password (a random one if none is given). Logs them out everywhere. */
  async resetPassword(username, password) {
    const row = this.q.byName.get(String(username ?? ""));
    if (!row) throw new GameError("not_found", "No such user", 404);
    let next = String(password ?? "").trim();
    if (!next) next = randomBytes(9).toString("base64url");
    this.#checkNew(next);
    this.q.setHash.run(await hashPassword(next), row.id);
    this.q.dropAll.run(row.id);
    return { password: next };
  }

  async register(username, password, legacyId) {
    username = String(username ?? "").trim();
    password = String(password ?? "");
    if (!USERNAME_RE.test(username)) throw new GameError("bad_username", "Username must be 3–20 letters, numbers or _");
    if (password.length < MIN_PASSWORD) throw new GameError("bad_password", `Password must be at least ${MIN_PASSWORD} characters`);
    if (password.length > 200) throw new GameError("bad_password", "Password is too long");
    if (this.q.byName.get(username)) throw new GameError("taken", "That username is taken", 409);
    const passHash = await hashPassword(password);
    // Re-check after the slow hash in case of a simultaneous signup.
    if (this.q.byName.get(username)) throw new GameError("taken", "That username is taken", 409);
    const userId = this.game.createUser(username, passHash, legacyId);
    return { userId, token: this.#newSession(userId) };
  }

  async login(username, password, ip) {
    username = String(username ?? "").trim();
    password = String(password ?? "");
    if (recentFailures(ip).length >= MAX_FAILURES) throw new GameError("rate_limited", "Too many failed logins. Try again in a few minutes.", 429);
    const row = this.q.byName.get(username);
    // Hash even for unknown users so response time doesn't reveal which usernames exist.
    const ok = row ? await verifyPassword(password, row.pass_hash) : (await hashPassword(password), false);
    if (!ok) {
      failures.set(ip, [...recentFailures(ip), Date.now()]);
      throw new GameError("bad_login", "Wrong username or password", 401);
    }
    if (row.banned) throw new GameError("banned", "This account has been banned", 403);
    return { userId: row.id, token: this.#newSession(row.id) };
  }
}

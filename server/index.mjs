#!/usr/bin/env node
// StrafeClicker server: serves the site, refreshes market prices once a minute on
// a fixed wall-clock schedule, keeps a price history, pushes updates to every
// browser over Server-Sent Events, and owns every account: balances, inventories
// and all rolls live here. Clients only ever see outcomes.
//
//   npm run dev     Vite dev server + API on one port
//   npm start       production: serves dist/ (run `npm run build` first)

import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gunzipSync, gzipSync } from "node:zlib";
import {
  PRICE_URLS,
  allVariants,
  fetchContents,
  fetchJson,
  fetchSalesBackfill,
  indexListings,
  priceCatalog,
} from "./data.mjs";
import { Auth } from "./auth.mjs";
import { openDb } from "./db.mjs";
import { Feed } from "./feed.mjs";
import { Settings } from "./settings.mjs";
import { Game, GameError } from "./game.mjs";
import { History } from "./history.mjs";
import { SteamMarket } from "./steam.mjs";
import { plinko } from "./games/plinko.mjs";
import { Flashbang } from "./games/flashbang.mjs";
import { Bhop } from "./games/bhop.mjs";
import { Defuse } from "./games/defuse.mjs";
import { Roulette } from "./games/roulette.mjs";
import { Coinflip } from "./games/coinflip.mjs";
import { Jackpot } from "./games/jackpot.mjs";
import { Battles } from "./games/battles.mjs";
import { Friends } from "./friends.mjs";
import { Trades } from "./trades.mjs";
import { Admin, ADMIN_USERNAME } from "./admin.mjs";
import { Profiles } from "./profiles.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SNAPSHOT = join(ROOT, "server/snapshot.json.gz");
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR ?? "data");
const DEV = process.argv.includes("--dev");
const PORT = Number(process.env.PORT ?? 3000);

const TICK_MS = 60_000;
/** The tradable-only listing is refetched every Nth tick (or sooner if we don't have it yet). */
const TRADABLE_EVERY = 5;
const KEEP_DIFFS = 120;
/** How often the price-history log is folded into the compressed history.br. */
const COMPACT_EVERY_MS = 3_600_000;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Skinport allows 8 requests per 5 minutes per IP. Track our own and stay at 7, so
 * retries can never push us into a permanent 429 loop. The main listing (5 per window)
 * always fits; the tradable listing and the one-off backfill use what's left.
 * The log is kept on disk so restarting the server doesn't forget recent requests.
 */
const skinportBudget = {
  limit: 7,
  windowMs: 5 * 60_000,
  file: join(DATA_DIR, "skinport-requests.json"),
  stamps: [],
  load() {
    try {
      this.stamps = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      this.stamps = [];
    }
  },
  take() {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    try {
      writeFileSync(this.file, JSON.stringify(this.stamps));
    } catch {
      // Not fatal; worst case a restart risks a 429.
    }
    return true;
  },
};

// ---------- state ----------

let contents;
/** Pre-compressed /api/catalog response (it's several MB of JSON with every sticker). */
let catalogBody;
let prices = {};
let version = 0;
/** Recent per-version changes so clients can catch up without a full download. */
const diffs = [];
let tradableListing = null;
/** Skinport's main listing from the last tick that got one (reused when a request is skipped). */
let mainListing = null;
const status = { lastUpdateAt: null, nextUpdateAt: null, changed: 0, error: null };
const history = new History(DATA_DIR);
const db = openDb(join(DATA_DIR, "strafeclicker.db"));
const feed = new Feed(db);
const settings = new Settings(db);
const game = new Game(db, { contents: () => contents, prices: () => prices }, feed, settings);
const auth = new Auth(db, game);

async function boot() {
  const snapshot = await readFile(SNAPSHOT)
    .then((buf) => JSON.parse(gunzipSync(buf).toString("utf8")))
    .catch(() => null);

  try {
    contents = await fetchContents();
    log(`contents: ${contents.cases.length} cases, ${Object.keys(contents.items).length} items (live)`);
  } catch (err) {
    if (!snapshot) throw new Error(`Can't fetch case contents and no snapshot: ${err.message}`);
    contents = snapshot.contents;
    log(`contents: using snapshot (${err.message})`);
  }
  const raw = Buffer.from(JSON.stringify(contents));
  catalogBody = {
    raw,
    gzip: gzipSync(raw),
    br: brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }),
  };
  const imported = game.importLegacyFile(join(DATA_DIR, "accounts.json"));
  if (imported) log(`accounts: imported ${imported} anonymous accounts from accounts.json (claimed on register)`);
  log(`accounts: ${game.userCount} users`);

  const validKeys = new Set(allVariants(contents).map((v) => v.key));
  const keep = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([k]) => validKeys.has(k)));

  await history.load(); // also creates DATA_DIR
  skinportBudget.load();
  if (history.empty && skinportBudget.take()) {
    try {
      for (const { t, changes } of await fetchSalesBackfill(contents)) await history.record(t, keep(changes), { backfill: true });
      log("history: backfilled from Skinport sale medians");
    } catch (err) {
      log(`history: no backfill (${err.message})`);
    }
  }
  const packed = await history.compact();
  log(`history: compressed ${(packed.rawBytes / 1e6).toFixed(1)} MB to ${(packed.packedBytes / 1e6).toFixed(2)} MB`);
  // Until the first tick lands: snapshot prices, overridden by anything newer in history.
  prices = { ...keep(snapshot?.prices), ...keep(history.latestLive()) };
  // Seconds since epoch, so versions keep increasing across restarts and a
  // client holding a version from a previous run always gets a full refresh.
  version = Math.floor(Date.now() / 1000);
  log(`history: ${history.series.size} series, live since ${history.liveSince ? new Date(history.liveSince).toISOString() : "never"}`);

  setInterval(() => history.compact().catch((e) => log("history compaction failed", e.message)), COMPACT_EVERY_MS).unref();
  await steam.load();
  steam.run();
  schedule();
}

// Steam prices, kept fresh for what people own and can open.
const ownedItems = db.prepare("SELECT DISTINCT item_id FROM items");
const steam = new SteamMarket(DATA_DIR, {
  log,
  hot: () => [
    ...ownedItems.all().map((r) => contents.items[r.item_id]?.name).filter(Boolean),
    ...contents.cases.map((c) => c.marketName).filter(Boolean),
  ],
});

// ---------- price ticks ----------

function schedule() {
  const next = (Math.floor(Date.now() / TICK_MS) + 1) * TICK_MS;
  status.nextUpdateAt = next;
  setTimeout(() => tick(next), next - Date.now());
}

async function tick(scheduledAt) {
  const n = Math.round(scheduledAt / TICK_MS);
  try {
    // Skinport: a missed request just means reusing its last listing; Steam carries on.
    if (skinportBudget.take()) {
      mainListing = await fetchJson(PRICE_URLS.main).catch((err) => {
        log(`skinport: ${err.message}`);
        return mainListing;
      });
    }
    if (!mainListing && !steam.prices.size) throw new Error("no prices from Skinport or Steam yet");
    if ((!tradableListing || n % TRADABLE_EVERY === 0) && skinportBudget.take()) {
      tradableListing = await fetchJson(PRICE_URLS.tradable).catch((err) => {
        log(`tradable listing: ${err.message}`);
        return tradableListing;
      });
    }
    // Steam's lowest listing wins wherever Steam has the item. Doppler phases share one
    // Steam listing, so those (and anything Steam hasn't reached yet) use Skinport.
    const index = indexListings([mainListing ?? [], tradableListing ?? []]);
    for (const [name, usd] of steam.snapshot()) index.set(`${name}|`, usd);
    const { prices: next, filled, unpriced } = priceCatalog(contents, index, prices);

    const changes = {};
    for (const [k, v] of Object.entries(next)) if (prices[k] !== v) changes[k] = v;
    const now = Date.now();
    // The first live sample records everything so each graph has a baseline.
    await history.record(now, history.liveSince == null ? next : changes);

    if (Object.keys(changes).length) {
      prices = next;
      version++;
      diffs.push({ version, changes });
      if (diffs.length > KEEP_DIFFS) diffs.shift();
    }
    Object.assign(status, { lastUpdateAt: now, changed: Object.keys(changes).length, error: null });
    log(`tick: ${status.changed} prices changed (v${version}, ${filled} interpolated, ${unpriced} unpriced)`);
  } catch (err) {
    status.error = err.message;
    log(`tick failed: ${err.message}`);
  } finally {
    schedule();
    broadcast("status", statusBody());
  }
}

const statusBody = () => ({ ...status, now: Date.now(), version, intervalMs: TICK_MS });

// ---------- SSE ----------

const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

feed.onWin((win) => broadcast("win", win));

/** Send an event to every open connection of one logged-in user. */
function toUser(userId, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) if (res.userId === userId) res.write(msg);
}

const flashbang = new Flashbang(game, db, { broadcast, toUser });
flashbang.start();
const roulette = new Roulette(game, db, { broadcast, toUser });
roulette.start();
const jackpot = new Jackpot(game, db, { broadcast, toUser });
jackpot.start();
const bhop = new Bhop(game, db);
const defuse = new Defuse(game, db);
/** Like broadcast, but each connection gets data made for its user. */
function broadcastPer(event, data) {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data(res.userId))}\n\n`);
}
const isOnline = (userId) => [...clients].some((res) => res.userId === userId);

const friends = new Friends(db);
const battles = new Battles(game, db, friends, { broadcastPer, toUser });
battles.start();
const trades = new Trades(game, db, friends, { toUser });
const coinflip = new Coinflip(game, db, friends, { broadcastPer, toUser });
coinflip.start();
const profiles = new Profiles(game, db, friends, isOnline);
const admin = new Admin({
  db,
  game,
  settings,
  isOnline,
  onlineCount: () => new Set([...clients].map((r) => r.userId).filter((id) => id != null)).size,
  steam,
  broadcast,
  toUser,
  flashbang,
});

/** Someone came online or went offline: refresh their friends' lists. */
function presenceChanged(userId) {
  for (const id of friends.friendIds(userId)) toUser(id, "friends", friends.list(id, isOnline));
}

/** After a friendship change: both sides' lists, and battles they can now (not) see. */
function friendsChanged(...userIds) {
  for (const id of userIds) toUser(id, "friends", friends.list(id, isOnline));
  battles.publish();
  coinflip.publish();
}

setInterval(() => {
  for (const res of clients) res.write(": ping\n\n");
}, 25_000).unref();

function events(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 3000\nevent: status\ndata: ${JSON.stringify(statusBody())}\n\n`);
  res.write(`event: wins\ndata: ${JSON.stringify(feed.recent())}\n\n`);
  res.write(`event: site\ndata: ${JSON.stringify(settings.public())}\n\n`);
  res.write(`event: fb\ndata: ${JSON.stringify(flashbang.state())}\n\n`);
  res.write(`event: roulette\ndata: ${JSON.stringify(roulette.state())}\n\n`);
  res.write(`event: jackpot\ndata: ${JSON.stringify(jackpot.state())}\n\n`);
  // Server-settled results (a flashbang auto cash-out, a pop) reach the player this way.
  res.userId = sessionUser(req);
  res.write(`event: battles\ndata: ${JSON.stringify(battles.list(res.userId))}\n\n`);
  res.write(`event: flips\ndata: ${JSON.stringify(coinflip.list(res.userId))}\n\n`);
  const wasOnline = res.userId != null && isOnline(res.userId);
  clients.add(res);
  if (res.userId != null && !wasOnline) presenceChanged(res.userId);
  req.on("close", () => {
    clients.delete(res);
    if (res.userId != null && !isOnline(res.userId)) presenceChanged(res.userId);
  });
}

// ---------- HTTP ----------

function send(req, res, code, body, type = "application/json; charset=utf-8", extraHeaders = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const headers = { "Content-Type": type, "Cache-Control": "no-cache", ...extraHeaders };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "") && !type.startsWith("image/")) {
    buf = gzipSync(buf);
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = buf.length;
  res.writeHead(code, headers);
  res.end(buf);
}

function sendCatalog(req, res) {
  const accept = req.headers["accept-encoding"] ?? "";
  const enc = /\bbr\b/.test(accept) ? "br" : /\bgzip\b/.test(accept) ? "gzip" : null;
  const buf = enc ? catalogBody[enc] : catalogBody.raw;
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    "Content-Length": buf.length,
    Vary: "Accept-Encoding",
    ...(enc ? { "Content-Encoding": enc } : {}),
  });
  res.end(buf);
}

// ---------- accounts ----------

const SESSION_COOKIE = "sc_session";
/** The pre-login anonymous account cookie; claimed into a new user on register. */
const LEGACY_COOKIE = "sc_account";

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookie(req, name, value, maxAgeSec) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

const sessionUser = (req) => auth.userForToken(cookieValue(req, SESSION_COOKIE));

/**
 * Behind a reverse proxy or tunnel set TRUST_PROXY=1 so login rate limits see the real
 * client IP. Cloudflare's CF-Connecting-IP comes first since Cloudflare always overwrites
 * it. Otherwise the last X-Forwarded-For entry is used: that's the one our proxy added.
 * Earlier entries can be anything the client sent.
 */
function clientIp(req) {
  if (process.env.TRUST_PROXY) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return cf.trim();
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) return xff.split(",").at(-1).trim();
  }
  return req.socket.remoteAddress ?? "?";
}

async function readJson(req) {
  // Requiring a JSON content type also means other sites can't post here with a plain form.
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new GameError("bad_request", "Expected JSON", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new GameError("bad_request", "Body too large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new GameError("bad_request", "Invalid JSON");
  }
}

/**
 * Maintenance mode refuses anything that starts a bet or opens something; finishing
 * what's running (cash-outs), selling, trading and clicking still work.
 */
const STARTS = {
  open: true,
  upgrade: true,
  plinko: true,
  roulette: true,
  jackpot: (b) => b.action !== "withdraw",
  flashbang: (b) => b.action === "bet",
  coinflip: (b) => ["create", "join", "bot"].includes(b.action),
  battle: (b) => ["create", "join", "bots"].includes(b.action),
  bhop: (b) => b.action === "start",
  defuse: (b) => b.action === "start",
  towers: (b) => b.action === "start",
  keno: true,
  race: true,
  blackjack: (b) => b.action === "bet",
  spin: true,
};
function checkMaintenance(userId, action, body) {
  if (!settings.get("maintenance")) return;
  const rule = STARTS[action];
  if (!rule || (typeof rule === "function" && !rule(body))) return;
  if (auth.usernameOf(userId) === ADMIN_USERNAME) return;
  throw new GameError("maintenance", "The site is paused for maintenance. Try again in a bit.", 503);
}

/** POST /api/<action> handlers for logged-in users. Each returns its result plus the account view. */
const actions = {
  click: (userId, body) => game.click(userId, body.clicks, body.times),
  plinko: (userId, body) => plinko(game, userId, body),
  claim: (userId, body) => game.claim(userId, body.id == null ? null : String(body.id)),
  flashbang: (userId, body) => {
    if (body.action === "bet") return flashbang.bet(userId, body);
    if (body.action === "cancel") return flashbang.cancel(userId);
    if (body.action === "cashout") return flashbang.cashout(userId);
    throw new GameError("bad_input", "Unknown action");
  },
  battle: (userId, body) => {
    if (body.action === "create") return battles.create(userId, body);
    if (body.action === "join") return battles.join(userId, body);
    if (body.action === "bots") return battles.bots(userId, body);
    if (body.action === "cancel") return battles.cancel(userId, body);
    throw new GameError("bad_input", "Unknown action");
  },
  profile: (userId, body) => {
    if (body.action === "rename") {
      const out = game.rename(userId, body.name);
      // Friends' lists show the new name.
      friendsChanged(userId, ...friends.friendIds(userId));
      return out;
    }
    return { profile: profiles.get(userId, body.username), account: game.view(userId) };
  },
  admin: (userId, body) => {
    admin.check(userId);
    const a = body.action;
    const r =
      a === "overview" ? admin.overview()
      : a === "users" ? { users: admin.users(body.query) }
      : a === "money" ? admin.money(body.username, body.amount)
      : a === "item" ? admin.giveItem(body.username, body)
      : a === "ban" ? admin.ban(body.username, true)
      : a === "unban" ? admin.ban(body.username, false)
      : a === "reset" ? admin.reset(body.username)
      : a === "settings" ? admin.setSettings(body)
      : a === "pop" ? admin.popFlashbang()
      : null;
    if (!r) throw new GameError("bad_input", "Unknown action");
    return { ...r, account: game.view(userId) };
  },
  trade: (userId, body) => {
    const withAccount = (r) => ({ ...r, account: r.account ?? game.view(userId) });
    if (body.action === "list") return withAccount(trades.list(userId));
    if (body.action === "inventory") return withAccount(trades.inventory(userId, body.username));
    if (body.action === "offer") return withAccount(trades.offer(userId, body));
    if (body.action === "accept") return trades.accept(userId, body.id);
    if (body.action === "decline" || body.action === "cancel") return withAccount(trades.close(userId, body.id));
    throw new GameError("bad_input", "Unknown action");
  },
  friends: (userId, body) => {
    const name = body.username;
    if (body.action === "request") friendsChanged(userId, friends.request(userId, name));
    else if (body.action === "accept") friendsChanged(userId, friends.accept(userId, name));
    else if (body.action === "remove") friendsChanged(userId, friends.remove(userId, name));
    else if (body.action !== "list") throw new GameError("bad_input", "Unknown action");
    return { ...friends.list(userId, isOnline), account: game.view(userId) };
  },
  roulette: (userId, body) => roulette.bet(userId, body),
  spin: (userId) => game.dailySpin(userId),
  jackpot: (userId, body) => (body.action === "withdraw" ? jackpot.withdraw(userId) : jackpot.deposit(userId, body)),
  coinflip: (userId, body) => {
    if (body.action === "create") return coinflip.create(userId, body);
    if (body.action === "join") return coinflip.join(userId, body);
    if (body.action === "bot") return coinflip.bot(userId, body);
    if (body.action === "cancel") return coinflip.cancel(userId, body);
    throw new GameError("bad_input", "Unknown action");
  },
  defuse: (userId, body) => {
    if (body.action === "state") return defuse.state(userId);
    if (body.action === "start") return defuse.start(userId, body);
    if (body.action === "reveal") return defuse.reveal(userId, body);
    if (body.action === "cashout") return defuse.cashout(userId);
    throw new GameError("bad_input", "Unknown action");
  },
  bhop: (userId, body) => {
    if (body.action === "state") return bhop.state(userId);
    if (body.action === "start") return bhop.start(userId, body);
    if (body.action === "jump") return bhop.jump(userId);
    if (body.action === "cashout") return bhop.cashout(userId);
    throw new GameError("bad_input", "Unknown action");
  },
  open: (userId, body) => game.open(userId, String(body.caseId ?? ""), body.count ?? 1),
  perk: (userId, body) => game.buyPerk(userId, String(body.perk ?? "")),
  sell: (userId, body) => game.sell(userId, body.uids),
  upgrade: (userId, body) => game.upgrade(userId, body.uids, body.target),
  reset: (userId) => {
    bhop.forget(userId); // their stakes are part of what's being wiped
    defuse.forget(userId);
    return game.reset(userId);
  },
};

const SESSION_MAX_AGE = 30 * 86_400;

/** POST /api/register, /api/login, /api/logout. They set or clear the session cookie. */
const authActions = {
  async register(req, body, headers) {
    const { userId, token } = await auth.register(body.username, body.password, cookieValue(req, LEGACY_COOKIE));
    headers["Set-Cookie"] = [cookie(req, SESSION_COOKIE, token, SESSION_MAX_AGE), cookie(req, LEGACY_COOKIE, "", 0)];
    return { account: game.view(userId) };
  },
  async login(req, body, headers) {
    const { userId, token } = await auth.login(body.username, body.password, clientIp(req));
    headers["Set-Cookie"] = cookie(req, SESSION_COOKIE, token, SESSION_MAX_AGE);
    return { account: game.view(userId) };
  },
  async logout(req, _body, headers) {
    auth.logout(cookieValue(req, SESSION_COOKIE));
    headers["Set-Cookie"] = cookie(req, SESSION_COOKIE, "", 0);
    return {};
  },
};

function pricesBody(since) {
  if (since > 0 && since <= version && (since === version || diffs[0]?.version <= since + 1)) {
    const changes = {};
    for (const d of diffs) if (d.version > since) Object.assign(changes, d.changes);
    return { version, full: false, prices: changes };
  }
  return { version, full: true, prices };
}

async function api(req, res, url) {
  if (url.pathname === "/api/catalog") return sendCatalog(req, res);
  if (url.pathname === "/api/me") {
    const userId = sessionUser(req);
    if (!userId) return send(req, res, 401, { error: "auth", message: "Not logged in" });
    return send(req, res, 200, game.view(userId));
  }
  const action = url.pathname.match(/^\/api\/(\w+)$/)?.[1];
  const isAuth = action && Object.hasOwn(authActions, action);
  if (isAuth || (action && Object.hasOwn(actions, action))) {
    if (req.method !== "POST") return send(req, res, 405, { error: "POST only" });
    const headers = {};
    try {
      const body = await readJson(req);
      if (isAuth) return send(req, res, 200, await authActions[action](req, body, headers), undefined, headers);
      const userId = sessionUser(req);
      if (!userId) throw new GameError("auth", "Please log in", 401);
      checkMaintenance(userId, action, body);
      return send(req, res, 200, actions[action](userId, body));
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      return send(req, res, err.status, { error: err.code, message: err.message }, undefined, headers);
    }
  }
  if (url.pathname === "/api/prices") return send(req, res, 200, pricesBody(Number(url.searchParams.get("since") ?? 0)));
  if (url.pathname === "/api/status") return send(req, res, 200, statusBody());
  if (url.pathname === "/api/events") return events(req, res);
  const m = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!contents.items[id] && !id.startsWith("case|")) return send(req, res, 404, { error: "unknown item" });
    const series = id.startsWith("case|") ? { [id]: history.forKey(id) } : history.forItem(id);
    return send(req, res, 200, { liveSince: history.liveSince, series });
  }
  send(req, res, 404, { error: "not found" });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveStatic(req, res, url) {
  let file = normalize(join(DIST, decodeURIComponent(url.pathname)));
  if (file !== DIST && !file.startsWith(DIST + sep)) return send(req, res, 403, "forbidden", "text/plain");
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(DIST, "index.html"); // SPA fallback
  }
  try {
    const body = await readFile(file);
    send(req, res, 200, body, MIME[extname(file)] ?? "application/octet-stream");
  } catch {
    send(req, res, 500, "Missing build. Run `npm run build` first.", "text/plain");
  }
}

async function main() {
  await boot();
  const server = createServer();
  let vite = null;
  if (DEV) {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({ server: { middlewareMode: true, hmr: { server } }, appType: "spa" });
  }
  server.on("request", (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      api(req, res, url).catch((err) => {
        log("api error", err);
        if (!res.headersSent) send(req, res, 500, { error: "internal error" });
      });
    } else if (vite) vite.middlewares(req, res);
    else serveStatic(req, res, url);
  });
  server.listen(PORT, () => log(`listening on http://localhost:${PORT}${DEV ? " (dev)" : ""}`));
}

// Close the database cleanly so the WAL is checkpointed.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    flashbang.stop();
    roulette.stop();
    jackpot.stop();
    void steam.stop().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

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
import { Game, GameError } from "./game.mjs";
import { History } from "./history.mjs";

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
const COMPACT_EVERY_MS = 6 * 3_600_000;

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
const status = { lastUpdateAt: null, nextUpdateAt: null, changed: 0, error: null };
const history = new History(join(DATA_DIR, "history.ndjson"));
const game = new Game(join(DATA_DIR, "accounts.json"), { contents: () => contents, prices: () => prices });

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
  await game.load();
  log(`accounts: ${game.accounts.size}`);

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
  } else {
    await history.compact();
  }
  // Until the first tick lands: snapshot prices, overridden by anything newer in history.
  prices = { ...keep(snapshot?.prices), ...keep(history.latestLive()) };
  // Seconds since epoch, so versions keep increasing across restarts and a
  // client holding a version from a previous run always gets a full refresh.
  version = Math.floor(Date.now() / 1000);
  log(`history: ${history.series.size} series, live since ${history.liveSince ? new Date(history.liveSince).toISOString() : "never"}`);

  setInterval(() => history.compact().catch((e) => log("compact failed", e.message)), COMPACT_EVERY_MS).unref();
  schedule();
}

// ---------- price ticks ----------

function schedule() {
  const next = (Math.floor(Date.now() / TICK_MS) + 1) * TICK_MS;
  status.nextUpdateAt = next;
  setTimeout(() => tick(next), next - Date.now());
}

async function tick(scheduledAt) {
  const n = Math.round(scheduledAt / TICK_MS);
  try {
    if (!skinportBudget.take()) throw new Error("skipped to stay under Skinport's rate limit");
    const main = await fetchJson(PRICE_URLS.main);
    if ((!tradableListing || n % TRADABLE_EVERY === 0) && skinportBudget.take()) {
      tradableListing = await fetchJson(PRICE_URLS.tradable).catch((err) => {
        log(`tradable listing: ${err.message}`);
        return tradableListing;
      });
    }
    const { prices: next, filled, unpriced } = priceCatalog(contents, indexListings([main, tradableListing ?? []]), prices);

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
  clients.add(res);
  req.on("close", () => clients.delete(res));
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

const COOKIE = "sc_account";

function cookieValue(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The caller's account, creating one (and its cookie) on first visit. */
function accountFor(req, headers) {
  const id = cookieValue(req, COOKIE);
  const a = game.account(id);
  if (a.id !== id) {
    const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    headers["Set-Cookie"] = `${COOKIE}=${encodeURIComponent(a.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`;
  }
  return a;
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

/** POST /api/<action> handlers. Each returns extra response fields; the account view is always added. */
const actions = {
  click: (a, body) => ({ credited: game.click(a, body.clicks) }),
  open: (a, body) => ({ items: game.open(a, String(body.caseId ?? ""), body.count ?? 1) }),
  perk: (a, body) => ({ level: game.buyPerk(a, String(body.perk ?? "")) }),
  sell: (a, body) => ({ sold: game.sell(a, body.uids) }),
  upgrade: (a, body) => game.upgrade(a, body.uids, body.target),
  reset: (a) => (game.reset(a), {}),
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
    const headers = {};
    const a = accountFor(req, headers);
    return send(req, res, 200, game.view(a), undefined, headers);
  }
  const action = url.pathname.match(/^\/api\/(\w+)$/)?.[1];
  if (action && Object.hasOwn(actions, action)) {
    if (req.method !== "POST") return send(req, res, 405, { error: "POST only" });
    const headers = {};
    try {
      const body = await readJson(req);
      const a = accountFor(req, headers);
      const result = actions[action](a, body);
      return send(req, res, 200, { ...result, account: game.view(a) }, undefined, headers);
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

// Accounts are saved a second after each change; don't lose that second on shutdown.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    game
      .flush()
      .catch((e) => console.error(e))
      .finally(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

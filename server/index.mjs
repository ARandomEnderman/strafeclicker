#!/usr/bin/env node
// StrafeClicker server: serves the site, refreshes market prices once a minute on
// a fixed wall-clock schedule, keeps a price history, and pushes updates to every
// browser over Server-Sent Events. Clients only ever *see* the schedule.
//
//   npm run dev     Vite dev server + API on one port
//   npm start       production: serves dist/ (run `npm run build` first)

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  PRICE_URLS,
  allVariants,
  fetchContents,
  fetchJson,
  fetchSalesBackfill,
  indexListings,
  priceCatalog,
} from "./data.mjs";
import { History } from "./history.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SNAPSHOT = join(ROOT, "server/snapshot.json");
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
 */
const skinportBudget = {
  limit: 7,
  windowMs: 5 * 60_000,
  stamps: [],
  take() {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  },
};

// ---------- state ----------

let contents;
let contentsBody; // pre-serialised /api/catalog response
let prices = {};
let version = 0;
/** Recent per-version changes so clients can catch up without a full download. */
const diffs = [];
let tradableListing = null;
const status = { lastUpdateAt: null, nextUpdateAt: null, changed: 0, error: null };
const history = new History(join(DATA_DIR, "history.ndjson"));

async function boot() {
  const snapshot = await readFile(SNAPSHOT, "utf8")
    .then(JSON.parse)
    .catch(() => null);

  try {
    contents = await fetchContents();
    log(`contents: ${contents.cases.length} cases, ${Object.keys(contents.items).length} items (live)`);
  } catch (err) {
    if (!snapshot) throw new Error(`Can't fetch case contents and no snapshot: ${err.message}`);
    contents = snapshot.contents;
    log(`contents: using snapshot (${err.message})`);
  }
  contentsBody = JSON.stringify(contents);

  const validKeys = new Set(allVariants(contents).map((v) => v.key));
  const keep = (map) => Object.fromEntries(Object.entries(map ?? {}).filter(([k]) => validKeys.has(k)));

  await history.load();
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

function send(req, res, code, body, type = "application/json; charset=utf-8") {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const headers = { "Content-Type": type, "Cache-Control": "no-cache" };
  if (buf.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "") && !type.startsWith("image/")) {
    buf = gzipSync(buf);
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = buf.length;
  res.writeHead(code, headers);
  res.end(buf);
}

function pricesBody(since) {
  if (since > 0 && since <= version && (since === version || diffs[0]?.version <= since + 1)) {
    const changes = {};
    for (const d of diffs) if (d.version > since) Object.assign(changes, d.changes);
    return { version, full: false, prices: changes };
  }
  return { version, full: true, prices };
}

async function api(req, res, url) {
  if (url.pathname === "/api/catalog") return send(req, res, 200, contentsBody);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

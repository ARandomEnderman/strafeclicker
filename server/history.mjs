// Price history, kept in memory and in two files:
//
//   history.br       everything up to the last compaction, brotli-compressed at max quality.
//                    Each series is one flat number array [t0, c0, dt1, dc1, dt2, dc2, …]:
//                    a start time (ms) and price (cents), then the change since the previous
//                    point. Small repeating deltas are what makes it compress so well.
//   history.ndjson   changes since then, one line per tick: {"t": ms, "p": {priceKey: usd}, "b": 1?}
//                    ("b" marks backfilled sale medians). Folded into history.br by compact().
//
// Older versions wrote only history.ndjson; it's picked up as the tail and compacted on start.

import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants as zlib } from "node:zlib";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);

const HOUR = 3_600_000;
/** Points newer than this keep full resolution; older ones are thinned to one per hour. */
const FULL_RES_MS = 48 * HOUR;

const toCents = (usd) => Math.round(usd * 100);

function encodeSeries(points) {
  const out = [];
  let pt = 0;
  let pc = 0;
  for (const [t, v] of points) {
    const c = toCents(v);
    out.push(t - pt, c - pc);
    pt = t;
    pc = c;
  }
  return out;
}

function decodeSeries(flat) {
  const out = [];
  let t = 0;
  let c = 0;
  for (let i = 0; i < flat.length; i += 2) {
    t += flat[i];
    c += flat[i + 1];
    out.push([t, c / 100]);
  }
  return out;
}

export class History {
  /** @param {string} dir where history.br and history.ndjson live */
  constructor(dir) {
    this.base = join(dir, "history.br");
    this.tail = join(dir, "history.ndjson");
    /** key -> [[t, usd], …] in time order */
    this.series = new Map();
    /** First live (non-backfilled) sample, or null. */
    this.liveSince = null;
    /** Newest timestamp already in history.br; tail lines at or before it are duplicates. */
    this.baseUntil = -Infinity;
    // Appends and compaction touch the same files, so they run one at a time.
    this.writes = Promise.resolve();
  }

  #write(fn) {
    this.writes = this.writes.then(fn, fn);
    return this.writes;
  }

  async load() {
    await mkdir(dirname(this.base), { recursive: true });
    try {
      const snap = JSON.parse((await decompress(await readFile(this.base))).toString("utf8"));
      this.liveSince = snap.liveSince;
      this.baseUntil = snap.until;
      for (const [key, flat] of Object.entries(snap.series)) this.series.set(key, decodeSeries(flat));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    try {
      const lines = createInterface({ input: createReadStream(this.tail), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.t > this.baseUntil) this.#apply(entry);
        } catch {
          // A torn last line from a crash; skip it.
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return this;
  }

  get empty() {
    return this.series.size === 0;
  }

  #apply({ t, p, b }) {
    if (!b && (this.liveSince == null || t < this.liveSince)) this.liveSince = t;
    for (const [key, v] of Object.entries(p)) {
      let s = this.series.get(key);
      if (!s) this.series.set(key, (s = []));
      s.push([t, v]);
    }
  }

  /** Latest live price for every key (backfilled sale medians don't count). */
  latestLive() {
    const out = {};
    if (this.liveSince == null) return out;
    for (const [key, s] of this.series) {
      const [t, v] = s[s.length - 1];
      if (t >= this.liveSince) out[key] = v;
    }
    return out;
  }

  async record(t, changes, { backfill = false } = {}) {
    if (!Object.keys(changes).length) return;
    const entry = backfill ? { t, p: changes, b: 1 } : { t, p: changes };
    this.#apply(entry);
    await this.#write(() => appendFile(this.tail, JSON.stringify(entry) + "\n"));
  }

  /** All series for one item (every phase / wear / StatTrak variant). */
  forItem(itemId) {
    const out = {};
    for (const [key, s] of this.series) if (key.startsWith(`${itemId}|`)) out[key] = s;
    return out;
  }

  forKey(key) {
    return this.series.get(key) ?? [];
  }

  /** Thin old points to one per hour, write everything to history.br and empty the tail. */
  async compact(now = Date.now()) {
    await this.#write(async () => {
      // Runs in the write queue, so no append can land between the snapshot and the
      // tail being emptied.
      const cutoff = now - FULL_RES_MS;
      let until = -Infinity;
      const series = {};
      for (const [key, s] of this.series) {
        const kept = [];
        for (let i = 0; i < s.length; i++) {
          const [t] = s[i];
          const next = s[i + 1];
          // Keep a point if it's recent, the last one in its hour, or the first live sample
          // (which marks where backfill ends).
          if (t >= cutoff || t === this.liveSince || !next || Math.floor(next[0] / HOUR) !== Math.floor(t / HOUR)) kept.push(s[i]);
        }
        this.series.set(key, kept);
        series[key] = encodeSeries(kept);
        if (kept.length) until = Math.max(until, kept[kept.length - 1][0]);
      }
      const json = JSON.stringify({ v: 1, liveSince: this.liveSince, until, series });
      const packed = await compress(json, {
        params: { [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY, [zlib.BROTLI_PARAM_SIZE_HINT]: json.length },
      });
      await writeFile(`${this.base}.tmp`, packed);
      await rename(`${this.base}.tmp`, this.base);
      await writeFile(this.tail, "");
      this.baseUntil = until;
      this.lastCompaction = { rawBytes: json.length, packedBytes: packed.length };
    });
    return this.lastCompaction;
  }
}

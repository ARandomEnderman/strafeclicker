// Price history, kept in memory and in an append-only NDJSON log.
// Each line is one moment: {"t": ms, "p": {priceKey: usd, …}, "b": 1?}
// Only keys whose price changed are written. "b" marks backfilled points
// (Skinport sale medians) that predate live tracking.

import { createReadStream } from "node:fs";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const HOUR = 3_600_000;
/** Points newer than this keep full resolution; older ones are thinned to one per hour. */
const FULL_RES_MS = 48 * HOUR;

export class History {
  constructor(file) {
    this.file = file;
    /** key -> [[t, usd], …] in time order */
    this.series = new Map();
    /** First live (non-backfilled) sample, or null. */
    this.liveSince = null;
    // Appends and compaction rewrite the same file, so they run one at a time.
    this.writes = Promise.resolve();
  }

  #write(fn) {
    this.writes = this.writes.then(fn, fn);
    return this.writes;
  }

  async load() {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const lines = createInterface({ input: createReadStream(this.file), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.#apply(JSON.parse(line));
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

  /** Latest known price for every key. */
  latest() {
    const out = {};
    for (const [key, s] of this.series) out[key] = s[s.length - 1][1];
    return out;
  }

  async record(t, changes, { backfill = false } = {}) {
    if (!Object.keys(changes).length) return;
    const entry = backfill ? { t, p: changes, b: 1 } : { t, p: changes };
    this.#apply(entry);
    await this.#write(() => appendFile(this.file, JSON.stringify(entry) + "\n"));
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

  /** Thin old points to one per hour per series and rewrite the log. */
  async compact(now = Date.now()) {
    const cutoff = now - FULL_RES_MS;
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
    }

    const byTime = new Map();
    for (const [key, s] of this.series) {
      for (const [t, v] of s) {
        if (!byTime.has(t)) byTime.set(t, {});
        byTime.get(t)[key] = v;
      }
    }
    const lines = [...byTime.keys()]
      .sort((a, b) => a - b)
      .map((t) => JSON.stringify(this.liveSince == null || t < this.liveSince ? { t, p: byTime.get(t), b: 1 } : { t, p: byTime.get(t) }));
    const tmp = `${this.file}.tmp`;
    await this.#write(async () => {
      await writeFile(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
      await rename(tmp, this.file);
    });
  }
}

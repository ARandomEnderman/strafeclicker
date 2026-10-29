// Admin panel backend. Only the account whose username is exactly "admin" (same
// case) gets in; everyone else gets a 404 as if the endpoint didn't exist.

import { BHOP_DIFFICULTIES, DAILY_PRIZES, FB_MAX, RACE_BOTS, PLINKO_TABLES, UPGRADE_RTP, floatInWear, priceKey } from "../shared/game.js";
import { MAX_BALANCE_CENTS } from "./db.mjs";
import { GameError, cents } from "./game.mjs";
import { EVENT_TYPES, RAIN_STORM_MS, RIGGABLE } from "./settings.mjs";

export const ADMIN_USERNAME = "admin";

/** A fresh drop of one item variant ({ itemId, wear, phase, stattrak }; bad wear / phase fall back to the first). */
export function makeDrop(game, spec) {
  const item = game.item(String(spec?.itemId ?? ""));
  if (!item) throw new GameError("bad_input", "Unknown item");
  const wear = item.wears.length ? (item.wears.includes(spec.wear) ? spec.wear : item.wears[0]) : null;
  const phase = item.phases ? (item.phases.some((p) => p.name === spec.phase) ? spec.phase : item.phases[0].name) : null;
  return { itemId: item.id, phase, wear, stattrak: !!spec.stattrak && item.stattrak && item.kind !== "gloves", float: floatInWear(item, wear, Math.random()), seed: item.kind === "sticker" ? null : Math.floor(Math.random() * 1001) };
}

/** Plinko's average payback for one table when bounces lean `rig / 2` toward the middle. */
function plinkoRtp(rows, risk, rig) {
  let dist = [1]; // dist[k] = chance of k right bounces so far
  for (let i = 0; i < rows; i++) {
    const next = Array(i + 2).fill(0);
    dist.forEach((p, k) => {
      const toward = k < i / 2 ? 1 : k > i / 2 ? 0 : null;
      const right = toward == null ? 0.5 : toward === 1 ? 0.5 + rig / 2 : 0.5 - rig / 2;
      next[k + 1] += p * right;
      next[k] += p * (1 - right);
    });
    dist = next;
  }
  return dist.reduce((s, p, k) => s + p * PLINKO_TABLES[rows][risk][k], 0);
}

/** Blackjack payback with basic strategy (no splits), simulated at a few rig levels. */
const BJ_RTP = [[0, 0.99], [0.1, 0.9505], [0.25, 0.9009], [0.5, 0.8202], [1, 0.6823]];
/** Video poker payback with perfect play, scaled by a simulation of the rig at a few levels. */
const POKER_RTP = [[0, 0.9954], [0.1, 0.9417], [0.25, 0.87], [0.5, 0.7347], [1, 0.476]];
/** Straight-line between the simulated points. */
function interp(table, rig) {
  for (let i = 1; i < table.length; i++) {
    const [r0, v0] = table[i - 1];
    const [r1, v1] = table[i];
    if (rig <= r1) return v0 + ((rig - r0) / (r1 - r0)) * (v1 - v0);
  }
  return table.at(-1)[1];
}

const pct = (x) => Math.round(x * 1000) / 10;
const money = (x) => `$${x.toFixed(2)}`;
/** Average daily spin prize when the top half of the prizes are (1 - rig) as likely. */
function dailyEv(rig) {
  const w = DAILY_PRIZES.map((p, i) => p.weight * (i >= DAILY_PRIZES.length / 2 ? 1 - rig : 1));
  const total = w.reduce((s, x) => s + x, 0);
  return DAILY_PRIZES.reduce((s, p, i) => s + (p.usd * w[i]) / total, 0);
}

/** What each game pays back on average right now, and what the rig does to it. */
export function rigReport(settings) {
  const r = (g) => settings.rig(g);
  const plinko = Object.keys(PLINKO_TABLES).flatMap((rows) => Object.keys(PLINKO_TABLES[rows]).map((risk) => plinkoRtp(Number(rows), risk, r("plinko"))));
  const bh = BHOP_DIFFICULTIES.medium;
  return [
    { game: "cases", rig: r("cases"), rtp: null, note: `Valve's drop rates, but ${pct(r("cases"))}% of Classified-or-better drops are re-rolled. Case value depends on market prices.` },
    { game: "upgrader", rig: r("upgrader"), rtp: pct(UPGRADE_RTP * (1 - r("upgrader"))), note: `Real win chance is ${pct(1 - r("upgrader"))}% of the chance shown.` },
    { game: "plinko", rig: r("plinko"), rtp: pct(plinko.reduce((s, x) => s + x, 0) / plinko.length), note: `Between ${pct(Math.min(...plinko))}% and ${pct(Math.max(...plinko))}% depending on rows and risk. Bounces lean ${pct(r("plinko") / 2)}% toward the middle.` },
    { game: "flashbang", rig: r("flashbang"), rtp: pct(Math.max(0.01, 0.99 - r("flashbang"))), note: `About ${pct(1 - Math.max(0.01, 0.99 - r("flashbang")) / 1.01)}% of rounds pop at 1.00x.` },
    { game: "roulette", rig: r("roulette"), rtp: pct((14 / 15) * (1 - r("roulette"))), note: `Up to this for a lone bettor: ${pct(r("roulette"))}% of spins land on whatever pays the table least. 93.3% with no rig.` },
    { game: "bhop", rig: r("bhop"), rtp: pct(0.99 * (1 - r("bhop")) ** 5), note: `Shown for 5 jumps; each jump's real safety is ${pct(1 - r("bhop"))}% of what's shown (Medium: ${pct(bh.p * (1 - r("bhop")))}% instead of ${pct(bh.p)}%). The longer the run, the worse.` },
    { game: "defuse", rig: r("defuse"), rtp: pct(0.99 * (1 - r("defuse")) ** 5), note: `Shown for 5 tiles; ${pct(r("defuse"))}% of safe picks get a bomb moved under them.` },
    { game: "coinflipBot", rig: r("coinflipBot"), rtp: pct(1 - r("coinflipBot") / 2), note: `Against a bot you win ${pct(0.5 - r("coinflipBot") / 2)}% of flips. Player-vs-player flips are always 50/50.` },
    { game: "towers", rig: r("towers"), rtp: pct(0.99 * (1 - r("towers")) ** 5), note: `Shown for 5 floors; ${pct(r("towers"))}% of safe picks get a T moved behind them.` },
    { game: "race", rig: r("race"), rtp: pct(0.99 * (1 - r("race"))), note: `Up to this for a lone bettor: ${pct(r("race"))}% of races go to the bot that pays the players least. Odds pay back 99% with no rig.` },
    { game: "bombplant", rig: r("bombplant"), rtp: pct(0.99 * (1 - r("bombplant"))), note: `Up to this for a lone bettor: ${pct(r("bombplant"))}% of rounds end the way that pays the players least. 99% with no rig.` },
    { game: "blackjack", rig: r("blackjack"), rtp: pct(interp(BJ_RTP, r("blackjack"))), note: `With perfect basic strategy; real players do worse. ${pct(r("blackjack"))}% of the dealer's draws are the best of three cards. About 99% with no rig.` },
    { game: "poker", rig: r("poker"), rtp: pct(interp(POKER_RTP, r("poker"))), note: `Jacks or Better 9/6, with perfect play (a simple strategy gets about 97%). ${pct(r("poker"))}% of draws also try the next cards and keep the worse hand. 99.5% with no rig.` },
    { game: "dailySpin", rig: r("dailySpin"), rtp: null, note: `Free, so no payback: worth ${money(dailyEv(r("dailySpin")))} a day on average (${money(dailyEv(0))} with no rig). The rig makes the top four prizes rarer.` },
    { game: "battles / jackpot / coinflip / hold'em / brackets (players)", rig: null, rtp: 100, note: "Player against player: nothing to rig, there's no house." },
  ];
}

export class Admin {
  /**
   * @param {{ db: import("node:sqlite").DatabaseSync, game: import("./game.mjs").Game, settings: import("./settings.mjs").Settings,
   *   isOnline: (id: number) => boolean, onlineCount: () => number, steam: any, broadcast: (e: string, d: any) => void,
   *   toUser: (id: number, e: string, d: any) => void, flashbang: any }} deps
   */
  constructor(deps) {
    Object.assign(this, deps);
    const db = this.db;
    this.q = {
      name: db.prepare("SELECT username FROM users WHERE id = ?"),
      byName: db.prepare("SELECT id FROM users WHERE username = ?"),
      // TOTAL adds in floating point, so a big sum can't overflow.
      count: db.prepare("SELECT COUNT(*) AS n, TOTAL(balance_cents) AS bal FROM users"),
      items: db.prepare("SELECT item_id, phase, wear, stattrak FROM items"),
      stats: db.prepare("SELECT stats FROM users"),
      search: db.prepare(`SELECT u.id, u.username, u.display_name, u.balance_cents, u.created_at, u.last_active, u.banned, u.muted_until,
        (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS items
        FROM users u WHERE u.username LIKE ? OR u.display_name LIKE ? ORDER BY u.last_active DESC NULLS LAST LIMIT 50`),
      ban: db.prepare("UPDATE users SET banned = ? WHERE id = ?"),
      dropSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    };
    // A rain storm that was running before a restart picks up again.
    this.stormAt = Date.now();
    setInterval(() => this.#storm(), 10_000).unref();
  }

  /** Throws a plain 404 unless userId is the admin account. */
  check(userId) {
    if (this.q.name.get(userId)?.username !== ADMIN_USERNAME) throw new GameError("not_found", "not found", 404);
  }

  overview() {
    const { n, bal } = this.q.count.get();
    const prices = this.game.market.prices();
    let itemValue = 0;
    const rows = this.q.items.all();
    for (const it of rows) itemValue += prices[priceKey({ itemId: it.item_id, phase: it.phase, wear: it.wear, stattrak: !!it.stattrak })] ?? 0;
    // House result per game: what players put in minus what they got back.
    const games = {};
    for (const { stats } of this.q.stats.all()) {
      for (const [g, s] of Object.entries(JSON.parse(stats).games ?? {})) {
        const t = (games[g] ??= { played: 0, wagered: 0, paid: 0 });
        t.played += s.played ?? 0;
        t.wagered += (s.wageredCents ?? 0) / 100;
        t.paid += (s.wonCents ?? 0) / 100;
      }
    }
    return {
      users: n,
      online: this.onlineCount(),
      balances: bal / 100,
      items: rows.length,
      itemValue: Math.round(itemValue * 100) / 100,
      games: Object.entries(games).map(([game, t]) => ({ game, ...t, house: Math.round((t.wagered - t.paid) * 100) / 100, rtp: t.wagered ? pct(t.paid / t.wagered) : null })),
      steam: { prices: this.steam.prices.size, sweep: this.steam.start, total: this.steam.total, intervalMs: this.steam.intervalMs, sweeps: this.steam.sweeps },
      events: this.settings.public().events,
      settings: {
        rig: this.settings.get("rig"),
        rigGames: this.settings.get("rigGames"),
        maintenance: this.settings.get("maintenance"),
        announcement: this.settings.get("announcement"),
        lbPrizes: this.settings.get("lbPrizes"),
        rainMin: this.settings.get("rainMin"),
      },
      rigGames: RIGGABLE,
      report: rigReport(this.settings),
      ...this.forcedView(),
    };
  }

  users(query) {
    const like = `%${String(query ?? "").replace(/[%_]/g, "")}%`;
    return this.q.search.all(like, like).map((u) => ({
      id: u.id,
      user: u.username,
      name: u.display_name || u.username,
      balance: u.balance_cents / 100,
      items: u.items,
      createdAt: u.created_at,
      lastActive: u.last_active,
      banned: !!u.banned,
      mutedUntil: u.muted_until && u.muted_until > Date.now() ? u.muted_until : null,
      online: this.isOnline(u.id),
    }));
  }

  #userId(username) {
    const r = this.q.byName.get(String(username ?? ""));
    if (!r) throw new GameError("not_found", "No such user", 404);
    return r.id;
  }

  /** Add (or with a negative amount, take) balance. */
  money(username, amount) {
    const id = this.#userId(username);
    const c = cents(Number(amount));
    if (!Number.isFinite(c) || c === 0) throw new GameError("bad_input", "Enter an amount");
    let capped = false;
    const { account } = this.game.act(id, (a) => {
      capped = a.balanceCents + c > MAX_BALANCE_CENTS;
      a.balanceCents = Math.max(0, Math.min(MAX_BALANCE_CENTS, a.balanceCents + c));
      return {};
    });
    this.toUser(id, "account", account);
    return { balance: account.balance, ...(capped ? { capped: `Balances top out at $${(MAX_BALANCE_CENTS / 100).toLocaleString("en-US")}` } : {}) };
  }

  /** Give a specific item variant. */
  giveItem(username, body) {
    const id = this.#userId(username);
    const drop = makeDrop(this.game, body);
    const { account } = this.game.act(id, (a, changes) => {
      this.game.grant(a, changes, [drop], "admin");
      return {};
    });
    this.toUser(id, "account", account);
    return { ok: true };
  }

  ban(username, banned) {
    const id = this.#userId(username);
    if (this.q.name.get(id).username === ADMIN_USERNAME) throw new GameError("bad_input", "Can't ban the admin");
    this.q.ban.run(banned ? 1 : 0, id);
    if (banned) this.q.dropSessions.run(id);
    return { ok: true };
  }

  reset(username) {
    this.game.reset(this.#userId(username));
    return { ok: true };
  }

  setSettings(body) {
    if (body.rig != null) this.settings.set("rig", clamp01(body.rig));
    if (body.rigGames != null) {
      const out = {};
      for (const [g, v] of Object.entries(body.rigGames)) if (RIGGABLE.includes(g) && v != null && v !== "") out[g] = clamp01(v);
      this.settings.set("rigGames", out);
    }
    if (body.maintenance != null) this.settings.set("maintenance", !!body.maintenance);
    if (body.lbPrizes != null) {
      const prizes = (list) => (Array.isArray(list) ? list.slice(0, 10).map((x) => Math.max(0, Math.round((Number(x) || 0) * 100) / 100)) : []);
      this.settings.set("lbPrizes", { daily: prizes(body.lbPrizes.daily), weekly: prizes(body.lbPrizes.weekly) });
    }
    if (body.rainMin != null) this.settings.set("rainMin", Math.max(0.01, Number(body.rainMin) || 1));
    if (body.announcement !== undefined) this.settings.set("announcement", body.announcement ? String(body.announcement).slice(0, 300) : null);
    this.broadcast("site", this.settings.public());
    return this.overview();
  }

  // ---------- events ----------

  /** Start (or replace) a timed event: cashback %, click multiplier or mission multiplier. */
  startEvent(body) {
    const t = EVENT_TYPES[body.type];
    if (!t) throw new GameError("bad_input", "Unknown event");
    const value = Number(body.value);
    if (!(value >= t.min && value <= t.max)) throw new GameError("bad_input", `${t.name}: pick ${t.min} to ${t.max}`);
    const minutes = Number(body.minutes);
    if (!(minutes >= 1 && minutes <= 24 * 60)) throw new GameError("bad_input", "Run it for 1 minute to 24 hours");
    const events = (this.settings.get("events") ?? []).filter((e) => e.type !== body.type && e.endsAt > Date.now());
    events.push({ type: body.type, value, endsAt: Date.now() + minutes * 60_000 });
    this.settings.set("events", events);
    this.broadcast("site", this.settings.public());
    this.broadcast("eventfx", { type: body.type, value, minutes });
    this.chat.system(`Event started: ${t.name}, ${t.what(value)} for ${minutes} minutes`);
    if (body.type === "rainStorm") {
      this.stormAt = 0;
      setTimeout(() => this.#storm(), 3000);
    }
    return { events: this.settings.public().events };
  }

  /** A rain storm's next rain, when one is due (checked every few seconds, and right after it starts). */
  #storm() {
    const ev = this.settings.event("rainStorm");
    if (!ev || Date.now() - (this.stormAt ?? 0) < RAIN_STORM_MS) return;
    this.stormAt = Date.now();
    const admin = this.q.byName.get(ADMIN_USERNAME);
    try {
      if (admin) this.chat.houseRain(admin.id, ev.value);
    } catch {
      // Nobody online to catch it: try again next time.
    }
  }

  endEvent(type) {
    this.settings.set("events", (this.settings.get("events") ?? []).filter((e) => e.type !== type && e.endsAt > Date.now()));
    this.broadcast("site", this.settings.public());
    return { events: this.settings.public().events };
  }

  /** Everyone online gets one free opening of a case (the house pays). */
  caseDrop(caseId) {
    const { c } = this.game.caseCost(String(caseId ?? ""));
    const ids = [...this.onlineIds()].filter((id) => this.q.name.get(id)?.username !== ADMIN_USERNAME);
    if (!ids.length) throw new GameError("nobody", "Nobody is online");
    for (const id of ids) {
      const { account } = this.game.act(id, (a, changes) => {
        const [owned] = this.game.grant(a, changes, [this.game.rollDrop(c)], c.id);
        // Sent before the account update, so the page can hide the item until its reel lands.
        this.toUser(id, "casedrop", { caseId: c.id, item: owned });
        return {};
      });
      this.toUser(id, "account", account);
    }
    this.chat.system(`Case drop: ${ids.length} player${ids.length === 1 ? "" : "s"} online each got a free ${c.name}`);
    return { count: ids.length };
  }

  // ---------- forcing outcomes ----------

  /** Set the result of the next round of a shared game (used once, overrides the rig). */
  forceRound(body) {
    const g = String(body.game ?? "");
    const v = body.value;
    if (v == null || v === "") {
      if (g === "flashbang") this.flashbang.forced = null;
      else if (g === "roulette") this.roulette.forced = null;
      else if (g === "race") this.race.forced = null;
      else if (g === "bombplant") this.bombplant.forced = null;
      else if (g === "jackpot") this.jackpot.forced = null;
      else throw new GameError("bad_input", "Unknown game");
      return this.forcedView();
    }
    if (g === "flashbang") {
      const x = Math.round(Number(v) * 100) / 100;
      if (!(x >= 1 && x <= FB_MAX)) throw new GameError("bad_input", `Pick 1.00x to ${FB_MAX}x`);
      this.flashbang.forced = x;
    } else if (g === "roulette") {
      const n = Number(v);
      if (!(Number.isInteger(n) && n >= 0 && n < 15)) throw new GameError("bad_input", "Pick a number 0 to 14");
      this.roulette.forced = n;
    } else if (g === "race") {
      const n = Number(v);
      if (!(Number.isInteger(n) && n >= 0 && n < RACE_BOTS.length)) throw new GameError("bad_input", "Pick a bot");
      this.race.forced = n;
    } else if (g === "bombplant") {
      const [site, result] = String(v).split("-");
      if (!["A", "B"].includes(site) || !["boom", "defuse"].includes(result)) throw new GameError("bad_input", "Pick an ending");
      this.bombplant.forced = { site, result };
    } else if (g === "jackpot") {
      const id = this.#userId(v);
      if (!this.jackpot.players().some((p) => p.userId === id)) throw new GameError("bad_input", "They're not in the pot");
      this.jackpot.forced = id;
    } else throw new GameError("bad_input", "Unknown game");
    return this.forcedView();
  }

  /** A player's next case drop (an item variant) and / or next upgrade (win / lose); null clears. */
  forcePlayer(username, body) {
    const id = this.#userId(username);
    if (body.clear) {
      this.game.forcedDrops.delete(id);
      this.game.forcedUpgrades.delete(id);
    }
    if (body.item?.itemId) this.game.forcedDrops.set(id, makeDrop(this.game, body.item));
    if (body.upgrade === "win" || body.upgrade === "lose") this.game.forcedUpgrades.set(id, body.upgrade === "win");
    return this.forcedView();
  }

  forcedView() {
    const name = (id) => this.q.name.get(id)?.username ?? "?";
    return {
      forced: {
        flashbang: this.flashbang.forced ?? null,
        roulette: this.roulette.forced ?? null,
        race: this.race.forced ?? null,
        bombplant: this.bombplant.forced ? `${this.bombplant.forced.site}-${this.bombplant.forced.result}` : null,
        jackpot: this.jackpot.forced != null ? name(this.jackpot.forced) : null,
      },
      jackpotPlayers: this.jackpot.players().map(({ userId, ...p }) => p),
      players: [
        ...[...this.game.forcedDrops].map(([id, d]) => ({ user: name(id), drop: `${d.stattrak ? "StatTrak " : ""}${this.game.item(d.itemId)?.name ?? d.itemId}${d.wear ? ` (${d.wear})` : ""}` })),
        ...[...this.game.forcedUpgrades].map(([id, w]) => ({ user: name(id), upgrade: w ? "win" : "lose" })),
      ],
    };
  }

  /** End the current flashbang round right now. */
  popFlashbang() {
    if (!this.flashbang.popNow()) throw new GameError("bad_input", "No round is running");
    return { ok: true };
  }
}

const clamp01 = (x) => Math.min(1, Math.max(0, Number(x) || 0));

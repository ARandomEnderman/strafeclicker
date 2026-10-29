import { getCatalog, openableCases, openCost } from "../catalog";
import { adminAction, ServerError } from "../state";
import type { Item } from "../types";
import { decimalInput, h, money, NO_AUTOFILL, parseDecimal, toast } from "./dom";
import { icon } from "./icons";
import { userLink } from "./profile-card";

// The admin panel: only reachable by the account named exactly "admin" (the server
// checks; this page just isn't linked for anyone else).

interface ReportRow {
  game: string;
  rig: number | null;
  rtp: number | null;
  note: string;
}
interface Overview {
  users: number;
  online: number;
  balances: number;
  items: number;
  itemValue: number;
  games: { game: string; played: number; wagered: number; paid: number; house: number; rtp: number | null }[];
  steam: { prices: number; sweep: number; total: number | null; intervalMs: number; sweeps: number };
  settings: {
    rig: number;
    rigGames: Record<string, number>;
    maintenance: boolean;
    announcement: string | null;
    lbPrizes: { daily: number[]; weekly: number[] };
    rainMin: number;
  };
  rigGames: string[];
  report: ReportRow[];
  events: { type: string; value: number; endsAt: number }[];
  forced: Forced["forced"];
  jackpotPlayers: Forced["jackpotPlayers"];
  players: Forced["players"];
}
interface Forced {
  forced: { flashbang: number | null; roulette: number | null; race: number | null; bombplant: string | null; jackpot: string | null };
  jackpotPlayers: { user: string; name: string; value: number }[];
  players: { user: string; drop?: string; upgrade?: string }[];
}
interface AdminUser {
  id: number;
  user: string;
  name: string;
  balance: number;
  items: number;
  createdAt: number;
  lastActive: number | null;
  banned: boolean;
  mutedUntil: number | null;
  online: boolean;
}
interface PromoCode {
  code: string;
  reward: string;
  uses: number;
  maxUses: number;
  expiresAt: number | null;
  createdAt: number;
  active: boolean;
}

const GAME_NAMES: Record<string, string> = {
  cases: "Cases",
  upgrader: "Upgrader",
  plinko: "Plinko",
  flashbang: "Flashbang",
  roulette: "Roulette",
  bhop: "B-hop",
  defuse: "Defuse",
  towers: "Towers",
  keno: "Keno",
  race: "Bot race",
  blackjack: "Blackjack",
  poker: "Video poker",
  bombplant: "Bomb plant",
  rps: "Rock paper scissors",
  bracket: "Brackets",
  coinflipBot: "Coinflip vs bot",
  rpsBot: "RPS vs bot",
  dailySpin: "Daily spin",
  battle: "Case battles",
  coinflip: "Coinflip",
  jackpot: "Jackpot",
};
const gameName = (g: string) => GAME_NAMES[g] ?? g;

async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    if (e instanceof ServerError) toast(e.message, "error");
    else throw e;
    return null;
  }
}

const ago = (t: number | null) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** The case last picked for a case drop (kept while the panel redraws). */
let dropCase = "";

export function adminPage() {
  const root = h("div", { class: "admin" });
  let ov: Overview | null = null;

  const section = (title: string, ...children: (HTMLElement | string)[]) => h("section", { class: "admin-card" }, h("h2", null, title), ...children);

  // ---------- rig ----------
  const rigSection = () => {
    const o = ov!;
    const globalInput = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round(o.settings.rig * 100)), class: "admin-range" }) as HTMLInputElement;
    const globalLabel = h("b", { class: "admin-rig-value" }, `${Math.round(o.settings.rig * 100)}%`);
    globalInput.addEventListener("input", () => (globalLabel.textContent = `${globalInput.value}%`));
    const overrides = new Map<string, HTMLInputElement>();
    const rows = o.report.map((r) => {
      const riggable = o.rigGames.includes(r.game);
      const own = o.settings.rigGames[r.game];
      const input = h("input", { class: "admin-num", type: "number", min: "0", max: "100", step: "1", placeholder: "global", value: own != null ? String(Math.round(own * 100)) : "", disabled: !riggable }) as HTMLInputElement;
      if (riggable) overrides.set(r.game, input);
      return h(
        "tr",
        null,
        h("td", null, h("b", null, gameName(r.game))),
        h("td", null, riggable ? h("span", { class: "admin-override" }, input, "%") : "–"),
        h("td", { class: r.rig ? "admin-bad" : "" }, r.rig == null ? "–" : `${Math.round(r.rig * 100)}%`),
        h("td", null, r.rtp == null ? "–" : `${r.rtp}%`),
        h("td", { class: "admin-note" }, r.note),
      );
    });
    const save = () =>
      run(async () => {
        const rigGames: Record<string, number> = {};
        for (const [g, el] of overrides) if (el.value.trim() !== "") rigGames[g] = Number(el.value) / 100;
        ov = (await adminAction<Overview>("settings", { rig: Number(globalInput.value) / 100, rigGames })) as Overview;
        draw();
      }, "Rig saved");
    return section(
      "Rig",
      h("p", { class: "hint" }, "How much the house tilts games in its favour, on top of the normal odds. 0% is fair: the odds shown are the real odds. Players aren't told."),
      h("div", { class: "admin-rig" }, h("span", null, "Global"), globalInput, globalLabel, h("button", { class: "btn btn-primary", onclick: () => void save() }, "Save")),
      h(
        "div",
        { class: "admin-table-wrap" },
        h(
          "table",
          { class: "admin-table" },
          h("thead", null, h("tr", null, h("th", null, "Game"), h("th", null, "Override"), h("th", null, "Rig now"), h("th", null, "Pays back"), h("th", null, "What it does"))),
          h("tbody", null, ...rows),
        ),
      ),
    );
  };

  // ---------- site ----------
  const siteSection = () => {
    const o = ov!;
    const ann = h("input", { class: "search", placeholder: "Announcement shown to everyone", maxlength: "300", value: o.settings.announcement ?? "" }) as HTMLInputElement;
    const setSettings = (body: object, ok: string) =>
      run(async () => {
        ov = (await adminAction<Overview>("settings", body)) as Overview;
        draw();
      }, ok);
    return section(
      "Site",
      h(
        "div",
        { class: "admin-row" },
        h("b", null, "Maintenance"),
        h("span", { class: o.settings.maintenance ? "admin-bad" : "admin-good" }, o.settings.maintenance ? "On: no new bets or openings" : "Off"),
        h("button", { class: "btn", onclick: () => void setSettings({ maintenance: !o.settings.maintenance }, o.settings.maintenance ? "Maintenance off" : "Maintenance on") }, o.settings.maintenance ? "Turn off" : "Turn on"),
        h(
          "button",
          {
            class: "btn",
            title: "After updating the server: every open page (yours too) reloads within a few seconds and gets the new version",
            onclick: async () => {
              if (!confirm("Reload every open page now? Use this after an update so everyone gets the new version.")) return;
              const r = await run(() => adminAction<{ pages: number }>("reloadAll"));
              if (r) toast(`Reloading ${r.pages} open page${r.pages === 1 ? "" : "s"}`);
            },
          },
          icon("refresh", 14),
          " Refresh everyone's page",
        ),
      ),
      h(
        "div",
        { class: "admin-row" },
        ann,
        h("button", { class: "btn btn-primary", onclick: () => void setSettings({ announcement: ann.value.trim() || null }, ann.value.trim() ? "Announcement posted" : "Announcement cleared") }, "Post"),
        h("button", { class: "btn btn-ghost", onclick: () => void setSettings({ announcement: null }, "Announcement cleared") }, "Clear"),
      ),
      h(
        "div",
        { class: "admin-row" },
        h("b", null, "Flashbang"),
        h("button", { class: "btn", onclick: () => void run(() => adminAction("pop"), "Popped") }, "Pop the current round now"),
      ),
    );
  };

  // ---------- forcing outcomes ----------
  const forceSection = () => {
    const o = ov!;
    const apply = (r: Forced | null) => {
      if (!r) return;
      Object.assign(ov!, r);
      draw();
    };
    const force = (game: string, value: string | number | null) => run(() => adminAction<Forced>("force", { game, value }), value == null ? "Cleared" : "Set for the next round").then(apply);
    const queued = (v: string | number | null, label?: string) => (v == null ? h("span", { class: "admin-muted" }, "random") : h("span", { class: "admin-bad" }, `Next: ${label ?? v}`));
    const select = (options: [string, string][]) => h("select", { class: "search admin-force-sel" }, ...options.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
    const row = (name: string, input: HTMLInputElement | HTMLSelectElement, game: string, current: string | number | null, label?: string) =>
      h(
        "div",
        { class: "admin-row" },
        h("b", { class: "admin-event-name" }, name),
        input,
        h("button", { class: "btn btn-primary", onclick: () => void force(game, input.value) }, "Set"),
        queued(current, label),
        current != null ? h("button", { class: "btn btn-ghost btn-sm", onclick: () => void force(game, null) }, "Clear") : "",
      );
    const ROUL = Array.from({ length: 15 }, (_, n): [string, string] => [String(n), `${n} (${n === 0 ? "green, 14x" : n <= 7 ? "T" : "CT"})`]);
    const BOTS: [string, string][] = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((b, i) => [String(i), b]);
    const ENDS: [string, string][] = [
      ["A-boom", "A, explodes"],
      ["A-defuse", "A, defused"],
      ["B-boom", "B, explodes"],
      ["B-defuse", "B, defused"],
    ];
    const f = o.forced;
    return section(
      "Rig the next round",
      h("p", { class: "hint" }, "Decide how the next round of a shared game ends. Used once, then it's random again (and the rig setting applies). Nobody is told."),
      row("Flashbang pop", decimalInput({ class: "admin-num", placeholder: "e.g. 1.00" }), "flashbang", f.flashbang, f.flashbang != null ? `${f.flashbang.toFixed(2)}x` : undefined),
      row("Roulette", select(ROUL), "roulette", f.roulette, f.roulette != null ? ROUL[f.roulette][1] : undefined),
      row("Bot race winner", select(BOTS), "race", f.race, f.race != null ? BOTS[f.race][1] : undefined),
      row("Bomb plant", select(ENDS), "bombplant", f.bombplant, ENDS.find((e) => e[0] === f.bombplant)?.[1]),
      o.jackpotPlayers.length
        ? row("Jackpot winner", select(o.jackpotPlayers.map((p) => [p.user, `${p.name} (${money(p.value)} in)`])), "jackpot", f.jackpot)
        : h("div", { class: "admin-row" }, h("b", { class: "admin-event-name" }, "Jackpot winner"), h("span", { class: "admin-muted" }, "Nobody's in the pot right now (refresh once someone deposits)."), f.jackpot ? queued(f.jackpot) : ""),
      o.players.length
        ? h(
            "div",
            { class: "admin-row admin-forced-players" },
            h("b", { class: "admin-event-name" }, "Rigged players"),
            ...o.players.map((p) => h("span", { class: "admin-chip" }, `${p.user}: ${p.drop ? `next drop ${p.drop}` : `next upgrade ${p.upgrade === "win" ? "wins" : "loses"}`}`)),
          )
        : "",
    );
  };

  // ---------- events ----------
  const EVENTS = [
    { type: "cashback", name: "Cashback", what: "% of every loss back", value: 20, step: "1" },
    { type: "clickBoost", name: "Click frenzy", what: "x clicker earnings", value: 3, step: "0.5" },
    { type: "missionBoost", name: "Mission bonus", what: "x mission rewards", value: 2, step: "0.5" },
    { type: "luckyHour", name: "Lucky hour", what: "% extra profit on every win", value: 25, step: "1" },
    { type: "caseSale", name: "Case sale", what: "% off every case", value: 25, step: "1" },
    { type: "marketSale", name: "Market sale", what: "% off the marketplace", value: 20, step: "1" },
    { type: "sellBonus", name: "Sell bonus", what: "% extra when selling items", value: 10, step: "1" },
    { type: "rainStorm", name: "Rain storm", what: "$ rained on everyone every 5 min", value: 50, step: "1" },
  ];
  const eventsSection = () => {
    const o = ov!;
    const rows = EVENTS.map((e) => {
      const live = o.events.find((x) => x.type === e.type && x.endsAt > Date.now());
      const value = decimalInput({ class: "admin-num", value: String(live?.value ?? e.value) });
      const minutes = decimalInput({ class: "admin-num", value: "30" });
      return h(
        "div",
        { class: "admin-row" },
        h("b", { class: "admin-event-name" }, e.name),
        value,
        h("span", { class: "admin-muted" }, e.what),
        h("span", { class: "admin-muted" }, "for"),
        minutes,
        h("span", { class: "admin-muted" }, "min"),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => {
              const r = await run(() => adminAction<{ events: Overview["events"] }>("eventStart", { type: e.type, value: parseDecimal(value.value), minutes: parseDecimal(minutes.value) }), `${e.name} started`);
              if (r) ((ov!.events = r.events), draw());
            },
          },
          live ? "Restart" : "Start",
        ),
        live
          ? h(
              "button",
              {
                class: "btn btn-ghost",
                onclick: async () => {
                  const r = await run(() => adminAction<{ events: Overview["events"] }>("eventEnd", { type: e.type }), `${e.name} ended`);
                  if (r) ((ov!.events = r.events), draw());
                },
              },
              `End (${Math.ceil((live.endsAt - Date.now()) / 60_000)} min left)`,
            )
          : "",
      );
    });
    const rainAmount = decimalInput({ class: "admin-num", value: "100" });
    // Case drop: a searchable grid of cases; click one, then drop it on everyone.
    const cases = [...openableCases()].sort((a, b) => openCost(b) - openCost(a));
    let pickedCase = dropCase && cases.some((c) => c.id === dropCase) ? dropCase : (cases[0]?.id ?? "");
    const caseGrid = h("div", { class: "admin-case-grid" });
    const dropBtn = h("button", { class: "btn btn-primary" });
    const caseSearch = h("input", { class: "search", placeholder: "Search cases and capsules" }) as HTMLInputElement;
    const drawCases = () => {
      const q = caseSearch.value.toLowerCase().trim();
      caseGrid.replaceChildren(
        ...cases
          .filter((c) => !q || c.name.toLowerCase().includes(q))
          .map((c) =>
            h(
              "button",
              {
                type: "button",
                class: `admin-case${c.id === pickedCase ? " picked" : ""}`,
                onclick: () => {
                  pickedCase = dropCase = c.id;
                  drawCases();
                },
              },
              h("img", { src: c.image, alt: "", loading: "lazy" }),
              h("span", { class: "admin-case-name" }, c.name),
              h("b", null, money(openCost(c))),
            ),
          ),
      );
      const c = cases.find((x) => x.id === pickedCase);
      dropBtn.textContent = c ? `Drop a free ${c.name} on everyone online` : "Pick a case";
      dropBtn.disabled = !c;
    };
    caseSearch.addEventListener("input", drawCases);
    dropBtn.addEventListener("click", () => void run(() => adminAction<{ count: number }>("caseDrop", { caseId: pickedCase })).then((r) => r && toast(`Dropped a case on ${r.count} player${r.count === 1 ? "" : "s"}`)));
    drawCases();
    return section(
      "Events",
      h("p", { class: "hint" }, "Timed events show a banner with a countdown to everyone and are announced in the chat. One-off events happen right away; the house pays, not your balance."),
      ...rows,
      h(
        "div",
        { class: "admin-row" },
        h("b", { class: "admin-event-name" }, "House rain"),
        h("span", { class: "admin-muted" }, "$"),
        rainAmount,
        h("span", { class: "admin-muted" }, "split among everyone online, with the full rain effect"),
        h("button", { class: "btn btn-primary", onclick: () => void run(() => adminAction("houseRain", { amount: parseDecimal(rainAmount.value) }), "It's raining") }, "Make it rain"),
      ),
      h(
        "div",
        { class: "admin-casedrop" },
        h("div", { class: "admin-row" }, h("b", { class: "admin-event-name" }, "Case drop"), h("span", { class: "admin-muted" }, "Everyone online gets one free opening, with the case reel on their screen."), caseSearch),
        caseGrid,
        h("div", { class: "admin-row" }, dropBtn),
      ),
    );
  };

  // ---------- chat and rewards ----------
  const chatSection = () => {
    const o = ov!;
    const rainMin = decimalInput({ class: "admin-num", value: String(o.settings.rainMin) });
    const daily = h("input", { class: "search", value: o.settings.lbPrizes.daily.join(", "), placeholder: "e.g. 25, 10, 5" }) as HTMLInputElement;
    const weekly = h("input", { class: "search", value: o.settings.lbPrizes.weekly.join(", "), placeholder: "e.g. 100, 50, 25" }) as HTMLInputElement;
    const nums = (v: string) =>
      v
        .split(/[,;\s]+/)
        .filter(Boolean)
        .map(Number)
        .filter((x) => Number.isFinite(x) && x >= 0);
    const save = () =>
      run(async () => {
        ov = (await adminAction<Overview>("settings", { rainMin: parseDecimal(rainMin.value), lbPrizes: { daily: nums(daily.value), weekly: nums(weekly.value) } })) as Overview;
        draw();
      }, "Saved");
    return section(
      "Chat & rewards",
      h("p", { class: "hint" }, "Leaderboard prizes go to the top wagerers when a day / week ends (UTC), first place first. Leave empty for no prizes. The admin account is never on the leaderboards."),
      h("div", { class: "admin-row" }, h("b", null, "Daily prizes ($)"), daily),
      h("div", { class: "admin-row" }, h("b", null, "Weekly prizes ($)"), weekly),
      h("div", { class: "admin-row" }, h("b", null, "Smallest /rain ($)"), rainMin, h("button", { class: "btn btn-primary", onclick: () => void save() }, "Save")),
      h(
        "div",
        { class: "admin-row" },
        h("b", null, "Chat"),
        h("span", { class: "admin-muted" }, "Delete single messages with the bin icon in the chat itself. Mute players in the list below."),
        h("button", { class: "btn btn-ghost", onclick: () => confirm("Delete every chat message?") && void run(() => adminAction("chatClear"), "Chat cleared") }, "Clear chat"),
      ),
    );
  };

  // ---------- promo codes ----------
  const promoList = h("div", { class: "admin-promos" });
  const drawPromos = (codes: PromoCode[]) =>
    promoList.replaceChildren(
      codes.length
        ? h(
            "div",
            { class: "admin-table-wrap" },
            h(
              "table",
              { class: "admin-table" },
              h("thead", null, h("tr", null, h("th", null, "Code"), h("th", null, "Gives"), h("th", null, "Used"), h("th", null, "Expires"), h("th", null, ""))),
              h(
                "tbody",
                null,
                ...codes.map((c) =>
                  h(
                    "tr",
                    { class: c.active ? "" : "admin-banned" },
                    h("td", null, h("b", null, c.code)),
                    h("td", null, c.reward),
                    h("td", null, `${c.uses}${c.maxUses ? ` / ${c.maxUses}` : ""}`),
                    h("td", null, c.expiresAt ? new Date(c.expiresAt).toLocaleString() : "never"),
                    h(
                      "td",
                      { class: "admin-actions" },
                      h(
                        "button",
                        {
                          class: "btn btn-sm btn-ghost",
                          onclick: async () => {
                            const r = await run(() => adminAction<{ codes: PromoCode[] }>("promoDelete", { code: c.code }), "Code deleted");
                            if (r) drawPromos(r.codes);
                          },
                        },
                        "Delete",
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : h("p", { class: "hint" }, "No codes yet."),
    );
  const promoSection = () => {
    const code = h("input", { class: "search", placeholder: "CODE", maxlength: "24" }) as HTMLInputElement;
    const usd = decimalInput({ class: "admin-num", placeholder: "$" });
    const uses = h("input", { class: "admin-num", type: "number", min: "0", step: "1", placeholder: "any" }) as HTMLInputElement;
    const hours = h("input", { class: "admin-num", type: "number", min: "0", step: "1", placeholder: "never" }) as HTMLInputElement;
    let item: { itemId: string; wear: string; stattrak: boolean; name: string } | null = null;
    const itemLabel = h("span", { class: "admin-muted" }, "No item");
    const q = h("input", { class: "search", placeholder: "Optional: add an item (search)" }) as HTMLInputElement;
    const results = h("div", { class: "admin-results" });
    q.addEventListener("input", () => {
      const sq = q.value.toLowerCase().trim();
      const found = sq.length < 2 ? [] : Object.values(getCatalog().items).filter((it) => it.name.toLowerCase().includes(sq)).slice(0, 8);
      results.replaceChildren(
        ...found.map((it) =>
          h(
            "button",
            {
              class: "trade-item",
              style: `--rarity:${it.color}`,
              onclick: () => {
                const wear = it.wears.length ? (prompt(`Wear for ${it.name}: ${it.wears.join(", ")}`, it.wears[0]) ?? it.wears[0]) : "";
                item = { itemId: it.id, wear, stattrak: false, name: it.name };
                itemLabel.replaceChildren(`${it.name}${wear ? ` (${wear})` : ""} `, h("button", { class: "linklike", onclick: () => ((item = null), (itemLabel.textContent = "No item")) }, "remove"));
                results.replaceChildren();
                q.value = "";
              },
            },
            h("img", { src: it.image, alt: "" }),
            h("span", { class: "trade-item-name" }, it.name),
          ),
        ),
      );
    });
    const create = async () => {
      const r = await run(
        () => adminAction<{ codes: PromoCode[] }>("promoCreate", { code: code.value, usd: parseDecimal(usd.value) || 0, maxUses: Number(uses.value) || 0, hours: Number(hours.value) || 0, item }),
        `Code ${code.value.toUpperCase()} created`,
      );
      if (r) {
        drawPromos(r.codes);
        code.value = usd.value = uses.value = hours.value = "";
      }
    };
    void run(() => adminAction<{ codes: PromoCode[] }>("promos")).then((r) => r && drawPromos(r.codes));
    return section(
      "Promo codes",
      h("p", { class: "hint" }, "Players redeem codes on the Missions page, once each. Give balance, an item, or both."),
      h(
        "div",
        { class: "admin-row" },
        code,
        h("label", { class: "admin-check" }, "Balance ", usd),
        h("label", { class: "admin-check" }, "Max uses ", uses),
        h("label", { class: "admin-check" }, "Expires in (hours) ", hours),
      ),
      h("div", { class: "admin-row" }, q, itemLabel),
      results,
      h("div", { class: "admin-row" }, h("button", { class: "btn btn-primary", onclick: () => void create() }, "Create code")),
      promoList,
    );
  };

  // ---------- economy ----------
  const economySection = () => {
    const o = ov!;
    const stat = (label: string, value: string) => h("div", { class: "pc-stat" }, h("span", null, label), h("b", null, value));
    return section(
      "Economy",
      h(
        "div",
        { class: "pc-stats" },
        stat("Players", `${o.users} (${o.online} online)`),
        stat("Total balances", money(o.balances)),
        stat("Items held", `${o.items.toLocaleString("en-US")} · ${money(o.itemValue)}`),
        stat("Steam prices", `${o.steam.prices.toLocaleString("en-US")}${o.steam.total ? ` · sweep ${Math.round((o.steam.sweep / o.steam.total) * 100)}%` : ""} · every ${(o.steam.intervalMs / 1000).toFixed(1)} s`),
      ),
      h(
        "div",
        { class: "admin-table-wrap" },
        h(
          "table",
          { class: "admin-table" },
          h("thead", null, h("tr", null, h("th", null, "Game"), h("th", null, "Rounds"), h("th", null, "Wagered"), h("th", null, "Paid out"), h("th", null, "House result"), h("th", null, "Actual payback"))),
          h(
            "tbody",
            null,
            ...[...o.games]
              .sort((a, b) => b.wagered - a.wagered)
              .map((g) =>
                h(
                  "tr",
                  null,
                  h("td", null, h("b", null, gameName(g.game))),
                  h("td", null, g.played.toLocaleString("en-US")),
                  h("td", null, money(g.wagered)),
                  h("td", null, money(g.paid)),
                  h("td", { class: g.house >= 0 ? "admin-good" : "admin-bad" }, `${g.house >= 0 ? "+" : ""}${money(g.house)}`),
                  h("td", null, g.rtp == null ? "–" : `${g.rtp}%`),
                ),
              ),
          ),
        ),
      ),
    );
  };

  // ---------- users ----------
  const usersBox = h("div", { class: "admin-users" });
  const search = h("input", { class: "search", ...NO_AUTOFILL, name: "player-search", placeholder: "Search players" }) as HTMLInputElement;
  let timer = 0;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void loadUsers(), 250);
  });
  const loadUsers = async () => {
    const r = await run(() => adminAction<{ users: AdminUser[] }>("users", { query: search.value }));
    if (r) drawUsers(r.users);
  };
  const drawUsers = (users: AdminUser[]) => {
    usersBox.replaceChildren(
      h(
        "div",
        { class: "admin-table-wrap" },
        h(
          "table",
          { class: "admin-table" },
          h("thead", null, h("tr", null, h("th", null, "Player"), h("th", null, "Balance"), h("th", null, "Items"), h("th", null, "Last seen"), h("th", null, ""))),
          h(
            "tbody",
            null,
            ...users.map((u) =>
              h(
                "tr",
                { class: u.banned ? "admin-banned" : "" },
                h("td", null, h("span", { class: `dot${u.online ? " on" : ""}` }), " ", userLink(u.user, u.name), h("span", { class: "admin-muted" }, ` @${u.user}${u.banned ? " · banned" : ""}${u.mutedUntil ? ` · muted ${u.mutedUntil > Date.now() + 3e11 ? "for good" : `till ${new Date(u.mutedUntil).toLocaleString()}`}` : ""}`)),
                h("td", null, money(u.balance)),
                h("td", null, String(u.items)),
                h("td", null, u.online ? "online" : ago(u.lastActive)),
                h(
                  "td",
                  { class: "admin-actions" },
                  h(
                    "button",
                    {
                      class: "btn btn-sm",
                      onclick: async () => {
                        const v = prompt(`Add money to ${u.user} (negative takes it away):`, "10");
                        if (v && (await run(() => adminAction("money", { username: u.user, amount: parseDecimal(v) }), `${parseDecimal(v) >= 0 ? "Gave" : "Took"} ${money(Math.abs(parseDecimal(v)))}`))) void loadUsers();
                      },
                    },
                    "Money",
                  ),
                  h("button", { class: "btn btn-sm", onclick: () => openGiveItem(u.user) }, "Give item"),
                  h("button", { class: "btn btn-sm", onclick: () => openGiveItem(u.user, true) }, "Rig"),
                  h(
                    "button",
                    {
                      class: "btn btn-sm",
                      onclick: async () => {
                        const v = prompt(`New password for ${u.user} (8+ characters). Leave empty for a random one. They'll be logged out everywhere.`, "");
                        if (v === null) return;
                        const r = await run(() => adminAction<{ password: string }>("password", { username: u.user, password: v }));
                        if (r) prompt(`${u.user}'s new password (copy it now, it isn't shown again):`, r.password);
                      },
                    },
                    "Password",
                  ),
                  h(
                    "button",
                    {
                      class: "btn btn-sm",
                      onclick: async () => {
                        if (u.mutedUntil) return (await run(() => adminAction("mute", { username: u.user, minutes: 0 }), "Unmuted")) && void loadUsers();
                        const v = prompt(`Mute ${u.user} in chat for how many minutes? (-1 = for good)`, "60");
                        if (v && (await run(() => adminAction("mute", { username: u.user, minutes: Number(v) }), "Muted"))) void loadUsers();
                      },
                    },
                    u.mutedUntil ? "Unmute" : "Mute",
                  ),
                  h(
                    "button",
                    { class: "btn btn-sm", onclick: async () => confirm(`Wipe ${u.user}'s balance, items, stats and upgrades?`) && (await run(() => adminAction("reset", { username: u.user }), "Account reset")) && void loadUsers() },
                    "Reset",
                  ),
                  u.user === "admin"
                    ? ""
                    : h(
                        "button",
                        { class: `btn btn-sm${u.banned ? "" : " btn-ghost"}`, onclick: async () => (await run(() => adminAction(u.banned ? "unban" : "ban", { username: u.user }), u.banned ? "Unbanned" : "Banned")) && void loadUsers() },
                        u.banned ? "Unban" : "Ban",
                      ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };

  // Give item: search the catalog, pick wear / StatTrak.
  const giveBox = h("div", { class: "admin-give", hidden: true });
  /** Give an item now, or (rig) set what this player's next case opening drops and how their next upgrade goes. */
  const openGiveItem = (user: string, rig = false) => {
    let picked: Item | null = null;
    let wear = "";
    let st = false;
    const q = h("input", { class: "search", placeholder: "Search items (e.g. Karambit Fade, AK-47 Redline)" }) as HTMLInputElement;
    const results = h("div", { class: "admin-results" });
    const opts = h("div", { class: "admin-row" });
    const drawOpts = () => {
      if (!picked) return opts.replaceChildren();
      opts.replaceChildren(
        h("b", null, picked.name),
        ...(picked.wears.length ? [h("select", { class: "search", onchange: (e: Event) => (wear = (e.target as HTMLSelectElement).value) }, ...picked.wears.map((w) => h("option", { value: w, selected: w === wear }, w)))] : []),
        ...(picked.stattrak ? [h("label", { class: "admin-check" }, h("input", { type: "checkbox", onchange: (e: Event) => (st = (e.target as HTMLInputElement).checked) }), "StatTrak")] : []),
        rig
          ? h(
              "button",
              {
                class: "btn btn-primary",
                onclick: async () => {
                  const r = await run(() => adminAction<Forced>("forcePlayer", { username: user, item: { itemId: picked!.id, wear, stattrak: st } }), `${user}'s next case drops ${picked!.name}`);
                  if (r) (Object.assign(ov!, r), draw());
                },
              },
              `Make it ${user}'s next drop`,
            )
          : h(
              "button",
              { class: "btn btn-primary", onclick: async () => (await run(() => adminAction("item", { username: user, itemId: picked!.id, wear, stattrak: st }), `Gave ${picked!.name} to ${user}`)) && void loadUsers() },
              `Give to ${user}`,
            ),
      );
    };
    q.addEventListener("input", () => {
      const s = q.value.toLowerCase().trim();
      const found = s.length < 2 ? [] : Object.values(getCatalog().items).filter((it) => it.name.toLowerCase().includes(s)).slice(0, 12);
      results.replaceChildren(
        ...found.map((it) =>
          h(
            "button",
            {
              class: "trade-item",
              style: `--rarity:${it.color}`,
              onclick: () => {
                picked = it;
                wear = it.wears[0] ?? "";
                drawOpts();
              },
            },
            h("img", { src: it.image, alt: "" }),
            h("span", { class: "trade-item-name" }, it.name),
          ),
        ),
      );
    });
    giveBox.hidden = false;
    giveBox.replaceChildren(
      h("div", { class: "admin-row" }, h("b", null, rig ? `Rig ${user}` : `Give an item to ${user}`), h("button", { class: "btn btn-ghost btn-sm", onclick: () => (giveBox.hidden = true) }, "Close")),
      ...(rig
        ? [
            h(
              "div",
              { class: "admin-row" },
              h("span", { class: "admin-muted" }, "Next upgrade:"),
              ...(["win", "lose"] as const).map((w) =>
                h(
                  "button",
                  {
                    class: "btn btn-sm",
                    onclick: async () => {
                      const r = await run(() => adminAction<Forced>("forcePlayer", { username: user, upgrade: w }), `${user}'s next upgrade will ${w}`);
                      if (r) (Object.assign(ov!, r), draw());
                    },
                  },
                  w === "win" ? "Wins" : "Loses",
                ),
              ),
              h(
                "button",
                {
                  class: "btn btn-sm btn-ghost",
                  onclick: async () => {
                    const r = await run(() => adminAction<Forced>("forcePlayer", { username: user, clear: true }), `Cleared ${user}'s rigging`);
                    if (r) (Object.assign(ov!, r), draw());
                  },
                },
                "Clear",
              ),
            ),
            h("p", { class: "hint" }, "Or search an item below to make it their next case drop (whatever case they open)."),
          ]
        : []),
      q,
      results,
      opts,
    );
    q.focus();
  };

  const draw = () => {
    if (!ov) return;
    root.replaceChildren(
      h("div", { class: "admin-top" }, h("h1", null, icon("admin", 22), " Admin"), h("button", { class: "btn btn-ghost", onclick: () => void load() }, "Refresh")),
      rigSection(),
      siteSection(),
      forceSection(),
      eventsSection(),
      chatSection(),
      promoSection(),
      economySection(),
      section("Players", search, giveBox, usersBox),
    );
  };
  const load = async () => {
    const r = await run(() => adminAction<Overview>("overview"));
    if (r) {
      ov = r as Overview;
      draw();
      void loadUsers();
    }
  };
  root.append(h("p", { class: "empty" }, "Loading..."));
  void load();
  return h("section", { class: "page narrow-wide" }, root);
}

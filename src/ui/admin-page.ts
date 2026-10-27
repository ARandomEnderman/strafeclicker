import { getCatalog } from "../catalog";
import { adminAction, ServerError } from "../state";
import type { Item } from "../types";
import { h, money, toast } from "./dom";
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
  settings: { rig: number; rigGames: Record<string, number>; maintenance: boolean; announcement: string | null };
  rigGames: string[];
  report: ReportRow[];
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
  online: boolean;
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
  coinflipBot: "Coinflip vs bot",
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
  const search = h("input", { class: "search", placeholder: "Search players" }) as HTMLInputElement;
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
                h("td", null, h("span", { class: `dot${u.online ? " on" : ""}` }), " ", userLink(u.user, u.name), h("span", { class: "admin-muted" }, ` @${u.user}${u.banned ? " · banned" : ""}`)),
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
                        if (v && (await run(() => adminAction("money", { username: u.user, amount: Number(v) }), `${Number(v) >= 0 ? "Gave" : "Took"} ${money(Math.abs(Number(v)))}`))) void loadUsers();
                      },
                    },
                    "Money",
                  ),
                  h("button", { class: "btn btn-sm", onclick: () => openGiveItem(u.user) }, "Give item"),
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
  const openGiveItem = (user: string) => {
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
        h(
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
      h("div", { class: "admin-row" }, h("b", null, `Give an item to ${user}`), h("button", { class: "btn btn-ghost btn-sm", onclick: () => (giveBox.hidden = true) }, "Close")),
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

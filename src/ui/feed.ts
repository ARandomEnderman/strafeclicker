import { getItem, imageOf } from "../catalog";
import { onServerEvent } from "../live";
import type { Win } from "../types";
import { h, money, mult } from "./dom";
import { icon, type IconName } from "./icons";
import { gameName } from "./game-names";
import { userLink } from "./profile-card";

// Sidebar list of big wins from everyone, pushed live by the server.

// Item wins use their own game names; bets use the stats ids (see game-names.ts).
const GAME_ICON: Record<string, IconName> = {
  case: "cases",
  cases: "cases",
  upgrader: "upgrader",
  upgrade: "upgrader",
  battle: "battles",
  jackpot: "jackpot",
  coinflip: "coins",
  flashbang: "flashbang",
  bhop: "bhop",
  roulette: "roulette",
  defuse: "bomb",
  bombplant: "bomb",
  towers: "towers",
  keno: "keno",
  race: "race",
  blackjack: "blackjack",
  poker: "poker",
  rps: "scissors",
  bracket: "bracket",
};
const ITEM_GAME_NAME: Record<string, string> = { case: "Case", upgrader: "Upgrader", battle: "Case battle", jackpot: "Jackpot", coinflip: "Coinflip" };
const nameOf = (game: string) => ITEM_GAME_NAME[game] ?? gameName(game);
const SHOWN = 30;

function winRow(w: Win, fresh: boolean) {
  const kind = w.kind ?? "item";
  const item = kind === "item" && w.drop ? getItem(w.drop.itemId) : null;
  const art = item ? h("img", { src: imageOf(w.drop!), alt: "", loading: "lazy" }) : icon(GAME_ICON[w.game] ?? "coins", 22);
  const who = w.name ?? w.user;
  if (kind === "loss") {
    return h(
      "div",
      { class: `win loss${fresh ? " fresh" : ""}`, title: `${who} lost ${money(w.value)} on ${nameOf(w.game)} (a ${money(w.stake)} bet; the typical bet is ${money(w.typical ?? 0)})` },
      h("div", { class: "win-art" }, art),
      h("div", { class: "win-user" }, userLink(w.user, who)),
      h("div", { class: "win-name" }, `Big loss · ${nameOf(w.game)}`),
      h("div", { class: "win-who" }, h("span", { class: "win-value" }, `-${money(w.value)}`), w.mult != null ? ` · ${mult(w.mult)}` : ""),
    );
  }
  const name = item ? `${w.drop!.stattrak ? "StatTrak " : ""}${item.name}` : `Big win · ${nameOf(w.game)}`;
  const times = w.mult != null ? mult(w.mult) : null;
  const how = (item ? [nameOf(w.game), times] : [times]).filter(Boolean).join(" · ");
  return h(
    "div",
    {
      class: `win${kind === "win" ? " cash" : ""}${fresh ? " fresh" : ""}`,
      style: item ? `--rarity:${item.color}` : "",
      title: kind === "win" ? `${who} won ${money(w.value)} on a ${money(w.stake)} bet (the typical bet is ${money(w.typical ?? 0)})` : `${who} won ${money(w.value)}${w.source ? ` from ${w.source}` : ""}`,
    },
    h("div", { class: "win-art" }, art),
    h("div", { class: "win-user" }, userLink(w.user, who)),
    h("div", { class: "win-name" }, name),
    h("div", { class: "win-who" }, h("span", { class: "win-value" }, money(w.value)), how ? ` · ${how}` : ""),
  );
}

export function feedPanel() {
  const list = h("div", { class: "feed-list" }, h("div", { class: "feed-empty" }, "No big wins yet. Be the first."));
  const known = new Set<number>();
  // What counts as big: SIGNIFICANT (10) times the site's typical bet, from the newest bet entry.
  const typical = h("span", { class: "feed-typical", title: "Wins and losses of 10 times the typical bet (and at least $5) show up here" });
  const setTypical = (w?: Win) => {
    if (w?.typical == null) return;
    typical.textContent = `typical bet ${money(w.typical)}`;
  };

  onServerEvent<Win[]>("wins", (wins) => {
    // Sent on every (re)connect: redraw from scratch.
    known.clear();
    const rows = wins.filter((w) => !w.drop || getItem(w.drop.itemId)).slice(0, SHOWN);
    rows.forEach((w) => known.add(w.id));
    list.replaceChildren(...(rows.length ? rows.map((w) => winRow(w, false)) : [h("div", { class: "feed-empty" }, "No big wins yet. Be the first.")]));
    setTypical(wins.find((w) => w.typical != null));
  });
  onServerEvent<Win>("win", (w) => {
    if (known.has(w.id) || (w.drop && !getItem(w.drop.itemId))) return;
    known.add(w.id);
    list.querySelector(".feed-empty")?.remove();
    list.prepend(winRow(w, true));
    setTypical(w);
    while (list.children.length > SHOWN) list.lastElementChild!.remove();
  });

  return h(
    "section",
    { class: "feed", "aria-label": "Live big wins and losses" },
    h("div", { class: "feed-head" }, h("span", { class: "live-dot" }), "Live wins", typical),
    list,
  );
}

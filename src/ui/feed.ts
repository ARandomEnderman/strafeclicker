import { getItem, imageOf } from "../catalog";
import { onServerEvent } from "../live";
import type { Win } from "../types";
import { h, money } from "./dom";
import { icon, type IconName } from "./icons";
import { userLink } from "./profile-card";

// Sidebar list of big wins from everyone, pushed live by the server.

const GAME_ICON: Record<Win["game"], IconName> = {
  case: "cases",
  upgrader: "upgrader",
  plinko: "plinko",
  flashbang: "flashbang",
  bhop: "bhop",
  battle: "battles",
  jackpot: "jackpot",
};
const GAME_NAME: Record<Win["game"], string> = {
  case: "Case",
  upgrader: "Upgrader",
  plinko: "Plinko",
  flashbang: "Flashbang",
  bhop: "B-hop",
  battle: "Case battle",
  jackpot: "Jackpot",
};
const SHOWN = 30;

function winRow(w: Win, fresh: boolean) {
  const item = w.drop ? getItem(w.drop.itemId) : null;
  const art = item
    ? h("img", { src: imageOf(w.drop!), alt: "", loading: "lazy" })
    : icon(GAME_ICON[w.game] ?? "coins", 22);
  const name = item ? `${w.drop!.stattrak ? "StatTrak " : ""}${item.name}` : (GAME_NAME[w.game] ?? w.game);
  const mult = w.mult != null ? `${+w.mult.toFixed(w.mult < 100 ? 2 : 0)}x` : null;
  const how = (item ? [GAME_NAME[w.game], mult] : [mult]).filter(Boolean).join(" · ");
  return h(
    "div",
    { class: `win${fresh ? " fresh" : ""}`, style: item ? `--rarity:${item.color}` : "", title: `${w.name ?? w.user} won ${money(w.value)}${w.source ? ` from ${w.source}` : ""}` },
    h("div", { class: "win-art" }, art),
    h("div", { class: "win-user" }, userLink(w.user, w.name ?? w.user)),
    h("div", { class: "win-name" }, name),
    h("div", { class: "win-who" }, h("span", { class: "win-value" }, money(w.value)), how ? ` · ${how}` : ""),
  );
}

export function feedPanel() {
  const list = h("div", { class: "feed-list" }, h("div", { class: "feed-empty" }, "No big wins yet. Be the first."));
  const known = new Set<number>();

  onServerEvent<Win[]>("wins", (wins) => {
    // Sent on every (re)connect: redraw from scratch.
    known.clear();
    const rows = wins.filter((w) => !w.drop || getItem(w.drop.itemId)).slice(0, SHOWN);
    rows.forEach((w) => known.add(w.id));
    list.replaceChildren(...(rows.length ? rows.map((w) => winRow(w, false)) : [h("div", { class: "feed-empty" }, "No big wins yet. Be the first.")]));
  });
  onServerEvent<Win>("win", (w) => {
    if (known.has(w.id) || (w.drop && !getItem(w.drop.itemId))) return;
    known.add(w.id);
    list.querySelector(".feed-empty")?.remove();
    list.prepend(winRow(w, true));
    while (list.children.length > SHOWN) list.lastElementChild!.remove();
  });

  return h(
    "section",
    { class: "feed", "aria-label": "Live big wins" },
    h("div", { class: "feed-head" }, h("span", { class: "live-dot" }), "Live wins"),
    list,
  );
}

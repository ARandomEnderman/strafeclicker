import type { Drop, Item } from "../types";
import { getItem, priceOf } from "../catalog";
import { WEAR_NAME } from "../odds";
import { renderSkin } from "../skin-renderer";
import { h, money } from "./dom";
import { openPriceChart } from "./price-chart";

export function displayName(item: Item, d?: Pick<Drop, "stattrak" | "phase">) {
  const st = d?.stattrak ? "StatTrak™ " : "";
  const star = item.kind === "knife" || item.kind === "gloves" ? "★ " : "";
  const finish = item.finish ? `${item.finish}${d?.phase ? ` (${d.phase})` : ""}` : "Vanilla";
  return { weapon: `${star}${st}${item.weapon}`, finish };
}

/** "StatTrak™ AK-47 | Redline (Field-Tested)" */
export function fullName(d: Drop) {
  const item = getItem(d.itemId);
  const n = displayName(item, d);
  return `${n.weapon} | ${n.finish}${d.wear ? ` (${WEAR_NAME[d.wear]})` : ""}`;
}

/** Clicking a card (anywhere but its buttons) opens the price graph. */
function chartOnClick(el: HTMLElement, item: Item, d?: Drop) {
  el.classList.add("clickable");
  el.title = "Price history";
  el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    openPriceChart(item, d);
  });
  return el;
}

/** Card for a concrete drop: picture, name, wear, float, price. */
export function dropCard(d: Drop, opts: { size?: "sm" | "md" | "lg"; extra?: Node } = {}) {
  const item = getItem(d.itemId);
  const name = displayName(item, d);
  const card = h(
    "div",
    { class: `item-card size-${opts.size ?? "md"}`, style: `--rarity:${item.color}` },
    h("div", { class: "item-art" }, renderSkin({ item, phase: d.phase, float: d.float, seed: d.seed, stattrak: d.stattrak, size: opts.size ?? "md" })),
    h(
      "div",
      { class: "item-meta" },
      h("div", { class: `item-weapon${d.stattrak ? " st" : ""}` }, name.weapon),
      h("div", { class: "item-finish" }, name.finish),
      h(
        "div",
        { class: "item-sub" },
        d.wear ? h("span", null, WEAR_NAME[d.wear]) : null,
        d.float != null ? h("span", { class: "float" }, d.float.toFixed(6)) : null,
      ),
      d.float != null ? floatBar(d.float) : null,
      h("div", { class: "item-price" }, money(priceOf(d))),
    ),
    opts.extra,
  );
  return chartOnClick(card, item, d);
}

function floatBar(f: number) {
  return h("div", { class: "float-bar" }, h("i", { style: `left:${(f * 100).toFixed(2)}%` }));
}

/** Card for an item as listed in a case (no specific wear yet). */
export function itemPreviewCard(item: Item, footer: Node | string) {
  const name = displayName(item);
  const card = h(
    "div",
    { class: "item-card size-sm", style: `--rarity:${item.color}` },
    h("div", { class: "item-art" }, renderSkin({ item, size: "sm" })),
    h(
      "div",
      { class: "item-meta" },
      h("div", { class: "item-weapon" }, name.weapon),
      h("div", { class: "item-finish" }, name.finish),
      h("div", { class: "item-sub" }, footer),
    ),
  );
  return chartOnClick(card, item);
}

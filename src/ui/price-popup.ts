import type { InventoryChange } from "../live";
import { getItem, round2 } from "../catalog";
import { deltaLine, h, money } from "./dom";
import { fullName } from "./item-card";
import { openModal } from "./modal";
import { openPriceChart } from "./price-chart";

const MAX_MOVERS = 8;
/** The popup only opens once the inventory has moved at least this much since you last saw one... */
const MIN_CHANGE_USD = 0.5;
/** ...and by at least this share of its value. Smaller moves keep adding up until they do. */
const MIN_CHANGE_SHARE = 0.02;

// Each item's value when you last saw a popup (or when it first showed up). Changes are
// measured from here, so lots of tiny moves still surface once they add up, and an
// update arriving while the popup is open folds into it.
const baseline = new Map<string, number>();
let open: { close: () => void } | null = null;

export function showInventoryChange(change: InventoryChange) {
  for (const { drop, before } of change.items) if (!baseline.has(drop.uid)) baseline.set(drop.uid, before);

  const rows = change.items.map(({ drop, after }) => ({ drop, before: baseline.get(drop.uid)!, after }));
  const before = round2(rows.reduce((s, r) => s + r.before, 0));
  const after = round2(rows.reduce((s, r) => s + r.after, 0));
  const movers = rows.filter((r) => r.after !== r.before).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  if (!movers.length) return;
  const moved = Math.abs(after - before);
  if (!open && (moved < MIN_CHANGE_USD || moved < before * MIN_CHANGE_SHARE)) return;

  open?.close();
  const delta = round2(after - before);
  const body = h(
    "div",
    { class: "popup-body" },
    h(
      "div",
      { class: "popup-hero" },
      h("div", { class: "popup-label" }, "Inventory value"),
      h("div", { class: "popup-value" }, money(after)),
      deltaLine(before, after),
      h("div", { class: "popup-was" }, `was ${money(before)}`),
    ),
    h(
      "div",
      { class: "movers" },
      h("div", { class: "movers-head" }, `${movers.length} item${movers.length === 1 ? "" : "s"} changed`),
      ...movers.slice(0, MAX_MOVERS).map((r) =>
        h(
          "button",
          {
            class: "mover",
            onclick: () => {
              open?.close();
              openPriceChart(getItem(r.drop.itemId), r.drop);
            },
          },
          h("span", { class: "mover-dot", style: `--rarity:${getItem(r.drop.itemId).color}` }),
          h("span", { class: "mover-name" }, fullName(r.drop)),
          h("span", { class: "mover-prices" }, `${money(r.before)} → ${money(r.after)}`),
          deltaLine(r.before, r.after, true),
        ),
      ),
      movers.length > MAX_MOVERS ? h("div", { class: "movers-more" }, `+${movers.length - MAX_MOVERS} more`) : null,
    ),
  );
  const close = openModal(delta >= 0 ? "Prices went up" : "Prices went down", body, {
    onClose: () => {
      open = null;
      // Seen: the next popup counts from here.
      for (const r of rows) baseline.set(r.drop.uid, r.after);
    },
  });
  open = { close };
}

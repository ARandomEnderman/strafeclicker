import type { InventoryChange } from "../live";
import { getItem, round2 } from "../catalog";
import { deltaLine, h, money } from "./dom";
import { fullName } from "./item-card";
import { openModal } from "./modal";
import { openPriceChart } from "./price-chart";

const MAX_MOVERS = 8;

// If updates arrive while the popup is still open, it keeps the value from
// before the first one, so it always shows the change since you last looked.
let open: { close: () => void; baseline: Map<string, number> } | null = null;

export function showInventoryChange(change: InventoryChange) {
  const baseline = open?.baseline ?? new Map<string, number>();
  for (const { drop, before } of change.items) if (!baseline.has(drop.uid)) baseline.set(drop.uid, before);

  const rows = change.items.map(({ drop, after }) => ({ drop, before: baseline.get(drop.uid)!, after }));
  const before = round2(rows.reduce((s, r) => s + r.before, 0));
  const after = round2(rows.reduce((s, r) => s + r.after, 0));
  const movers = rows.filter((r) => r.after !== r.before).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  if (!movers.length) return;

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
  const close = openModal(delta >= 0 ? "Prices went up" : "Prices went down", body, { onClose: () => (open = null) });
  open = { close, baseline };
}

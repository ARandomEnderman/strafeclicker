import type { InventoryChange } from "../live";
import { round2 } from "../catalog";
import { deltaLine, h, money, toast } from "./dom";
import { fullName } from "./item-card";

// How price changes reach the player: a short toast for each live update, and a few
// lines in the welcome-back popup for what changed while the tab was closed.

const AWAY_MOVERS = 3;
/** Live updates smaller than this aren't worth a toast. */
const MIN_TOAST_USD = 0.01;

function summarize(change: InventoryChange) {
  const before = round2(change.items.reduce((s, r) => s + r.before, 0));
  const after = round2(change.items.reduce((s, r) => s + r.after, 0));
  const movers = change.items.filter((r) => r.after !== r.before).sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
  return { before, after, delta: round2(after - before), movers };
}
const signed = (d: number) => `${d >= 0 ? "+" : "-"}${money(Math.abs(d))}`;

/** One short toast per price update: "Prices: inventory +$0.42 (AK-47 | Redline +$0.30)". */
export function priceToast(change: InventoryChange) {
  const { delta, movers } = summarize(change);
  if (!movers.length || Math.abs(delta) < MIN_TOAST_USD) return;
  const top = movers[0];
  toast(`Prices: inventory ${signed(delta)} (${fullName(top.drop)} ${signed(round2(top.after - top.before))})`, delta >= 0 ? "up" : "down", 4000);
}

/** The inventory part of the welcome-back popup, or null if nothing moved. */
export function awaySection(change: InventoryChange | null) {
  if (!change) return null;
  const { before, after, delta, movers } = summarize(change);
  if (!movers.length || Math.abs(delta) < MIN_TOAST_USD) return null;
  return h(
    "div",
    { class: "away-prices" },
    h("div", { class: "away-head" }, h("span", null, "Your inventory while you were gone"), h("b", null, money(after)), deltaLine(before, after)),
    ...movers.slice(0, AWAY_MOVERS).map((r) =>
      h("div", { class: "away-row" }, h("span", { class: "mover-name" }, fullName(r.drop)), deltaLine(r.before, r.after, true)),
    ),
    movers.length > AWAY_MOVERS ? h("div", { class: "movers-more" }, `+${movers.length - AWAY_MOVERS} more`) : null,
  );
}

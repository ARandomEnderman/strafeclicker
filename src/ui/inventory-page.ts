import { getItem, priceOf, round2 } from "../catalog";
import { TIER_INFO, TIERS } from "../odds";
import { getState, lockItems, sell, ServerError, subscribe } from "../state";
import { onPricesForPage } from "../live";
import type { Item, OwnedItem, Tier } from "../types";
import { decimalInput, h, money, parseDecimal, toast } from "./dom";
import { icon } from "./icons";
import { displayName, dropCard } from "./item-card";
import { onLeave } from "./page";

// Your items: search and filter them, tick several to sell or lock at once, or sell
// everything under a price. Locked items can't be sold, upgraded, staked or traded.

type Sort = "new" | "value" | "cheap";
type Kind = "all" | Item["kind"];
const KINDS: { kind: Kind; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "weapon", label: "Weapons" },
  { kind: "knife", label: "Knives" },
  { kind: "gloves", label: "Gloves" },
  { kind: "sticker", label: "Stickers" },
];

// Kept while you move around the site.
let sort: Sort = "new";
let kind: Kind = "all";
let tier: Tier | "all" = "all";
let query = "";
const selected = new Set<string>();

export function inventoryPage() {
  const head = h("div");
  const chips = h("div", { class: "inv-chips" });
  const pickedBar = h("div");
  const selectAllSlot = h("span");
  const sellAllSlot = h("span");
  const grid = h("div");
  let busy = false;

  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: "Search your items",
    value: query,
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      draw();
    },
  }) as HTMLInputElement;
  const tierSelect = h(
    "select",
    {
      class: "search inv-tier",
      onchange: (e: Event) => {
        tier = (e.target as HTMLSelectElement).value as typeof tier;
        draw();
      },
    },
    h("option", { value: "all" }, "All rarities"),
    ...TIERS.map((t: Tier) => h("option", { value: t, selected: tier === t }, TIER_INFO[t].label)),
  );
  const under = decimalInput({ class: "inv-under", placeholder: "1.00", "aria-label": "Sell everything under this price" });
  const sellUnder = () => {
    const usd = parseDecimal(under.value);
    if (!(usd > 0)) return toast("Enter a price", "error");
    const items = getState().inventory.filter((it) => !it.locked && priceOf(it) < usd);
    if (!items.length) return toast(`Nothing unlocked is worth under ${money(usd)}`, "error");
    void sellItems(items, `everything under ${money(usd)}`);
  };
  under.addEventListener("keydown", (e) => e.key === "Enter" && sellUnder());

  /** Sell some items, after asking when it's more than one. */
  const sellItems = async (items: OwnedItem[], what: string) => {
    if (!items.length || busy) return;
    const total = round2(items.reduce((s, it) => s + priceOf(it), 0));
    if (items.length > 1 && !confirm(`Sell ${what} (${items.length} items) for about ${money(total)}?`)) return;
    busy = true;
    try {
      const got = await sell(items.map((it) => it.uid));
      items.forEach((it) => selected.delete(it.uid));
      toast(items.length === 1 ? `Sold ${getItem(items[0].itemId).name} for ${money(got)}` : `Sold ${items.length} items for ${money(got)}`);
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
      draw();
    }
  };
  const setLocked = async (items: OwnedItem[], locked: boolean) => {
    if (!items.length || busy) return;
    busy = true;
    try {
      await lockItems(
        items.map((it) => it.uid),
        locked,
      );
      if (items.length > 1) toast(`${locked ? "Locked" : "Unlocked"} ${items.length} items`);
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
      draw();
    }
  };

  const matches = (it: OwnedItem) => {
    const item = getItem(it.itemId);
    if (kind !== "all" && item.kind !== kind) return false;
    if (tier !== "all" && item.tier !== tier) return false;
    if (!query.trim()) return true;
    const n = displayName(item, it);
    const text = `${n.weapon} ${n.finish} ${it.phase ?? ""} ${it.stattrak ? "stattrak" : ""}`.toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .every((w) => text.includes(w));
  };

  const chip = (active: boolean, label: string, onclick: () => void) => h("button", { class: `chip${active ? " active" : ""}`, onclick }, label);

  const draw = () => {
    const all = getState().inventory;
    for (const uid of [...selected]) if (!all.some((it) => it.uid === uid)) selected.delete(uid);
    const shown = all.filter(matches);
    if (sort === "value") shown.sort((a, b) => priceOf(b) - priceOf(a));
    if (sort === "cheap") shown.sort((a, b) => priceOf(a) - priceOf(b));
    const total = round2(all.reduce((s, it) => s + priceOf(it), 0));
    const sellable = all.filter((it) => !it.locked);
    const sellableTotal = round2(sellable.reduce((s, it) => s + priceOf(it), 0));
    const picked = all.filter((it) => selected.has(it.uid));
    const pickedTotal = round2(picked.reduce((s, it) => s + priceOf(it), 0));
    const top = all.reduce<OwnedItem | null>((best, it) => (!best || priceOf(it) > priceOf(best) ? it : best), null);

    head.replaceChildren(
      h(
        "div",
        { class: "case-stats" },
        // Only what's in the inventory now; cases, spending and upgrades are in Bet history.
        h("div", { class: "stat" }, h("span", null, "Items"), h("b", null, all.length)),
        h("div", { class: "stat" }, h("span", null, "Inventory value"), h("b", null, money(total))),
        top ? h("div", { class: "stat" }, h("span", null, "Most valuable"), h("b", null, `${displayName(getItem(top.itemId), top).weapon} | ${displayName(getItem(top.itemId), top).finish} · ${money(priceOf(top))}`)) : null,
        h("div", { class: "stat" }, h("span", null, "Locked"), h("b", null, all.filter((it) => it.locked).length)),
      ),
    );

    chips.replaceChildren(
      h("div", { class: "sort" }, ...KINDS.map((k) => chip(kind === k.kind, k.label, () => ((kind = k.kind), draw())))),
      h(
        "div",
        { class: "sort" },
        chip(sort === "new", "Newest", () => ((sort = "new"), draw())),
        chip(sort === "value", "Priciest", () => ((sort = "value"), draw())),
        chip(sort === "cheap", "Cheapest", () => ((sort = "cheap"), draw())),
      ),
    );

    pickedBar.replaceChildren(
      picked.length
        ? h(
            "div",
            { class: "inv-bar picked" },
            h("b", null, `${picked.length} selected · ${money(pickedTotal)}`),
            h("button", { class: "btn btn-primary btn-sm", disabled: picked.some((it) => it.locked), title: picked.some((it) => it.locked) ? "Some of these are locked" : "", onclick: () => void sellItems(picked, "the selected items") }, "Sell selected"),
            h("button", { class: "btn btn-sm", onclick: () => void setLocked(picked, true) }, icon("lock", 13), " Lock"),
            h("button", { class: "btn btn-sm", onclick: () => void setLocked(picked, false) }, "Unlock"),
            h("button", { class: "btn btn-ghost btn-sm", onclick: () => (selected.clear(), draw()) }, "Clear"),
          )
        : "",
    );
    selectAllSlot.replaceChildren(shown.length ? h("button", { class: "btn btn-ghost btn-sm", onclick: () => (shown.forEach((it) => selected.add(it.uid)), draw()) }, `Select all ${shown.length} shown`) : "");
    sellAllSlot.replaceChildren(sellable.length ? h("button", { class: "btn btn-sm", onclick: () => void sellItems(sellable, "every unlocked item") }, `Sell all unlocked · ${money(sellableTotal)}`) : "");

    grid.replaceChildren(
      !all.length
        ? h("p", { class: "empty" }, "Nothing here yet. ", h("a", { href: "#/" }, "Open a case"), ".")
        : !shown.length
          ? h("p", { class: "empty" }, "No items match.")
          : h("div", { class: "item-grid inv" }, ...shown.map(card)),
    );
  };

  const card = (it: OwnedItem) => {
    const on = selected.has(it.uid);
    const el = dropCard(it, {
      extra: h(
        "div",
        { class: "inv-card-btns" },
        h(
          "button",
          {
            class: `btn btn-sm inv-pick${on ? " on" : ""}`,
            title: on ? "Unselect" : "Select",
            "aria-pressed": String(on),
            onclick: (e: Event) => {
              e.stopPropagation();
              if (on) selected.delete(it.uid);
              else selected.add(it.uid);
              draw();
            },
          },
          on ? icon("check", 14) : h("span", { class: "inv-box" }),
        ),
        h(
          "button",
          {
            class: `btn btn-sm inv-lock${it.locked ? " on" : ""}`,
            title: it.locked ? "Locked: nothing can sell, upgrade, stake or trade it. Click to unlock." : "Lock it so nothing can sell, upgrade, stake or trade it",
            onclick: (e: Event) => {
              e.stopPropagation();
              void setLocked([it], !it.locked);
            },
          },
          icon("lock", 14),
        ),
        h(
          "button",
          {
            class: "btn btn-sm",
            disabled: !!it.locked,
            onclick: (e: Event) => {
              e.stopPropagation();
              void sellItems([it], "this item");
            },
          },
          "Sell",
        ),
      ),
    });
    el.classList.toggle("inv-selected", on);
    el.classList.toggle("inv-locked", !!it.locked);
    return el;
  };

  draw();
  onPricesForPage(draw);
  // Redraw when the items change (not on every balance update).
  let seen = "";
  const sig = () => getState().inventory.map((it) => `${it.uid}${it.locked ? "L" : ""}`).join();
  seen = sig();
  onLeave(
    subscribe(() => {
      if (sig() === seen) return;
      seen = sig();
      draw();
    }),
  );
  return h(
    "section",
    { class: "page" },
    h("h1", null, "Inventory"),
    head,
    h("div", { class: "toolbar inv-toolbar" }, search, tierSelect, chips),
    h(
      "div",
      { class: "inv-actions" },
      pickedBar,
      h(
        "div",
        { class: "inv-bar" },
        selectAllSlot,
        h("span", { class: "inv-under-wrap" }, "Sell everything under $", under, h("button", { class: "btn btn-sm", onclick: sellUnder }, "Sell")),
        sellAllSlot,
      ),
    ),
    grid,
  );
}

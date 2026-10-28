import { getItem, imageOf } from "../catalog";
import { serverNow } from "../live";
import { InsufficientFunds, marketAction, ServerError, type MarketSlot } from "../state";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { displayName } from "./item-card";
import { onLeave } from "./page";
import { playReveal } from "./sound";

// The marketplace: your own shop of eight listings (three cheap skins, a sticker, two mid,
// two $1,000+) that changes every five minutes. Some listings are deals.

const left = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function marketPage() {
  const grid = h("div", { class: "item-grid mk-grid" });
  const clock = h("b", { class: "mk-clock" });
  let refreshAt = 0;
  let busy = false;

  const card = (o: MarketSlot | null) => {
    if (!o) return h("div", { class: "mk-card empty" }, "Nothing here this time");
    const item = getItem(o.itemId);
    const n = displayName(item, o);
    const deal = o.price < o.list;
    return h(
      "div",
      { class: `mk-card${o.sold ? " sold" : ""}${deal ? " deal" : ""}`, style: `--rarity:${item.color}` },
      deal ? h("span", { class: "mk-deal" }, `Deal -${Math.round((1 - o.price / o.list) * 100)}%`) : "",
      h("img", { src: imageOf(o), alt: "", loading: "lazy" }),
      h("div", { class: "mk-weapon" }, n.weapon),
      h("div", { class: "mk-finish" }, n.finish),
      h("div", { class: "mk-wear" }, [o.wear, o.stattrak ? "StatTrak" : ""].filter(Boolean).join(" · ")),
      h("div", { class: "mk-price" }, deal ? h("s", null, money(o.list)) : "", h("b", null, money(o.price))),
      o.sold
        ? h("div", { class: "mk-sold" }, icon("check", 14), " Bought")
        : h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              disabled: busy,
              onclick: async () => {
                if (busy) return;
                busy = true;
                try {
                  await marketAction("buy", { slot: o.slot });
                  playReveal(item.tier);
                  toast(`Bought ${n.weapon} | ${n.finish} for ${money(o.price)}`);
                } catch (e) {
                  if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
                  else if (e instanceof ServerError) toast(e.message, "error");
                  else throw e;
                } finally {
                  busy = false;
                  void load();
                }
              },
            },
            "Buy",
          ),
    );
  };

  const load = async () => {
    try {
      const r = await marketAction("view");
      refreshAt = r.refreshAt;
      grid.replaceChildren(...r.slots.map(card));
    } catch (e) {
      if (e instanceof ServerError) grid.replaceChildren(h("p", { class: "empty" }, e.message));
      else throw e;
    }
  };
  // The clock, and a fresh shop when it runs out.
  const timer = setInterval(() => {
    clock.textContent = refreshAt ? left(refreshAt - serverNow()) : "";
    if (refreshAt && serverNow() >= refreshAt + 500) {
      refreshAt = 0;
      void load();
    }
  }, 500);
  onLeave(() => clearInterval(timer));
  grid.append(h("p", { class: "empty" }, "Loading..."));
  void load();

  return h(
    "section",
    { class: "page" },
    h("div", { class: "ach-top" }, h("h1", null, "Marketplace"), h("span", { class: "hint" }, "New skins in ", clock)),
    h("p", { class: "hint" }, "Your own shop: eight listings, new ones every 5 minutes, two of them $1,000+. Deals take part of the 10% market fee off."),
    grid,
  );
}

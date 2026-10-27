import { getItem, imageOf, priceOf, round2 } from "../catalog";
import { friendLists, loadFriends, onFriends } from "../friends";
import { onPricesForPage } from "../live";
import { WEAR_NAME } from "../odds";
import { getState, InsufficientFunds, ServerError, subscribe, tradeAction } from "../state";
import { loadTrades, onTrades, setTrades, tradeLists, type Trade, type TradeItem, type TradeLists } from "../trades";
import { decimalInput, h, money, parseDecimal, toast } from "./dom";
import { icon } from "./icons";
import { displayName } from "./item-card";
import { onLeave } from "./page";
import { userLink } from "./profile-card";

// Trading with friends: pick items (and cash) from both inventories and send an offer.
// Nothing is held while it's open; the server checks everything again on accept.

const MAX_ITEMS = 20;

const value = (items: TradeItem[]) => round2(items.reduce((s, it) => s + (it.missing ? 0 : priceOf(it)), 0));

function itemTile(it: TradeItem, opts: { selected?: boolean; onClick?: () => void } = {}) {
  if (it.missing) return h("div", { class: "trade-item missing" }, h("span", null, "Item no longer exists"));
  const item = getItem(it.itemId);
  const n = displayName(item, it);
  return h(
    opts.onClick ? "button" : "div",
    {
      class: `trade-item${opts.selected ? " selected" : ""}`,
      style: `--rarity:${item.color}`,
      title: `${n.weapon} | ${n.finish}${it.wear ? ` (${WEAR_NAME[it.wear]})` : ""}`,
      ...(opts.onClick ? { type: "button", onclick: opts.onClick } : {}),
    },
    h("img", { src: imageOf(it), alt: "", loading: "lazy" }),
    h("span", { class: "trade-item-name" }, n.weapon),
    h("span", { class: "trade-item-finish" }, `${n.finish}${it.wear ? ` · ${it.wear}` : ""}`),
    h("b", null, money(priceOf(it))),
  );
}

/** @param withUser a friend to start an offer with (#/trade?with=...) */
export function tradePage(withUser: string | null = null) {
  let tab: "offers" | "new" | "history" = withUser ? "new" : tradeLists().open.some((t) => t.incoming) ? "offers" : "new";
  const body = h("div", { class: "trade-body" });
  const tabsEl = h("div", { class: "tabs trade-tabs" });

  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
      return null;
    }
  };

  // ---------- offers ----------
  const offerCard = (t: Trade) => {
    const me = getState().username;
    // From my point of view: what I give and what I get.
    const iGive = t.from === me ? t.give : t.get;
    const iGet = t.from === me ? t.get : t.give;
    const cashGive = t.from === me ? t.giveCash : t.getCash;
    const cashGet = t.from === me ? t.getCash : t.giveCash;
    const other = t.from === me ? (t.toName ?? t.to) : (t.fromName ?? t.from);
    const otherUser = t.from === me ? t.to : t.from;
    const side = (title: string, items: TradeItem[], cash: number) =>
      h(
        "div",
        { class: "trade-side" },
        h("div", { class: "trade-side-head" }, h("b", null, title), h("span", null, money(round2(value(items) + cash)))),
        h("div", { class: "trade-items" }, ...items.map((it) => itemTile(it)), ...(cash ? [h("div", { class: "trade-cash" }, icon("coins", 14), money(cash))] : [])),
        ...(items.length || cash ? [] : [h("p", { class: "fb-empty" }, "Nothing")]),
      );
    const status: Record<Trade["status"], string> = {
      open: t.incoming ? `${other} sent you an offer` : `Waiting for ${other}`,
      accepted: "Accepted",
      declined: t.incoming ? "You declined" : `${other} declined`,
      cancelled: t.incoming ? `${other} cancelled it` : "You cancelled it",
      failed: "Failed: something in it was gone",
    };
    const actions =
      t.status !== "open"
        ? []
        : t.incoming
          ? [
              h("button", { class: "btn btn-primary btn-sm", onclick: () => void run(() => tradeAction<TradeLists>("accept", { id: t.id }).then(setTrades), "Trade accepted") }, "Accept"),
              h("button", { class: "btn btn-ghost btn-sm", onclick: () => void run(() => tradeAction<TradeLists>("decline", { id: t.id }).then(setTrades)) }, "Decline"),
            ]
          : [h("button", { class: "btn btn-ghost btn-sm", onclick: () => void run(() => tradeAction<TradeLists>("cancel", { id: t.id }).then(setTrades)) }, "Cancel offer")];
    return h(
      "div",
      { class: `trade-card ${t.status}${t.incoming && t.status === "open" ? " incoming" : ""}` },
      h(
        "div",
        { class: "trade-card-head" },
        icon("trade", 16),
        h("b", null, "With ", userLink(otherUser, other)),
        h("span", { class: "trade-status" }, status[t.status]),
        h("span", { class: "trade-when" }, new Date(t.status === "open" ? t.createdAt : t.updatedAt).toLocaleString()),
      ),
      h("div", { class: "trade-sides" }, side("You give", iGive, cashGive), h("div", { class: "trade-arrow" }, icon("trade", 20)), side("You get", iGet, cashGet)),
      ...(actions.length ? [h("div", { class: "trade-actions" }, ...actions)] : []),
    );
  };

  // ---------- new offer ----------
  let partner = "";
  let theirs: TradeItem[] = [];
  const give = new Set<string>();
  const get = new Set<string>();
  let giveCash = 0;
  let getCash = 0;
  let loadingPartner = false;

  const pickPartner = async (name: string) => {
    partner = name;
    give.clear();
    get.clear();
    theirs = [];
    if (!name) return draw();
    loadingPartner = true;
    draw();
    const r = await run(() => tradeAction<{ user: string; items: TradeItem[] }>("inventory", { username: name }));
    loadingPartner = false;
    if (r && partner === name) theirs = r.items;
    draw();
  };

  const toggle = (set: Set<string>, uid: string) => {
    if (set.has(uid)) set.delete(uid);
    else if (set.size >= MAX_ITEMS) return toast(`Up to ${MAX_ITEMS} items on each side`, "error");
    else set.add(uid);
    draw();
  };

  const cashInput = (v: number, onChange: (n: number) => void) => {
    const el = decimalInput({ class: "bet-field", placeholder: "0.00", value: v ? v.toFixed(2) : "" });
    el.addEventListener("change", () => {
      onChange(Math.max(0, Math.round((parseDecimal(el.value) || 0) * 100) / 100));
      draw();
    });
    return h("div", { class: "bet-row trade-cash-input" }, h("span", { class: "bet-cur" }, icon("coins", 14)), el);
  };

  const send = async () => {
    const r = await run(
      () => tradeAction<TradeLists>("offer", { username: partner, give: [...give], get: [...get], giveCash, getCash }),
      `Offer sent to ${partner}`,
    );
    if (!r) return;
    setTrades(r);
    give.clear();
    get.clear();
    giveCash = getCash = 0;
    tab = "offers";
    draw();
  };

  const drawNew = () => {
    const friends = friendLists().friends;
    if (!friends.length) {
      return [h("p", { class: "empty" }, "You can trade with friends. ", h("a", { href: "#/friends" }, "Add a friend"), " first.")];
    }
    const select = h(
      "select",
      { class: "search trade-partner", onchange: (e: Event) => void pickPartner((e.target as HTMLSelectElement).value) },
      h("option", { value: "" }, "Choose a friend"),
      ...friends.map((f) => h("option", { value: f.user, selected: f.user.toLowerCase() === partner.toLowerCase() }, `${f.name}${f.name !== f.user ? ` (@${f.user})` : ""}${f.online ? ", online" : ""}`)),
    );
    if (!partner) return [select];
    const mine = getState().inventory;
    const giveItems = mine.filter((it) => give.has(it.uid));
    const getItems = theirs.filter((it) => get.has(it.uid));
    const giveTotal = round2(value(giveItems) + giveCash);
    const getTotal = round2(value(getItems) + getCash);
    const pane = (title: string, items: TradeItem[], picked: Set<string>, cash: number, setCash: (n: number) => void, total: number) =>
      h(
        "div",
        { class: "trade-pane" },
        h("div", { class: "trade-side-head" }, h("b", null, title), h("span", null, `${picked.size} item${picked.size === 1 ? "" : "s"}${cash ? ` + ${money(cash)}` : ""} · ${money(total)}`)),
        h("label", { class: "field-label" }, "Cash"),
        cashInput(cash, setCash),
        h(
          "div",
          { class: "trade-grid" },
          ...(items.length
            ? [...items].sort((a, b) => priceOf(b) - priceOf(a)).map((it) => itemTile(it, { selected: picked.has(it.uid), onClick: () => toggle(picked, it.uid) }))
            : [h("p", { class: "fb-empty" }, loadingPartner ? "Loading..." : "No items")]),
        ),
      );
    return [
      select,
      h(
        "div",
        { class: "trade-summary" },
        h("span", null, "You give ", h("b", null, money(giveTotal))),
        h("span", null, "You get ", h("b", { class: getTotal >= giveTotal ? "up" : "down" }, money(getTotal))),
        h("button", { class: "btn btn-primary", disabled: !giveItems.length && !getItems.length, onclick: () => void send() }, `Send offer to ${partner}`),
      ),
      h(
        "div",
        { class: "trade-panes" },
        pane("Your items (you give)", mine, give, giveCash, (n) => (giveCash = n), giveTotal),
        pane(`${partner}'s items (you get)`, theirs, get, getCash, (n) => (getCash = n), getTotal),
      ),
    ];
  };

  const draw = () => {
    const l = tradeLists();
    const incoming = l.open.filter((t) => t.incoming).length;
    const tabBtn = (id: typeof tab, label: string, badge = 0) =>
      h("button", { class: `tab${tab === id ? " active" : ""}`, onclick: () => ((tab = id), draw()) }, label, ...(badge ? [h("span", { class: "badge ping" }, String(badge))] : []));
    tabsEl.replaceChildren(tabBtn("offers", "Offers", incoming), tabBtn("new", "New offer"), tabBtn("history", "History"));
    if (tab === "offers") body.replaceChildren(...(l.open.length ? l.open.map(offerCard) : [h("p", { class: "empty" }, "No open offers.")]));
    else if (tab === "history") body.replaceChildren(...(l.history.length ? l.history.map(offerCard) : [h("p", { class: "empty" }, "No finished trades yet.")]));
    else body.replaceChildren(...drawNew());
  };

  onLeave(onTrades(draw));
  onLeave(onFriends(() => tab === "new" && draw()));
  onLeave(subscribe(() => tab !== "new" && draw()));
  onPricesForPage(draw);
  void loadTrades();
  void loadFriends();
  draw();
  if (withUser) void pickPartner(withUser);

  return h("section", { class: "page" }, h("h1", null, "Trade"), h("p", { class: "hint" }, "Swap items and cash with friends. Nothing changes hands until they accept."), tabsEl, body);
}

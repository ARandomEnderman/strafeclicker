import { onServerEvent, serverNow } from "./live";
import { setCaseSale } from "./catalog";
import { setClickBoost } from "./state";
import { h, toast } from "./ui/dom";
import { icon } from "./ui/icons";
import { openModal } from "./ui/modal";
import { playReveal } from "./ui/sound";

// Site-wide notices from the admin: an announcement, maintenance mode, and running events
// (each with a countdown).

export interface SiteEvent {
  type: "cashback" | "clickBoost" | "missionBoost" | "luckyHour" | "caseSale" | "marketSale" | "sellBonus" | "rainStorm";
  value: number;
  endsAt: number;
}
export interface SiteState {
  maintenance: boolean;
  announcement: string | null;
  events: SiteEvent[];
}

let state: SiteState = { maintenance: false, announcement: null, events: [] };
const banner = h("div", { class: "site-banner", hidden: true });

export const siteState = () => state;
export const activeEvent = (type: SiteEvent["type"]) => state.events.find((e) => e.type === type && e.endsAt > serverNow()) ?? null;

/** The banner shown at the top of every page. */
export function siteBanner() {
  return banner;
}

const EVENT_TEXT: Record<SiteEvent["type"], (v: number) => string> = {
  cashback: (v) => `Cashback event: ${v}% of every losing bet comes back`,
  clickBoost: (v) => `Click frenzy: the clicker pays ${v}x`,
  missionBoost: (v) => `Mission bonus: daily mission rewards are ${v}x`,
  luckyHour: (v) => `Lucky hour: every win pays ${v}% more profit`,
  caseSale: (v) => `Case sale: ${v}% off every case`,
  marketSale: (v) => `Market sale: ${v}% off the marketplace`,
  sellBonus: (v) => `Sell bonus: selling items pays ${v}% more`,
  rainStorm: (v) => `Rain storm: the house rains $${v} on everyone online every 5 minutes`,
};
const EVENT_SHORT: Record<SiteEvent["type"], (v: number) => string> = {
  cashback: (v) => `${v}% cashback`,
  clickBoost: (v) => `${v}x clicker`,
  missionBoost: (v) => `${v}x missions`,
  luckyHour: (v) => `Lucky hour +${v}%`,
  caseSale: (v) => `Cases -${v}%`,
  marketSale: (v) => `Market -${v}%`,
  sellBonus: (v) => `Selling +${v}%`,
  rainStorm: (v) => `$${v} rain storm`,
};
const left = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}:${String(s % 60).padStart(2, "0")} left`;
};

const timers: HTMLElement[] = [];
function draw() {
  const parts: HTMLElement[] = [];
  timers.length = 0;
  if (state.maintenance) parts.push(h("div", { class: "site-note maint" }, icon("admin", 16), h("span", null, "Paused for maintenance: no new bets or openings for now. Cash-outs, selling and trading still work.")));
  if (state.announcement) parts.push(h("div", { class: "site-note" }, icon("announce", 16), h("span", null, state.announcement)));
  const live = state.events.filter((e) => e.endsAt > serverNow());
  const timer = (e: SiteEvent) => {
    const t = h("b", { class: "site-event-left", "data-ends": String(e.endsAt) }, left(e.endsAt - serverNow()));
    timers.push(t);
    return t;
  };
  // One event gets the full sentence; several share one row of chips.
  if (live.length === 1) parts.push(h("div", { class: "site-note event" }, icon("gift", 16), h("span", null, EVENT_TEXT[live[0].type](live[0].value)), timer(live[0])));
  else if (live.length)
    parts.push(
      h(
        "div",
        { class: "site-note event multi" },
        icon("gift", 16),
        ...live.map((e) => h("span", { class: "site-event-chip", title: EVENT_TEXT[e.type](e.value) }, EVENT_SHORT[e.type](e.value), timer(e))),
      ),
    );
  banner.replaceChildren(...parts);
  banner.hidden = !parts.length;
  setClickBoost(activeEvent("clickBoost")?.value ?? 1);
  setCaseSale(activeEvent("caseSale")?.value ?? 0);
}

// Countdowns, and dropping events that ran out.
setInterval(() => {
  if (state.events.some((e) => e.endsAt <= serverNow() && timers.some((t) => Number(t.dataset.ends) === e.endsAt))) return draw();
  for (const t of timers) t.textContent = left(Number(t.dataset.ends) - serverNow());
}, 1000);

onServerEvent<SiteState>("site", (s) => {
  state = { ...s, events: s.events ?? [] };
  draw();
});
// The server says which build it serves, on every (re)connect. A different one than this
// page was loaded with means the site was updated: reload to get it (spread over a few
// seconds so the server isn't hit by everyone at once).
let build: string | null = null;
onServerEvent<{ build: string }>("build", (b) => {
  if (build == null) build = b.build;
  else if (b.build !== build) {
    build = b.build;
    toast("Updating to the latest version...", "info", 5000);
    setTimeout(() => location.reload(), 1000 + Math.random() * 3000);
  }
});

// The admin's pop-up announcement: a dialog on every open page.
onServerEvent<{ title: string; text: string }>("popup", (p) => {
  let close = () => {};
  close = openModal(
    p.title,
    h(
      "div",
      { class: "popup-body admin-popup" },
      h("div", { class: "admin-popup-icon" }, icon("announce", 26)),
      h("p", { class: "admin-popup-text" }, p.text),
      h("button", { class: "btn btn-primary", onclick: () => close() }, "Got it"),
    ),
  );
  playReveal("covert");
});

// One-off messages for this player (an event's free case, say).
onServerEvent<{ text: string }>("notice", (n) => toast(n.text, "achievement", 5000));

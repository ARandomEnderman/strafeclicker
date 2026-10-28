import { onServerEvent, serverNow } from "./live";
import { setClickBoost } from "./state";
import { h, toast } from "./ui/dom";
import { icon } from "./ui/icons";

// Site-wide notices from the admin: an announcement, maintenance mode, and running events
// (each with a countdown).

export interface SiteEvent {
  type: "cashback" | "clickBoost" | "missionBoost";
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
  for (const e of state.events) {
    if (e.endsAt <= serverNow()) continue;
    const t = h("b", { class: "site-event-left", "data-ends": String(e.endsAt) }, left(e.endsAt - serverNow()));
    timers.push(t);
    parts.push(h("div", { class: "site-note event" }, icon("gift", 16), h("span", null, EVENT_TEXT[e.type](e.value)), t));
  }
  banner.replaceChildren(...parts);
  banner.hidden = !parts.length;
  setClickBoost(activeEvent("clickBoost")?.value ?? 1);
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
// The admin asked every open page to reload (to pick up a new version after an update).
// Spread over a few seconds so the server isn't hit by everyone at once.
onServerEvent("reload", () => {
  toast("Updating StrafeClicker...", "info", 4000);
  setTimeout(() => location.reload(), 500 + Math.random() * 2500);
});

// One-off messages for this player (an event's free case, say).
onServerEvent<{ text: string }>("notice", (n) => toast(n.text, "achievement", 5000));

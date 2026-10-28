import { getCase } from "../catalog";
import { onServerEvent } from "../live";
import { hideItems } from "../state";
import type { OwnedItem } from "../types";
import { reelPopup } from "./case-page";
import { h } from "./dom";
import { icon, type IconName } from "./icons";
import { playReveal } from "./sound";

// What admin events look like on everyone's screen: a splash when a timed event starts
// (a flash, a burst of sparks, the event's name), and for a case drop the case-opening
// reel in a popup, landing on what you got.

const EVENTS: Record<string, { title: string; icon: IconName; text: (v: number, min: number) => string; color: string }> = {
  cashback: { title: "Cashback event", icon: "coins", color: "#3ecf8e", text: (v, m) => `${v}% of every losing bet comes back for ${m} minutes` },
  clickBoost: { title: "Click frenzy", icon: "clicker", color: "#f5a524", text: (v, m) => `The clicker pays ${v}x for ${m} minutes` },
  missionBoost: { title: "Mission bonus", icon: "missions", color: "#a66ae0", text: (v, m) => `Daily mission rewards are ${v}x for ${m} minutes` },
};

/** A full-screen splash: flash, ring, sparks flying out, a big title. */
export function eventSplash(title: string, text: string, color: string, iconName: IconName) {
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const layer = h("div", { class: "ev-splash", style: `--c:${color}`, "aria-hidden": "true" });
  layer.append(h("div", { class: "ev-flash" }), h("div", { class: "ev-ring" }), h("div", { class: "ev-ring two" }));
  for (let i = 0; i < (calm ? 12 : 70); i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 160 + Math.random() * 520;
    const s = h("i", { class: "ev-spark" });
    s.style.cssText = `--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;--t:${(0.9 + Math.random() * 0.9).toFixed(2)}s;--d:${(Math.random() * 0.25).toFixed(2)}s;--s:${(0.6 + Math.random()).toFixed(2)}`;
    layer.append(s);
  }
  layer.append(h("div", { class: "ev-card" }, h("div", { class: "ev-icon" }, icon(iconName, 34)), h("b", null, title), h("span", null, text)));
  document.body.append(layer);
  playReveal("gold");
  setTimeout(() => layer.remove(), 3600);
}

onServerEvent<{ type: string; value: number; minutes: number }>("eventfx", (e) => {
  const ev = EVENTS[e.type];
  if (ev) eventSplash(ev.title, ev.text(e.value, e.minutes), ev.color, ev.icon);
});

// Case drop: the item is already yours; hide it until the reel lands on it.
onServerEvent<{ caseId: string; item: OwnedItem }>("casedrop", (d) => {
  const c = getCase(d.caseId);
  if (!c) return;
  const reveal = hideItems([d.item.uid]);
  const safety = setTimeout(reveal, 12_000);
  void reelPopup(c, d.item, "Case drop!").finally(() => {
    clearTimeout(safety);
    reveal();
  });
});

import { RAIN_LEVELS } from "../../shared/game.js";
import type { ChatMessage } from "../chat";
import { h, money } from "./dom";
import { playRain } from "./sound";

// What a /rain does to everyone's screen. The level is log10 of the amount (0 for
// $1–9 ... 5 for $100,000+), and each level adds more:
//   0 Drizzle       a few coins fall
//   1 Shower        more coins and some bills, a banner
//   2 Downpour      rain streaks, a green glow round the edges
//   3 Storm         a lightning flash and thunder
//   4 Thunderstorm  repeated lightning, the screen shakes
//   5 Monsoon       a gold storm, a huge banner, the works

const PIECES = [16, 36, 70, 120, 180, 260];
const STREAKS = [0, 0, 40, 70, 110, 160];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export function rainFx(m: ChatMessage) {
  const level = Math.max(0, Math.min(5, m.level ?? 0));
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const layer = h("div", { class: `rain-fx lv${level}`, "aria-hidden": "true" });
  const spread = 1.2 + level * 0.5; // seconds over which pieces start falling
  const n = Math.round(PIECES[level] * (calm ? 0.25 : 1));
  for (let i = 0; i < n; i++) {
    const kind = level >= 5 && Math.random() < 0.25 ? "gem" : level >= 1 && Math.random() < 0.4 ? "bill" : "coin";
    const piece = h("i", { class: `rf-${kind}` }, kind === "gem" ? "" : "$");
    piece.style.cssText = `--x:${rand(0, 100)}vw;--d:${rand(0, spread)}s;--t:${rand(1.6, 3)}s;--r:${rand(-540, 540)}deg;--s:${rand(0.7, 1.3)};--sway:${rand(-8, 8)}vw`;
    layer.append(piece);
  }
  for (let i = 0; i < STREAKS[level] * (calm ? 0.25 : 1); i++) {
    const s = h("i", { class: "rf-streak" });
    s.style.cssText = `--x:${rand(-10, 110)}vw;--d:${rand(0, spread + 1)}s;--t:${rand(0.45, 0.8)}s`;
    layer.append(s);
  }
  if (level >= 1) {
    layer.append(
      h(
        "div",
        { class: "rf-banner" },
        h("b", null, RAIN_LEVELS[level]),
        h("span", null, `${money(m.amount ?? 0)} from ${m.name ?? m.user}`),
        m.yours ? h("em", null, `+${money(m.yours)} for you`) : "",
      ),
    );
  }
  if (level >= 3 && !calm) {
    // One flash for a storm, more as it gets bigger.
    for (let i = 0; i < level - 2; i++) {
      const f = h("div", { class: "rf-flash" });
      f.style.animationDelay = `${0.3 + i * rand(0.7, 1.1)}s`;
      layer.append(f);
    }
  }
  if (level >= 4 && !calm) {
    document.body.classList.add("rain-shake");
    setTimeout(() => document.body.classList.remove("rain-shake"), 1200 + level * 300);
  }
  document.body.append(layer);
  playRain(level);
  setTimeout(() => layer.remove(), (spread + 3.5) * 1000);
}

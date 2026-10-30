import { RAIN_LEVELS } from "../../shared/game.js";
import type { ChatMessage } from "../chat";
import { h, money } from "./dom";
import { playRain } from "./sound";

// What a /rain does to everyone's screen. The level is log10 of the amount (0 for
// $1–9 ... 5 for $100,000+), and each level adds more:
//   0 Drizzle       a few spinning coins fall, some land in a pile
//   1 Shower        more coins and some bills, a banner counting up the amount
//   2 Downpour      a storm cloud they pour from, rain streaks, a green glow round the edges
//   3 Storm         lightning bolts with a flash and thunder
//   4 Thunderstorm  more bolts, the screen shakes
//   5 Monsoon       a gold storm, gold rays behind a huge banner, gems
//   6 Hurricane     the wind blows everything sideways
//   7 Typhoon       a vortex spins in the middle of the screen
//   8 Tsunami       a wave of money washes up the screen
//   9 Cataclysm     a red sky, red lightning, falling gold bars, a harder shake
//  10 Apocalypse    all of it, cycling through every colour
// Each level keeps everything below it. Your share flies from the banner into your balance.

/**
 * Coins and bills that fall: 40 × log10(amount + 1), so every extra zero adds 40
 * ($1: 12, $100: 80, $10,000: 160, $1M: 240), at least 10 and at most 400.
 */
const piecesFor = (usd: number) => Math.min(400, Math.max(10, Math.round(40 * Math.log10(usd + 1))));
const STREAKS = [0, 0, 40, 70, 110, 160, 200, 230, 260, 280, 300];
/** Share of the pieces that land and pile up at the bottom instead of falling past it. */
const LAND = 0.3;
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** "ge2 ge3 ..." up to the level, so each level's styles build on the ones below. */
export const rainClasses = (level: number) =>
  Array.from({ length: Math.max(0, level - 1) }, (_, i) => `ge${i + 2}`).join(" ");

/** A jagged lightning bolt from the top of the screen, as an SVG path in vw/vh units. */
function bolt() {
  let x = rand(10, 90);
  let y = 0;
  const pts = [`${x},${y}`];
  const end = rand(45, 85);
  while (y < end) {
    y += rand(4, 9);
    x += rand(-5, 5);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "rf-bolt");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", pts.join(" "));
  svg.append(line);
  return svg;
}

/** Count the banner's amount up from zero. */
function countUp(el: HTMLElement, to: number, ms: number) {
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / ms);
    el.textContent = money(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** A few coins arc from `from` into the balance in the top bar, which then pulses. */
function payInto(from: HTMLElement, layer: HTMLElement, delayMs: number) {
  const target = document.querySelector<HTMLElement>(".balance-amount");
  if (!target) return;
  setTimeout(() => {
    const a = from.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const sx = a.left + a.width / 2;
    const sy = a.top + a.height / 2;
    const ex = b.left + b.width / 2;
    const ey = b.top + b.height / 2;
    for (let i = 0; i < 14; i++) {
      const c = h("i", { class: "rf-pay" }, h("span", { class: "rf-coin" }, "$"));
      layer.append(c);
      const lift = rand(60, 160);
      const mx = (sx + ex) / 2 + rand(-120, 120);
      const my = Math.min(sy, ey) - lift;
      c.animate(
        [
          { transform: `translate(${sx}px, ${sy}px) scale(0.6)`, opacity: 0 },
          { transform: `translate(${mx}px, ${my}px) scale(1.1)`, opacity: 1, offset: 0.45 },
          { transform: `translate(${ex}px, ${ey}px) scale(0.5)`, opacity: 0.9 },
        ],
        { duration: rand(750, 1000), delay: i * 45, easing: "cubic-bezier(0.5, 0, 0.6, 1)", fill: "both" },
      );
    }
    setTimeout(() => {
      target.classList.remove("rf-got");
      void target.offsetWidth;
      target.classList.add("rf-got");
    }, 800);
  }, delayMs);
}

export function rainFx(m: ChatMessage) {
  const level = Math.max(0, Math.min(RAIN_LEVELS.length - 1, m.level ?? 0));
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const layer = h("div", { class: `rain-fx lv${level} ${rainClasses(level)}`, "aria-hidden": "true" });
  const spread = 1.2 + Math.min(level, 7) * 0.5; // seconds over which pieces start falling
  const wind = level >= 6 ? 35 : 8; // vw of sideways drift
  const top = level >= 2 ? 8 : -6; // vh: from under the cloud once there is one
  const n = Math.round(piecesFor(m.amount ?? 0) * (calm ? 0.25 : 1));

  if (level >= 2) layer.append(h("div", { class: "rf-cloud" }));
  if (level >= 5 && !calm) layer.append(h("div", { class: "rf-rays" }));
  if (level >= 7 && !calm) layer.append(h("div", { class: "rf-vortex" }));
  if (level >= 8 && !calm) layer.append(h("div", { class: "rf-wave" }));

  for (let i = 0; i < n; i++) {
    const roll = Math.random();
    const kind = level >= 9 && roll < 0.15 ? "bar" : level >= 5 && roll < 0.35 ? "gem" : level >= 1 && Math.random() < 0.4 ? "bill" : "coin";
    const lands = !calm && kind !== "bill" && Math.random() < LAND;
    const x = rand(0, 100);
    const sway = level >= 6 ? rand(wind * 0.4, wind) : rand(-wind, wind); // a hurricane blows one way
    const d = rand(0, spread);
    const t = rand(1.6, 3);
    const flip = rand(0.5, 1.1);
    const rest = rand(10, 40); // px above the bottom edge where a landing piece settles
    // The piece falls; its face (coin/bill/gem) flips on its own while it does.
    const face = h("span", { class: `rf-${kind}` }, kind === "gem" || kind === "bar" ? "" : "$");
    const piece = h("i", { class: `rf-piece${lands ? " lands" : ""}` }, face);
    piece.style.cssText = [
      `--x:${x}vw`,
      `--y0:${top}vh`,
      `--d:${d}s`,
      `--t:${t}s`,
      `--r:${rand(-540, 540)}deg`,
      `--s:${rand(0.7, 1.3)}`,
      `--sway:${sway}vw`,
      `--floor:calc(${100 - top}vh - ${rest + 30}px)`,
      `--flip:${flip}s`,
      `--flips:${Math.max(1, Math.round(t / flip))}`,
      `--gone:${(spread + 3 - 0.5).toFixed(2)}s`,
    ].join(";");
    layer.append(piece);
    if (lands && level >= 1) {
      // A ring of sparkle where it lands.
      const splash = h("i", { class: "rf-splash" });
      splash.style.cssText = `left:${x + sway}vw;bottom:${rest}px;animation-delay:${(d + t * 0.86).toFixed(2)}s`;
      layer.append(splash);
    }
  }
  for (let i = 0; i < STREAKS[level] * (calm ? 0.25 : 1); i++) {
    const s = h("i", { class: "rf-streak" });
    s.style.cssText = `--x:${rand(-10, 110)}vw;--d:${rand(0, spread + 1)}s;--t:${rand(0.45, 0.8)}s`;
    layer.append(s);
  }

  let banner: HTMLElement | null = null;
  if (level >= 1) {
    const amount = h("span", { class: "rf-amount" }, money(0));
    banner = h(
      "div",
      { class: "rf-banner" },
      h("b", null, RAIN_LEVELS[level]),
      h("span", null, amount, ` from ${m.name ?? m.user}`),
      m.yours ? h("em", null, `+${money(m.yours)} for you`) : "",
    );
    layer.append(banner);
    if (calm) amount.textContent = money(m.amount ?? 0);
    else countUp(amount, m.amount ?? 0, 900 + level * 150);
  }
  if (level >= 3 && !calm) {
    // A bolt and a flash for a storm, more as it gets bigger.
    for (let i = 0; i < Math.min(12, (level - 2) * 2); i++) {
      const at = 0.3 + i * rand(0.45, 0.8);
      const b = bolt();
      b.style.animationDelay = `${at}s`;
      layer.append(b);
      if (i % 2 === 0) {
        const f = h("div", { class: "rf-flash" });
        f.style.animationDelay = `${at}s`;
        layer.append(f);
      }
    }
  }
  if (level >= 4 && !calm) {
    const shake = level >= 9 ? "rain-shake-hard" : "rain-shake";
    document.body.classList.add(shake);
    setTimeout(() => document.body.classList.remove(shake), 1200 + level * 300);
  }
  document.body.append(layer);
  if (m.yours && !calm) payInto(banner ?? layer, layer, 700);
  playRain(level);
  setTimeout(() => layer.remove(), (spread + 3.5) * 1000);
}

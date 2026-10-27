import { serverNow } from "../live";
import { DAILY_PRIZES, DAILY_SPIN_MS } from "../odds";
import { dailySpin, getState, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { playReveal, playTick } from "./sound";

// The free daily spin: a wheel of balance prizes, once every 24 hours.

const SVG = "http://www.w3.org/2000/svg";
const R = 150;
const N = DAILY_PRIZES.length;
const SEG = 360 / N;
const SPINS = 7;
const EASING = "cubic-bezier(0.12, 0.8, 0.2, 1)";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const fmt = (t: number) => {
  const s = Math.max(0, Math.ceil(t / 1000));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
};

export function spinPage() {
  // Equal-sized slices, cheapest to priciest around the wheel, coloured by prize.
  const wheel = svg("g", {});
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  DAILY_PRIZES.forEach((p, i) => {
    const a0 = i * SEG;
    const a1 = a0 + SEG;
    const [x0, y0] = [Math.cos(rad(a0)) * R, Math.sin(rad(a0)) * R];
    const [x1, y1] = [Math.cos(rad(a1)) * R, Math.sin(rad(a1)) * R];
    const hueVal = 210 - (i / (N - 1)) * 170;
    wheel.append(svg("path", { d: `M0 0 L${x0} ${y0} A${R} ${R} 0 0 1 ${x1} ${y1} Z`, fill: `hsl(${hueVal} 60% ${36 + i * 2}%)`, stroke: "#0d0f14", "stroke-width": 3 }));
    const mid = a0 + SEG / 2;
    const label = svg("text", {
      x: Math.cos(rad(mid)) * R * 0.68,
      y: Math.sin(rad(mid)) * R * 0.68,
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      transform: `rotate(${mid} ${Math.cos(rad(mid)) * R * 0.68} ${Math.sin(rad(mid)) * R * 0.68})`,
      class: "sp-label",
    });
    label.textContent = p.usd >= 1 ? `$${p.usd}` : `${p.usd * 100}¢`;
    wheel.append(label);
  });
  wheel.append(svg("circle", { cx: 0, cy: 0, r: 26, class: "sp-hub" }));
  const root = svg("svg", { viewBox: `${-R - 10} ${-R - 24} ${2 * R + 20} ${2 * R + 34}`, class: "jp-svg sp-svg" });
  root.append(wheel, svg("path", { d: `M-13 ${-R - 20} L13 ${-R - 20} L0 ${-R + 8} Z`, class: "jp-pointer" }));

  const status = h("div", { class: "sp-status" });
  const btn = h("button", { class: "btn btn-primary btn-lg sp-btn", onclick: () => void spin() }, "Spin");
  let spinning = false;
  let rotation = 0;
  let pendingReveal: (() => void) | null = null;

  const draw = () => {
    if (spinning) return;
    const left = getState().nextSpinAt - serverNow();
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? `Next spin in ${fmt(left)}` : "Spin";
    if (!status.dataset.result) status.textContent = left > 0 ? "Come back tomorrow for another free spin." : "Your free spin is ready.";
  };
  const timer = setInterval(draw, 1000);
  onLeave(() => clearInterval(timer));
  onLeave(subscribe(draw));

  const spin = async () => {
    if (spinning) return;
    spinning = true;
    btn.disabled = true;
    btn.textContent = "Spinning...";
    let r;
    try {
      r = await dailySpin();
    } catch (e) {
      spinning = false;
      draw();
      if (e instanceof ServerError) return toast(e.message, "error");
      throw e;
    }
    pendingReveal = r.reveal;
    // Land somewhere inside the prize's slice, under the pointer at the top.
    const inSlice = (0.15 + Math.random() * 0.7) * SEG;
    const target = rotation - (rotation % 360) + SPINS * 360 + (360 - (r.slot * SEG + inSlice));
    const anim = wheel.animate([{ transform: `rotate(${rotation}deg)` }, { transform: `rotate(${target}deg)` }], { duration: DAILY_SPIN_MS, easing: EASING, fill: "forwards" });
    let last = -1;
    const tick = () => {
      if (anim.playState !== "running") return;
      const deg = rotation + (anim.effect?.getComputedTiming().progress ?? 0) * (target - rotation);
      const seg = Math.floor(deg / SEG);
      if (seg !== last) {
        if (last >= 0) playTick();
        last = seg;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await anim.finished.catch(() => undefined);
    rotation = target;
    r.reveal();
    pendingReveal = null;
    playReveal(r.slot >= N - 2 ? "gold" : r.slot >= N / 2 ? "covert" : "restricted");
    status.dataset.result = "1";
    status.textContent = `You won ${money(r.prize)}!`;
    status.classList.add("won");
    spinning = false;
    draw();
  };
  // Leaving mid-spin still puts the prize in the balance.
  onLeave(() => pendingReveal?.());

  draw();
  return h(
    "section",
    { class: "page narrow game-page" },
    h("h1", null, "Daily spin"),
    h("p", { class: "hint" }, "One free spin every 24 hours. Whatever it lands on goes straight into your balance."),
    h("div", { class: "game-stage sp-stage" }, h("div", { class: "jp-wheel sp-wheel" }, root), status, btn),
  );
}

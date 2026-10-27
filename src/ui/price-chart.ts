import type { Drop, Item, WearKey } from "../types";
import { priceKey, priceOf } from "../catalog";
import { onPrices, serverNow } from "../live";
import { WEAR_NAME } from "../odds";
import { deltaLine, h, money } from "./dom";
import { displayName } from "./item-card";
import { openModal } from "./modal";

type Point = [t: number, usd: number];
type Variant = Pick<Drop, "phase" | "wear" | "stattrak">;
interface HistoryResponse {
  liveSince: number | null;
  series: Record<string, Point[]>;
}

const HOUR = 3_600_000;
const RANGES = [
  { key: "1h", label: "1H", ms: HOUR },
  { key: "24h", label: "24H", ms: 24 * HOUR },
  { key: "7d", label: "7D", ms: 7 * 24 * HOUR },
  { key: "30d", label: "30D", ms: 30 * 24 * HOUR },
  { key: "all", label: "All", ms: Infinity },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];
let range: RangeKey = "24h";

const SVG = "http://www.w3.org/2000/svg";
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Price-over-time for one item, with chips to switch wear / StatTrak / phase. */
export function openPriceChart(item: Item, initial?: Partial<Variant>) {
  let variant: Variant = {
    phase: initial?.phase ?? item.phases?.[0]?.name ?? null,
    wear: initial?.wear !== undefined ? initial.wear : item.wears.includes("FT") ? "FT" : (item.wears[0] ?? null),
    stattrak: initial?.stattrak ?? false,
  };
  let data: HistoryResponse | null = null;

  const controls = h("div", { class: "chart-controls" });
  const stats = h("div", { class: "case-stats" });
  const plot = h("div", { class: "chart-plot" });
  const note = h("p", { class: "hint chart-note" });
  const table = h("tbody");
  const body = h(
    "div",
    { class: "chart-body" },
    controls,
    stats,
    plot,
    note,
    h(
      "details",
      { class: "chart-table" },
      h("summary", null, "Data table"),
      h("table", null, h("thead", null, h("tr", null, h("th", null, "Time"), h("th", null, "Price"), h("th", null, "Change"))), table),
    ),
  );

  const load = async () => {
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(item.id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      plot.replaceChildren(h("p", { class: "empty" }, `Couldn't load price history: ${(err as Error).message}`));
      return;
    }
    draw();
  };

  const draw = () => {
    drawControls();
    if (!data) return;
    const key = priceKey({ itemId: item.id, ...variant });
    // The current price is always the right-hand end of the line.
    const series: Point[] = [...(data.series[key] ?? [])];
    const now = serverNow();
    const current = priceOf({ itemId: item.id, ...variant });
    if (!series.length || series[series.length - 1][1] !== current) series.push([now, current]);

    const ms = RANGES.find((r) => r.key === range)!.ms;
    const t0 = Number.isFinite(ms) ? now - ms : series[0][0];
    const visible = clip(series, t0, now);
    // Stats use live samples only: backfilled sale medians are a different metric
    // from the live listing price and would show a fake jump.
    const liveFrom = Math.max(t0, data.liveSince ?? -Infinity);
    const liveVals = clip(series, liveFrom, now).map((p) => p[1]);
    const vals = liveVals.length ? liveVals : visible.map((p) => p[1]);
    const changeLabel =
      liveFrom > t0 ? `Change since ${timeLabel(liveFrom, now - liveFrom)}` : `Change (${RANGES.find((r) => r.key === range)!.label})`;
    stats.replaceChildren(
      stat("Current", money(current)),
      h("div", { class: "stat" }, h("span", null, changeLabel), deltaLine(vals[0], current)),
      stat("High", money(Math.max(...vals))),
      stat("Low", money(Math.min(...vals))),
    );

    renderPlot(plot, visible, t0, now, data.liveSince);
    const backfilled = data.liveSince != null && visible.some(([t]) => t < data!.liveSince!);
    note.textContent = backfilled
      ? `Dashed: Skinport sale medians (90d / 30d / 7d / 24h) from before live tracking started on ${new Date(data.liveSince!).toLocaleString()}.`
      : "The server records the price every minute when it changes.";

    const rows = series.filter(([t]) => t >= t0).reverse().slice(0, 200);
    table.replaceChildren(
      ...rows.map(([t, v], i) => {
        const prev = rows[i + 1]?.[1];
        return h(
          "tr",
          null,
          h("td", null, new Date(t).toLocaleString()),
          h("td", null, money(v)),
          h("td", null, prev == null ? "" : deltaLine(prev, v, true)),
        );
      }),
    );
  };

  const chip = (label: string, active: boolean, onclick: () => void) =>
    h("button", { class: `chip${active ? " active" : ""}`, onclick: () => (onclick(), draw()) }, label);

  const drawControls = () => {
    const groups: Node[] = [];
    if (item.phases)
      groups.push(h("div", { class: "sort" }, ...item.phases.map((p) => chip(p.name, variant.phase === p.name, () => (variant = { ...variant, phase: p.name })))));
    if (item.wears.length)
      groups.push(
        h("div", { class: "sort" }, ...item.wears.map((w: WearKey) => chip(w, variant.wear === w, () => (variant = { ...variant, wear: w })))),
      );
    if (item.stattrak && item.kind !== "gloves")
      groups.push(chip("StatTrak™", variant.stattrak, () => (variant = { ...variant, stattrak: !variant.stattrak })));
    groups.push(h("div", { class: "sort range" }, ...RANGES.map((r) => chip(r.label, range === r.key, () => (range = r.key)))));
    controls.replaceChildren(...groups);
  };

  const n = displayName(item, variant);
  const title = `${n.weapon} | ${n.finish}${variant.wear ? ` (${WEAR_NAME[variant.wear]})` : ""}`;
  const unsubscribe = onPrices(() => load());
  // Redraw only on real width changes; redrawing can itself resize the box (scrollbars).
  let lastWidth = 0;
  const resize = new ResizeObserver(() => {
    if (!data || plot.clientWidth === lastWidth) return;
    lastWidth = plot.clientWidth;
    draw();
  });
  openModal(item.finish ? `${item.weapon} | ${item.finish}` : item.weapon, body, {
    wide: true,
    onClose: () => {
      unsubscribe();
      resize.disconnect();
    },
  });
  plot.setAttribute("aria-label", `Price history for ${title}`);
  resize.observe(plot);
  drawControls();
  load();
}

function stat(label: string, value: string) {
  return h("div", { class: "stat" }, h("span", null, label), h("b", null, value));
}

/** Points inside [t0, t1], starting with the price that was in effect at t0 and held to t1. */
function clip(series: Point[], t0: number, t1: number): Point[] {
  const before = series.filter(([t]) => t <= t0);
  const inside = series.filter(([t]) => t > t0 && t <= t1);
  const out: Point[] = before.length ? [[t0, before[before.length - 1][1]], ...inside] : inside;
  out.push([t1, out[out.length - 1][1]]);
  return out;
}

/** Round tick step: 1, 2, 2.5 or 5 × 10^k. */
function niceStep(span: number, count: number) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
}

function timeLabel(t: number, span: number) {
  const d = new Date(t);
  return span <= 36 * HOUR
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderPlot(host: HTMLElement, pts: Point[], t0: number, t1: number, liveSince: number | null) {
  const W = Math.max(280, host.clientWidth);
  const H = 260;
  const m = { l: 60, r: 16, t: 14, b: 28 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;

  const vals = pts.map((p) => p[1]);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 0.01) {
    const pad = Math.max(0.01, hi * 0.05);
    lo -= pad;
    hi += pad;
  }
  const step = niceStep(hi - lo, 4);
  lo = Math.max(0, Math.floor(lo / step) * step);
  hi = Math.ceil(hi / step) * step;
  const tStart = Math.min(t0, pts[0][0]);
  const x = (t: number) => m.l + ((t - tStart) / Math.max(1, t1 - tStart)) * iw;
  const y = (v: number) => m.t + ih - ((v - lo) / (hi - lo)) * ih;

  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "chart-svg", role: "img" });

  // Recessive grid + y ticks.
  for (let v = lo; v <= hi + step / 2; v += step) {
    svg.append(s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid" }));
    const label = s("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" });
    label.textContent = money(v);
    svg.append(label);
  }
  const span = t1 - tStart;
  for (let i = 0; i <= 4; i++) {
    const t = tStart + (span * i) / 4;
    const label = s("text", { x: x(t), y: H - 8, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle", class: "tick" });
    label.textContent = timeLabel(t, span);
    svg.append(label);
  }

  // Backfilled sale medians are straight dashed segments; live samples are a step line
  // (a price holds until the next change).
  const split = liveSince ?? -Infinity;
  const back = pts.filter(([t]) => t < split);
  const live = pts.filter(([t]) => t >= split);
  if (back.length && live.length) back.push(live[0]);
  let livePath = "";
  live.forEach(([t, v], i) => (livePath += i === 0 ? `M${x(t)},${y(v)}` : `H${x(t)}V${y(v)}`));
  const backPath = back.map(([t, v], i) => `${i ? "L" : "M"}${x(t)},${y(v)}`).join("");
  const fullPath = backPath + (livePath ? (backPath ? livePath.replace(/^M/, "L") : livePath) : "");

  svg.append(s("path", { d: `${fullPath}V${y(lo)}H${x(pts[0][0])}Z`, class: "area" }));
  if (backPath) svg.append(s("path", { d: backPath, class: "line dashed" }));
  if (livePath) svg.append(s("path", { d: livePath, class: "line" }));
  const [lt, lv] = pts[pts.length - 1];
  svg.append(s("circle", { cx: x(lt), cy: y(lv), r: 4, class: "end-dot" }));

  // Crosshair + tooltip: snap to the price in effect at the pointer's time.
  const cross = s("line", { y1: m.t, y2: m.t + ih, class: "crosshair", visibility: "hidden" });
  const dot = s("circle", { r: 4, class: "end-dot", visibility: "hidden" });
  const hit = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", tabindex: 0 });
  svg.append(cross, dot, hit);
  const tip = h("div", { class: "chart-tip", hidden: true });

  const show = (clientX: number) => {
    const box = svg.getBoundingClientRect();
    const px = Math.min(Math.max(((clientX - box.left) / box.width) * W, m.l), m.l + iw);
    const t = tStart + ((px - m.l) / iw) * Math.max(1, t1 - tStart);
    let v = pts[0][1];
    for (const p of pts) if (p[0] <= t) v = p[1];
    for (const el of [cross, dot]) el.setAttribute("visibility", "visible");
    cross.setAttribute("x1", String(px));
    cross.setAttribute("x2", String(px));
    dot.setAttribute("cx", String(px));
    dot.setAttribute("cy", String(y(v)));
    tip.replaceChildren(h("b", null, money(v)), h("span", null, new Date(t).toLocaleString()));
    tip.hidden = false;
    tip.style.left = `${(px / W) * 100}%`;
    tip.style.top = `${(y(v) / H) * 100}%`;
  };
  const hide = () => {
    for (const el of [cross, dot]) el.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  hit.addEventListener("pointermove", (e) => show((e as PointerEvent).clientX));
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(svg.getBoundingClientRect().right - 1));
  hit.addEventListener("blur", hide);

  host.replaceChildren(svg, tip);
}

import type { PerkId } from "../../shared/game.js";
import { OFFLINE_CAP_HOURS, PERKS, perkValue } from "../odds";
import { buyPerk, displayBalance, getState, InsufficientFunds, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";

// An Obsidian-style graph: "Start" in the middle, each branch spiralling outward one
// level per ring. Nodes float on a small spring simulation and can be dragged; the
// background pans and the wheel zooms. Buying happens in the card below the graph.

// Three branches 120° apart around the centre.
const BRANCHES: { id: PerkId; angle: number; format: (v: number) => string; effect: (v: number) => string }[] = [
  { id: "multiOpen", angle: Math.PI * (5 / 6), format: (v) => `×${v}`, effect: (v) => `Open ${v} case${v === 1 ? "" : "s"} at once` },
  { id: "clickPower", angle: Math.PI / 6, format: (v) => money(v), effect: (v) => `${money(v)} per click` },
  { id: "offlineIncome", angle: -Math.PI / 2, format: (v) => `${money(v)}/h`, effect: (v) => `${money(v)} per hour while away` },
];

const RING = 64; // distance between levels
const TWIST = 0.16; // radians each level turns, so branches curl slightly around the centre

type State = "root" | "owned" | "next" | "locked";
interface GNode {
  key: string;
  branch: PerkId | null;
  level: number;
  home: { x: number; y: number };
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  r: number;
  el?: SVGGElement;
}

const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function buildGraph() {
  const nodes: GNode[] = [{ key: "root", branch: null, level: 0, home: { x: 0, y: 0 }, x: 0, y: 0, vx: 0, vy: 0, phase: 0, r: 26 }];
  const edges: [GNode, GNode][] = [];
  for (const b of BRANCHES) {
    let prev = nodes[0];
    PERKS[b.id].levels.slice(1).forEach((_, i) => {
      const level = i + 1;
      const a = b.angle + level * TWIST;
      const home = { x: Math.cos(a) * RING * level, y: Math.sin(a) * RING * level };
      // Start slightly scattered so the graph "settles" in, like Obsidian's does.
      const n: GNode = {
        key: `${b.id}:${level}`,
        branch: b.id,
        level,
        home,
        x: home.x * 0.3 + (Math.random() - 0.5) * 30,
        y: home.y * 0.3 + (Math.random() - 0.5) * 30,
        vx: 0,
        vy: 0,
        phase: Math.random() * Math.PI * 2,
        r: 15 - Math.min(level, 5),
      };
      nodes.push(n);
      edges.push([prev, n]);
      prev = n;
    });
  }
  return { nodes, edges };
}

export function treePage() {
  const { nodes, edges } = buildGraph();
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const neighbours = new Map<GNode, Set<GNode>>(nodes.map((n) => [n, new Set([n])]));
  for (const [a, b] of edges) {
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  }

  let selected: GNode | null = null;
  let hovered: GNode | null = null;
  let buying = false;

  const stateOf = (n: GNode): State => {
    if (!n.branch) return "root";
    const owned = getState().perks[n.branch];
    return n.level <= owned ? "owned" : n.level === owned + 1 ? "next" : "locked";
  };

  // ---------- SVG scene ----------

  const root = svg("svg", { class: "graph-svg", role: "img", "aria-label": "Upgrade tree" });
  const world = svg("g");
  const edgeLayer = svg("g", { class: "graph-edges" });
  const nodeLayer = svg("g");
  world.append(edgeLayer, nodeLayer);
  root.append(world);

  const edgeEls = edges.map(([a, b]) => {
    const line = svg("line");
    edgeLayer.append(line);
    return { a, b, line };
  });

  for (const n of nodes) {
    const g = svg("g", { class: "graph-node", tabindex: 0 });
    g.append(svg("circle", { class: "graph-halo", r: n.r + 9 }), svg("circle", { class: "graph-dot", r: n.r }));
    const label = svg("text", { class: "graph-label", y: n.r + 15, "text-anchor": "middle" });
    const sub = svg("text", { class: "graph-sub", y: n.r + 28, "text-anchor": "middle" });
    if (!n.branch) {
    }
    g.append(label, sub);
    g.addEventListener("pointerenter", () => (hovered = n));
    g.addEventListener("pointerleave", () => hovered === n && (hovered = null));
    g.addEventListener("focus", () => select(n));
    g.addEventListener("keydown", (e) => (e as KeyboardEvent).key === "Enter" && select(n));
    n.el = g;
    nodeLayer.append(g);
  }

  const paintNodes = () => {
    for (const n of nodes) {
      const st = stateOf(n);
      const g = n.el!;
      g.setAttribute("class", `graph-node ${st}${selected === n ? " selected" : ""}`);
      const [label, sub] = g.querySelectorAll<SVGTextElement>(".graph-label, .graph-sub");
      if (!n.branch) {
        label.textContent = "Start";
        sub.textContent = "";
        continue;
      }
      const b = BRANCHES.find((x) => x.id === n.branch)!;
      const lvl = PERKS[n.branch].levels[n.level];
      label.textContent = b.format(lvl.value);
      sub.textContent = st === "owned" ? "owned" : money(lvl.cost);
      g.setAttribute("aria-label", `${PERKS[n.branch].name} level ${n.level}: ${b.effect(lvl.value)}, ${st === "owned" ? "owned" : money(lvl.cost)}`);
    }
    for (const { b, line } of edgeEls) line.setAttribute("class", stateOf(b) === "owned" ? "owned" : stateOf(b) === "next" ? "next" : "");
  };

  // ---------- pan / zoom / drag ----------

  // Start zoomed so the whole graph fits; recomputed until the user zooms or pans.
  const graphRadius = Math.max(...nodes.map((n) => Math.hypot(n.home.x, n.home.y))) + 60;
  let view = { x: 0, y: 0, k: 1 };
  let userMoved = false;
  const fit = (box: DOMRect) => {
    if (!userMoved && box.width) view.k = Math.min(1.3, Math.max(0.4, (Math.min(box.width, box.height) / 2) / graphRadius));
  };
  let drag: { node: GNode | null; startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null = null;
  const toWorld = (clientX: number, clientY: number) => {
    const box = root.getBoundingClientRect();
    return { x: (clientX - box.left - box.width / 2 - view.x) / view.k, y: (clientY - box.top - box.height / 2 - view.y) / view.k };
  };

  root.addEventListener("pointerdown", (e) => {
    const target = (e.target as Element).closest(".graph-node");
    const node = target ? nodes.find((n) => n.el === target) ?? null : null;
    drag = { node, startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, moved: false };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 4) drag.moved = true;
    if (drag.node) {
      const p = toWorld(e.clientX, e.clientY);
      Object.assign(drag.node, { x: p.x, y: p.y, vx: 0, vy: 0 });
    } else {
      view.x = drag.viewX + e.clientX - drag.startX;
      view.y = drag.viewY + e.clientY - drag.startY;
      userMoved = true;
    }
  });
  const endDrag = () => {
    if (drag && !drag.moved && drag.node) select(drag.node);
    drag = null;
  };
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", () => (drag = null));
  root.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const k = Math.min(2.5, Math.max(0.4, view.k * Math.exp(-e.deltaY * 0.0015)));
      // Zoom around the pointer.
      const box = root.getBoundingClientRect();
      const px = e.clientX - box.left - box.width / 2;
      const py = e.clientY - box.top - box.height / 2;
      view.x = px - ((px - view.x) * k) / view.k;
      view.y = py - ((py - view.y) * k) / view.k;
      view.k = k;
      userMoved = true;
    },
    { passive: false },
  );

  // ---------- physics ----------

  let raf = 0;
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(2, (now - last) / 16.67);
    last = now;
    const t = now / 1000;
    for (const n of nodes) {
      if (drag?.node === n) continue;
      // Pull toward a home spot that bobs gently, so the graph never quite sits still.
      const hx = n.home.x + Math.sin(t * 0.6 + n.phase) * 6;
      const hy = n.home.y + Math.cos(t * 0.5 + n.phase * 1.3) * 6;
      let fx = (hx - n.x) * (n.branch ? 0.012 : 0.05);
      let fy = (hy - n.y) * (n.branch ? 0.012 : 0.05);
      for (const m of nodes) {
        if (m === n) continue;
        const dx = n.x - m.x;
        const dy = n.y - m.y;
        const d2 = Math.max(dx * dx + dy * dy, 100);
        const f = 900 / d2;
        fx += (dx / Math.sqrt(d2)) * f;
        fy += (dy / Math.sqrt(d2)) * f;
      }
      n.vx = (n.vx + fx * dt) * 0.86;
      n.vy = (n.vy + fy * dt) * 0.86;
    }
    for (const [a, b] of edges) {
      // Springs along edges: dragging one node tugs its neighbours.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - RING) * 0.02 * dt;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      if (drag?.node !== a) {
        a.vx += ux;
        a.vy += uy;
      }
      if (drag?.node !== b) {
        b.vx -= ux;
        b.vy -= uy;
      }
    }
    for (const n of nodes) {
      if (drag?.node === n) continue;
      n.x += n.vx * dt;
      n.y += n.vy * dt;
    }

    // Render.
    const box = root.getBoundingClientRect();
    fit(box);
    world.setAttribute("transform", `translate(${box.width / 2 + view.x} ${box.height / 2 + view.y}) scale(${view.k})`);
    const focus = hovered ?? (drag?.node || null);
    const near = focus ? neighbours.get(focus)! : null;
    for (const { a, b, line } of edgeEls) {
      line.setAttribute("x1", a.x.toFixed(1));
      line.setAttribute("y1", a.y.toFixed(1));
      line.setAttribute("x2", b.x.toFixed(1));
      line.setAttribute("y2", b.y.toFixed(1));
      line.classList.toggle("dim", !!near && !(near.has(a) && near.has(b)));
    }
    for (const n of nodes) {
      n.el!.setAttribute("transform", `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
      n.el!.classList.toggle("dim", !!near && !near.has(n));
      n.el!.classList.toggle("focus", focus === n);
    }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  onLeave(() => cancelAnimationFrame(raf));

  // ---------- detail card ----------

  const card = h("div", { class: "graph-card" });
  const select = (n: GNode) => {
    selected = n;
    paintNodes();
    drawCard();
  };

  const drawCard = () => {
    const n = selected;
    if (!n || !n.branch) {
      // Nothing (or the root) picked: show what can be bought next on each branch.
      card.replaceChildren(
        h("div", { class: "graph-card-title" }, "Next upgrades"),
        h("div", { class: "graph-card-hint" }, "Click a node in the graph for details. Drag nodes, drag the background to pan, scroll to zoom."),
        ...BRANCHES.map((b) => {
          const next = byKey.get(`${b.id}:${getState().perks[b.id] + 1}`);
          return next ? nodeRow(next) : h("div", { class: "graph-row" }, h("b", null, PERKS[b.id].name), h("span", null, "Maxed"));
        }),
      );
      return;
    }
    card.replaceChildren(
      h("div", { class: "graph-card-title" }, `${PERKS[n.branch].name} · level ${n.level}`),
      nodeRow(n),
      h("button", { class: "linklike", onclick: () => ((selected = null), paintNodes(), drawCard()) }, "Show next upgrades"),
    );
  };

  const nodeRow = (n: GNode) => {
    const b = BRANCHES.find((x) => x.id === n.branch)!;
    const lvl = PERKS[n.branch!].levels[n.level];
    const st = stateOf(n);
    const affordable = displayBalance() >= lvl.cost;
    return h(
      "div",
      { class: `graph-row ${st}` },
      h("div", null, h("b", null, b.effect(lvl.value)), h("div", { class: "graph-card-hint" }, `${PERKS[n.branch!].name} level ${n.level}`)),
      st === "owned"
        ? h("span", { class: "tree-owned" }, "Owned")
        : st === "next"
          ? h(
              "button",
              {
                class: "btn btn-primary btn-sm",
                disabled: buying || !affordable,
                title: affordable ? "" : `Need ${money(lvl.cost - displayBalance())} more`,
                onclick: () => buy(n.branch!, b.effect(lvl.value)),
              },
              `Buy ${money(lvl.cost)}`,
            )
          : h("span", { class: "tree-cost" }, icon("lock", 12), ` ${money(lvl.cost)} · unlock level ${n.level - 1} first`),
    );
  };

  async function buy(id: PerkId, label: string) {
    buying = true;
    drawCard();
    try {
      await buyPerk(id);
      toast(`Unlocked: ${label}`);
      // Move the selection along the branch so the next buy is one click away.
      const next = byKey.get(`${id}:${getState().perks[id] + 1}`);
      if (selected?.branch === id) selected = next ?? selected;
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      buying = false;
      paintNodes();
      drawCard();
    }
  }

  onLeave(
    subscribe(() => {
      paintNodes();
      drawCard();
    }),
  );
  paintNodes();
  drawCard();

  const summary = h(
    "div",
    { class: "case-stats" },
    ...BRANCHES.map((b) => h("div", { class: "stat" }, h("span", null, PERKS[b.id].name), h("b", null, b.effect(perkValue(getState().perks, b.id))))),
  );
  onLeave(
    subscribe(() =>
      summary.replaceChildren(
        ...BRANCHES.map((b) => h("div", { class: "stat" }, h("span", null, PERKS[b.id].name), h("b", null, b.effect(perkValue(getState().perks, b.id))))),
      ),
    ),
  );

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Upgrade tree"),
    h(
      "p",
      { class: "hint" },
      `Spend balance to open more cases at once, earn more per click and earn more while you're away (up to ${OFFLINE_CAP_HOURS} hours). Each level unlocks the next.`,
    ),
    summary,
    h("div", { class: "graph" }, root),
    card,
  );
}

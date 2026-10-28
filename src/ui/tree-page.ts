import type { PerkId } from "../../shared/game.js";
import { CLICK_CPS_LIMIT, OFFLINE_CAP_HOURS, PERKS, perkValue } from "../odds";
import { buyPerk, displayBalance, getState, InsufficientFunds, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { icon, iconNode, type IconName } from "./icons";
import { onLeave } from "./page";

// An Obsidian-style graph: "Start" in the middle, each branch spiralling outward one
// level per ring. Nodes float on a small spring simulation and can be dragged; the
// background pans and the wheel zooms. Each node shows its icon and price; hovering
// shows the details in a tooltip, clicking pins it so the upgrade can be bought there.

// Five branches 72° apart around the centre.
const BRANCHES: { id: PerkId; angle: number; icon: IconName; about: string; effect: (v: number) => string }[] = [
  {
    id: "multiOpen",
    angle: -Math.PI / 2 - (4 * Math.PI) / 5,
    icon: "multiOpen",
    about: "Open several of the same case in one go.",
    effect: (v) => `Open ${v} case${v === 1 ? "" : "s"} at once`,
  },
  {
    id: "clickPower",
    angle: -Math.PI / 2,
    icon: "clickPower",
    about: `What each click on the clicker pays (in full up to ${CLICK_CPS_LIMIT} clicks per second).`,
    effect: (v) => `${money(v)} per click`,
  },
  {
    id: "offlineIncome",
    angle: -Math.PI / 2 + (4 * Math.PI) / 5,
    icon: "offlineIncome",
    about: `Paid when you come back after 5+ minutes away, for up to ${OFFLINE_CAP_HOURS} hours. It's some minutes of full-speed clicking per hour away, so click power raises it too.`,
    effect: (v) => `${v} min of clicking per hour away (${money(v * perkValue(getState().perks, "clickPower") * CLICK_CPS_LIMIT * 60)}/h at your click power)`,
  },
  {
    id: "battleRounds",
    angle: -Math.PI / 2 + (2 * Math.PI) / 5,
    icon: "battleRounds",
    about: "How many cases you can put in a case battle you create.",
    effect: (v) => `Up to ${v} cases per battle`,
  },
  {
    id: "maxBet",
    angle: -Math.PI / 2 - (2 * Math.PI) / 5,
    icon: "maxBet",
    about: "The most you can bet on one round of any game.",
    effect: (v) => (Number.isFinite(v) ? `Bet up to ${money(v)}` : "No max bet"),
  },
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

/** A Lucide icon drawn inside the graph's SVG, centred on 0,0. */
function svgIcon(name: IconName, size: number) {
  const g = document.createElementNS(SVG, "g");
  g.setAttribute("class", "graph-icon");
  g.setAttribute("transform", `translate(${-size / 2} ${-size / 2}) scale(${size / 24})`);
  for (const [tag, attrs] of iconNode(name)[2] ?? []) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    g.append(el);
  }
  return g;
}
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function buildGraph() {
  const nodes: GNode[] = [{ key: "root", branch: null, level: 0, home: { x: 0, y: 0 }, x: 0, y: 0, vx: 0, vy: 0, phase: 0, r: 24 }];
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
        r: 18 - Math.min(level, 4) * 0.5,
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

  /** Node whose tooltip is pinned open (clicked / tapped / Enter). */
  let pinned: GNode | null = null;
  let hovered: GNode | null = null;
  /** Node actually under the pointer (hovered lingers while moving onto the tooltip). */
  let under: GNode | null = null;
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

  // Hover shows a node's tooltip; leaving it hides it after a short grace period so the
  // pointer can move onto the tooltip (to press Buy).
  let hideTimer = 0;
  const hoverNode = (n: GNode | null) => {
    clearTimeout(hideTimer);
    if (n) {
      hovered = n;
      drawTip();
    } else {
      hideTimer = window.setTimeout(() => {
        hovered = null;
        drawTip();
      }, 180);
    }
  };

  for (const n of nodes) {
    const g = svg("g", { class: "graph-node", tabindex: 0 });
    g.append(svg("circle", { class: "graph-halo", r: n.r + 9 }), svg("circle", { class: "graph-dot", r: n.r }));
    g.append(n.branch ? svgIcon(BRANCHES.find((b) => b.id === n.branch)!.icon, n.r * 1.05) : svgIcon("award", 24));
    g.append(svg("text", { class: "graph-price", y: n.r + 15, "text-anchor": "middle" }));
    g.addEventListener("pointerenter", () => {
      under = n;
      hoverNode(n);
    });
    g.addEventListener("pointerleave", () => {
      if (under === n) under = null;
      if (hovered === n) hoverNode(null);
    });
    g.addEventListener("focus", () => pin(n));
    g.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Escape") pin(null);
      if (key === "Enter" && n.branch && stateOf(n) === "next") buy(n);
    });
    n.el = g;
    nodeLayer.append(g);
  }

  const paintNodes = () => {
    for (const n of nodes) {
      const st = stateOf(n);
      const g = n.el!;
      g.setAttribute("class", `graph-node ${st}${pinned === n ? " selected" : ""}`);
      const price = g.querySelector<SVGTextElement>(".graph-price")!;
      if (!n.branch) {
        price.textContent = "Start";
        continue;
      }
      const lvl = PERKS[n.branch].levels[n.level];
      price.textContent = st === "owned" ? "Owned" : money(lvl.cost);
      const b = BRANCHES.find((x) => x.id === n.branch)!;
      g.setAttribute("aria-label", `${PERKS[n.branch].name} level ${n.level}: ${b.effect(lvl.value)}, ${st === "owned" ? "owned" : money(lvl.cost)}`);
    }
    for (const { b, line } of edgeEls) line.setAttribute("class", stateOf(b) === "owned" ? "owned" : stateOf(b) === "next" ? "next" : "");
  };

  // ---------- pan / zoom / drag ----------

  // Start zoomed so the whole graph fits; recomputed until the user zooms or pans.
  // Fit the bounding box of the node homes (plus room for labels), centred.
  const PAD = 50;
  const minX = Math.min(...nodes.map((n) => n.home.x)) - PAD;
  const maxX = Math.max(...nodes.map((n) => n.home.x)) + PAD;
  const minY = Math.min(...nodes.map((n) => n.home.y)) - PAD;
  const maxY = Math.max(...nodes.map((n) => n.home.y)) + PAD;
  let view = { x: 0, y: 0, k: 1 };
  let userMoved = false;
  const fit = (box: DOMRect) => {
    if (userMoved || !box.width) return;
    view.k = Math.min(1.6, Math.max(0.4, Math.min(box.width / (maxX - minX), box.height / (maxY - minY))));
    view.x = (-(minX + maxX) / 2) * view.k;
    view.y = (-(minY + maxY) / 2) * view.k;
  };
  let drag: { node: GNode | null; wasPinned: boolean; startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null = null;
  const toWorld = (clientX: number, clientY: number) => {
    const box = root.getBoundingClientRect();
    return { x: (clientX - box.left - box.width / 2 - view.x) / view.k, y: (clientY - box.top - box.height / 2 - view.y) / view.k };
  };

  root.addEventListener("pointerdown", (e) => {
    if (tip.contains(e.target as Node)) return;
    const target = (e.target as Element).closest(".graph-node");
    const node = target ? nodes.find((n) => n.el === target) ?? null : null;
    // Read before the node takes focus (which pins it).
    drag = { node, wasPinned: !!node && node === pinned, startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, moved: false };
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
    // A click (not a drag) pins that node's tooltip; clicking empty space unpins.
    if (drag && !drag.moved) pin(drag.node && !drag.wasPinned ? drag.node : null);
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
    const focus = drag?.node || under;
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
    placeTip(box);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  onLeave(() => cancelAnimationFrame(raf));

  // ---------- tooltip ----------

  const tip = h("div", { class: "graph-tip", role: "tooltip", hidden: true });
  tip.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  tip.addEventListener("pointerleave", () => hovered && hoverNode(null));
  // A pinned tooltip stays put while the pointer crosses other nodes on its way to Buy.
  const tipNode = () => pinned ?? hovered;

  const pin = (n: GNode | null) => {
    pinned = n;
    paintNodes();
    drawTip();
  };

  const drawTip = () => {
    const n = tipNode();
    tip.hidden = !n;
    tip.classList.toggle("pinned", !!n && n === pinned);
    if (!n) return;
    if (!n.branch) {
      tip.replaceChildren(
        h("div", { class: "tip-head" }, icon("award", 16), h("b", null, "Your upgrades")),
        ...BRANCHES.map((b) =>
          h("div", { class: "tip-row" }, icon(b.icon, 14), h("span", null, b.effect(perkValue(getState().perks, b.id)))),
        ),
        h("div", { class: "tip-hint" }, "Hover a node for details, click to pin it. Drag nodes or the background, scroll to zoom."),
      );
      return;
    }
    const b = BRANCHES.find((x) => x.id === n.branch)!;
    const perk = PERKS[n.branch];
    const lvl = perk.levels[n.level];
    const prev = perk.levels[n.level - 1];
    const st = stateOf(n);
    const affordable = displayBalance() >= lvl.cost;
    const gain = prev.value && Number.isFinite(lvl.value) ? Math.round((lvl.value / prev.value - 1) * 100) : null;

    let action: HTMLElement;
    if (st === "owned") action = h("div", { class: "tip-owned" }, "Owned");
    else if (st === "locked") action = h("div", { class: "tip-locked" }, icon("lock", 13), ` Unlock level ${n.level - 1} first`);
    else
      action = h(
        "button",
        {
          class: "btn btn-primary btn-sm",
          disabled: buying || !affordable,
          onclick: () => buy(n),
        },
        affordable ? `Buy for ${money(lvl.cost)}` : `Need ${money(lvl.cost - displayBalance())} more`,
      );

    tip.replaceChildren(
      h("div", { class: "tip-head" }, icon(b.icon, 16), h("b", null, perk.name), h("span", null, `Level ${n.level} of ${perk.levels.length - 1}`)),
      h("div", { class: "tip-effect" }, b.effect(lvl.value)),
      h("div", { class: "tip-row" }, h("span", null, "Before"), h("b", null, b.effect(prev.value))),
      ...(gain != null ? [h("div", { class: "tip-row" }, h("span", null, "Increase"), h("b", { class: "up" }, `+${gain}%`))] : []),
      h("div", { class: "tip-row" }, h("span", null, "Cost"), h("b", null, money(lvl.cost))),
      h("div", { class: "tip-hint" }, b.about),
      action,
    );
  };

  /** Keep the tooltip beside its node as the graph moves. */
  const placeTip = (box: DOMRect) => {
    const n = tipNode();
    if (!n || tip.hidden) return;
    const sx = box.width / 2 + view.x + n.x * view.k;
    const sy = box.height / 2 + view.y + n.y * view.k;
    const gap = (n.r + 10) * view.k;
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    // Right of the node, or left if it wouldn't fit; clamped inside the graph.
    let x = sx + gap;
    if (x + w > box.width - 8) x = sx - gap - w;
    x = Math.max(8, Math.min(box.width - w - 8, x));
    const y = Math.max(8, Math.min(box.height - hgt - 8, sy - hgt / 2));
    tip.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
  };

  async function buy(n: GNode) {
    const id = n.branch!;
    const label = BRANCHES.find((x) => x.id === id)!.effect(PERKS[id].levels[n.level].value);
    buying = true;
    drawTip();
    try {
      await buyPerk(id);
      toast(`Unlocked: ${label}`);
      // Move the pin along the branch so the next buy is one click away.
      if (pinned === n) pinned = byKey.get(`${id}:${getState().perks[id] + 1}`) ?? n;
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      buying = false;
      paintNodes();
      drawTip();
    }
  }

  onLeave(
    subscribe(() => {
      paintNodes();
      drawTip();
    }),
  );
  onLeave(() => clearTimeout(hideTimer));
  paintNodes();

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
    summary,
    h("div", { class: "graph" }, root, tip, h("div", { class: "graph-hint" }, "Hover for details, click to pin. Drag to move, scroll to zoom.")),
  );
}

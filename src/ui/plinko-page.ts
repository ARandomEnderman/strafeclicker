import { PLINKO_DROP_MS, PLINKO_RISKS, PLINKO_ROWS, PLINKO_TABLES } from "../odds";
import { dropPlinko, InsufficientFunds, ServerError } from "../state";
import { betInput, segmented } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { playTick } from "./sound";

// The server picks each ball's path; this page only animates it. Several balls can be
// in the air at once. A ball's winnings show in the balance when it lands.

type Risk = (typeof PLINKO_RISKS)[number];
const SETTINGS_KEY = "strafeclicker:plinko";

function loadSettings(): { rows: number; risk: Risk } {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return { rows: PLINKO_ROWS.includes(s.rows) ? s.rows : 16, risk: PLINKO_RISKS.includes(s.risk) ? s.risk : "medium" };
  } catch {
    return { rows: 16, risk: "medium" };
  }
}

/** Slot colour: yellow in the middle, red at the edges. */
const slotColor = (k: number, rows: number) => `hsl(${45 - (Math.abs(k - rows / 2) / (rows / 2)) * 45} 90% 55%)`;

const fmtMult = (m: number) => (m >= 100 ? `${m}` : m.toString()) + "x";

export function plinkoPage() {
  let { rows, risk } = loadSettings();
  let inFlight = 0;
  const save = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ rows, risk }));
    } catch {
      // ignore
    }
  };

  const board = h("div", { class: "plinko-board" });
  const pegLayer = h("div", { class: "plinko-pegs" });
  const slotLayer = h("div", { class: "plinko-slots" });
  const ballLayer = h("div", { class: "plinko-balls" });
  board.append(pegLayer, slotLayer, ballLayer);
  const history = h("div", { class: "plinko-history" });

  // Geometry, recomputed when the board resizes or the rows change.
  let s = 30; // peg spacing (px)
  let top = 20; // y of the first peg row
  let pegs: HTMLElement[][] = [];
  let slots: HTMLElement[] = [];

  const layout = () => {
    const w = board.clientWidth || 600;
    s = Math.min(48, w / (rows + 2.5));
    top = s * 0.9;
    board.style.height = `${top + rows * s + s * 1.1}px`;
    board.style.setProperty("--s", `${s}px`);
    pegs = [];
    pegLayer.replaceChildren();
    for (let r = 0; r < rows; r++) {
      const row: HTMLElement[] = [];
      for (let j = 0; j < r + 3; j++) {
        const p = h("i", { class: "peg", style: `left:calc(50% + ${(j - (r + 2) / 2) * s}px);top:${top + r * s}px` });
        row.push(p);
        pegLayer.append(p);
      }
      pegs.push(row);
    }
    const table = PLINKO_TABLES[rows][risk];
    slots = table.map((m, k) =>
      h(
        "div",
        {
          class: "slot",
          style: `left:calc(50% + ${(k - rows / 2) * s}px);top:${top + (rows - 0.5) * s + s * 0.45}px;width:${s - 3}px;--c:${slotColor(k, rows)}`,
        },
        fmtMult(m),
      ),
    );
    slotLayer.replaceChildren(...slots);
  };
  const ro = new ResizeObserver(() => inFlight === 0 && layout());
  ro.observe(board);
  onLeave(() => ro.disconnect());

  const drop = (path: number[], onLand: () => void) => {
    const R = path.length;
    const ballR = Math.max(4, s * 0.22);
    const pegR = Math.max(2, s * 0.09);
    const ball = h("i", { class: "ball", style: `width:${ballR * 2}px;height:${ballR * 2}px;margin:${-ballR}px 0 0 ${-ballR}px` });
    ballLayer.append(ball);

    // Peg contact points: at row r the ball sits on the peg it has bounced to.
    let k = 0;
    const hits: { x: number; y: number; peg: HTMLElement }[] = [];
    for (let r = 0; r < R; r++) {
      hits.push({ x: (k - r / 2) * s, y: top + r * s - ballR - pegR, peg: pegs[r]?.[k + 1] });
      k += path[r];
    }
    const end = { x: (k - R / 2) * s, y: top + (R - 0.5) * s + s * 0.55 };

    const total = PLINKO_DROP_MS(R);
    const first = 200 / total;
    const hop = (1 - first - 200 / total) / R;
    const frames: Keyframe[] = [{ transform: `translate(0px, ${top - s * 1.1}px)`, offset: 0, easing: "cubic-bezier(.5,0,1,1)" }];
    hits.forEach((p, r) => {
      const t = first + r * hop;
      const next = hits[r + 1] ?? end;
      frames.push({ transform: `translate(${p.x}px, ${p.y}px)`, offset: t, easing: "cubic-bezier(0,0,.5,1)" });
      // Bounce: up and sideways to the apex, then fall onto the next peg.
      const jitter = (Math.random() - 0.5) * s * 0.08;
      frames.push({ transform: `translate(${(p.x + next.x) / 2 + jitter}px, ${p.y - s * 0.28}px)`, offset: t + hop * 0.4, easing: "cubic-bezier(.5,0,1,1)" });
    });
    frames.push({ transform: `translate(${end.x}px, ${end.y}px)`, offset: 1 });
    const anim = ball.animate(frames, { duration: total, fill: "forwards" });

    const timers = hits.map((p, r) =>
      setTimeout(() => {
        playTick();
        p.peg?.classList.remove("hit");
        void p.peg?.offsetWidth;
        p.peg?.classList.add("hit");
      }, (first + r * hop) * total),
    );
    anim.finished
      .catch(() => undefined)
      .then(() => {
        timers.forEach(clearTimeout);
        ball.remove();
        onLand();
      });
  };

  const bet = betInput();
  const go = async () => {
    const stake = bet.value();
    const r0 = rows;
    let res;
    try {
      res = await dropPlinko(stake, rows, risk);
    } catch (e) {
      if (e instanceof InsufficientFunds) return toast("Not enough balance", "error");
      if (e instanceof ServerError) return toast(e.message, "error");
      throw e;
    }
    if (r0 !== rows) layout();
    inFlight++;
    lock();
    drop(res.path, () => {
      inFlight--;
      lock();
      res.reveal();
      const slot = slots[res.slot];
      slot?.classList.remove("land");
      void slot?.offsetWidth;
      slot?.classList.add("land");
      history.prepend(h("div", { class: `plinko-chip${res.mult >= 1 ? " up" : ""}`, style: `--c:${slotColor(res.slot, res.path.length)}`, title: `${money(res.stake)} → ${money(res.payout)}` }, fmtMult(res.mult)));
      while (history.children.length > 12) history.lastElementChild!.remove();
    });
  };
  const dropBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => void go() }, "Drop ball");

  const riskSeg = segmented<Risk>(
    "Risk",
    PLINKO_RISKS.map((x) => ({ value: x, label: x[0].toUpperCase() + x.slice(1) })),
    risk,
    (v) => {
      risk = v;
      save();
      layout();
    },
  );
  const rowSeg = segmented<number>(
    "Rows",
    PLINKO_ROWS.map((n) => ({ value: n, label: String(n) })),
    rows,
    (v) => {
      rows = v;
      save();
      layout();
    },
  );
  // Rows and risk change the board, so they're locked while balls are falling.
  const lock = () => {
    riskSeg.setDisabled(inFlight > 0);
    rowSeg.setDisabled(inFlight > 0);
  };

  requestAnimationFrame(layout);

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Plinko"),
    h(
      "div",
      { class: "game-layout" },
      h("div", { class: "game-panel" }, bet.el, riskSeg.el, rowSeg.el, dropBtn, h("p", { class: "hint" }, "Each peg bounces the ball left or right. The slot it lands in multiplies your bet.")),
      h("div", { class: "game-stage plinko-stage" }, history, board),
    ),
  );
}

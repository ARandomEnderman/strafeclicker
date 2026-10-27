import { KENO_DRAWS, KENO_MAX_PICKS, KENO_REVEAL_MS, KENO_TABLES, KENO_TILES } from "../odds";
import { displayBalance, InsufficientFunds, playKeno, ServerError } from "../state";
import { betInput } from "./bet-input";
import { h, money, mult, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";
import { playReveal, playSafe, playTick } from "./sound";

// Keno on a 7×7 grid. Pick up to 10 tiles, the server draws 10; the page reveals the
// draw one tile at a time.

const PICKS_KEY = "strafeclicker:keno-picks";
const fmtMult = mult;

export function kenoPage() {
  let picks = new Set<number>();
  try {
    const saved = JSON.parse(localStorage.getItem(PICKS_KEY) ?? "[]");
    if (Array.isArray(saved)) picks = new Set(saved.filter((t) => Number.isInteger(t) && t >= 0 && t < KENO_TILES).slice(0, KENO_MAX_PICKS));
  } catch {
    // ignore
  }
  let busy = false;
  let shown: { drawn: Set<number>; revealed: Set<number> } | null = null;

  const save = () => {
    try {
      localStorage.setItem(PICKS_KEY, JSON.stringify([...picks]));
    } catch {
      // ignore
    }
  };

  const tiles = Array.from({ length: KENO_TILES }, (_, i) =>
    h(
      "button",
      {
        type: "button",
        class: "kn-tile",
        onclick: () => {
          if (busy) return;
          if (picks.has(i)) picks.delete(i);
          else if (picks.size >= KENO_MAX_PICKS) return toast(`Up to ${KENO_MAX_PICKS} tiles`, "error");
          else picks.add(i);
          shown = null;
          save();
          draw();
        },
      },
      String(i + 1),
    ),
  );
  const grid = h("div", { class: "kn-grid" }, ...tiles);
  const banner = h("div", { class: "bh-banner" });
  const table = h("div", { class: "kn-table" });

  const draw = () => {
    tiles.forEach((t, i) => {
      const picked = picks.has(i);
      const revealed = shown?.revealed.has(i);
      const hit = revealed && picked;
      t.className = `kn-tile${picked ? " picked" : ""}${revealed ? (hit ? " hit" : " drawn") : ""}`;
      t.replaceChildren(hit ? icon("gem", 22) : String(i + 1));
      t.disabled = busy;
    });
    const row = KENO_TABLES[picks.size] ?? [];
    const hits = shown && shown.revealed.size === KENO_DRAWS ? [...picks].filter((t) => shown!.drawn.has(t)).length : -1;
    table.replaceChildren(
      ...(row.length
        ? row.map((m, k) => h("div", { class: `kn-pay${m ? "" : " zero"}${k === hits ? " current" : ""}` }, h("b", null, m ? fmtMult(m) : "0x"), h("span", null, `${k} hit${k === 1 ? "" : "s"}`)))
        : [h("p", { class: "fb-empty" }, "Pick up to 10 tiles to see what they pay.")]),
    );
    playBtn.disabled = busy || !picks.size;
    playBtn.textContent = picks.size ? `Play ${picks.size} tile${picks.size === 1 ? "" : "s"}` : "Pick tiles";
    bet.setDisabled(busy);
  };

  const bet = betInput();
  const playBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => void play() });
  const randomBtn = h(
    "button",
    {
      class: "btn",
      onclick: () => {
        if (busy) return;
        const n = picks.size || 5;
        picks = new Set();
        while (picks.size < n) picks.add(Math.floor(Math.random() * KENO_TILES));
        shown = null;
        save();
        draw();
      },
    },
    "Random",
  );
  const clearBtn = h("button", { class: "btn btn-ghost", onclick: () => !busy && ((picks = new Set()), (shown = null), save(), draw()) }, "Clear");

  const play = async () => {
    if (busy || !picks.size) return;
    if (bet.value() > displayBalance() + 1e-9) return toast("Not enough balance", "error");
    busy = true;
    banner.textContent = "";
    banner.className = "bh-banner";
    draw();
    let r;
    try {
      r = await playKeno(bet.value(), [...picks]);
    } catch (e) {
      busy = false;
      draw();
      if (e instanceof InsufficientFunds) return toast("Not enough balance", "error");
      if (e instanceof ServerError) return toast(e.message, "error");
      throw e;
    }
    shown = { drawn: new Set(r.drawn), revealed: new Set() };
    const step = KENO_REVEAL_MS / KENO_DRAWS;
    for (const t of r.drawn) {
      await new Promise((ok) => setTimeout(ok, step));
      shown.revealed.add(t);
      if (picks.has(t)) playSafe();
      else playTick();
      draw();
    }
    r.reveal();
    busy = false;
    if (r.payout > 0) {
      banner.textContent = `${r.hits} hit${r.hits === 1 ? "" : "s"}: ${r.mult}x, +${money(r.payout)}`;
      banner.className = "bh-banner won";
      if (r.mult >= 10) playReveal(r.mult >= 100 ? "gold" : "covert");
    } else {
      banner.textContent = `${r.hits} hit${r.hits === 1 ? "" : "s"}. No win this time.`;
      banner.className = "bh-banner lost";
    }
    draw();
  };
  onLeave(() => (busy = false));

  draw();
  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Keno"),
    h(
      "div",
      { class: "game-layout" },
      h(
        "div",
        { class: "game-panel" },
        bet.el,
        h("div", { class: "kn-buttons" }, randomBtn, clearBtn),
        playBtn,
        h("p", { class: "hint" }, `Pick up to ${KENO_MAX_PICKS} tiles. The more get hit, the more it pays.`),
      ),
      h("div", { class: "game-stage kn-stage" }, banner, grid, table),
    ),
  );
}

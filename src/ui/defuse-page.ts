import { DEFUSE_TILES, defuseMultiplier } from "../odds";
import { defuseAction, InsufficientFunds, ServerError, type DefuseRun } from "../state";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { playBoom, playSafe } from "./sound";

// Mines with C4s. The server already knows where the bombs are; the page only finds
// out by hitting one, or when the round ends.

const PRESETS = [1, 3, 5, 10, 24];
const BOMBS_KEY = "strafeclicker:defuse-bombs";

/** "4%" or "1 in 3,268,760": the chance of picking every safe tile before any bomb. */
function clearOdds(bombs: number) {
  let p = 1;
  for (let i = 0; i < DEFUSE_TILES - bombs; i++) p *= (DEFUSE_TILES - bombs - i) / (DEFUSE_TILES - i);
  return p >= 0.01 ? `${Math.round(p * 100)}%` : `1 in ${Math.round(1 / p).toLocaleString("en-US")}`;
}

export function defusePage() {
  let bombs = 3;
  try {
    const b = Number(localStorage.getItem(BOMBS_KEY));
    if (b >= 1 && b < DEFUSE_TILES) bombs = b;
  } catch {
    // ignore
  }
  let run: DefuseRun | null = null;
  let busy = false;
  /** After a round: where the bombs were, the one that went off (if any), and the safe tiles found. */
  let shown: { mines: number[]; boom: number | null; found: number[] } | null = null;

  // ---------- grid ----------
  const tiles = Array.from({ length: DEFUSE_TILES }, (_, i) =>
    h("button", { class: "df-tile", type: "button", "aria-label": `Tile ${i + 1}`, onclick: () => void reveal(i) }),
  );
  const grid = h("div", { class: "df-grid" }, ...tiles);
  const banner = h("div", { class: "bh-banner" });
  const stage = h("div", { class: "df-stage" }, banner, grid);

  const drawGrid = () => {
    const revealed = new Set(run?.revealed ?? shown?.found ?? []);
    tiles.forEach((t, i) => {
      const mine = shown?.mines.includes(i);
      const state = revealed.has(i) ? "safe" : shown ? (mine ? (shown.boom === i ? "boom" : "mine") : "rest") : "hidden";
      t.className = `df-tile ${state}`;
      t.disabled = !run || busy || revealed.has(i);
      t.classList.toggle("over", !run && !!shown);
      t.replaceChildren(...(state === "safe" ? [icon("check", 26)] : mine ? [icon("bomb", 26)] : []));
    });
  };

  // ---------- controls ----------
  const bet = betInput();
  const bombsInput = h("input", { class: "bet-field", type: "number", min: "1", max: String(DEFUSE_TILES - 1), value: String(bombs), "aria-label": "Bombs" }) as HTMLInputElement;
  const presets = PRESETS.map((n) => h("button", { class: "bet-btn", type: "button", onclick: () => setBombs(n) }, String(n)));
  const setBombs = (n: number) => {
    bombs = Math.min(DEFUSE_TILES - 1, Math.max(1, Math.floor(n) || 1));
    bombsInput.value = String(bombs);
    try {
      localStorage.setItem(BOMBS_KEY, String(bombs));
    } catch {
      // ignore
    }
    drawInfo();
  };
  bombsInput.addEventListener("change", () => setBombs(Number(bombsInput.value)));
  const bombsEl = h("div", null, h("label", { class: "field-label" }, "Bombs"), h("div", { class: "bet-row" }, h("span", { class: "bet-cur" }, icon("bomb", 14)), bombsInput, ...presets));

  const info = h("div", { class: "bh-info" });
  const drawInfo = () => {
    const b = run?.bombs ?? bombs;
    const k = run?.revealed.length ?? 0;
    const safe = DEFUSE_TILES - b;
    info.replaceChildren(
      h("div", { class: "tip-row" }, h("span", null, "Next tile is safe"), h("b", null, `${Math.round(((DEFUSE_TILES - b - k) / (DEFUSE_TILES - k)) * 100)}%`)),
      h("div", { class: "tip-row" }, h("span", null, "Next tile pays"), h("b", null, `${defuseMultiplier(b, k + 1).toFixed(2)}x`)),
      h("div", { class: "tip-row" }, h("span", null, safe === 1 ? "Finding the 1 safe tile pays" : `Finding all ${safe} safe tiles pays`), h("b", null, `${defuseMultiplier(b, safe).toLocaleString("en-US")}x`)),
      h("div", { class: "tip-row" }, h("span", null, "Chance of finding them all"), h("b", null, clearOdds(b))),
    );
  };

  const startBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => void start() }, "Start round");
  const cashBtn = h("button", { class: "btn btn-lg bh-cash", onclick: () => void cashout() });
  const drawButtons = () => {
    startBtn.hidden = !!run;
    cashBtn.hidden = !run;
    if (run) cashBtn.textContent = run.revealed.length ? `Cash out ${money(Math.floor(run.stake * 100 * run.mult) / 100)} (${run.mult.toFixed(2)}x)` : "Take bet back";
    startBtn.disabled = cashBtn.disabled = busy;
    bet.setDisabled(busy || !!run);
    bombsInput.disabled = busy || !!run;
    presets.forEach((p) => (p.disabled = busy || !!run));
  };
  const redraw = () => {
    drawGrid();
    drawButtons();
    drawInfo();
  };

  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    drawButtons();
    try {
      await fn();
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
      redraw();
    }
  };

  const start = () =>
    guard(async () => {
      const r = await defuseAction("start", { bet: bet.value(), bombs });
      run = r.run;
      shown = null;
      banner.textContent = "";
      banner.className = "bh-banner";
      stage.classList.remove("exploded");
    });

  const reveal = (tile: number) =>
    guard(async () => {
      if (!run) return;
      const r = await defuseAction("reveal", { tile });
      if (r.result === "boom") {
        shown = { mines: r.mines!, boom: tile, found: run.revealed };
        playBoom();
        stage.classList.remove("exploded");
        void stage.offsetWidth;
        stage.classList.add("exploded");
        banner.textContent = `Boom. You hit a C4 after ${shown.found.length} safe tile${shown.found.length === 1 ? "" : "s"}.`;
        banner.className = "bh-banner lost";
        run = null;
        return;
      }
      playSafe();
      if (r.result === "cleared") {
        shown = { mines: r.mines!, boom: null, found: [...run.revealed, tile] };
        run = null;
        banner.textContent = `Board cleared: ${r.mult}x, +${money(r.payout!)}`;
        banner.className = "bh-banner won";
        return;
      }
      run = r.run;
    });

  const cashout = () =>
    guard(async () => {
      const found = run?.revealed ?? [];
      const r = await defuseAction("cashout");
      shown = { mines: r.mines ?? [], boom: null, found };
      run = null;
      if (r.result === "cashed") {
        banner.textContent = `Defused at ${r.mult}x: +${money(r.payout!)}`;
        banner.className = "bh-banner won";
      } else {
        banner.textContent = "Bet returned";
        banner.className = "bh-banner";
      }
    });

  // Pick up a round that's still open (reload, another tab).
  void defuseAction("state").then((r) => {
    run = r.run;
    redraw();
  });
  redraw();

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Defuse"),
    h(
      "div",
      { class: "game-layout" },
      h(
        "div",
        { class: "game-panel" },
        bet.el,
        bombsEl,
        info,
        startBtn,
        cashBtn,
        h("p", { class: "hint" }, "C4s are hidden under some tiles. Every safe tile raises the multiplier; hit a bomb and the bet is gone. Cash out whenever you like."),
      ),
      h("div", { class: "game-stage df-wrap" }, stage),
    ),
  );
}

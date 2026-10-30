import { hotkey } from "../hotkeys";
import { DEFUSE_TILES, defuseMultiplier } from "../odds";
import { defuseAction, InsufficientFunds, ServerError, type DefuseRun } from "../state";
import { autoBet } from "./auto-bet";
import { betInput } from "./bet-input";
import { h, money, mult, toast } from "./dom";
import { onLeave } from "./page";
import { icon } from "./icons";
import { playBoom, playSafe } from "./sound";

// Mines with C4s. The server already knows where the bombs are; the page only finds
// out by hitting one, or when the round ends.

const PRESETS = [1, 3, 5, 10, 24];
const BOMBS_KEY = "strafeclicker:defuse-bombs";

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
  /** Auto mode: the tiles to reveal every round, in the order they were picked. */
  let picks: number[] = [];
  let auto: ReturnType<typeof autoBet> | null = null;
  const autoMode = () => auto?.mode() === "auto";

  // ---------- grid ----------
  const tiles = Array.from({ length: DEFUSE_TILES }, (_, i) =>
    h("button", { class: "df-tile", type: "button", "aria-label": `Tile ${i + 1}`, onclick: () => (autoMode() ? togglePick(i) : void reveal(i)) }),
  );
  const grid = h("div", { class: "df-grid" }, ...tiles);
  const banner = h("div", { class: "bh-banner" });
  const stage = h("div", { class: "df-stage" }, banner, grid);

  const togglePick = (i: number) => {
    if (auto?.running()) return;
    if (picks.includes(i)) picks = picks.filter((x) => x !== i);
    else if (picks.length >= DEFUSE_TILES - bombs) return toast(`With ${bombs} bombs you can pick up to ${DEFUSE_TILES - bombs} tiles`, "error");
    else picks.push(i);
    shown = null;
    banner.textContent = "";
    stage.classList.remove("exploded");
    redraw();
  };

  const drawGrid = () => {
    const revealed = new Set(run?.revealed ?? shown?.found ?? []);
    tiles.forEach((t, i) => {
      const mine = shown?.mines.includes(i);
      const state = revealed.has(i) ? "safe" : shown ? (mine ? (shown.boom === i ? "boom" : "mine") : "rest") : "hidden";
      t.className = `df-tile ${state}`;
      // Auto mode: tiles are picked, not revealed, and the picks stay outlined.
      if (autoMode()) {
        t.disabled = !!auto?.running() || !!run;
        t.classList.toggle("picked", picks.includes(i));
        t.classList.toggle("over", !!shown);
        t.replaceChildren(...(state === "safe" ? [icon("check", 26)] : mine ? [icon("bomb", 26)] : []));
        return;
      }
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
    if (autoMode()) {
      info.replaceChildren(
        h("div", { class: "tip-row" }, h("span", null, "Tiles picked"), h("b", null, picks.length ? String(picks.length) : "Tap tiles to pick")),
        ...(picks.length ? [h("div", { class: "tip-row" }, h("span", null, "Each win pays"), h("b", null, mult(defuseMultiplier(b, picks.length))))] : []),
      );
      return;
    }
    info.replaceChildren(
      h("div", { class: "tip-row" }, h("span", null, "Next tile pays"), h("b", null, mult(defuseMultiplier(b, k + 1)))),
      h("div", { class: "tip-row" }, h("span", null, safe === 1 ? "Finding the 1 safe tile pays" : `Finding all ${safe} safe tiles pays`), h("b", null, mult(defuseMultiplier(b, safe)))),
    );
  };

  const startBtn = hotkey(h("button", { class: "btn btn-primary btn-lg", onclick: () => void start() }, "Start round"), "space r");
  const cashBtn = hotkey(h("button", { class: "btn btn-lg bh-cash", onclick: () => void cashout() }), "space");
  const drawButtons = () => {
    startBtn.hidden = !!run || autoMode();
    cashBtn.hidden = !run;
    if (run) cashBtn.textContent = run.revealed.length ? `Cash out ${money(Math.floor(run.stake * 100 * run.mult) / 100)} (${mult(run.mult)})` : "Take bet back";
    startBtn.disabled = cashBtn.disabled = busy;
    const locked = busy || !!run || !!auto?.running();
    bet.setDisabled(locked);
    bombsInput.disabled = locked;
    presets.forEach((p) => (p.disabled = locked));
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

  // ---------- auto ----------
  let left = false;
  onLeave(() => (left = true));
  /** One auto round: the server plays it in one go, then the picks flip over in order. */
  const autoRound = async (stake: number, speed: number): Promise<number | null> => {
    let res;
    try {
      res = (await defuseAction("auto", { bet: stake, bombs, tiles: picks })) as unknown as { result: "boom" | "cashed"; tile?: number; revealed: number[]; mines: number[]; mult: number; payout: number; stake: number };
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
      return null;
    }
    stage.classList.remove("exploded");
    banner.textContent = "";
    banner.className = "bh-banner";
    // Flip the safe ones one by one, then show where the bombs were.
    for (let k = 1; k <= res.revealed.length; k++) {
      shown = { mines: [], boom: null, found: res.revealed.slice(0, k) };
      drawGrid();
      if (!left) playSafe();
      await new Promise((ok) => setTimeout(ok, 70 / speed));
    }
    shown = { mines: res.mines, boom: res.result === "boom" ? res.tile! : null, found: res.revealed };
    drawGrid();
    if (res.result === "boom") {
      if (!left) playBoom();
      void stage.offsetWidth;
      stage.classList.add("exploded");
      banner.textContent = `Boom after ${res.revealed.length} safe tile${res.revealed.length === 1 ? "" : "s"}`;
      banner.className = "bh-banner lost";
    } else {
      banner.textContent = `${mult(res.mult)}: +${money(res.payout)}`;
      banner.className = "bh-banner won";
    }
    return Math.round((res.payout - res.stake) * 100) / 100;
  };
  let lastMode = "manual";
  auto = autoBet({
    bet,
    play: autoRound,
    delayMs: 600,
    canStart: () => (run ? "Finish the round you have open first" : !picks.length ? "Tap the tiles to reveal first" : null),
    onChange: ({ mode }) => {
      // Switching mode clears the board; starting or stopping auto keeps the last round on it.
      if (mode !== lastMode) {
        lastMode = mode;
        shown = null;
        banner.textContent = "";
      }
      redraw();
    },
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
        auto.modeEl,
        bet.el,
        bombsEl,
        info,
        startBtn,
        cashBtn,
        auto.el,
      ),
      h("div", { class: "game-stage df-wrap" }, stage),
    ),
  );
}

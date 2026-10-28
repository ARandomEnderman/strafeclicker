import { hotkey } from "../hotkeys";
import type { TowerDifficulty } from "../../shared/game.js";
import { TOWER_DIFFICULTIES, towerMultiplier } from "../odds";
import { InsufficientFunds, ServerError, towersAction, type TowerFloor, type TowerRun } from "../state";
import { betInput, segmented } from "./bet-input";
import { h, money, mult, toast } from "./dom";
import { icon } from "./icons";
import { playBoom, playSafe } from "./sound";

// Towers: climb floor after floor, picking a door each time. It never ends; cash out
// whenever you like.

const DIFFS = Object.keys(TOWER_DIFFICULTIES) as TowerDifficulty[];
const DIFF_KEY = "strafeclicker:towers";
const AHEAD = 4; // locked floors shown above the current one

export function towersPage() {
  let difficulty: TowerDifficulty = "medium";
  try {
    const d = localStorage.getItem(DIFF_KEY) as TowerDifficulty;
    if (DIFFS.includes(d)) difficulty = d;
  } catch {
    // ignore
  }
  let run: TowerRun | null = null;
  /** The floors of the run that just ended, to keep them on screen. */
  let ended: { floors: TowerFloor[]; caught: boolean } | null = null;
  let busy = false;

  const tower = h("div", { class: "tw-tower" });
  const banner = h("div", { class: "bh-banner" });
  const stage = h("div", { class: "tw-stage" }, tower);

  const diff = () => (run?.difficulty as TowerDifficulty) ?? difficulty;

  const floorRow = (n: number, state: "done" | "current" | "locked" | "caught", floor?: TowerFloor) => {
    const d = TOWER_DIFFICULTIES[diff()];
    const doors = Array.from({ length: d.doors }, (_, i) => {
      const isT = floor?.ts.includes(i);
      const picked = floor?.door === i;
      let cls = "tw-door";
      let content: Node | string = icon("door", 22);
      if (state === "done" || state === "caught") {
        if (picked && !isT) ((cls += " safe"), (content = icon("check", 22)));
        else if (isT) ((cls += picked ? " caught" : " t"), (content = icon("skull", 22)));
        else cls += " rest";
      }
      return h("button", { type: "button", class: cls, disabled: state !== "current" || busy, onclick: () => void pick(i) }, content);
    });
    return h(
      "div",
      { class: `tw-floor ${state}`, "data-floor": n },
      h("div", { class: "tw-label" }, h("span", null, `Floor ${n}`), h("b", null, mult(towerMultiplier(diff(), n)))),
      h("div", { class: "tw-doors", style: `--doors:${d.doors}` }, ...doors),
    );
  };

  const draw = () => {
    const floors = run?.floors ?? ended?.floors ?? [];
    const rows: HTMLElement[] = [];
    floors.forEach((f, i) => rows.push(floorRow(i + 1, ended?.caught && i === floors.length - 1 ? "caught" : "done", f)));
    const next = floors.length + 1;
    if (run) rows.push(floorRow(next, "current"));
    for (let k = run ? 1 : 0; k < AHEAD; k++) rows.push(floorRow(next + k, "locked"));
    // Bottom floor at the bottom.
    tower.replaceChildren(...rows.reverse());
    // Keep the current floor (or the last one played) in view.
    const focus = tower.querySelector(".tw-floor.current") ?? tower.querySelector(".tw-floor.caught, .tw-floor.done");
    focus?.scrollIntoView({ block: "center", behavior: "smooth" });
    drawButtons();
    drawInfo();
  };

  // ---------- controls ----------
  const bet = betInput();
  const diffSeg = segmented<TowerDifficulty>(
    "Difficulty",
    DIFFS.map((d) => ({ value: d, label: TOWER_DIFFICULTIES[d].name })),
    difficulty,
    (v) => {
      difficulty = v;
      try {
        localStorage.setItem(DIFF_KEY, v);
      } catch {
        // ignore
      }
      if (!run) {
        ended = null;
        draw();
      }
    },
  );
  const info = h("div", { class: "bh-info" });
  const drawInfo = () => {
    const k = run?.floors.length ?? 0;
    info.replaceChildren(
      h("div", { class: "tip-row" }, h("span", null, "Next floor pays"), h("b", null, mult(towerMultiplier(diff(), k + 1)))),
    );
  };
  const startBtn = hotkey(h("button", { class: "btn btn-primary btn-lg", onclick: () => void start() }, "Start climbing"), "space r");
  const cashBtn = hotkey(h("button", { class: "btn btn-lg bh-cash", onclick: () => void cashout() }), "space");
  const drawButtons = () => {
    startBtn.hidden = !!run;
    cashBtn.hidden = !run;
    if (run) cashBtn.textContent = run.floors.length ? `Cash out ${money(Math.floor(run.stake * 100 * run.mult) / 100)} (${mult(run.mult)})` : "Take bet back";
    startBtn.disabled = cashBtn.disabled = busy;
    bet.setDisabled(busy || !!run);
    diffSeg.setDisabled(busy || !!run);
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
      draw();
    }
  };

  const start = () =>
    guard(async () => {
      const r = await towersAction("start", { bet: bet.value(), difficulty });
      run = r.run;
      ended = null;
      banner.textContent = "";
      banner.className = "bh-banner";
    });

  const pick = (door: number) =>
    guard(async () => {
      if (!run) return;
      const r = await towersAction("pick", { door });
      if (r.result === "caught") {
        playBoom();
        ended = { floors: r.floors!, caught: true };
        run = null;
        banner.textContent = `A T was behind that door on floor ${r.floors!.length}.`;
        banner.className = "bh-banner lost";
        return;
      }
      playSafe();
      if (r.result === "top") {
        ended = { floors: r.floors!, caught: false };
        run = null;
        banner.textContent = `You reached the top: ${mult(r.mult!)}, +${money(r.payout!)}`;
        banner.className = "bh-banner won";
        return;
      }
      run = r.run;
    });

  const cashout = () =>
    guard(async () => {
      const floors = run?.floors ?? [];
      const r = await towersAction("cashout");
      ended = { floors, caught: false };
      run = null;
      if (r.result === "cashed") {
        banner.textContent = `Cashed out on floor ${floors.length}: ${mult(r.mult!)}, +${money(r.payout!)}`;
        banner.className = "bh-banner won";
      } else {
        banner.textContent = "Bet returned";
        banner.className = "bh-banner";
      }
    });

  void towersAction("state").then((r) => {
    run = r.run;
    draw();
  });
  draw();

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Towers"),
    h(
      "div",
      { class: "game-layout" },
      h("div", { class: "game-panel" }, bet.el, diffSeg.el, info, startBtn, cashBtn),
      h("div", { class: "game-stage tw-wrap" }, banner, stage),
    ),
  );
}

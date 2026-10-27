import type { RouletteColor } from "../../shared/game.js";
import { serverNow } from "../live";
import { ROULETTE_BET_MS, ROULETTE_COLORS, ROULETTE_PAYOUT, ROULETTE_SPIN_MS, ROULETTE_WHEEL, rouletteColor } from "../odds";
import { onRoulette, rouletteState, type RouletteState } from "../roulette";
import { getState, InsufficientFunds, rouletteBet, ServerError } from "../state";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { userLink } from "./profile-card";
import { playReveal, playTick } from "./sound";

// One wheel for everyone. The strip's start and end positions only depend on the last
// number, the next number and the server's stopping point, and the spin follows the
// server clock, so every browser shows the same strip in the same place.

const PITCH = 80; // px from one tile to the next (tile + gap)
const CYCLES = 24; // copies of the wheel on the strip
const START_CYCLE = 4;
const SPIN_CYCLES = 9; // whole turns per spin
const EASING = "cubic-bezier(0.12, 0.8, 0.2, 1)";
const LABEL: Record<RouletteColor, string> = { t: "T", ct: "CT", green: "Green" };

const tileIndex = (n: number) => ROULETTE_WHEEL.indexOf(n);

export function roulettePage() {
  // ---------- strip ----------
  const strip = h("div", { class: "rl-strip" });
  for (let c = 0; c < CYCLES; c++) {
    for (const n of ROULETTE_WHEEL) strip.append(h("div", { class: `rl-tile ${rouletteColor(n)}` }, String(n)));
  }
  const viewport = h("div", { class: "rl-viewport" }, strip, h("div", { class: "rl-marker" }));
  const status = h("div", { class: "rl-status" });
  const bar = h("i");
  const timer = h("div", { class: "fb-timer rl-timer" }, bar);
  const history = h("div", { class: "fb-history rl-history" });

  /** Translate that puts position `p` (in tiles along the strip) under the marker. */
  const xFor = (p: number) => viewport.clientWidth / 2 - p * PITCH;
  const restPos = (n: number) => START_CYCLE * 15 + tileIndex(n) + 0.5;

  let anim: Animation | null = null;
  let animRound = -1;
  const place = (s: RouletteState) => {
    const last = s.history[0] ?? 0;
    if (s.phase === "betting") {
      anim?.cancel();
      anim = null;
      animRound = -1;
      strip.style.transform = `translateX(${xFor(restPos(last))}px)`;
      return;
    }
    // Spinning or showing the result: one animation per round, joined mid-way if late.
    if (animRound === s.round) return;
    animRound = s.round;
    // While spinning the history doesn't have this round's number yet; after, it does.
    const from = restPos(s.phase === "spinning" ? last : (s.history[1] ?? 0));
    const to = (START_CYCLE + SPIN_CYCLES) * 15 + tileIndex(s.number!) + s.stop!;
    anim?.cancel();
    anim = strip.animate([{ transform: `translateX(${xFor(from)}px)` }, { transform: `translateX(${xFor(to)}px)` }], {
      duration: ROULETTE_SPIN_MS,
      easing: EASING,
      fill: "forwards",
    });
    anim.currentTime = Math.min(ROULETTE_SPIN_MS, Math.max(0, serverNow() - s.spinAt));
    // Ticks as tiles pass the marker.
    let lastTile = Math.floor(from);
    const tick = () => {
      if (!anim || anim.playState !== "running") return;
      const x = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41;
      const t = Math.floor((viewport.clientWidth / 2 - x) / PITCH);
      if (t !== lastTile) {
        playTick();
        lastTile = t;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // ---------- betting ----------
  const bet = betInput();
  const columns = Object.fromEntries(
    ROULETTE_COLORS.map((c) => {
      const btn = h("button", { class: `btn btn-lg rl-bet ${c}`, onclick: () => void place_(c) }, `${LABEL[c]} · ${ROULETTE_PAYOUT[c]}x`);
      const total = h("span", { class: "rl-col-total" });
      const list = h("div", { class: "rl-col-list" });
      const col = h("div", { class: `rl-col ${c}` }, btn, h("div", { class: "rl-col-head" }, h("span", null, "Total bet"), total), list);
      return [c, { col, btn, total, list }];
    }),
  ) as unknown as Record<RouletteColor, { col: HTMLElement; btn: HTMLButtonElement; total: HTMLElement; list: HTMLElement }>;

  let busy = false;
  const place_ = async (color: RouletteColor) => {
    if (busy) return;
    busy = true;
    try {
      await rouletteBet(color, bet.value());
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
    }
  };

  const drawBets = (s: RouletteState) => {
    const me = getState().username;
    const won = s.phase === "result" ? rouletteColor(s.number!) : null;
    for (const c of ROULETTE_COLORS) {
      const { col, btn, total, list } = columns[c];
      const bets = s.bets.filter((b) => b.color === c);
      total.textContent = money(bets.reduce((x, b) => x + b.stake, 0));
      btn.disabled = s.phase !== "betting";
      col.classList.toggle("won", won === c);
      col.classList.toggle("lost", won != null && won !== c);
      list.replaceChildren(
        ...bets.map((b) =>
          h(
            "div",
            { class: `rl-bet-row${b.user === me ? " me" : ""}` },
            userLink(b.user, b.name, { avatar: true }),
            h("b", null, won === c ? `+${money(b.stake * ROULETTE_PAYOUT[c])}` : money(b.stake)),
          ),
        ),
      );
    }
    history.replaceChildren(...s.history.slice(0, 20).map((n) => h("span", { class: `rl-chip ${rouletteColor(n)}` }, String(n))));
  };

  // ---------- status line + clock ----------
  let raf = 0;
  let lastPhase = "";
  const loop = () => {
    const s = rouletteState();
    if (s) {
      if (s.phase === "betting") {
        const left = Math.max(0, s.spinAt - serverNow());
        status.textContent = `Rolling in ${(left / 1000).toFixed(1)}s`;
        bar.style.width = `${(left / ROULETTE_BET_MS) * 100}%`;
        timer.hidden = false;
      } else {
        timer.hidden = true;
        const done = s.phase === "result" || serverNow() - s.spinAt >= ROULETTE_SPIN_MS;
        status.textContent = done ? `Landed on ${s.number} · ${LABEL[rouletteColor(s.number!)]}` : "Rolling...";
        status.className = `rl-status${done ? ` ${rouletteColor(s.number!)}` : ""}`;
        if (s.phase === "result" && lastPhase === "spinning") playReveal(rouletteColor(s.number!) === "green" ? "gold" : "restricted");
      }
      if (s.phase === "betting") status.className = "rl-status";
      lastPhase = s.phase;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));

  const onState = (s: RouletteState) => {
    place(s);
    drawBets(s);
  };
  onLeave(onRoulette(onState));
  const s0 = rouletteState();
  // Wait a frame so the viewport has its width.
  requestAnimationFrame(() => s0 && onState(s0));

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Roulette"),
    h("div", { class: "game-stage rl-stage" }, history, viewport, h("div", { class: "rl-under" }, status, timer)),
    h("div", { class: "rl-controls" }, bet.el),
    h("div", { class: "rl-cols" }, columns.t.col, columns.green.col, columns.ct.col),
  );
}

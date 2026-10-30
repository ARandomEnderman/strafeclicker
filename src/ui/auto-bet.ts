import { segmented } from "./bet-input";
import { decimalInput, h, money, parseDecimal } from "./dom";
import { onLeave } from "./page";

// The Manual / Auto switch and the auto-bet settings, shared by the games that have an
// auto mode. Auto plays `play(stake)` over and over: for a number of bets (or until
// stopped), stopping early on a profit or loss target, and optionally raising the bet by
// a percentage after a win or a loss (back to the base bet otherwise). A speed setting
// shortens the pause between bets and each bet's animation.

type OnResult = "reset" | "raise";

export interface AutoBetOptions {
  /** The game's bet field. */
  bet: { value: () => number; set: (v: number) => void };
  /** One bet at `speed` times the normal pace; resolves to its profit (payout minus stake), or null to stop (an error, say). */
  play: (stake: number, speed: number) => Promise<number | null>;
  /** Pause between bets at normal speed. */
  delayMs: number;
  /** Called when switching mode and when auto starts or stops. */
  onChange?: (state: { mode: "manual" | "auto"; running: boolean }) => void;
  /** Checked before starting; return an error message to refuse. */
  canStart?: () => string | null;
}

const SPEEDS = [1, 2, 5, 10];
/** Remembered across games and visits. */
let speed = 1;

export function autoBet(opts: AutoBetOptions) {
  let mode: "manual" | "auto" = "manual";
  let running = false;
  let stopRequested = false;
  const changed = () => opts.onChange?.({ mode, running });

  const num = (placeholder: string) => decimalInput({ class: "search auto-input", placeholder });
  const count = num("No limit");
  const profit = num("Off");
  const loss = num("Off");
  const winPct = num("0");
  const lossPct = num("0");
  let onWin: OnResult = "reset";
  let onLoss: OnResult = "reset";
  const field = (label: string, input: HTMLElement) => h("div", { class: "ab-field" }, h("label", { class: "field-label" }, label), input);
  const rule = (label: string, set: (v: OnResult) => void, input: HTMLInputElement) => {
    const seg = segmented<OnResult>(
      label,
      [
        { value: "reset", label: "Reset" },
        { value: "raise", label: "Raise" },
      ],
      "reset",
      (v) => {
        set(v);
        input.disabled = v === "reset";
      },
    );
    input.disabled = true;
    return h("div", { class: "auto-rule" }, seg.el, h("label", { class: "auto-pct" }, input, h("span", null, "%")));
  };

  // Can change while auto runs: it applies from the next bet.
  const speedSeg = segmented<number>(
    "Speed",
    SPEEDS.map((x) => ({ value: x, label: `${x}x` })),
    speed,
    (v) => (speed = v),
  );
  const status = h("div", { class: "auto-status" });
  const startBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => (running ? (stopRequested = true) : void run()) }, "Start auto");
  const settings = h(
    "div",
    { class: "auto-settings", hidden: true },
    field("Number of bets", count),
    h("div", { class: "auto-pair" }, field("Stop at profit ($)", profit), field("Stop at loss ($)", loss)),
    rule("On win", (v) => (onWin = v), winPct),
    rule("On loss", (v) => (onLoss = v), lossPct),
    speedSeg.el,
    startBtn,
    status,
  );
  const modeSeg = segmented<"manual" | "auto">(
    "Mode",
    [
      { value: "manual", label: "Manual" },
      { value: "auto", label: "Auto" },
    ],
    mode,
    (v) => {
      mode = v;
      settings.hidden = v !== "auto";
      changed();
    },
  );

  const drawStatus = (done: number, total: number | null, net: number) => {
    status.replaceChildren(
      h("span", null, `${done}${total ? ` / ${total}` : ""} bets`),
      h("b", { class: net >= 0 ? "up" : "down" }, `${net >= 0 ? "+" : "-"}${money(Math.abs(net))}`),
    );
  };

  async function run() {
    const refusal = opts.canStart?.();
    if (refusal) return void (status.textContent = refusal);
    const total = Math.floor(parseDecimal(count.value)) || null;
    const stopProfit = parseDecimal(profit.value) || null;
    const stopLoss = parseDecimal(loss.value) || null;
    const base = opts.bet.value();
    running = true;
    stopRequested = false;
    startBtn.textContent = "Stop auto";
    startBtn.classList.replace("btn-primary", "btn-danger");
    modeSeg.setDisabled(true);
    settings.querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.dataset.wasDisabled = String(i.disabled), (i.disabled = true)));
    changed();
    let done = 0;
    let net = 0;
    drawStatus(0, total, 0);
    while (!stopRequested && !left && (!total || done < total)) {
      const stake = opts.bet.value();
      const p = await opts.play(stake, speed);
      if (p == null) break;
      done++;
      net = Math.round((net + p) * 100) / 100;
      drawStatus(done, total, net);
      if (stopProfit && net >= stopProfit) break;
      if (stopLoss && -net >= stopLoss) break;
      // Next bet: back to the base, or raised by the percentage.
      const pct = p > 0 ? (onWin === "raise" ? parseDecimal(winPct.value) || 0 : null) : onLoss === "raise" ? parseDecimal(lossPct.value) || 0 : null;
      opts.bet.set(pct == null ? base : stake * (1 + pct / 100));
      if (!stopRequested) await new Promise((r) => setTimeout(r, opts.delayMs / speed));
    }
    // Back to the bet you started with, so a run of raises doesn't leave a big bet behind.
    opts.bet.set(base);
    running = false;
    startBtn.textContent = "Start auto";
    startBtn.classList.replace("btn-danger", "btn-primary");
    modeSeg.setDisabled(false);
    settings.querySelectorAll<HTMLInputElement>("input").forEach((i) => (i.disabled = i.dataset.wasDisabled === "true"));
    changed();
  }
  let left = false;
  onLeave(() => {
    left = true;
    stopRequested = true;
  });

  return {
    /** The Manual / Auto switch. */
    modeEl: modeSeg.el,
    /** The auto settings and start button (hidden in manual mode). */
    el: settings,
    mode: () => mode,
    running: () => running,
  };
}

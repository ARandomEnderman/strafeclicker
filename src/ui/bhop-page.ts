import { hotkey } from "../hotkeys";
import type { BhopDifficulty } from "../../shared/game.js";
import { BHOP_DIFFICULTIES, bhopMultiplier } from "../odds";
import { applyAccount, bhopAction, InsufficientFunds, ServerError, type BhopResult, type BhopRun } from "../state";
import { agentSprite } from "./agent-sprite";
import { betInput, segmented } from "./bet-input";
import { h, money, mult, toast } from "./dom";
import { onLeave } from "./page";
import { playTick } from "./sound";

// Jump along a lane of bhop blocks. The server already knows which block gives way;
// the page only finds out by landing on it, or when the run ends.

const SPACING = 150; // px from one block to the next
const JUMP_MS = 520;
const DIFF_KEY = "strafeclicker:bhop";
const DIFFS = Object.keys(BHOP_DIFFICULTIES) as BhopDifficulty[];

export function bhopPage() {
  let difficulty: BhopDifficulty = "medium";
  try {
    const d = localStorage.getItem(DIFF_KEY) as BhopDifficulty;
    if (DIFFS.includes(d)) difficulty = d;
  } catch {
    // ignore
  }
  let run: BhopRun | null = null;
  let busy = false;
  let pos = 0; // block the agent stands on (0 = start ledge)

  // ---------- stage ----------
  const lane = h("div", { class: "bh-lane" });
  // The wrapper moves; the picture inside is centred on it whatever its width.
  const agentImg = h("img", { alt: "" }) as HTMLImageElement;
  void agentSprite().then((src) => (agentImg.src = src));
  const agent = h("div", { class: "bh-agent" }, agentImg);
  lane.append(agent);
  const stage = h("div", { class: "bh-stage" }, h("div", { class: "bh-sky" }), lane);
  const banner = h("div", { class: "bh-banner" });
  stage.append(banner);

  let blocks: HTMLElement[] = [];
  const buildLane = (d: BhopDifficulty) => {
    const { steps } = BHOP_DIFFICULTIES[d];
    blocks.forEach((b) => b.remove());
    lane.querySelectorAll(".bh-ghost").forEach((g) => g.remove());
    blocks = Array.from({ length: steps + 1 }, (_, i) =>
      h(
        "div",
        { class: `bh-block${i === 0 ? " start" : ""}`, style: `left:${i * SPACING}px` },
        h("span", { class: "bh-mult" }, i === 0 ? "Start" : mult(bhopMultiplier(d, i))),
      ),
    );
    lane.prepend(...blocks);
  };

  /** Put block `i` about a third of the way across the stage. */
  const camera = (i: number, animate: boolean, ms = JUMP_MS) => {
    const x = -i * SPACING + Math.min(stage.clientWidth * 0.3, 220);
    lane.style.transition = animate ? `transform ${ms}ms ease-in-out` : "none";
    lane.style.transform = `translateX(${x}px)`;
  };
  const placeAgent = (i: number) => {
    agent.getAnimations().forEach((a) => a.cancel());
    agent.style.transform = `translateX(${i * SPACING}px)`;
  };
  const markBlocks = () => blocks.forEach((b, i) => b.classList.toggle("passed", i > 0 && i <= pos));

  let revealTimers: ReturnType<typeof setTimeout>[] = [];
  const reset = () => {
    revealTimers.forEach(clearTimeout);
    revealTimers = [];
    pos = 0;
    buildLane(run?.difficulty as BhopDifficulty ?? difficulty);
    placeAgent(0);
    camera(0, false);
    banner.textContent = "";
    banner.className = "bh-banner";
  };

  /** Hop to block `to`; if it breaks, fall through it. */
  const jumpTo = (to: number, breaks: boolean) =>
    new Promise<void>((done) => {
      const from = pos * SPACING;
      const dx = (to - pos) * SPACING;
      camera(to, true);
      const a = agent.animate(
        [
          { transform: `translate(${from}px, 0) rotate(0deg)` },
          { transform: `translate(${from + dx * 0.5}px, -70px) rotate(-6deg)`, easing: "cubic-bezier(.5,0,1,1)" },
          { transform: `translate(${from + dx}px, 0) rotate(0deg)` },
        ],
        { duration: JUMP_MS, easing: "cubic-bezier(0,.4,.6,1)", fill: "forwards" },
      );
      a.finished.then(() => {
        pos = to;
        agent.style.transform = `translateX(${to * SPACING}px)`;
        a.cancel();
        if (!breaks) {
          playTick();
          markBlocks();
          return done();
        }
        blocks[to]?.classList.add("broken");
        agent
          .animate([{ transform: `translate(${from + dx}px, 0)` }, { transform: `translate(${from + dx}px, 420px) rotate(25deg)`, opacity: 0 }], {
            duration: 700,
            easing: "cubic-bezier(.5,0,1,1)",
            fill: "forwards",
          })
          .finished.then(() => done());
      });
    });

  /** End of a run: show where the lane would have broken. */
  /**
   * After cashing out: the blocks you could still have landed on light up, then the
   * camera pans to the one that would have given way and drops it, and comes back.
   */
  const reveal = (breaksAt: number | null | undefined) => {
    const end = breaksAt ?? blocks.length;
    blocks.forEach((b, i) => {
      if (i > pos && i < end) b.classList.add("would-hold");
      if (i > end) b.classList.add("beyond");
    });
    if (breaksAt == null || !blocks[breaksAt]) {
      banner.textContent += " · The whole lane would have held";
      return;
    }
    const block = blocks[breaksAt];
    const ghost = h("div", { class: "bh-ghost", style: `left:${breaksAt * SPACING}px` }, h("span", null, "Would have broken"));
    lane.append(ghost);
    // Only pan if it's off to the right of what's on screen.
    const visible = Math.floor((stage.clientWidth - Math.min(stage.clientWidth * 0.3, 220)) / SPACING) - 1;
    const far = breaksAt - pos > visible;
    const panMs = far ? Math.min(1600, 300 + (breaksAt - pos) * 90) : 0;
    if (far) camera(breaksAt - 1, true, panMs);
    revealTimers.push(
      setTimeout(() => block.classList.add("would-break"), panMs + 150),
      setTimeout(() => far && camera(pos, true, panMs), panMs + 2600),
    );
  };

  // ---------- controls ----------
  const bet = betInput();
  const diffSeg = segmented<BhopDifficulty>(
    "Difficulty",
    DIFFS.map((d) => ({ value: d, label: BHOP_DIFFICULTIES[d].name })),
    difficulty,
    (v) => {
      difficulty = v;
      try {
        localStorage.setItem(DIFF_KEY, v);
      } catch {
        // ignore
      }
      if (!run) reset();
      drawInfo();
    },
  );
  const info = h("div", { class: "bh-info" });
  const drawInfo = () => {
    const d = BHOP_DIFFICULTIES[(run?.difficulty as BhopDifficulty) ?? difficulty];
    info.replaceChildren(
      h("div", { class: "tip-row" }, h("span", null, "Max win"), h("b", null, mult(bhopMultiplier((run?.difficulty as BhopDifficulty) ?? difficulty, d.steps)))),
    );
  };

  // Space also starts a run (and jumps during one, below).
  const startBtn = hotkey(h("button", { class: "btn btn-primary btn-lg", onclick: () => void start() }, "Start run"), "space r");
  const jumpBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => void jump() }, "Jump");
  const cashBtn = h("button", { class: "btn btn-lg bh-cash", onclick: () => void cashout() });

  const drawButtons = () => {
    startBtn.hidden = !!run;
    jumpBtn.hidden = !run;
    cashBtn.hidden = !run;
    if (run) {
      const d = run.difficulty as BhopDifficulty;
      const next = bhopMultiplier(d, run.step + 1);
      jumpBtn.textContent = `Jump to ${mult(next)}`;
      cashBtn.textContent = run.step === 0 ? "Take bet back" : `Cash out ${money(Math.floor(run.stake * 100 * run.mult) / 100)}`;
    }
    [startBtn, jumpBtn, cashBtn].forEach((b) => (b.disabled = busy));
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
      drawButtons();
      drawInfo();
    }
  };

  const start = () =>
    guard(async () => {
      const r = await bhopAction("start", { bet: bet.value(), difficulty });
      run = r.run;
      reset();
    });

  const jump = () =>
    guard(async () => {
      // The account (stats, a finished run's payout) is shown once the jump lands.
      const r = (await bhopAction("jump", {}, true)) as BhopResult & { account: Parameters<typeof applyAccount>[0] };
      const fell = r.result === "fell";
      await jumpTo(r.step!, fell);
      applyAccount(r.account);
      run = r.run;
      if (fell) {
        banner.textContent = `Fell through on block ${r.step}`;
        banner.className = "bh-banner lost";
      } else if (r.result === "finished") {
        banner.textContent = `Made it to the end: ${r.mult}x, +${money(r.payout!)}`;
        banner.className = "bh-banner won";
      }
    });

  const cashout = () =>
    guard(async () => {
      const r = await bhopAction("cashout");
      run = null;
      if (r.result === "cashed") {
        banner.textContent = `Cashed out at ${r.mult}x: +${money(r.payout!)}`;
        banner.className = "bh-banner won";
      } else {
        banner.textContent = "Bet returned";
        banner.className = "bh-banner";
      }
      reveal(r.breaksAt);
    });

  // Space jumps, Enter cashes out.
  const onKey = (e: KeyboardEvent) => {
    if (!run || (e.target as HTMLElement).closest("input")) return;
    if (e.code === "Space") {
      e.preventDefault();
      void jump();
    } else if (e.code === "Enter") void cashout();
  };
  window.addEventListener("keydown", onKey);
  onLeave(() => window.removeEventListener("keydown", onKey));

  // Pick up a run that's still open (reload, another tab).
  void bhopAction("state").then((r) => {
    run = r.run;
    reset();
    if (run) {
      pos = run.step;
      placeAgent(pos);
      camera(pos, false);
      markBlocks();
    }
    drawButtons();
    drawInfo();
  });
  reset();
  drawButtons();
  drawInfo();

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "B-hop"),
    h(
      "div",
      { class: "game-layout" },
      h(
        "div",
        { class: "game-panel" },
        bet.el,
        diffSeg.el,
        info,
        startBtn,
        jumpBtn,
        cashBtn,
        h("p", { class: "hint" }, "Space to jump, Enter to cash out."),
      ),
      h("div", { class: "game-stage bh-wrap" }, stage),
    ),
  );
}

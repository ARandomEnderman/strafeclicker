import flashbangImg from "../assets/flashbang.webp";
import { fbState, onFlashbang, setWatchingFlashbang, type FbBet, type FbState } from "../flashbang";
import { serverNow } from "../live";
import { FB_AUTO_MIN, FB_GROWTH, FB_INTERMISSION_MS, FB_MAX, fbMultiplierAt } from "../odds";
import { flashbangAction, getState, InsufficientFunds, ServerError } from "../state";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";

// Crash game. The server runs one round for everyone; this page draws the multiplier
// curve with the flashbang riding its tip, and the pop.

const AUTO_KEY = "strafeclicker:fb-auto";
const fmt = (m: number) => `${m.toFixed(2)}x`;
/** Growth per second, for drawing the curve. */
const G = FB_GROWTH * 1000;
const multClass = (m: number) => (m >= 10 ? "m-high" : m >= 2 ? "m-mid" : "m-low");

export function flashbangPage() {
  setWatchingFlashbang(true);
  onLeave(() => setWatchingFlashbang(false));

  // ---------- stage ----------
  const canvas = h("canvas", { class: "fb-canvas" }) as HTMLCanvasElement;
  const nade = h("img", { class: "fb-nade", src: flashbangImg, alt: "" });
  const burst = h("div", { class: "fb-burst" });
  const big = h("div", { class: "fb-mult" });
  const sub = h("div", { class: "fb-sub" });
  const bar = h("i");
  const timerBar = h("div", { class: "fb-timer" }, bar);
  const stage = h("div", { class: "fb-stage" }, canvas, burst, nade, h("div", { class: "fb-center" }, big, sub, timerBar));
  const history = h("div", { class: "fb-history" });

  let poppedAt = 0; // local time of the last pop, for the burst animation
  let popMult = 1;

  const draw = () => {
    const s = fbState();
    const box = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(box.width * dpr) || canvas.height !== Math.round(box.height * dpr)) {
      canvas.width = Math.round(box.width * dpr);
      canvas.height = Math.round(box.height * dpr);
    }
    const c = canvas.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, box.width, box.height);
    if (!s) return;

    const running = s.phase === "running" && s.startAt != null;
    const elapsed = running ? serverNow() - s.startAt! : 0;
    const popShowing = !running && performance.now() - poppedAt < 3000;
    const m = running ? fbMultiplierAt(elapsed) : popShowing ? popMult : 1;
    const sinceSecs = Math.max(8, (running ? elapsed / 1000 : popShowing ? Math.log(popMult) / G : 0) + 2);
    const topMult = Math.max(2, m * 1.25);
    const pad = { l: 44, r: 24, t: 24, b: 28 };
    const w = box.width - pad.l - pad.r;
    const hgt = box.height - pad.t - pad.b;
    const X = (sec: number) => pad.l + (sec / sinceSecs) * w;
    const Y = (mult: number) => pad.t + hgt - ((mult - 1) / (topMult - 1)) * hgt;

    // Grid lines at round multipliers.
    c.font = "11px system-ui, sans-serif";
    c.fillStyle = "#6b7286";
    c.strokeStyle = "rgba(255,255,255,0.05)";
    const step = topMult > 20 ? 10 : topMult > 6 ? 2 : topMult > 3 ? 0.5 : 0.25;
    for (let v = 1; v <= topMult; v += step) {
      c.beginPath();
      c.moveTo(pad.l, Y(v));
      c.lineTo(box.width - pad.r, Y(v));
      c.stroke();
      c.fillText(`${+v.toFixed(2)}x`, 6, Y(v) + 4);
    }

    // The curve so far.
    const showCurve = running || popShowing;
    const secs = running ? elapsed / 1000 : Math.log(popMult) / G;
    let tip = { x: X(0), y: Y(1) };
    if (showCurve && secs > 0) {
      const grad = c.createLinearGradient(0, Y(topMult), 0, Y(1));
      grad.addColorStop(0, running ? "rgba(245,165,36,0.35)" : "rgba(239,91,91,0.3)");
      grad.addColorStop(1, "rgba(245,165,36,0)");
      c.beginPath();
      c.moveTo(X(0), Y(1));
      const n = 80;
      for (let i = 1; i <= n; i++) {
        const t = (secs * i) / n;
        c.lineTo(X(t), Y(Math.exp(G * t)));
      }
      tip = { x: X(secs), y: Y(Math.exp(G * secs)) };
      c.strokeStyle = running ? "#f5a524" : "#ef5b5b";
      c.lineWidth = 3;
      c.stroke();
      c.lineTo(tip.x, Y(1));
      c.closePath();
      c.fillStyle = grad;
      c.fill();
    }

    // Flashbang at the tip (resting bottom-left between rounds), wobbling as it flies.
    const now = performance.now();
    const popped = popShowing;
    nade.style.opacity = popped ? "0" : "1";
    const wobble = running ? Math.sin(now / 140) * 8 + Math.min(40, secs * 3) : -15;
    const size = Math.max(42, Math.min(70, box.height * 0.16));
    nade.style.height = `${size}px`;
    nade.style.transform = `translate(${tip.x - size * 0.2}px, ${tip.y - size * 0.8}px) rotate(${wobble}deg)`;
    burst.style.transform = `translate(${tip.x}px, ${tip.y}px)`;

    // Centre text.
    if (running) {
      big.textContent = fmt(m);
      big.className = "fb-mult";
      sub.textContent = "";
      timerBar.hidden = true;
    } else if (popped && s.last) {
      big.textContent = fmt(s.last.crash);
      big.className = "fb-mult popped";
      sub.textContent = "Popped";
      timerBar.hidden = true;
    } else {
      const left = Math.max(0, (s.nextAt ?? 0) - serverNow());
      big.textContent = `${(left / 1000).toFixed(1)}s`;
      big.className = "fb-mult waiting";
      sub.textContent = "Next round starts in";
      timerBar.hidden = false;
      bar.style.width = `${(left / FB_INTERMISSION_MS) * 100}%`;
    }
    drawButton();
  };

  let raf = 0;
  const loop = () => {
    draw();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));

  // ---------- controls ----------
  const bet = betInput();
  let savedAuto = "";
  try {
    savedAuto = localStorage.getItem(AUTO_KEY) ?? "";
  } catch {
    // ignore
  }
  const auto = h("input", {
    class: "bet-field auto-field",
    type: "number",
    min: String(FB_AUTO_MIN),
    max: String(FB_MAX),
    step: "0.01",
    placeholder: "Off",
    value: savedAuto,
    inputmode: "decimal",
    "aria-label": "Auto cash out at",
  }) as HTMLInputElement;
  auto.addEventListener("change", () => {
    try {
      localStorage.setItem(AUTO_KEY, auto.value);
    } catch {
      // ignore
    }
  });
  const autoEl = h("div", null, h("label", { class: "field-label" }, "Auto cash out at"), h("div", { class: "bet-row" }, auto, h("span", { class: "bet-suffix" }, "x")));

  const mainBtn = h("button", { class: "btn btn-primary btn-lg fb-main" });
  let busy = false;
  type Mode = "bet" | "next" | "cashout" | "cancel" | "cancel-next";
  let mode: Mode = "bet";

  const mine = (list: FbBet[]) => list.find((b) => b.user === getState().username);
  const drawButton = () => {
    const s = fbState();
    if (!s) return;
    const cur = mine(s.bets);
    const nxt = mine(s.next);
    if (s.phase === "running" && cur?.status === "open") {
      mode = "cashout";
      const m = fbMultiplierAt(serverNow() - (s.startAt ?? 0));
      mainBtn.textContent = `Cash out ${money(Math.floor(cur.stake * 100 * m) / 100)}`;
    } else if (s.phase === "waiting" && cur?.status === "queued") {
      mode = "cancel";
      mainBtn.textContent = `Cancel bet (${money(cur.stake)})`;
    } else if (nxt) {
      mode = "cancel-next";
      mainBtn.textContent = `Cancel next-round bet (${money(nxt.stake)})`;
    } else if (s.phase === "running") {
      mode = "next";
      mainBtn.textContent = "Bet on next round";
    } else {
      mode = "bet";
      mainBtn.textContent = "Place bet";
    }
    mainBtn.classList.toggle("cashout", mode === "cashout");
    mainBtn.classList.toggle("cancel", mode === "cancel" || mode === "cancel-next");
    mainBtn.disabled = busy;
    const locked = mode !== "bet" && mode !== "next";
    bet.setDisabled(locked);
    auto.disabled = locked;
  };

  mainBtn.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    drawButton();
    try {
      if (mode === "cashout") {
        const r = await flashbangAction<{ mult: number; payout: number }>("cashout");
        toast(`Cashed out at ${fmt(r.mult)}: +${money(r.payout)}`);
      } else if (mode === "cancel" || mode === "cancel-next") {
        await flashbangAction("cancel");
      } else {
        const a = auto.value.trim() ? Number(auto.value) : null;
        await flashbangAction("bet", { bet: bet.value(), auto: a });
      }
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
      drawButton();
    }
  });

  // ---------- players ----------
  const players = h("div", { class: "fb-players" });
  const betRow = (b: FbBet) =>
    h(
      "div",
      { class: `fb-bet ${b.status}${b.user === getState().username ? " me" : ""}` },
      h("span", { class: "fb-user" }, b.user),
      h("span", { class: "fb-stake" }, money(b.stake)),
      h(
        "span",
        { class: "fb-result" },
        b.status === "won" ? `${fmt(b.mult!)}  +${money(b.payout)}` : b.status === "lost" ? "Flashed" : b.status === "open" ? "Riding" : "Waiting",
      ),
    );
  const drawPlayers = (s: FbState) => {
    const current = s.phase === "waiting" && !s.bets.length && s.last ? s.last.bets : s.bets;
    const title = s.phase === "running" ? "This round" : s.bets.length ? "Next round" : "Last round";
    players.replaceChildren(
      h("div", { class: "fb-players-head" }, h("b", null, title), h("span", null, `${current.length} player${current.length === 1 ? "" : "s"}`)),
      ...(current.length ? current.map(betRow) : [h("div", { class: "fb-empty" }, "No bets yet")]),
      ...(s.next.length ? [h("div", { class: "fb-players-head" }, h("b", null, "Next round"), h("span", null, `${s.next.length}`)), ...s.next.map(betRow)] : []),
    );
    history.replaceChildren(...s.history.map((x) => h("span", { class: `fb-chip ${multClass(x)}` }, fmt(x))));
  };

  onLeave(
    onFlashbang((s, popped) => {
      if (popped && s.last) {
        poppedAt = performance.now();
        popMult = s.last.crash;
        burst.classList.remove("go");
        void burst.offsetWidth;
        burst.classList.add("go");
      }
      drawPlayers(s);
    }),
  );
  const s0 = fbState();
  if (s0) drawPlayers(s0);

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Flashbang"),
    h(
      "div",
      { class: "game-layout" },
      h(
        "div",
        { class: "game-panel" },
        bet.el,
        autoEl,
        mainBtn,
        h("p", { class: "hint" }, "The multiplier climbs until the flashbang pops. Cash out before it does. Everyone plays the same round."),
        players,
      ),
      h("div", { class: "game-stage fb-wrap" }, history, stage),
    ),
  );
}

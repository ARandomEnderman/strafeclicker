import { serverNow } from "../live";
import { RACE_BET_MS, RACE_BOTS, RACE_STEPS } from "../odds";
import { onRace, raceState, type RaceState } from "../race";
import { getState, InsufficientFunds, raceBet, ServerError } from "../state";
import { agentSprite } from "./agent-sprite";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { userLink } from "./profile-card";
import { playReveal, playTick } from "./sound";

// Bot race: five lanes, one shared race. The server scripts every bot's path, so the
// race looks the same on every screen.

const HUES = [0, 200, 110, 280, 40]; // hue-rotate per bot, so they're told apart
const COLORS = ["#d65f5f", "#4f8fdc", "#4fbf73", "#a66ae0", "#d9a13a"];

/** A bot's progress (0–1) `t` ms into the race, from its scripted path. */
function progressAt(path: number[], finish: number, t: number) {
  if (t <= 0) return 0;
  if (t >= finish) return 1;
  const f = (t / finish) * RACE_STEPS;
  const k = Math.floor(f);
  const a = k === 0 ? 0 : path[k - 1];
  const b = path[k];
  return a + (b - a) * (f - k);
}

export function racePage() {
  // ---------- track ----------
  const runners: HTMLElement[] = [];
  const oddsEls: HTMLElement[] = [];
  const lanes = RACE_BOTS.map((name, i) => {
    const img = h("img", { alt: "", style: `filter: hue-rotate(${HUES[i]}deg) saturate(1.4) drop-shadow(0 4px 4px rgba(0,0,0,.5))` }) as HTMLImageElement;
    void agentSprite().then((src) => (img.src = src));
    const runner = h("div", { class: "rc-runner" }, img);
    runners.push(runner);
    const odds = h("b", null);
    oddsEls.push(odds);
    return h(
      "div",
      { class: "rc-lane", style: `--c:${COLORS[i]}` },
      h("div", { class: "rc-name" }, h("span", null, name), odds),
      h("div", { class: "rc-track" }, runner, h("div", { class: "rc-finish" })),
    );
  });
  const status = h("div", { class: "rl-status rc-status" });
  const bar = h("i");
  const timer = h("div", { class: "fb-timer rl-timer" }, bar);
  const history = h("div", { class: "fb-history rc-history" });
  const track = h("div", { class: "rc-lanes" }, ...lanes);

  // ---------- betting ----------
  const bet = betInput();
  let busy = false;
  const cards = RACE_BOTS.map((name, i) => {
    const btn = h("button", { class: "btn rc-bet", style: `--c:${COLORS[i]}`, onclick: () => void place(i) });
    const list = h("div", { class: "rl-col-list" });
    const total = h("span", { class: "rl-col-total" });
    const card = h("div", { class: "rc-card", style: `--c:${COLORS[i]}` }, btn, h("div", { class: "rl-col-head" }, h("span", null, "Total bet"), total), list);
    return { card, btn, list, total, name };
  });
  const place = async (i: number) => {
    if (busy) return;
    busy = true;
    try {
      await raceBet(i, bet.value());
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
    }
  };

  const drawBets = (s: RaceState) => {
    const me = getState().username;
    const done = s.phase === "result";
    cards.forEach((c, i) => {
      const bets = s.bets.filter((b) => b.bot === i);
      c.btn.textContent = `${c.name} · ${s.odds[i].toFixed(2)}x`;
      c.btn.disabled = s.phase !== "betting";
      c.total.textContent = money(bets.reduce((x, b) => x + b.stake, 0));
      c.card.classList.toggle("won", done && s.winner === i);
      c.card.classList.toggle("lost", done && s.winner !== i);
      c.list.replaceChildren(
        ...bets.map((b) =>
          h("div", { class: `rl-bet-row${b.user === me ? " me" : ""}` }, userLink(b.user, b.name, { avatar: true }), h("b", null, done && s.winner === i ? `+${money(b.stake * s.odds[i])}` : money(b.stake))),
        ),
      );
      oddsEls[i].textContent = `${s.odds[i].toFixed(2)}x · ${Math.round(s.chances[i] * 100)}%`;
    });
    history.replaceChildren(...s.history.slice(0, 16).map((r) => h("span", { class: "rc-chip", style: `--c:${COLORS[r.winner]}`, title: `${RACE_BOTS[r.winner]} at ${r.odds}x` }, RACE_BOTS[r.winner][0])));
  };

  // ---------- the race clock ----------
  let raf = 0;
  let celebrated = -1;
  let lastTick = 0;
  const loop = () => {
    const s = raceState();
    if (s) {
      if (s.phase === "betting") {
        const left = Math.max(0, s.startAt - serverNow());
        status.textContent = `Race starts in ${(left / 1000).toFixed(1)}s`;
        status.style.color = "";
        bar.style.width = `${(left / RACE_BET_MS) * 100}%`;
        timer.hidden = false;
        runners.forEach((r) => (r.style.left = "0%"));
        runners.forEach((r) => r.classList.remove("running"));
      } else if (s.race) {
        timer.hidden = true;
        const t = serverNow() - s.startAt;
        const winnerDone = t >= s.race.finish[s.winner!];
        runners.forEach((r, i) => {
          const p = progressAt(s.race!.paths[i], s.race!.finish[i], t);
          r.style.left = `calc(${p * 100}% - ${p * 56}px)`;
          r.classList.toggle("running", p > 0 && p < 1);
        });
        if (!winnerDone && t - lastTick > 300) {
          playTick();
          lastTick = t;
        }
        if (winnerDone) {
          status.textContent = `${RACE_BOTS[s.winner!]} wins at ${s.odds[s.winner!].toFixed(2)}x`;
          status.style.color = COLORS[s.winner!];
          if (celebrated !== s.round) {
            celebrated = s.round;
            const mine = s.bets.some((b) => b.user === getState().username && b.bot === s.winner);
            playReveal(mine ? "covert" : "milspec");
          }
        } else {
          status.textContent = "And they're off!";
          status.style.color = "";
        }
      }
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));
  onLeave(onRace(drawBets));
  const s0 = raceState();
  if (s0) drawBets(s0);

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Bot race"),
    h("div", { class: "game-stage rc-stage" }, history, track, h("div", { class: "rl-under" }, status, timer)),
    h("div", { class: "rl-controls" }, bet.el),
    h("div", { class: "rc-cards" }, ...cards.map((c) => c.card)),
  );
}

import { BP_ARRIVE_MS, BP_BET_MS, BP_END_MS, BP_PICKS, BP_PLANT_MS, type BpOutcome } from "../../shared/game.js";
import { bombPlantState, onBombPlant, type BombPlantState } from "../bombplant";
import { serverNow } from "../live";
import { bombPlantBet, getState, InsufficientFunds, ServerError } from "../state";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { userLink } from "./profile-card";
import { playBoom, playSafe, playTick } from "./sound";

// Bomb plant: a small top-down map. The T runs to a site and plants, the CTs retake,
// and the bomb either goes off or gets defused. Every screen plays the same round.

const NS = "http://www.w3.org/2000/svg";
type Pt = [number, number];
const T_PATH: Record<"A" | "B", Pt[]> = {
  A: [[200, 232], [330, 232], [330, 62]],
  B: [[200, 232], [70, 232], [70, 62]],
};
const CT_PATH: Record<"A" | "B", Pt[]> = {
  A: [[200, 26], [318, 26], [318, 50]],
  B: [[200, 26], [82, 26], [82, 50]],
};
/** Where along the CTs' run they are when the round ends, if the bomb goes off. */
const BOOM_CT_REACH = 0.8;
/** When the CTs reach the bomb if they defuse it (share of the retake). */
const DEFUSE_ARRIVE = 0.55;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** The point `f` (0–1) of the way along a path. */
function along(path: Pt[], f: number): Pt {
  const segs = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]));
  let d = Math.max(0, Math.min(1, f)) * segs.reduce((a, b) => a + b, 0);
  for (let i = 0; i < segs.length; i++) {
    if (d <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? Math.min(1, d / segs[i]) : 0;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
    }
    d -= segs[i];
  }
  return path.at(-1)!;
}

function mapSvg() {
  const root = svg("svg", { viewBox: "0 0 400 260", class: "bp-map" });
  const floor = (x: number, y: number, w: number, hh: number) => root.append(svg("rect", { x, y, width: w, height: hh, rx: 4, class: "bp-floor" }));
  // Corridors first, then rooms on top.
  floor(50, 212, 300, 40); // T side
  floor(305, 40, 50, 212); // A long
  floor(45, 40, 50, 212); // B tunnels
  floor(60, 10, 280, 34); // CT side
  floor(180, 44, 40, 168); // mid
  floor(285, 20, 90, 80); // A site
  floor(25, 20, 90, 80); // B site
  floor(160, 6, 80, 40); // CT spawn
  floor(150, 214, 100, 40); // T spawn
  const label = (x: number, y: number, text: string, cls: string) => {
    const t = svg("text", { x, y, class: cls, "text-anchor": "middle" });
    t.textContent = text;
    root.append(t);
    return t;
  };
  label(330, 92, "A", "bp-site");
  label(70, 92, "B", "bp-site");
  label(200, 250, "T SPAWN", "bp-spawn");
  label(200, 20, "CT SPAWN", "bp-spawn");
  const bomb = svg("g", { class: "bp-bomb", visibility: "hidden" });
  bomb.append(svg("circle", { r: 14, class: "bp-bomb-glow" }), svg("rect", { x: -7, y: -5, width: 14, height: 10, rx: 2, class: "bp-bomb-body" }), svg("circle", { r: 2, cy: -1, class: "bp-bomb-led" }));
  const boom = svg("circle", { r: 0, class: "bp-boom", visibility: "hidden" });
  const t = svg("g", { class: "bp-t" });
  t.append(svg("circle", { r: 9 }), Object.assign(svg("text", { y: 4, "text-anchor": "middle" }), { textContent: "T" }));
  const plantRing = svg("circle", { r: 14, class: "bp-ring", "stroke-dasharray": "88", "stroke-dashoffset": "88", visibility: "hidden" });
  const cts = [0, 1, 2].map(() => {
    const g = svg("g", { class: "bp-ct" });
    g.append(svg("circle", { r: 8 }), Object.assign(svg("text", { y: 3.5, "text-anchor": "middle" }), { textContent: "CT" }));
    root.append(g);
    return g;
  });
  root.append(bomb, boom, plantRing, t);
  return { root, bomb, boom, t, plantRing, cts };
}

export function bombplantPage() {
  const m = mapSvg();
  const status = h("div", { class: "rl-status bp-status" });
  const bar = h("i");
  const timer = h("div", { class: "fb-timer rl-timer" }, bar);
  const bombBar = h("i");
  const bombTimer = h("div", { class: "bp-bombtimer", hidden: true }, bombBar);
  const history = h("div", { class: "fb-history bp-history" });

  const bet = betInput();
  let busy = false;
  const place = async (pick: string) => {
    if (busy) return;
    busy = true;
    try {
      await bombPlantBet(pick, bet.value());
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
    }
  };
  const pickBtns = new Map<string, HTMLButtonElement>();
  const group = (title: string, picks: string[]) =>
    h(
      "div",
      { class: "bp-group" },
      h("div", { class: "field-label" }, title),
      h(
        "div",
        { class: "bp-picks" },
        ...picks.map((p) => {
          const b = h("button", { class: `btn bp-pick ${p}`, onclick: () => void place(p) }, h("span", null, BP_PICKS[p].label), h("b", null, `${BP_PICKS[p].pays}x`)) as HTMLButtonElement;
          pickBtns.set(p, b);
          return b;
        }),
      ),
    );
  const betList = h("div", { class: "bp-bets" });

  const drawBets = (s: BombPlantState) => {
    const me = getState().username;
    const done = s.phase === "result" && s.outcome;
    pickBtns.forEach((b, p) => {
      b.disabled = s.phase !== "betting";
      b.classList.toggle("won", !!done && BP_PICKS[p].wins(s.outcome!));
    });
    betList.replaceChildren(
      ...(s.bets.length
        ? s.bets.map((b) => {
            const won = done ? BP_PICKS[b.pick].wins(s.outcome!) : null;
            return h(
              "div",
              { class: `rl-bet-row${b.user === me ? " me" : ""}${won === false ? " lost" : ""}` },
              userLink(b.user, b.name, { avatar: true }),
              h("span", { class: "bp-bet-pick" }, BP_PICKS[b.pick].label),
              h("b", null, won ? `+${money(b.stake * BP_PICKS[b.pick].pays)}` : money(b.stake)),
            );
          })
        : [h("p", { class: "empty" }, "No bets this round yet.")]),
    );
    history.replaceChildren(
      ...s.history.slice(0, 16).map((o: BpOutcome) => h("span", { class: `bp-chip ${o.result}`, title: `${o.site} site, ${o.result === "boom" ? "exploded" : "defused"}` }, o.site)),
    );
  };

  // ---------- the round clock ----------
  let raf = 0;
  let lastBeep = 0;
  let ended = -1;
  const place2 = (el: SVGElement, p: Pt) => el.setAttribute("transform", `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})`);
  const reset = () => {
    place2(m.t, T_PATH.A[0]);
    m.cts.forEach((c, i) => place2(c, [CT_PATH.A[0][0] - 14 + i * 14, CT_PATH.A[0][1]]));
    m.bomb.setAttribute("visibility", "hidden");
    m.boom.setAttribute("visibility", "hidden");
    m.plantRing.setAttribute("visibility", "hidden");
    m.t.setAttribute("visibility", "visible");
    bombTimer.hidden = true;
  };
  const loop = () => {
    const s = bombPlantState();
    if (s) {
      if (s.phase === "betting") {
        reset();
        const left = Math.max(0, s.startAt - serverNow());
        status.textContent = `Round starts in ${(left / 1000).toFixed(1)}s`;
        status.className = "rl-status bp-status";
        bar.style.width = `${(left / BP_BET_MS) * 100}%`;
        timer.hidden = false;
      } else if (s.outcome) {
        timer.hidden = true;
        const o = s.outcome;
        const t = serverNow() - s.startAt;
        const site = along(T_PATH[o.site], 1);
        place2(m.t, along(T_PATH[o.site], t / BP_ARRIVE_MS));
        // Planting: a ring fills round the T.
        const planting = t >= BP_ARRIVE_MS && t < BP_PLANT_MS;
        m.plantRing.setAttribute("visibility", planting ? "visible" : "hidden");
        place2(m.plantRing, site);
        m.plantRing.setAttribute("stroke-dashoffset", String(88 * (1 - (t - BP_ARRIVE_MS) / (BP_PLANT_MS - BP_ARRIVE_MS))));
        const planted = t >= BP_PLANT_MS;
        m.bomb.setAttribute("visibility", planted && !(o.result === "boom" && t >= BP_END_MS) ? "visible" : "hidden");
        place2(m.bomb, [site[0] + 12, site[1] + 8]);
        // The CTs leave spawn once the bomb is down.
        const retake = Math.max(0, (t - BP_PLANT_MS) / (BP_END_MS - BP_PLANT_MS));
        const reach = o.result === "defuse" ? Math.min(1, retake / DEFUSE_ARRIVE) : retake * BOOM_CT_REACH;
        m.cts.forEach((c, i) => {
          const p = along(CT_PATH[o.site], Math.max(0, reach - i * 0.06));
          place2(c, [p[0] + (i - 1) * 10, p[1] + (i - 1) * 4]);
        });
        bombTimer.hidden = !planted;
        bombBar.style.width = `${Math.max(0, 1 - retake) * 100}%`;
        // Faster beeps as the timer runs down.
        if (planted && t < BP_END_MS && t - lastBeep > 120 + 700 * (1 - retake)) {
          playTick();
          lastBeep = t;
        }
        if (t >= BP_END_MS) {
          const boom = o.result === "boom";
          m.boom.setAttribute("visibility", boom ? "visible" : "hidden");
          place2(m.boom, site);
          m.boom.setAttribute("r", String(Math.min(70, ((t - BP_END_MS) / 400) * 70)));
          m.boom.style.opacity = String(Math.max(0, 1 - (t - BP_END_MS) / 1800));
          if (boom) m.t.setAttribute("visibility", "hidden");
          status.textContent = boom ? `The bomb exploded at ${o.site}` : `Bomb defused at ${o.site}`;
          status.className = `rl-status bp-status ${o.result}`;
          if (ended !== s.round) {
            ended = s.round;
            if (boom) playBoom();
            else playSafe();
          }
        } else if (planted) {
          status.textContent = `Bomb planted at ${o.site}. CTs are retaking`;
          status.className = "rl-status bp-status";
        } else {
          status.textContent = planting ? `Planting at ${o.site}...` : "The T is heading to a site...";
          status.className = "rl-status bp-status";
        }
      }
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));
  onLeave(onBombPlant(drawBets));
  const s0 = bombPlantState();
  if (s0) drawBets(s0);

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Bomb plant"),
    h("div", { class: "game-stage bp-stage" }, history, m.root as unknown as HTMLElement, bombTimer, h("div", { class: "rl-under" }, status, timer)),
    h("div", { class: "rl-controls" }, bet.el),
    h("div", { class: "bp-board" }, group("Site", ["A", "B"]), group("How it ends", ["boom", "defuse"]), group("Both", ["A-boom", "A-defuse", "B-boom", "B-defuse"])),
    h("div", { class: "bp-betlist" }, h("h2", null, "Bets this round"), betList),
  );
}

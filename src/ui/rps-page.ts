import { RPS_PICK_MS, RPS_WINS } from "../../shared/game.js";
import { serverNow } from "../live";
import { onRps, rpsById, rpsDuels, type Hand, type RpsDuel, type RpsPlayer } from "../rps";
import { getState, InsufficientFunds, rpsAction, ServerError } from "../state";
import { betInput, segmented } from "./bet-input";
import { h, money, toast } from "./dom";
import { icon, type IconName } from "./icons";
import { onLeave } from "./page";
import { avatar, userLink } from "./profile-card";
import { playBoom, playReveal, playSafe, playTick } from "./sound";

// Rock paper scissors: the lobby (#/rps) and one duel (#/rps/<id>).

const HANDS: Hand[] = ["rock", "paper", "scissors"];
const HAND_ICON: Record<Hand, IconName> = { rock: "rock", paper: "paper", scissors: "scissors" };
const HAND_NAME: Record<Hand, string> = { rock: "Rock", paper: "Paper", scissors: "Scissors" };

const act = async (action: "create" | "join" | "bot" | "cancel" | "pick", body: object) => {
  try {
    return await rpsAction(action, body);
  } catch (e) {
    if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
    else if (e instanceof ServerError) toast(e.message, "error");
    else throw e;
    return null;
  }
};

const nameOf = (p: RpsPlayer | null) => (p ? (p.bot ? h("b", null, p.name) : userLink(p.user, p.name)) : h("b", { class: "cf-waiting" }, "Waiting..."));
const handEl = (hand: Hand | null, size = 40) => h("span", { class: `rps-hand${hand ? "" : " unknown"}` }, hand ? icon(HAND_ICON[hand], size) : "?");

// ---------- lobby ----------

export function rpsPage(code: string | null = null) {
  const list = h("div", { class: "cf-list" });
  const bet = betInput();
  let visibility: RpsDuel["visibility"] = "public";
  const visSeg = segmented<RpsDuel["visibility"]>(
    "Who can join",
    [
      { value: "public", label: "Public" },
      { value: "friends", label: "Friends" },
      { value: "private", label: "Private" },
    ],
    visibility,
    (v) => (visibility = v),
  );
  const create = async () => {
    const r = await act("create", { bet: bet.value(), visibility });
    if (r) location.hash = `#/rps/${r.id}`;
  };
  const codeInput = h("input", { class: "search code-field", placeholder: "Code", maxlength: "6", value: code ?? "", "aria-label": "Duel code" }) as HTMLInputElement;
  const codeForm = h(
    "form",
    {
      class: "bt-code",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!codeInput.value.trim()) return;
        const r = await act("join", { code: codeInput.value.trim() });
        if (r) location.hash = `#/rps/${r.id}`;
      },
    },
    h("span", { class: "field-label" }, "Got a code for a private duel?"),
    codeInput,
    h("button", { class: "btn", type: "submit" }, "Join"),
  );

  const card = (d: RpsDuel) => {
    const me = getState().username;
    const inIt = d.seat != null;
    const label = d.status === "waiting" && d.creator.user !== me ? `Join for ${money(d.stake)}` : d.status === "playing" ? (inIt ? "Play" : "Watch") : "Open";
    const winner = d.winner != null ? (d.winner === 0 ? d.creator : d.joiner) : null;
    return h(
      "div",
      { class: `cf-card ${d.status}${inIt ? " mine" : ""}` },
      h("div", { class: "cf-card-side" }, h("div", { class: "cf-player" }, avatar(d.creator.user, d.creator.name, 36), h("div", { class: "cf-player-names" }, nameOf(d.creator)))),
      h(
        "div",
        { class: "cf-mid" },
        h("b", { class: "cf-stake" }, money(d.stake * 2)),
        h("span", null, winner ? `${winner.name} won` : d.status === "playing" ? `${d.score[0]} : ${d.score[1]}` : d.visibility !== "public" ? (d.visibility === "friends" ? "Friends only" : "Private") : "Open"),
      ),
      h("div", { class: "cf-card-side" }, h("div", { class: "cf-player" }, d.joiner ? avatar(d.joiner.user, d.joiner.name, 36) : h("span", { class: "avatar cf-empty" }, "?"), h("div", { class: "cf-player-names" }, nameOf(d.joiner)))),
      d.status === "waiting" && d.creator.user !== me
        ? h("button", { class: "btn btn-sm btn-primary", onclick: async () => (await act("join", { id: d.id })) && (location.hash = `#/rps/${d.id}`) }, label)
        : h("a", { class: "btn btn-sm", href: `#/rps/${d.id}` }, label),
    );
  };
  const draw = () => {
    const all = rpsDuels();
    const open = all.filter((d) => d.status !== "done");
    const done = all.filter((d) => d.status === "done");
    list.replaceChildren(
      h("h2", null, "Open"),
      ...(open.length ? open.map(card) : [h("p", { class: "fb-empty" }, "No open duels. Start one.")]),
      ...(done.length ? [h("h2", null, "Recent"), ...done.map(card)] : []),
    );
  };
  onLeave(onRps(draw));
  draw();

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Rock paper scissors"),
    h("p", { class: "hint" }, `First to ${RPS_WINS} wins takes both stakes.`),
    codeForm,
    h(
      "div",
      { class: "bt-create" },
      h("div", { class: "bt-create-head" }, icon("scissors", 18), h("b", null, "New duel")),
      h("div", { class: "bt-create-row" }, bet.el, visSeg.el, h("button", { class: "btn btn-primary", onclick: () => void create() }, "Create duel")),
    ),
    list,
  );
}

// ---------- one duel ----------

export function rpsView(id: number) {
  const root = h("div", { class: "rps-view" });
  const bar = h("i");
  const timer = h("div", { class: "fb-timer rl-timer" }, bar);
  const status = h("div", { class: "rl-status rps-status" });
  let lastPhase = "";
  let picking = false;

  const draw = () => {
    const d = rpsById(id);
    if (!d) {
      root.replaceChildren(h("p", { class: "empty" }, "This duel doesn't exist, is private, or was cancelled. ", h("a", { href: "#/rps" }, "Back to duels")));
      return;
    }
    const me = d.seat;
    const round = d.rounds.at(-1);
    // Sounds when a round is revealed and when the duel ends.
    const key = `${d.rounds.length}:${d.phase}:${d.status}`;
    if (key !== lastPhase) {
      if (d.phase === "reveal" && round && me != null) {
        if (round.winner == null) playTick();
        else if (round.winner === me) playSafe();
        else playBoom();
      }
      if (d.status === "done" && lastPhase && me != null) {
        if (d.winner === me) playReveal("covert");
      }
      lastPhase = key;
    }

    const side = (p: RpsPlayer | null, seat: 0 | 1) => {
      const hand = round?.picks[seat] ?? null;
      const picked = round?.picked[seat] ?? false;
      const showing = d.phase === "reveal" || d.status === "done" || hand;
      return h(
        "div",
        { class: `rps-side${round && d.phase !== "picking" && round.winner === seat ? " won" : ""}${me === seat ? " me" : ""}` },
        p ? avatar(p.user, p.name, 44) : h("span", { class: "avatar cf-empty" }, "?"),
        nameOf(p),
        h("div", { class: "rps-score" }, String(d.score[seat])),
        d.status === "waiting" ? "" : showing ? handEl(hand, 56) : h("span", { class: `rps-hand unknown${picked ? " ready" : ""}` }, picked ? icon("check", 28) : "?"),
      );
    };

    const controls: HTMLElement[] = [];
    if (d.status === "waiting" && d.creator.user === getState().username) {
      controls.push(
        h(
          "div",
          { class: "bt-actions cf-actions" },
          h("button", { class: "btn", onclick: () => void act("bot", { id }) }, icon("box", 14), " Play a bot"),
          h("button", { class: "btn btn-ghost", onclick: () => confirm("Cancel this duel? You get your stake back.") && void act("cancel", { id }).then((r) => r && (location.hash = "#/rps")) }, "Cancel"),
        ),
      );
      if (d.code) controls.push(h("p", { class: "hint" }, "Private duel. Share the code ", h("b", null, d.code), " to let someone join."));
    } else if (d.status === "waiting") {
      controls.push(h("button", { class: "btn btn-primary btn-lg", onclick: () => void act("join", { id }) }, `Join for ${money(d.stake)}`));
    } else if (d.status === "playing" && d.phase === "picking" && me != null && round && !round.picks[me]) {
      controls.push(
        h(
          "div",
          { class: "rps-picks" },
          ...HANDS.map((hand) =>
            h(
              "button",
              {
                class: "btn rps-pick",
                disabled: picking,
                onclick: async () => {
                  picking = true;
                  await act("pick", { id, hand });
                  picking = false;
                },
              },
              icon(HAND_ICON[hand], 40),
              h("span", null, HAND_NAME[hand]),
            ),
          ),
        ),
      );
    }

    root.replaceChildren(
      h("div", { class: "bt-crumbs" }, h("a", { href: "#/rps" }, "Duels"), h("h1", null, `Rock paper scissors · ${money(d.stake * 2)}`)),
      h("div", { class: "game-stage rps-stage" }, h("div", { class: "rps-board" }, side(d.creator, 0), h("div", { class: "rps-vs" }, "VS"), side(d.joiner, 1)), h("div", { class: "rl-under" }, status, timer)),
      ...controls,
      d.rounds.length
        ? h(
            "div",
            { class: "rps-history" },
            ...d.rounds
              .filter((r) => d.phase !== "picking" || r !== round)
              .map((r, i) => {
                const hand = (seat: 0 | 1) => {
                  const el = handEl(r.picks[seat], 18);
                  if (r.winner === seat) el.classList.add("win");
                  return el;
                };
                return h("div", { class: `rps-round${r.winner == null ? " tie" : ""}` }, h("span", null, `Round ${i + 1}`), hand(0), h("b", null, r.winner == null ? "tie" : "vs"), hand(1));
              }),
          )
        : "",
    );
  };

  let raf = 0;
  const loop = () => {
    const d = rpsById(id);
    if (d) {
      const left = d.deadline ? Math.max(0, d.deadline - serverNow()) : 0;
      timer.hidden = !(d.status === "playing" && d.phase === "picking");
      bar.style.width = `${(left / RPS_PICK_MS) * 100}%`;
      const round = d.rounds.at(-1);
      const who = (s: 0 | 1) => (s === 0 ? d.creator : d.joiner)!.name;
      if (d.status === "waiting") status.textContent = "Waiting for an opponent";
      else if (d.status === "done") status.textContent = d.winner === d.seat ? `You won ${money(d.stake * 2)}` : `${who(d.winner!)} wins`;
      else if (d.phase === "picking") status.textContent = d.seat != null && round?.picks[d.seat] ? `Waiting for the other pick · ${Math.ceil(left / 1000)}s` : `Pick a hand · ${Math.ceil(left / 1000)}s`;
      else if (round) status.textContent = round.winner == null ? "Tie, go again" : `${who(round.winner)} takes the round`;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));
  onLeave(onRps(draw));
  draw();
  return h("section", { class: "page" }, root);
}

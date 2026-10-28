import { BRACKET_GAMES, BRACKET_SHOW_MS } from "../../shared/game.js";
import { bracketById, brackets, onBrackets, type Bracket, type BracketCard, type BracketGame, type BracketMatch } from "../brackets";
import { getItem, imageOf, openableCases, openCost } from "../catalog";
import { serverNow } from "../live";
import { bracketAction, getState, InsufficientFunds, ServerError } from "../state";
import { betInput, segmented } from "./bet-input";
import { h, money, toast } from "./dom";
import { icon, type IconName } from "./icons";
import { onLeave } from "./page";
import { userLink } from "./profile-card";
import { playReveal, playTick } from "./sound";

// Bracket tournaments: the lobby (#/brackets) and one bracket (#/brackets/<id>).

const STAGE_NAMES: Record<number, string[]> = { 4: ["Semi-finals", "Final"], 8: ["Quarter-finals", "Semi-finals", "Final"] };
const HAND_ICON: Record<string, IconName> = { rock: "rock", paper: "paper", scissors: "scissors" };
const SUITS: Record<BracketCard["s"], string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

const act = async (action: "create" | "join" | "bots" | "leave" | "pick", body: object) => {
  try {
    return await bracketAction(action, body);
  } catch (e) {
    if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
    else if (e instanceof ServerError) toast(e.message, "error");
    else throw e;
    return null;
  }
};

const stageLabel = (b: Bracket, i: number) => {
  const s = b.stages[i];
  return `${STAGE_NAMES[b.size][i]} · ${BRACKET_GAMES[s.game]}${s.game === "unbox" && s.caseName ? ` (${s.caseName})` : ""}`;
};

// ---------- lobby ----------

export function bracketsPage(code: string | null = null) {
  const list = h("div", { class: "cf-list" });
  let size = 4;
  let visibility: Bracket["visibility"] = "public";
  const fee = betInput(undefined, "Entry fee");
  const cases = [...openableCases()].sort((a, b) => openCost(a) - openCost(b));
  const stagePicks: { game: BracketGame; caseId: string }[] = [0, 1, 2].map(() => ({ game: "coinflip", caseId: cases[0]?.id ?? "" }));
  const stagesBox = h("div", { class: "br-stages" });
  const drawStages = () => {
    stagesBox.replaceChildren(
      ...STAGE_NAMES[size].map((name, i) => {
        const pick = stagePicks[i];
        const caseSel = h(
          "select",
          { class: "search", onchange: (e: Event) => (pick.caseId = (e.target as HTMLSelectElement).value), hidden: pick.game !== "unbox" },
          ...cases.map((c) => h("option", { value: c.id, selected: c.id === pick.caseId }, `${c.name} (${money(openCost(c))})`)),
        );
        return h(
          "div",
          { class: "br-stage-pick" },
          h("span", { class: "field-label" }, name),
          h(
            "select",
            {
              class: "search",
              onchange: (e: Event) => {
                pick.game = (e.target as HTMLSelectElement).value as BracketGame;
                caseSel.hidden = pick.game !== "unbox";
              },
            },
            ...Object.entries(BRACKET_GAMES).map(([id, label]) => h("option", { value: id, selected: id === pick.game }, label)),
          ),
          caseSel,
        );
      }),
    );
  };
  drawStages();
  const sizeSeg = segmented<number>(
    "Players",
    [
      { value: 4, label: "4" },
      { value: 8, label: "8" },
    ],
    size,
    (v) => {
      size = v;
      drawStages();
    },
  );
  const visSeg = segmented<Bracket["visibility"]>(
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
    const stages = stagePicks.slice(0, Math.log2(size)).map((s) => (s.game === "unbox" ? s : { game: s.game }));
    const r = await act("create", { size, fee: fee.value(), visibility, stages });
    if (r) location.hash = `#/brackets/${r.id}`;
  };

  const codeInput = h("input", { class: "search code-field", placeholder: "Code", maxlength: "6", value: code ?? "", "aria-label": "Bracket code" }) as HTMLInputElement;
  const codeForm = h(
    "form",
    {
      class: "bt-code",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!codeInput.value.trim()) return;
        const r = await act("join", { code: codeInput.value.trim() });
        if (r) location.hash = `#/brackets/${r.id}`;
      },
    },
    h("span", { class: "field-label" }, "Got a code for a private bracket?"),
    codeInput,
    h("button", { class: "btn", type: "submit" }, "Join"),
  );

  const card = (b: Bracket) => {
    const champ = b.champion != null ? b.players[b.champion] : null;
    return h(
      "a",
      { class: `bt-card ${b.status === "done" ? "done" : b.status}${b.seat != null ? " mine" : ""}`, href: `#/brackets/${b.id}` },
      h(
        "div",
        { class: "bt-card-head" },
        h("b", null, `${b.size} players`),
        h("span", null, b.stages.map((s) => BRACKET_GAMES[s.game]).join(" → ")),
        b.visibility !== "public" ? h("span", { class: "bt-vis" }, icon(b.visibility === "friends" ? "friends" : "lock", 12), b.visibility === "friends" ? "Friends only" : "Private") : "",
      ),
      h(
        "div",
        { class: "bt-card-foot" },
        h("span", { class: "bt-cost" }, `${money(b.fee)} entry · ${money(b.pot)} pot`),
        h("span", { class: `bt-status ${b.status}` }, champ ? `Won by ${champ.name}` : b.status === "running" ? "In progress" : `${b.players.length}/${b.size} players`),
      ),
    );
  };
  const draw = () => {
    const all = brackets();
    const live = all.filter((b) => b.status !== "done");
    const done = all.filter((b) => b.status === "done");
    list.replaceChildren(
      h("h2", null, "Open"),
      live.length ? h("div", { class: "bt-grid" }, ...live.map(card)) : h("p", { class: "fb-empty" }, "No brackets right now. Start one."),
      ...(done.length ? [h("h2", null, "Finished"), h("div", { class: "bt-grid" }, ...done.map(card))] : []),
    );
  };
  onLeave(onBrackets(draw));
  draw();

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Brackets"),
    h("p", { class: "hint" }, "Pick a game for every round. The champion takes the whole pot."),
    codeForm,
    h(
      "div",
      { class: "bt-create" },
      h("div", { class: "bt-create-head" }, icon("bracket", 18), h("b", null, "New bracket")),
      h("div", { class: "bt-create-row" }, sizeSeg.el, fee.el, visSeg.el),
      stagesBox,
      h("div", { class: "bt-create-row" }, h("button", { class: "btn btn-primary", onclick: () => void create() }, "Create bracket")),
    ),
    list,
  );
}

// ---------- one bracket ----------

const cardEl = (c: BracketCard | null) =>
  c ? h("span", { class: `br-card${c.s === "h" || c.s === "d" ? " red" : ""}` }, c.r, SUITS[c.s]) : h("span", { class: "br-card back" });

function matchEl(b: Bracket, m: BracketMatch, game: BracketGame, mySeat: number | null) {
  const now = serverNow();
  // Auto matches play out on screen for BRACKET_SHOW_MS after startAt.
  const shown = m.status === "done" || (m.startAt != null && now >= m.startAt + BRACKET_SHOW_MS * 0.75);
  const row = (seat: number, side: 0 | 1) => {
    const p = b.players[seat];
    const won = m.winner === seat;
    let extra: Node | string = "";
    if (game === "coinflip" && m.result?.side) extra = h("span", { class: `cf-side ${side === 0 ? "t" : "ct"}` }, side === 0 ? "T" : "CT");
    if (game === "highcard" && m.status !== "pending") extra = cardEl(shown ? m.result!.cards![side] : null);
    if (game === "unbox" && m.status !== "pending") {
      const d = m.result!.drops![side];
      extra = shown ? h("span", { class: "br-drop" }, h("img", { src: imageOf(d), alt: "", title: getItem(d.itemId)?.name ?? "", style: `--rarity:${getItem(d.itemId)?.color}` }), money(m.result!.values![side])) : h("span", { class: "br-drop spinning" }, icon("box", 16));
    }
    if (game === "rps" && m.rps) {
      const r = m.rps.rounds.at(-1);
      const pick = r?.picks[side];
      extra = h("span", { class: "br-rps" }, h("b", null, String(m.rps.score[side])), pick ? icon(HAND_ICON[pick], 16) : r?.picked[side] ? icon("check", 14) : "");
    }
    return h(
      "div",
      { class: `br-player${won ? " won" : m.winner != null ? " lost" : ""}${seat === mySeat ? " me" : ""}` },
      p.bot ? h("span", { class: "br-name" }, p.name) : h("span", { class: "br-name" }, userLink(p.user!, p.name)),
      extra,
    );
  };
  const controls: HTMLElement[] = [];
  // Your RPS match: pick buttons while the round is open and you haven't picked.
  const mySide = m.a === mySeat ? 0 : m.b === mySeat ? 1 : -1;
  if (game === "rps" && m.rps?.phase === "picking" && mySide >= 0 && !m.rps.rounds.at(-1)!.picks[mySide]) {
    controls.push(
      h(
        "div",
        { class: "br-picks" },
        ...["rock", "paper", "scissors"].map((hand) => h("button", { class: "btn btn-sm", title: hand, onpointerdown: () => void act("pick", { id: b.id, hand }) }, icon(HAND_ICON[hand], 18))),
        h("span", { class: "hint" }, `${Math.max(0, Math.ceil((m.rps.deadline - now) / 1000))}s`),
      ),
    );
  }
  const status = m.status === "pending" ? "Waiting" : m.status === "playing" ? (game === "rps" ? (m.rps?.phase === "reveal" ? "Reveal" : "Picking") : shown ? "" : game === "coinflip" ? "Flipping..." : game === "highcard" ? "Drawing..." : "Opening...") : "";
  return h("div", { class: `br-match ${m.status}` }, row(m.a, 0), row(m.b, 1), status ? h("div", { class: "br-match-status" }, status) : "", ...controls);
}

export function bracketView(id: number) {
  const root = h("div", { class: "br-view" });
  let lastKey = "";
  let celebrated = false;
  const draw = () => {
    const b = bracketById(id);
    if (!b) {
      root.replaceChildren(h("p", { class: "empty" }, "This bracket doesn't exist, is private, or was cancelled. ", h("a", { href: "#/brackets" }, "Back to brackets")));
      return;
    }
    const me = getState().username;
    const mySeat = b.players.findIndex((p) => p.user === me);
    const champ = b.champion != null ? b.players[b.champion] : null;
    if (champ && !celebrated) {
      celebrated = true;
      if (b.champion === mySeat) playReveal("gold");
    }
    const actions: HTMLElement[] = [];
    if (b.status === "waiting") {
      if (mySeat < 0) actions.push(h("button", { class: "btn btn-primary", onclick: () => void act("join", { id }) }, `Join for ${money(b.fee)}`));
      if (b.mine) actions.push(h("button", { class: "btn", onclick: () => void act("bots", { id }) }, icon("box", 14), " Fill with bots and start"));
      if (mySeat >= 0) actions.push(h("button", { class: "btn btn-ghost", onclick: () => confirm(b.mine ? "Cancel this bracket? Everyone gets their fee back." : "Leave? You get your fee back.") && void act("leave", { id }).then((r) => r && b.mine && (location.hash = "#/brackets")) }, b.mine ? "Cancel" : "Leave"));
    }
    const columns = b.stages.map((s, i) => {
      const matches = b.rounds[i] ?? Array.from({ length: b.size / 2 ** (i + 1) }, () => null);
      return h(
        "div",
        { class: "br-col" },
        h("div", { class: "br-col-head" }, stageLabel(b, i)),
        ...matches.map((m) => (m ? matchEl(b, m, s.game, mySeat >= 0 ? mySeat : null) : h("div", { class: "br-match pending" }, h("div", { class: "br-player" }, h("span", { class: "br-name" }, "TBD")), h("div", { class: "br-player" }, h("span", { class: "br-name" }, "TBD"))))),
      );
    });
    root.replaceChildren(
      h("div", { class: "bt-crumbs" }, h("a", { href: "#/brackets" }, "Brackets"), h("h1", null, `${b.size}-player bracket · ${money(b.pot)} pot`)),
      h("p", { class: "hint" }, `${money(b.fee)} entry${b.code ? ` · Code ${b.code}` : ""}`),
      champ
        ? h("div", { class: "br-champion" }, icon("crown", 22), h("span", null, champ.bot ? champ.name : userLink(champ.user!, champ.name), ` wins ${money(b.pot)}`))
        : "",
      b.status === "waiting"
        ? h(
            "div",
            { class: "br-seats" },
            h("h2", null, `Players ${b.players.length} / ${b.size}`),
            h("div", { class: "br-seat-list" }, ...b.players.map((p) => h("div", { class: "br-seat" }, p.bot ? p.name : userLink(p.user!, p.name, { avatar: true }))), ...Array.from({ length: b.size - b.players.length }, () => h("div", { class: "br-seat open" }, "Open seat"))),
          )
        : "",
      actions.length ? h("div", { class: "bt-actions" }, ...actions) : "",
      h("div", { class: "br-tree" }, ...columns),
    );
  };
  onLeave(onBrackets(draw));
  // Animations follow the clock: redraw a few times a second while it's running.
  const tick = setInterval(() => {
    const b = bracketById(id);
    if (b?.status !== "running") return;
    const reveals = JSON.stringify(b.rounds.map((r) => r.map((m) => [m.status, m.startAt != null && serverNow() >= m.startAt + BRACKET_SHOW_MS * 0.75])));
    // Redraw when something on screen changes: a match reveals, or the pick countdown ticks.
    const key = `${reveals}|${Math.floor(serverNow() / 1000)}`;
    if (key === lastKey) return;
    if (lastKey && !lastKey.startsWith(reveals)) playTick();
    lastKey = key;
    draw();
  }, 250);
  onLeave(() => clearInterval(tick));
  draw();
  return h("section", { class: "page" }, root);
}

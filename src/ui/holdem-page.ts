import { HOLDEM_CHIPS, HOLDEM_SIZES, HOLDEM_TURN_MS, bestHand } from "../../shared/game.js";
import { holdemById, holdemGames, onHoldem, type HeCard, type HeGame, type HePlayer } from "../holdem";
import { serverNow } from "../live";
import { holdemAction, InsufficientFunds, ServerError } from "../state";
import { betInput, segmented } from "./bet-input";
import { decimalInput, h, money, parseDecimal, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";
import { avatar, userLink } from "./profile-card";
import { playReveal, playSafe, playTick } from "./sound";

// Texas Hold'em: the lobby (#/holdem) and one table (#/holdem/<id>). Sit-and-go: everyone
// pays the entry fee, starts with the same chips, and the last one with chips wins them all.

const SUITS: Record<HeCard["s"], string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

const act = async (action: "create" | "join" | "bots" | "start" | "leave" | "act", body: object) => {
  try {
    return await holdemAction(action, body);
  } catch (e) {
    if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
    else if (e instanceof ServerError) toast(e.message, "error");
    else throw e;
    return null;
  }
};

const chips = (n: number) => n.toLocaleString("en-US");

function cardEl(c: HeCard | null, cls = "") {
  if (!c) return h("div", { class: `bj-card back ${cls}` });
  const red = c.s === "h" || c.s === "d";
  return h("div", { class: `bj-card${red ? " red" : ""} ${cls}` }, h("span", { class: "bj-rank" }, c.r), h("span", { class: "bj-suit" }, SUITS[c.s]));
}

const nameOf = (p: HePlayer) => (p.bot ? h("b", null, p.name) : userLink(p.user, p.name));

// ---------- lobby ----------

export function holdemPage(code: string | null = null) {
  const list = h("div", { class: "cf-list he-list" });
  const fee = betInput(undefined, "Entry fee");
  let size = 6;
  const sizeSeg = segmented<number>(
    "Players",
    HOLDEM_SIZES.map((n) => ({ value: n, label: String(n) })),
    size,
    (v) => (size = v),
  );
  let visibility: HeGame["visibility"] = "public";
  const visSeg = segmented<HeGame["visibility"]>(
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
    const r = await act("create", { bet: fee.value(), size, visibility });
    if (r) location.hash = `#/holdem/${r.id}`;
  };
  const codeInput = h("input", { class: "search code-field", placeholder: "Code", maxlength: "6", value: code ?? "", "aria-label": "Table code" }) as HTMLInputElement;
  const codeForm = h(
    "form",
    {
      class: "bt-code",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!codeInput.value.trim()) return;
        const r = await act("join", { code: codeInput.value.trim() });
        if (r) location.hash = `#/holdem/${r.id}`;
      },
    },
    h("span", { class: "field-label" }, "Got a code for a private table?"),
    codeInput,
    h("button", { class: "btn", type: "submit" }, "Join"),
  );

  const card = (g: HeGame) => {
    const inIt = g.seat != null;
    const winner = g.winner != null ? g.players[g.winner] : null;
    const button =
      g.status === "waiting" && !inIt && g.players.length < g.size
        ? h("button", { class: "btn btn-sm btn-primary", onclick: async () => (await act("join", { id: g.id })) && (location.hash = `#/holdem/${g.id}`) }, `Join for ${money(g.fee)}`)
        : h("a", { class: "btn btn-sm", href: `#/holdem/${g.id}` }, g.status === "playing" ? (inIt ? "Play" : "Watch") : "Open");
    return h(
      "div",
      { class: `he-row ${g.status}${inIt ? " mine" : ""}` },
      h("div", { class: "he-row-seats" }, ...Array.from({ length: g.size }, (_, i) => (g.players[i] ? avatar(g.players[i].user, g.players[i].name, 30) : h("span", { class: "avatar cf-empty" }, "?")))),
      h(
        "div",
        { class: "he-row-info" },
        h("b", null, `${money(g.fee)} entry · wins ${money(g.prize)}`),
        h(
          "span",
          null,
          winner
            ? `${winner.name} won`
            : g.status === "playing"
              ? `Hand ${g.handNo} · ${g.players.filter((p) => !p.out).length} left`
              : `${g.players.length}/${g.size} seated · by ${g.creator}${g.visibility !== "public" ? (g.visibility === "friends" ? " · friends only" : " · private") : ""}`,
        ),
      ),
      button,
    );
  };
  const draw = () => {
    const all = holdemGames();
    const open = all.filter((g) => g.status !== "done");
    const done = all.filter((g) => g.status === "done");
    list.replaceChildren(
      h("h2", null, "Tables"),
      ...(open.length ? open.map(card) : [h("p", { class: "fb-empty" }, "No tables right now. Start one.")]),
      ...(done.length ? [h("h2", null, "Recent"), ...done.map(card)] : []),
    );
  };
  onLeave(onHoldem(draw));
  draw();

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Texas Hold'em"),
    h("p", { class: "hint" }, `Sit-and-go: everyone pays the entry fee and starts with ${chips(HOLDEM_CHIPS)} chips. Blinds go up as you play; the last player with chips wins every entry fee.`),
    codeForm,
    h(
      "div",
      { class: "bt-create" },
      h("div", { class: "bt-create-head" }, icon("poker", 18), h("b", null, "New table")),
      h("div", { class: "bt-create-row" }, fee.el, sizeSeg.el, visSeg.el, h("button", { class: "btn btn-primary", onclick: () => void create() }, "Create table")),
    ),
    list,
  );
}

// ---------- one table ----------

export function holdemView(id: number) {
  const root = h("div", { class: "he-view" });
  const bar = h("i");
  const timer = h("div", { class: "fb-timer rl-timer" }, bar);
  const status = h("div", { class: "rl-status he-status" });
  // The raise amount: kept across redraws while it's your turn.
  const raiseInput = decimalInput({ class: "he-raise-input", "aria-label": "Raise to" });
  const raiseRange = h("input", { type: "range", class: "he-raise-range", "aria-label": "Raise to" }) as HTMLInputElement;
  raiseRange.addEventListener("input", () => (raiseInput.value = raiseRange.value));
  raiseInput.addEventListener("input", () => (raiseRange.value = String(Math.round(parseDecimal(raiseInput.value) || 0))));
  let turnKey = "";
  let lastKey = "";
  let busy = false;

  const move = async (body: object) => {
    if (busy) return;
    busy = true;
    await act("act", { id, ...body });
    busy = false;
  };

  const seatEl = (g: HeGame, p: HePlayer, i: number, pos: number) => {
    const hd = g.hand;
    const turn = hd?.phase === "betting" && hd.toAct === i;
    const won = hd?.results?.some((r) => r.winners.includes(i));
    const cards = p.cards === null ? [cardEl(null, "sm"), cardEl(null, "sm")] : p.cards.map((c) => cardEl(c, "sm"));
    return h(
      "div",
      { class: `he-seat pos${pos}${i === g.seat ? " me" : ""}${turn ? " turn" : ""}${p.folded && p.inHand ? " folded" : ""}${p.out ? " out" : ""}${won ? " won" : ""}` },
      h("div", { class: "he-seat-cards" }, ...(p.inHand ? cards : [])),
      h(
        "div",
        { class: "he-seat-box" },
        avatar(p.user, p.name, 30),
        h(
          "div",
          { class: "he-seat-text" },
          h("div", { class: "he-seat-name" }, nameOf(p), g.button === i ? h("span", { class: "he-dealer", title: "Dealer" }, "D") : ""),
          h("div", { class: "he-seat-chips" }, p.out ? (p.place ? `Out · #${p.place}` : "Out") : `${chips(p.chips)} chips`),
        ),
      ),
      h("div", { class: "he-seat-last" }, p.hand ?? (p.away && !p.out ? "Away" : (p.last ?? ""))),
      p.bet > 0 ? h("div", { class: "he-bet" }, chips(p.bet)) : "",
    );
  };

  const draw = () => {
    const g = holdemById(id);
    if (!g) {
      root.replaceChildren(h("p", { class: "empty" }, "This table doesn't exist, is private, or was cancelled. ", h("a", { href: "#/holdem" }, "Back to tables")));
      return;
    }
    const hd = g.hand;
    const me = g.seat;
    // Sounds: your turn, and a hand you won.
    const key = `${hd?.no}:${hd?.phase}:${hd?.toAct}:${g.status}`;
    if (key !== lastKey) {
      if (hd?.phase === "betting" && hd.toAct === me && me != null) playTick();
      if (hd?.phase === "result" && me != null && hd.results?.some((r) => r.winners.includes(me))) playSafe();
      if (g.status === "done" && lastKey && g.winner === me && me != null) playReveal("covert");
      lastKey = key;
    }

    // Seats go round the table with yours at the bottom.
    const n = g.players.length;
    const from = me ?? 0;
    const seats = g.players.map((p, i) => seatEl(g, p, i, (i - from + n) % n));
    const board = hd ? [...hd.board.map((c) => cardEl(c)), ...Array.from({ length: 5 - hd.board.length }, () => h("div", { class: "bj-card slot" }))] : [];
    const results = hd?.results
      ? h(
          "div",
          { class: "he-results" },
          ...hd.results.map((r) => h("div", null, h("b", null, r.winners.map((w) => g.players[w].name).join(" & ")), ` ${r.winners.length > 1 ? "split" : "wins"} ${chips(r.amount)}${r.hand ? ` with ${r.hand}` : ""}`)),
        )
      : "";
    const felt = h(
      "div",
      { class: `he-felt seats${n}` },
      h(
        "div",
        { class: "he-centre" },
        g.status === "waiting"
          ? h("div", { class: "he-wait" }, h("b", null, `Waiting for players · ${g.players.length}/${g.size}`), h("span", null, `${money(g.fee)} entry · winner takes ${money(g.prize)}`))
          : h(
              "div",
              null,
              h("div", { class: "he-board" }, ...board),
              h("div", { class: "he-pot" }, hd ? `Pot ${chips(hd.pot)}` : ""),
              hd ? h("div", { class: "he-blinds" }, `Blinds ${hd.sb}/${hd.bb}${hd.nextLevelIn ? ` · up in ${hd.nextLevelIn} hand${hd.nextLevelIn === 1 ? "" : "s"}` : ""}`) : "",
              results,
            ),
      ),
      ...seats,
    );

    // Your hand's name, once there are cards to name.
    const mine = me != null ? g.players[me] : null;
    const myHand = mine?.cards?.length && hd ? bestHand([...mine.cards, ...hd.board]).name : null;

    const controls: (HTMLElement | string)[] = [];
    if (g.status === "waiting") {
      if (g.mine)
        controls.push(
          h(
            "div",
            { class: "bt-actions cf-actions" },
            h("button", { class: "btn btn-primary", onclick: () => void act("bots", { id }) }, icon("box", 14), ` Fill ${g.size - g.players.length} seat${g.size - g.players.length === 1 ? "" : "s"} with bots`),
            g.players.length >= 2 ? h("button", { class: "btn", onclick: () => void act("start", { id }) }, `Start now with ${g.players.length}`) : "",
            h("button", { class: "btn btn-ghost", onclick: () => confirm("Cancel this table? Everyone gets their entry fee back.") && void act("leave", { id }).then((r) => r && (location.hash = "#/holdem")) }, "Cancel"),
          ),
        );
      else if (me != null) controls.push(h("button", { class: "btn btn-ghost", onclick: () => void act("leave", { id }) }, "Get up (fee back)"));
      else if (g.players.length < g.size) controls.push(h("button", { class: "btn btn-primary btn-lg", onclick: () => void act("join", { id }) }, `Sit down for ${money(g.fee)}`));
      if (g.code && me != null) controls.push(h("p", { class: "hint" }, "Private table. Share the code ", h("b", null, g.code), " to let people join."));
    } else if (g.status === "playing" && hd?.you && me != null) {
      const y = hd.you;
      const tk = `${hd.no}:${hd.street}:${hd.currentBet}`;
      if (tk !== turnKey) {
        turnKey = tk;
        raiseRange.min = String(y.minRaiseTo);
        raiseRange.max = String(y.maxRaiseTo);
        raiseRange.step = String(Math.max(1, Math.round(hd.bb / 2)));
        raiseRange.value = raiseInput.value = String(y.minRaiseTo);
      }
      const canRaise = y.maxRaiseTo > hd.currentBet && mine!.chips > y.toCall;
      const preset = (label: string, to: number) =>
        h("button", { class: "btn btn-sm", type: "button", onclick: () => (raiseRange.value = raiseInput.value = String(Math.min(y.maxRaiseTo, Math.max(y.minRaiseTo, Math.round(to))))) }, label);
      controls.push(
        h(
          "div",
          { class: "he-actions" },
          h("button", { class: "btn btn-danger", onclick: () => void move({ move: "fold" }) }, "Fold"),
          y.toCall > 0
            ? h("button", { class: "btn", onclick: () => void move({ move: "call" }) }, y.toCall >= mine!.chips ? `All-in ${chips(y.toCall)}` : `Call ${chips(y.toCall)}`)
            : h("button", { class: "btn", onclick: () => void move({ move: "check" }) }, "Check"),
          canRaise
            ? h(
                "div",
                { class: "he-raise" },
                h("div", { class: "he-presets" }, preset("Min", y.minRaiseTo), preset("½ pot", hd.currentBet + hd.pot / 2), preset("Pot", hd.currentBet + hd.pot), preset("All-in", y.maxRaiseTo)),
                h("div", { class: "he-raise-row" }, raiseRange, raiseInput),
                h(
                  "button",
                  { class: "btn btn-primary", onclick: () => void move({ move: "raise", amount: parseDecimal(raiseInput.value) }) },
                  hd.currentBet > 0 ? "Raise to" : "Bet",
                ),
              )
            : "",
        ),
      );
    }
    if (g.status === "playing" && mine && !mine.out)
      controls.push(h("button", { class: "btn btn-ghost btn-sm he-leave", onclick: () => confirm("Leave the table? You forfeit the game and your entry fee.") && void act("leave", { id }) }, "Leave table"));
    if (g.status === "done" && g.winner != null) {
      const w = g.players[g.winner];
      controls.push(h("div", { class: `he-final${g.winner === me ? " won" : ""}` }, g.winner === me ? `You won ${money(g.prize)}!` : `${w.name} won ${money(g.prize)}`, h("a", { class: "btn btn-sm", href: "#/holdem" }, "Back to tables")));
    }

    root.replaceChildren(
      h("div", { class: "bt-crumbs" }, h("a", { href: "#/holdem" }, "Tables"), h("h1", null, `Hold'em · ${money(g.fee)} entry`)),
      h("div", { class: "game-stage he-stage" }, felt, h("div", { class: "rl-under" }, status, timer)),
      myHand ? h("div", { class: "he-myhand" }, "You have ", h("b", null, myHand)) : "",
      ...controls,
      g.log.length ? h("div", { class: "he-log" }, ...g.log.slice(-6).map((l) => h("div", null, l))) : "",
    );
  };

  let raf = 0;
  const loop = () => {
    const g = holdemById(id);
    const hd = g?.hand;
    const left = hd?.deadline ? Math.max(0, hd.deadline - serverNow()) : 0;
    timer.hidden = !(g?.status === "playing" && hd?.phase === "betting" && hd.deadline);
    bar.style.width = `${(left / HOLDEM_TURN_MS) * 100}%`;
    if (!g) status.textContent = "";
    else if (g.status === "waiting") status.textContent = "Waiting for players";
    else if (g.status === "done") status.textContent = "Game over";
    else if (hd?.phase === "result") status.textContent = "Next hand soon";
    else if (hd?.phase === "dealing") status.textContent = "Dealing...";
    else if (hd && hd.toAct >= 0) status.textContent = hd.toAct === g.seat ? `Your turn · ${Math.ceil(left / 1000)}s` : `${g.players[hd.toAct].name} to act · ${Math.ceil(left / 1000)}s`;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));
  onLeave(onHoldem(draw));
  draw();
  return h("section", { class: "page" }, root);
}

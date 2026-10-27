import { bjState, onBlackjack, type BjCard, type BjSeat, type BjState } from "../blackjack";
import { serverNow } from "../live";
import { BJ_BET_MS, BJ_PLAY_MS, BJ_SEATS } from "../odds";
import { blackjackAction, getState, InsufficientFunds, ServerError } from "../state";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { userLink } from "./profile-card";
import { playBoom, playReveal, playSafe, playTick } from "./sound";

// Blackjack: one dealer, up to four players who all play their hand at the same time.
// Your hand is shown big, the other seats at the table beside it.

const SUITS: Record<BjCard["s"], string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

function cardEl(c: BjCard | null, fresh: boolean) {
  const cls = `bj-card${fresh ? " dealt" : ""}`;
  if (!c) return h("div", { class: `${cls} back` });
  const red = c.s === "h" || c.s === "d";
  return h("div", { class: `${cls}${red ? " red" : ""}` }, h("span", { class: "bj-rank" }, c.r), h("span", { class: "bj-suit" }, SUITS[c.s]));
}

const STATUS: Record<BjSeat["status"], string> = { betting: "Waiting for cards", playing: "Thinking...", stood: "Stands", bust: "Bust", blackjack: "Blackjack!" };
const RESULT: Record<NonNullable<BjSeat["result"]>, string> = { blackjack: "Blackjack!", win: "Win", push: "Push", lose: "Lose" };

export function blackjackPage() {
  const dealerCards = h("div", { class: "bj-cards" });
  const dealerTotal = h("span", { class: "bj-total" });
  const status = h("div", { class: "rl-status bj-status" });
  const bar = h("i");
  const timer = h("div", { class: "fb-timer rl-timer" }, bar);
  const mySeat = h("div", { class: "bj-seat mine" });
  const others = h("div", { class: "bj-others" });

  // ---------- controls ----------
  const bet = betInput();
  let busy = false;
  const act = async (action: "bet" | "hit" | "stand" | "double") => {
    if (busy) return;
    busy = true;
    try {
      await blackjackAction(action, action === "bet" ? bet.value() : undefined);
    } catch (e) {
      if (e instanceof InsufficientFunds) toast(e.message || "Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
    }
  };
  const dealBtn = h("button", { class: "btn btn-primary", onclick: () => void act("bet") }, "Place bet");
  const hitBtn = h("button", { class: "btn btn-primary", onclick: () => void act("hit") }, "Hit");
  const standBtn = h("button", { class: "btn", onclick: () => void act("stand") }, "Stand");
  const doubleBtn = h("button", { class: "btn", onclick: () => void act("double") }, "Double");
  const betRow = h("div", { class: "rl-controls bj-bet" }, bet.el, dealBtn);
  const playRow = h("div", { class: "bj-actions" }, hitBtn, standBtn, doubleBtn);

  // Cards already on screen, so only new ones get the deal animation.
  const shown = new Map<string, number>();
  const cardsOf = (key: string, cards: (BjCard | null)[]) => {
    const before = shown.get(key) ?? 0;
    shown.set(key, cards.length);
    return cards.map((c, i) => cardEl(c, i >= before));
  };

  const seatEl = (el: HTMLElement, s: BjSeat, round: number) => {
    const badge = s.result ? RESULT[s.result] : STATUS[s.status];
    const cls = s.result ?? s.status;
    el.className = `bj-seat${el === mySeat ? " mine" : ""} ${cls}`;
    el.replaceChildren(
      h("div", { class: "bj-seat-head" }, userLink(s.user, s.name, { avatar: true }), h("b", null, money(s.stake), s.doubled ? " (doubled)" : "")),
      h("div", { class: "bj-cards" }, ...cardsOf(`${round}:${s.user}`, s.cards)),
      h(
        "div",
        { class: "bj-seat-foot" },
        h("span", { class: "bj-total" }, s.total == null ? "" : `${s.soft && s.total < 21 ? "Soft " : ""}${s.total}`),
        h("span", { class: `bj-badge ${cls}` }, badge, s.result && s.payout > 0 ? ` +${money(s.payout)}` : ""),
      ),
    );
    return el;
  };

  let lastRound = -1;
  let lastPhase = "";
  let lastDealer = 0;
  const draw = (st: BjState) => {
    const t = st.table;
    const me = getState().username;
    const seat = t?.seats.find((s) => s.user === me);
    if (!t || t.phase === "idle") {
      dealerCards.replaceChildren(cardEl(null, false), cardEl(null, false));
      dealerTotal.textContent = "";
      shown.clear();
    } else {
      dealerCards.replaceChildren(...cardsOf(`${t.round}:dealer`, t.dealer));
      dealerTotal.textContent = t.dealerTotal == null ? "" : String(t.dealerTotal);
    }
    // Sounds: a tick per dealer card, and the result of your own hand.
    if (t) {
      if (t.round === lastRound && t.dealer.length > lastDealer && t.phase === "dealer") playTick();
      if (t.phase === "result" && lastPhase !== "result" && seat?.result) {
        if (seat.result === "lose") playBoom();
        else if (seat.result === "push") playSafe();
        else playReveal(seat.result === "blackjack" ? "covert" : "restricted");
      }
      lastRound = t.round;
      lastPhase = t.phase;
      lastDealer = t.dealer.length;
    }

    if (seat && t) seatEl(mySeat, seat, t.round);
    else mySeat.replaceChildren(h("div", { class: "bj-empty" }, "Place a bet to sit down. Everyone at the table plays their hand at the same time."));
    mySeat.hidden = false;
    const rest = (t?.seats ?? []).filter((s) => s.user !== me);
    others.replaceChildren(
      ...rest.map((s) => seatEl(h("div"), s, t!.round)),
      ...Array.from({ length: Math.max(0, BJ_SEATS - 1 - rest.length) }, () => h("div", { class: "bj-seat open" }, h("div", { class: "bj-empty" }, "Open seat"))),
    );

    const playing = seat?.status === "playing" && t?.phase === "playing";
    playRow.hidden = !playing;
    doubleBtn.disabled = !playing || seat!.cards.length !== 2;
    // You can bet when you're not in the current hand (or it's over).
    const canBet = !seat || t?.phase === "result" || t?.phase === "idle";
    betRow.hidden = !canBet;
  };

  // ---------- the clock ----------
  let raf = 0;
  const loop = () => {
    const t = bjState()?.table;
    const left = t?.deadline ? Math.max(0, t.deadline - serverNow()) : 0;
    timer.hidden = !(t && (t.phase === "betting" || t.phase === "playing"));
    if (!t || t.phase === "idle") status.textContent = "Waiting for players";
    else if (t.phase === "betting") {
      status.textContent = `Dealing in ${(left / 1000).toFixed(1)}s`;
      bar.style.width = `${(left / BJ_BET_MS) * 100}%`;
    } else if (t.phase === "playing") {
      status.textContent = `${Math.ceil(left / 1000)}s to play your hand`;
      bar.style.width = `${(left / BJ_PLAY_MS) * 100}%`;
    } else if (t.phase === "dealer") status.textContent = "Dealer plays";
    else status.textContent = t.dealerTotal != null && t.dealerTotal > 21 ? "Dealer busts" : `Dealer has ${t.dealerTotal}`;
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));
  onLeave(onBlackjack(draw));
  draw(bjState() ?? { tables: 0, table: null });

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Blackjack"),
    h(
      "div",
      { class: "game-stage bj-stage" },
      h("div", { class: "bj-dealer" }, h("div", { class: "bj-dealer-head" }, h("span", null, "Dealer"), dealerTotal), dealerCards, h("div", { class: "bj-rules" }, "Blackjack pays 3:2 · Dealer stands on 17")),
      h("div", { class: "rl-under" }, status, timer),
      h("div", { class: "bj-table" }, mySeat, others),
    ),
    playRow,
    betRow,
  );
}

import { POKER_HANDS, pokerHand, type PokerCard } from "../../shared/game.js";
import { InsufficientFunds, pokerDeal, pokerDraw, pokerState, ServerError } from "../state";
import { betInput } from "./bet-input";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";
import { playBoom, playReveal, playTick } from "./sound";

// Video poker, Jacks or Better: deal five, tap the cards to hold, draw once.

const SUITS: Record<PokerCard["s"], string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const FLIP_MS = 130;

function cardFace(c: PokerCard | null) {
  if (!c) return h("div", { class: "bj-card back" });
  const red = c.s === "h" || c.s === "d";
  return h("div", { class: `bj-card${red ? " red" : ""}` }, h("span", { class: "bj-rank" }, c.r), h("span", { class: "bj-suit" }, SUITS[c.s]));
}

export function pokerPage() {
  let hand: (PokerCard | null)[] = [null, null, null, null, null];
  let hold = [false, false, false, false, false];
  /** "idle": no hand; "holding": dealt, choosing what to keep; "busy": cards moving. */
  let phase: "idle" | "holding" | "busy" = "busy";
  let winId: string | null = null;
  let left = false;
  onLeave(() => (left = true));

  const bet = betInput();
  const status = h("div", { class: "vp-status" });
  const slots = Array.from({ length: 5 }, (_, i) =>
    h("button", {
      type: "button",
      class: "vp-slot",
      onclick: () => {
        if (phase !== "holding") return;
        hold[i] = !hold[i];
        playTick();
        draw();
      },
    }),
  );
  const table = h("div", { class: "vp-pays" });
  const actBtn = h("button", { class: "btn btn-primary btn-lg vp-act", onclick: () => void act() });

  const draw = () => {
    slots.forEach((el, i) => {
      el.classList.toggle("held", hold[i]);
      el.disabled = phase !== "holding";
      el.replaceChildren(cardFace(hand[i]), h("span", { class: "vp-held" }, hold[i] ? "HELD" : ""));
    });
    const dealt = phase === "holding" && hand.every(Boolean) ? pokerHand(hand as PokerCard[]) : null;
    const show = winId ?? dealt?.id ?? null;
    table.replaceChildren(
      ...POKER_HANDS.map((x) => h("div", { class: `vp-pay${x.id === show ? (winId ? " win" : " now") : ""}` }, h("span", null, x.name), h("b", null, `${x.pay}x`))),
    );
    actBtn.textContent = phase === "holding" ? "Draw" : "Deal";
    actBtn.disabled = phase === "busy";
    bet.setDisabled(phase !== "idle");
  };

  /** Show cards one by one, face down first. */
  const flip = async (cards: PokerCard[], which: boolean[]) => {
    which.forEach((w, i) => w && (hand[i] = null));
    draw();
    for (let i = 0; i < 5; i++) {
      if (!which[i]) continue;
      await new Promise((r) => setTimeout(r, FLIP_MS));
      hand[i] = cards[i];
      playTick();
      draw();
      slots[i].firstElementChild?.classList.add("dealt");
    }
  };

  const act = async () => {
    if (phase === "busy") return;
    const was = phase;
    phase = "busy";
    draw();
    try {
      if (was === "idle") {
        const r = await pokerDeal(bet.value());
        hold = [false, false, false, false, false];
        winId = null;
        status.textContent = "";
        await flip(r.run.hand, [true, true, true, true, true]);
        phase = "holding";
        status.textContent = "Tap cards to hold them, then draw.";
      } else {
        const r = await pokerDraw(hold);
        await flip(r.hand, hold.map((x) => !x));
        r.reveal();
        const res = POKER_HANDS.find((x) => x.id === r.result);
        winId = res?.id ?? null;
        if (res) {
          status.textContent = `${res.name}: +${money(r.payout)}`;
          if (!left) playReveal(res.pay >= 25 ? "gold" : res.pay >= 6 ? "covert" : res.pay >= 3 ? "classified" : "restricted");
        } else {
          status.textContent = "No win";
          if (!left) playBoom();
        }
        phase = "idle";
      }
    } catch (e) {
      phase = was;
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
    draw();
  };

  // Pick up a hand that was dealt before a reload.
  void pokerState()
    .then((r) => {
      if (r.run) {
        hand = r.run.hand;
        phase = "holding";
        status.textContent = `Your ${money(r.run.stake)} hand. Tap cards to hold them, then draw.`;
      } else phase = "idle";
      draw();
    })
    .catch(() => {
      phase = "idle";
      draw();
    });
  draw();

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Video poker"),
    h(
      "div",
      { class: "game-stage vp-stage" },
      table,
      h("div", { class: "vp-hand" }, ...slots),
      status,
    ),
    h("div", { class: "rl-controls vp-controls" }, bet.el, actBtn),
  );
}

import { BET_MIN, perkValue } from "../odds";
import { displayBalance, getState } from "../state";
import { decimalInput, h, parseDecimal } from "./dom";
import { icon } from "./icons";

const KEY = "strafeclicker:bet";
const ADDS: [string, number][] = [
  ["+1", 1],
  ["+10", 10],
  ["+100", 100],
  ["+1K", 1000],
];

/** Bet amount field with half / double / max buttons and +1 to +1K. Remembers the last amount. */
export function betInput(onChange?: () => void, label = "Bet amount") {
  let saved = 0.1;
  try {
    saved = Number(localStorage.getItem(KEY)) || saved;
  } catch {
    // storage unavailable
  }
  const input = decimalInput({ class: "bet-field", value: saved.toFixed(2), "aria-label": "Bet amount" });

  // Up to the account's max bet (the upgrade tree raises it).
  const clamp = (v: number) => Math.round(Math.min(perkValue(getState().perks, "maxBet"), Math.max(BET_MIN, v)) * 100) / 100;
  const set = (v: number) => {
    input.value = clamp(v).toFixed(2);
    save();
    onChange?.();
  };
  const save = () => {
    try {
      localStorage.setItem(KEY, String(value()));
    } catch {
      // ignore
    }
  };
  const value = () => clamp(parseDecimal(input.value) || 0);
  input.addEventListener("change", () => set(value()));
  input.addEventListener("input", () => onChange?.());

  const el = h(
    "div",
    { class: "bet" },
    h("label", { class: "field-label" }, label),
    h(
      "div",
      { class: "bet-row" },
      h("span", { class: "bet-cur" }, icon("coins", 14)),
      input,
      h("button", { class: "bet-btn", type: "button", onclick: () => set(value() / 2) }, "½"),
      h("button", { class: "bet-btn", type: "button", onclick: () => set(value() * 2) }, "2×"),
      h("button", { class: "bet-btn", type: "button", onclick: () => set(Math.floor(displayBalance() * 100) / 100) }, "Max"),
    ),
    h(
      "div",
      { class: "bet-adds" },
      ...ADDS.map(([label, add]) => h("button", { class: "bet-btn", type: "button", onclick: () => set(value() + add) }, label)),
      h("button", { class: "bet-btn", type: "button", title: "Back to the smallest bet", onclick: () => set(BET_MIN) }, "Clear"),
    ),
  );
  return {
    el,
    value,
    set,
    setDisabled(d: boolean) {
      el.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((x) => (x.disabled = d));
    },
  };
}

/** A row of mutually exclusive options. */
export function segmented<T extends string | number>(label: string, options: { value: T; label: string }[], initial: T, onPick: (v: T) => void) {
  let current = initial;
  const buttons = options.map((o) =>
    h(
      "button",
      {
        type: "button",
        class: `seg-btn${o.value === current ? " active" : ""}`,
        onclick: () => {
          current = o.value;
          buttons.forEach((b, i) => b.classList.toggle("active", options[i].value === current));
          onPick(current);
        },
      },
      o.label,
    ),
  );
  const el = h("div", { class: "seg-wrap" }, h("label", { class: "field-label" }, label), h("div", { class: "seg" }, ...buttons));
  return {
    el,
    get value() {
      return current;
    },
    setDisabled(d: boolean) {
      buttons.forEach((b) => (b.disabled = d));
    },
  };
}

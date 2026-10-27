import { OFFLINE_CAP_HOURS, perkValue } from "../odds";
import { click, clickValue, displayBalance, getState, subscribe } from "../state";
import { h, money } from "./dom";
import { onLeave } from "./page";
import { playTick } from "./sound";

let sessionClicks = 0;
let sessionEarned = 0;

export function clickerPage() {
  const balance = h("div", { class: "clicker-balance" });
  const session = h("b");
  const lifetime = h("b");
  const sync = () => {
    balance.textContent = money(displayBalance());
    session.textContent = `${sessionClicks} (${money(sessionEarned)})`;
    lifetime.textContent = String(getState().stats.clicks);
    worth.textContent = `+${money(clickValue())}`;
    perClick.textContent = money(clickValue());
  };
  onLeave(subscribe(sync));

  const worth = h("small");
  const perClick = h("b");
  const button = h("button", { class: "clicker-button", "aria-label": "Click for money" }, h("span", null, "CLICK"), worth);
  const zone = h("div", { class: "clicker-zone" }, button);

  button.addEventListener("click", (e) => {
    sessionClicks++;
    sessionEarned += clickValue();
    click();
    playTick();
    // Keyboard presses report 0,0; float the label from the button's centre then.
    const box = zone.getBoundingClientRect();
    const x = e.clientX ? e.clientX - box.left : box.width / 2;
    const y = e.clientY ? e.clientY - box.top : box.height / 2;
    const pop = h("span", { class: "clicker-pop", style: `left:${x}px;top:${y}px` }, `+${money(clickValue())}`);
    zone.append(pop);
    pop.addEventListener("animationend", () => pop.remove());
    button.classList.remove("hit");
    void button.offsetWidth;
    button.classList.add("hit");
  });
  // Holding a key down shouldn't count as hundreds of clicks.
  button.addEventListener("keydown", (e) => e.repeat && e.preventDefault());

  sync();
  return h(
    "section",
    { class: "page narrow clicker" },
    h("h1", null, "Clicker"),
    h("p", { class: "hint" }, "Click for money, spend it on cases and capsules. ", h("a", { href: "#/tree" }, "Upgrade your clicks"), " in the upgrade tree."),
    balance,
    zone,
    h(
      "div",
      { class: "case-stats" },
      h("div", { class: "stat" }, h("span", null, "Per click"), perClick),
      h("div", { class: "stat" }, h("span", null, "This visit"), session),
      h("div", { class: "stat" }, h("span", null, "All-time clicks"), lifetime),
      h(
        "div",
        { class: "stat", title: `Paid when you come back, for up to ${OFFLINE_CAP_HOURS} hours away` },
        h("span", null, "Offline income"),
        h("b", null, `${money(perkValue(getState().perks, "offlineIncome"))}/h`),
      ),
    ),
  );
}

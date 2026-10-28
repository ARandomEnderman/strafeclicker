import { CLICK_CPS_LIMIT, OFFLINE_CAP_HOURS, offlinePerHour } from "../odds";
import { click, clickSpeed, clickValue, displayBalance, getState, subscribe } from "../state";
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

  // Click speed: full pay up to CLICK_CPS_LIMIT per second, exponentially less above it.
  const cpsValue = h("b");
  const cpsFill = h("i");
  const cpsNote = h("span", { class: "cps-note" });
  const meter = h(
    "div",
    { class: "cps", title: `Clicks pay in full up to ${CLICK_CPS_LIMIT} per second. Faster than that, each click is worth exponentially less.` },
    h("div", { class: "cps-head" }, h("span", null, "Clicks per second"), cpsValue, cpsNote),
    h("div", { class: "cps-bar" }, cpsFill, h("u", { style: `left:${(CLICK_CPS_LIMIT / 20) * 100}%` })),
  );
  const drawSpeed = () => {
    const { cps, efficiency } = clickSpeed();
    cpsValue.textContent = cps.toFixed(1);
    cpsFill.style.width = `${Math.min(100, (cps / 20) * 100)}%`;
    meter.classList.toggle("over", efficiency < 1);
    cpsNote.textContent = efficiency < 1 ? `paying ${Math.round(efficiency * 100)}%` : "";
  };
  const speedTimer = setInterval(drawSpeed, 100);
  onLeave(() => clearInterval(speedTimer));
  drawSpeed();

  button.addEventListener("click", (e) => {
    sessionClicks++;
    const earned = click();
    sessionEarned += earned;
    drawSpeed();
    playTick();
    // Keyboard presses report 0,0; float the label from the button's centre then.
    const box = zone.getBoundingClientRect();
    const x = e.clientX ? e.clientX - box.left : box.width / 2;
    const y = e.clientY ? e.clientY - box.top : box.height / 2;
    const pop = h("span", { class: "clicker-pop", style: `left:${x}px;top:${y}px` }, `+${money(earned)}`);
    pop.classList.toggle("weak", earned < clickValue() - 1e-9);
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
    meter,
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
        h("b", null, `${money(offlinePerHour(getState().perks))}/h`),
      ),
    ),
  );
}

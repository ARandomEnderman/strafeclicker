import "./style.css";
import { getCase, getCatalog, loadCatalog } from "./catalog";
import type { Case } from "./types";
import { displayBalance, getState, initState, resetAll, subscribe } from "./state";
import { h, money } from "./ui/dom";
import { casesPage } from "./ui/cases-page";
import { casePage } from "./ui/case-page";
import { inventoryPage } from "./ui/inventory-page";
import { clickerPage } from "./ui/clicker-page";
import { upgraderPage } from "./ui/upgrader-page";
import { treePage } from "./ui/tree-page";
import { leavePage } from "./ui/page";
import { setSound, soundEnabled } from "./ui/sound";
import { clearPageListeners, onPrices, startLive } from "./live";
import { countdown } from "./ui/countdown";
import { showInventoryChange } from "./ui/price-popup";

const app = document.getElementById("app")!;

function header() {
  const balance = h("b", { class: "balance-amount" });
  const invCount = h("span", { class: "badge" });
  const sync = () => {
    balance.textContent = money(displayBalance());
    invCount.textContent = String(getState().inventory.length);
  };
  subscribe(sync);
  sync();

  const soundBtn = h("button", { class: "btn btn-ghost btn-sm", title: "Sound" }, soundEnabled() ? "🔊" : "🔇");
  soundBtn.addEventListener("click", () => {
    setSound(!soundEnabled());
    soundBtn.textContent = soundEnabled() ? "🔊" : "🔇";
  });

  return h(
    "header",
    { class: "topbar" },
    h("a", { class: "logo", href: "#/" }, "STRAFE", h("span", null, "CLICKER")),
    h(
      "nav",
      null,
      h("a", { href: "#/", "data-route": "cases" }, "Cases"),
      h("a", { href: "#/clicker", "data-route": "clicker" }, "Clicker"),
      h("a", { href: "#/upgrader", "data-route": "upgrader" }, "Upgrader"),
      h("a", { href: "#/tree", "data-route": "tree" }, "Upgrade tree"),
      h("a", { href: "#/inventory", "data-route": "inventory" }, "Inventory ", invCount),
    ),
    countdown(),
    h(
      "div",
      { class: "balance" },
      soundBtn,
      h("span", { class: "balance-label" }, "Balance"),
      balance,
    ),
  );
}

function footer() {
  return h(
    "footer",
    { class: "footer" },
    h("span", null, "Simulator only. Play money, no deposits, no withdrawals, nothing is real. Not affiliated with Valve."),
    h("span", null, `Prices: ${getCatalog().sources.prices}, refreshed by the server every minute.`),
    h(
      "button",
      {
        class: "linklike",
        onclick: async () => {
          if (!confirm("Wipe balance, inventory and stats?")) return;
          await resetAll();
          route();
        },
      },
      "Reset everything",
    ),
  );
}

const main = h("main");

const KINDS: Case["kind"][] = ["case", "capsule", "autograph"];

function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const [, page, arg] = path.split("/");
  let view: HTMLElement;
  let active = page || "cases";
  clearPageListeners();
  leavePage();
  if (page === "case" && arg && getCase(arg)) {
    view = casePage(getCase(arg)!);
    active = "cases";
  } else if (page === "inventory") view = inventoryPage();
  else if (page === "clicker") view = clickerPage();
  else if (page === "upgrader") view = upgraderPage();
  else if (page === "tree") view = treePage();
  else {
    const kind = new URLSearchParams(query).get("kind") as Case["kind"];
    view = casesPage(KINDS.includes(kind) ? kind : "case");
    active = "cases";
  }

  document.querySelectorAll<HTMLAnchorElement>("nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === active));
  main.replaceChildren(view);
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    await Promise.all([loadCatalog(), initState()]);
  } catch (err) {
    app.replaceChildren(h("p", { class: "empty" }, `Couldn't load the item catalog: ${(err as Error).message}`));
    throw err;
  }
  app.replaceChildren(header(), main, footer(), h("div", { id: "toasts" }));
  window.addEventListener("hashchange", route);
  route();
  onPrices(showInventoryChange);
  startLive();
}

boot();

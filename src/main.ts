import "./style.css";
import { getCase, getCatalog, loadCatalog, priceOf, round2 } from "./catalog";
import type { Case } from "./types";
import type { Account } from "./types";
import { displayBalance, getState, initState, logout, resetAll, setLoggedOutHandler, setOfflineHandler, subscribe } from "./state";
import { openModal } from "./ui/modal";
import { icon } from "./ui/icons";
import { authPage } from "./ui/auth-page";
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
  const invValue = h("b");
  const sync = () => {
    balance.textContent = money(displayBalance());
    invCount.textContent = String(getState().inventory.length);
    invValue.textContent = money(round2(getState().inventory.reduce((s, it) => s + priceOf(it), 0)));
  };
  subscribe(sync);
  onPrices(sync);
  sync();

  const soundBtn = h("button", { class: "btn btn-ghost btn-sm", title: "Sound", "aria-label": "Toggle sound" }, icon(soundEnabled() ? "sound" : "mute"));
  soundBtn.addEventListener("click", () => {
    setSound(!soundEnabled());
    soundBtn.replaceChildren(icon(soundEnabled() ? "sound" : "mute"));
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
      h("a", { class: "inv-value", href: "#/inventory", title: "Current market value of your inventory" }, h("span", null, "Inventory"), invValue),
      h(
        "div",
        { class: "user" },
        h("span", { class: "user-name", title: "Logged in" }, getState().username),
        h("button", { class: "btn btn-ghost btn-sm", onclick: () => logout() }, "Log out"),
      ),
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
          if (!confirm(`Wipe ${getState().username}'s balance, inventory, stats and upgrades? This can't be undone.`)) return;
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

function startApp() {
  app.replaceChildren(header(), main, footer(), h("div", { id: "toasts" }));
  window.addEventListener("hashchange", route);
  route();
  onPrices(showInventoryChange);
  startLive();
  if (pendingOffline) showOffline(pendingOffline);
  pendingOffline = null;
}

function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** "Welcome back" popup for offline income (shown once the app is on screen). */
let pendingOffline: NonNullable<Account["offline"]> | null = null;
function showOffline(o: NonNullable<Account["offline"]>) {
  if (!document.querySelector(".topbar")) {
    pendingOffline = o;
    return;
  }
  openModal(
    "Welcome back",
    h(
      "div",
      { class: "popup-body" },
      h(
        "div",
        { class: "popup-hero" },
        h("div", { class: "popup-label" }, `You were away for ${duration(o.seconds)}`),
        h("div", { class: "popup-value" }, `+${money(o.earned)}`),
        h("div", { class: "popup-was" }, "offline income. ", h("a", { href: "#/tree" }, "Earn more"), " in the upgrade tree."),
      ),
    ),
  );
}

async function boot() {
  setOfflineHandler(showOffline);
  let loggedIn: boolean;
  try {
    [, loggedIn] = await Promise.all([loadCatalog(), initState()]);
  } catch (err) {
    app.replaceChildren(h("p", { class: "empty" }, `Couldn't load the item catalog: ${(err as Error).message}`));
    throw err;
  }
  // Session expired mid-visit: back to the login screen (a reload keeps it simple).
  setLoggedOutHandler(() => location.reload());
  if (loggedIn) startApp();
  else app.replaceChildren(authPage(async () => (await initState()) && startApp()));
}

boot();

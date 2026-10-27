import "./style.css";
import { getCase, getCatalog, loadCatalog, priceOf, round2 } from "./catalog";
import type { Case } from "./types";
import type { Account } from "./types";
import { displayBalance, getState, initState, logout, resetAll, setLoggedOutHandler, setOfflineHandler, setUnlockedHandler, subscribe } from "./state";
import { openModal } from "./ui/modal";
import { icon, type IconName } from "./ui/icons";
import { feedPanel } from "./ui/feed";
import { authPage } from "./ui/auth-page";
import { h, money, toast } from "./ui/dom";
import { casesPage } from "./ui/cases-page";
import { casePage } from "./ui/case-page";
import { inventoryPage } from "./ui/inventory-page";
import { clickerPage } from "./ui/clicker-page";
import { upgraderPage } from "./ui/upgrader-page";
import { treePage } from "./ui/tree-page";
import { achievementsPage } from "./ui/achievements-page";
import { plinkoPage } from "./ui/plinko-page";
import { flashbangPage } from "./ui/flashbang-page";
import { bhopPage } from "./ui/bhop-page";
import { battlesPage } from "./ui/battles-page";
import { battlePage } from "./ui/battle-page";
import "./battles";
import { friendsPage } from "./ui/friends-page";
import { tradePage } from "./ui/trade-page";
import { loadTrades, onTrades, tradeLists } from "./trades";
import { friendLists, loadFriends, onFriends } from "./friends";
import "./flashbang";
import { ACHIEVEMENTS } from "../shared/achievements.js";
import { leavePage } from "./ui/page";
import { setSound, soundEnabled } from "./ui/sound";
import { clearPageListeners, onPrices, startLive } from "./live";
import { countdown } from "./ui/countdown";
import { showInventoryChange } from "./ui/price-popup";

const app = document.getElementById("app")!;

type NavItem = { route: string; href: string; label: string; icon: IconName };
const MAIN_NAV: NavItem[] = [
  { route: "clicker", href: "#/clicker", label: "Clicker", icon: "clicker" },
  { route: "cases", href: "#/", label: "Cases", icon: "cases" },
  { route: "battles", href: "#/battles", label: "Case battles", icon: "battles" },
  { route: "upgrader", href: "#/upgrader", label: "Upgrader", icon: "upgrader" },
  { route: "plinko", href: "#/plinko", label: "Plinko", icon: "plinko" },
  { route: "flashbang", href: "#/flashbang", label: "Flashbang", icon: "flashbang" },
  { route: "bhop", href: "#/bhop", label: "B-hop", icon: "bhop" },
];
const BOTTOM_NAV: NavItem[] = [
  { route: "inventory", href: "#/inventory", label: "Inventory", icon: "inventory" },
  { route: "trade", href: "#/trade", label: "Trade", icon: "trade" },
  { route: "tree", href: "#/tree", label: "Upgrades", icon: "upgrades" },
  { route: "achievements", href: "#/achievements", label: "Achievements", icon: "achievements" },
];

function navLink(n: NavItem, extra?: Node) {
  return h("a", { href: n.href, "data-route": n.route, class: "side-link" }, icon(n.icon, 18), h("span", null, n.label), extra);
}

/** Left column: logo, games, the live big-wins feed, and account pages at the bottom. */
function sidebar() {
  const invCount = h("span", { class: "badge" });
  // Unclaimed achievement rewards.
  const toClaim = h("span", { class: "badge ping", hidden: true });
  const sync = () => {
    invCount.textContent = String(getState().inventory.length);
    const a = getState();
    const n = Object.keys(a.achievements).filter((id) => !a.claimed[id]).length;
    toClaim.hidden = !n;
    toClaim.textContent = String(n);
  };
  subscribe(sync);
  sync();
  // Trade offers waiting for an answer.
  const offers = h("span", { class: "badge ping", hidden: true });
  onTrades(() => {
    const n = tradeLists().open.filter((t) => t.incoming).length;
    offers.hidden = !n;
    offers.textContent = String(n);
  });
  void loadTrades();
  return h(
    "aside",
    { class: "sidebar", id: "sidebar" },
    h("a", { class: "logo", href: "#/" }, "STRAFE", h("span", null, "CLICKER")),
    h("nav", { class: "side-nav" }, ...MAIN_NAV.map((n) => navLink(n))),
    feedPanel(),
    h(
      "nav",
      { class: "side-nav bottom" },
      ...BOTTOM_NAV.map((n) => navLink(n, { inventory: invCount, achievements: toClaim, trade: offers }[n.route])),
    ),
  );
}

/** Top bar: price timer on the left; balance, inventory worth and profile on the right. */
function topbar() {
  const balance = h("b", { class: "balance-amount" });
  const invValue = h("b");
  const sync = () => {
    balance.textContent = money(displayBalance());
    invValue.textContent = money(round2(getState().inventory.reduce((s, it) => s + priceOf(it), 0)));
  };
  subscribe(sync);
  onPrices(sync);
  sync();

  const soundBtn = h("button", { class: "btn btn-ghost btn-sm icon-btn", title: "Sound", "aria-label": "Toggle sound" }, icon(soundEnabled() ? "sound" : "mute"));
  soundBtn.addEventListener("click", () => {
    setSound(!soundEnabled());
    soundBtn.replaceChildren(icon(soundEnabled() ? "sound" : "mute"));
  });
  // Friends, with a badge for pending requests.
  const requests = h("span", { class: "dot-badge", hidden: true });
  const friendsBtn = h("a", { class: "btn btn-ghost btn-sm icon-btn", href: "#/friends", title: "Friends", "aria-label": "Friends" }, icon("friends"), requests);
  onFriends(() => {
    const n = friendLists().incoming.length;
    requests.hidden = !n;
    requests.textContent = String(n);
  });
  void loadFriends();

  const menuBtn = h(
    "button",
    { class: "btn btn-ghost btn-sm icon-btn menu-btn", "aria-label": "Menu", onclick: () => document.body.classList.toggle("nav-open") },
    icon("menu", 18),
  );

  return h(
    "header",
    { class: "topbar" },
    menuBtn,
    countdown(),
    h(
      "div",
      { class: "wallet" },
      h("div", { class: "wallet-item" }, h("span", null, "Balance"), balance),
      h("a", { class: "wallet-item", href: "#/inventory", title: "Current market value of your inventory" }, h("span", null, "Inventory"), invValue),
    ),
    h(
      "div",
      { class: "profile" },
      friendsBtn,
      soundBtn,
      h("span", { class: "user-name", title: "Logged in" }, icon("user", 16), getState().username),
      h("button", { class: "btn btn-ghost btn-sm icon-btn", title: "Log out", "aria-label": "Log out", onclick: () => logout() }, icon("logout")),
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
  else if (page === "achievements") view = achievementsPage();
  else if (page === "plinko") view = plinkoPage();
  else if (page === "flashbang") view = flashbangPage();
  else if (page === "bhop") view = bhopPage();
  else if (page === "battles") view = arg ? battlePage(Number(arg)) : battlesPage(new URLSearchParams(query).get("code"));
  else if (page === "friends") view = friendsPage();
  else if (page === "trade") view = tradePage();
  else {
    const kind = new URLSearchParams(query).get("kind") as Case["kind"];
    view = casesPage(KINDS.includes(kind) ? kind : "case");
    active = "cases";
  }

  document.querySelectorAll<HTMLAnchorElement>(".side-link").forEach((a) => a.classList.toggle("active", a.dataset.route === active));
  document.body.classList.remove("nav-open");
  main.replaceChildren(view);
  window.scrollTo(0, 0);
}

function startApp() {
  app.replaceChildren(
    h("div", { class: "shell" }, sidebar(), h("div", { class: "content" }, topbar(), main, footer())),
    h("div", { class: "nav-scrim", onclick: () => document.body.classList.remove("nav-open") }),
    h("div", { id: "toasts" }),
  );
  window.addEventListener("hashchange", route);
  route();
  onPrices(showInventoryChange);
  startLive();
  if (pendingOffline) showOffline(pendingOffline);
  pendingOffline = null;
  showUnlocked(pendingUnlocked.splice(0));
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

/** Achievement toasts (queued if they arrive before the app is on screen, e.g. at login). */
let pendingUnlocked: string[] = [];
function showUnlocked(ids: string[]) {
  if (!document.getElementById("toasts")) {
    pendingUnlocked.push(...ids);
    return;
  }
  for (const id of ids) {
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (a) toast(`Achievement unlocked: ${a.name}. Claim ${money(a.reward)} in Achievements.`, "achievement", 5000);
  }
}

async function boot() {
  setOfflineHandler(showOffline);
  setUnlockedHandler(showUnlocked);
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

import "./style.css";
import { getCase, loadCatalog, priceOf, round2 } from "./catalog";
import type { Case } from "./types";
import type { Account } from "./types";
import { displayBalance, getState, initState, logout, resetAll, setLoggedOutHandler, setOfflineHandler, setUnlockedHandler, subscribe } from "./state";
import { openModal } from "./ui/modal";
import { icon, type IconName } from "./ui/icons";
import { feedPanel } from "./ui/feed";
import { chatButton, chatPanel, setChatOpen } from "./ui/chat-panel";
import { missionsPage } from "./ui/missions-page";
import { leaderboardPage } from "./ui/leaderboard-page";
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
import { defusePage } from "./ui/defuse-page";
import { roulettePage } from "./ui/roulette-page";
import { coinflipPage, coinflipView } from "./ui/coinflip-page";
import "./flips";
import { jackpotPage } from "./ui/jackpot-page";
import { siteBanner } from "./site";
import { adminPage } from "./ui/admin-page";
import { spinPage } from "./ui/spin-page";
import { kenoPage } from "./ui/keno-page";
import { towersPage } from "./ui/towers-page";
import { racePage } from "./ui/race-page";
import { blackjackPage } from "./ui/blackjack-page";
import { pokerPage } from "./ui/poker-page";
import { bombplantPage } from "./ui/bombplant-page";
import "./race";
import "./bombplant";
import "./blackjack";
import "./jackpot";
import "./roulette";
import { battlesPage } from "./ui/battles-page";
import { battlePage } from "./ui/battle-page";
import "./battles";
import { friendsPage } from "./ui/friends-page";
import { tradePage } from "./ui/trade-page";
import { profilePage } from "./ui/profile-page";
import { avatar } from "./ui/profile-card";
import { loadTrades, onTrades, tradeLists } from "./trades";
import { friendLists, loadFriends, onFriends } from "./friends";
import "./flashbang";
import { ACHIEVEMENTS } from "../shared/achievements.js";
import { leavePage } from "./ui/page";
import { setSound, soundEnabled } from "./ui/sound";
import { clearPageListeners, onPrices, serverNow, startLive } from "./live";
import { countdown } from "./ui/countdown";
import { awaySection, priceToast } from "./ui/price-popup";
import type { InventoryChange } from "./live";

const app = document.getElementById("app")!;

type NavItem = { route: string; href: string; label: string; icon: IconName };
const MAIN_NAV: NavItem[] = [
  { route: "clicker", href: "#/clicker", label: "Clicker", icon: "clicker" },
  { route: "cases", href: "#/", label: "Cases", icon: "cases" },
  { route: "battles", href: "#/battles", label: "Case battles", icon: "battles" },
  { route: "upgrader", href: "#/upgrader", label: "Upgrader", icon: "upgrader" },
];
/** The casino games: a group in the sidebar that folds up when there isn't room. */
const GAMES_NAV: NavItem[] = [
  { route: "coinflip", href: "#/coinflip", label: "Coinflip", icon: "coins" },
  { route: "jackpot", href: "#/jackpot", label: "Jackpot", icon: "jackpot" },
  { route: "plinko", href: "#/plinko", label: "Plinko", icon: "plinko" },
  { route: "flashbang", href: "#/flashbang", label: "Flashbang", icon: "flashbang" },
  { route: "roulette", href: "#/roulette", label: "Roulette", icon: "roulette" },
  { route: "race", href: "#/race", label: "Bot race", icon: "race" },
  { route: "bombplant", href: "#/bombplant", label: "Bomb plant", icon: "target" },
  { route: "bhop", href: "#/bhop", label: "B-hop", icon: "bhop" },
  { route: "defuse", href: "#/defuse", label: "Defuse", icon: "bomb" },
  { route: "keno", href: "#/keno", label: "Keno", icon: "keno" },
  { route: "towers", href: "#/towers", label: "Towers", icon: "towers" },
  { route: "blackjack", href: "#/blackjack", label: "Blackjack", icon: "blackjack" },
  { route: "poker", href: "#/poker", label: "Video poker", icon: "poker" },
];
const BOTTOM_NAV: NavItem[] = [
  { route: "inventory", href: "#/inventory", label: "Inventory", icon: "inventory" },
  { route: "trade", href: "#/trade", label: "Trade", icon: "trade" },
  { route: "tree", href: "#/tree", label: "Upgrades", icon: "upgrades" },
];
/** Free rewards and rankings, another foldable group. */
const REWARDS_NAV: NavItem[] = [
  { route: "missions", href: "#/missions", label: "Daily missions", icon: "missions" },
  { route: "spin", href: "#/spin", label: "Daily spin", icon: "gift" },
  { route: "achievements", href: "#/achievements", label: "Achievements", icon: "achievements" },
  { route: "leaderboard", href: "#/leaderboard", label: "Leaderboards", icon: "leaderboard" },
];

function navLink(n: NavItem, extra?: Node) {
  return h("a", { href: n.href, "data-route": n.route, class: "side-link" }, icon(n.icon, 18), h("span", null, n.label), extra);
}

/**
 * A titled, foldable group of sidebar links. Clicking the title folds it (and that choice
 * is remembered); groups nobody folded by hand fold on their own when the sidebar runs
 * out of height (see fitSidebar). A folded group shows the sum of its links' badges.
 */
interface SideGroup {
  el: HTMLElement;
  /** "open" / "closed" if the player chose, else null (automatic). */
  pref: "open" | "closed" | null;
  set: (open: boolean) => void;
  syncBadge: () => void;
}
const GROUP_KEY = "strafeclicker:side:";
function sideGroup(key: string, label: string, items: NavItem[], badges: Record<string, HTMLElement> = {}, onToggle: () => void): SideGroup {
  let pref: SideGroup["pref"] = null;
  try {
    const v = localStorage.getItem(GROUP_KEY + key);
    if (v === "open" || v === "closed") pref = v;
  } catch {
    // ignore
  }
  const sum = h("span", { class: "badge ping", hidden: true });
  const body = h("nav", { class: "side-group-body", "aria-label": label }, ...items.map((n) => navLink(n, badges[n.route])));
  const head = h("button", { type: "button", class: "side-group-head", "aria-expanded": "true" }, h("span", null, label), sum, icon("chevron", 14));
  const el = h("div", { class: "side-group" }, head, body);
  const g: SideGroup = {
    el,
    pref,
    set(open) {
      el.classList.toggle("collapsed", !open);
      body.hidden = !open;
      head.setAttribute("aria-expanded", String(open));
      g.syncBadge();
    },
    syncBadge() {
      const n = Object.values(badges).reduce((s, b) => s + (b.hidden ? 0 : Number(b.textContent) || 0), 0);
      sum.hidden = !n || !body.hidden;
      sum.textContent = String(n);
    },
  };
  head.addEventListener("click", () => {
    const open = body.hidden;
    g.pref = open ? "open" : "closed";
    try {
      localStorage.setItem(GROUP_KEY + key, g.pref);
    } catch {
      // ignore
    }
    g.set(open);
    onToggle();
  });
  g.set(pref !== "closed");
  return g;
}

/** Open as many automatic groups as fit the sidebar's height, in order (games first). */
function fitSidebar(scroll: HTMLElement, groups: SideGroup[]) {
  const auto = groups.filter((g) => g.pref == null);
  auto.forEach((g) => g.set(false));
  for (const g of auto) {
    g.set(true);
    if (scroll.scrollHeight > scroll.clientHeight + 1) g.set(false);
  }
}

/** Left column: logo, the main pages, the games and rewards groups, and account pages at the bottom. */
function sidebar() {
  const invCount = h("span", { class: "badge" });
  // Unclaimed achievement rewards, and a ready daily spin.
  const toClaim = h("span", { class: "badge ping", hidden: true });
  const spinReady = h("span", { class: "badge ping", hidden: true }, "1");
  const syncSpin = () => {
    spinReady.hidden = getState().nextSpinAt > serverNow();
    rewards?.syncBadge();
  };
  let rewards: SideGroup | undefined;
  setInterval(syncSpin, 30_000);
  subscribe(syncSpin);
  syncSpin();
  const missionsReady = h("span", { class: "badge ping", hidden: true });
  const sync = () => {
    invCount.textContent = String(getState().inventory.length);
    const a = getState();
    const n = Object.keys(a.achievements).filter((id) => !a.claimed[id]).length;
    toClaim.hidden = !n;
    toClaim.textContent = String(n);
    const m = a.missions?.list.filter((x) => x.done && !x.claimed).length ?? 0;
    missionsReady.hidden = !m;
    missionsReady.textContent = String(m);
    rewards?.syncBadge();
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
  const scroll = h("div", { class: "side-scroll" });
  const fit = () => fitSidebar(scroll, groups);
  const games = sideGroup("games", "Games", GAMES_NAV, {}, fit);
  rewards = sideGroup("rewards", "Rewards", REWARDS_NAV, { achievements: toClaim, spin: spinReady, missions: missionsReady }, fit);
  const groups = [games, rewards];
  scroll.append(
    h("nav", { class: "side-nav" }, ...MAIN_NAV.map((n) => navLink(n))),
    games.el,
    rewards.el,
    h(
      "nav",
      { class: "side-nav bottom" },
      ...BOTTOM_NAV.map((n) => navLink(n, { inventory: invCount, trade: offers }[n.route])),
      ...(getState().isAdmin ? [navLink({ route: "admin", href: "#/admin", label: "Admin", icon: "admin" })] : []),
    ),
  );
  window.addEventListener("resize", fit);
  requestAnimationFrame(fit);
  return h(
    "aside",
    { class: "sidebar", id: "sidebar" },
    h("a", { class: "logo", href: "#/" }, "STRAFE", h("span", null, "CLICKER")),
    scroll,
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

  // Your name, linking to your profile; follows display name changes.
  const myName = h("a", { class: "user-name", href: `#/u/${encodeURIComponent(getState().username)}`, title: "Your profile" });
  const syncName = () => myName.replaceChildren(avatar(getState().username, getState().displayName, 22), h("span", null, getState().displayName));
  subscribe(syncName);
  syncName();

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
      chatButton(),
      friendsBtn,
      soundBtn,
      myName,
      h("button", { class: "btn btn-ghost btn-sm icon-btn", title: "Log out", "aria-label": "Log out", onclick: () => logout() }, icon("logout")),
    ),
  );
}

function footer() {
  return h(
    "footer",
    { class: "footer" },
    h("span", null, "Simulator only. Play money, no deposits, no withdrawals, nothing is real. Not affiliated with Valve."),
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
  else if (page === "defuse") view = defusePage();
  else if (page === "roulette") view = roulettePage();
  else if (page === "jackpot") view = jackpotPage();
  else if (page === "spin") view = spinPage();
  else if (page === "keno") view = kenoPage();
  else if (page === "towers") view = towersPage();
  else if (page === "race") view = racePage();
  else if (page === "blackjack") view = blackjackPage();
  else if (page === "poker") view = pokerPage();
  else if (page === "bombplant") view = bombplantPage();
  else if (page === "missions") view = missionsPage();
  else if (page === "leaderboard") view = leaderboardPage();
  else if (page === "admin" && getState().isAdmin) view = adminPage();
  else if (page === "coinflip") view = arg ? coinflipView(Number(arg)) : coinflipPage(new URLSearchParams(query).get("code"));
  else if (page === "battles") view = arg ? battlePage(Number(arg)) : battlesPage(new URLSearchParams(query).get("code"));
  else if (page === "friends") view = friendsPage();
  else if (page === "trade") view = tradePage(new URLSearchParams(query).get("with"));
  else if (page === "u" && arg) view = profilePage(decodeURIComponent(arg));
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
    h(
      "div",
      { class: "shell" },
      sidebar(),
      h("div", { class: "content" }, topbar(), siteBanner(), main, footer()),
      // Right column: live wins in the top third, the chat below.
      h(
        "aside",
        { class: "rightbar" },
        h("button", { class: "btn btn-ghost btn-sm icon-btn rightbar-close", "aria-label": "Close chat and live wins", onclick: () => setChatOpen(false) }, icon("close", 16)),
        feedPanel(),
        chatPanel(),
      ),
    ),
    h("div", { class: "nav-scrim", onclick: () => document.body.classList.remove("nav-open") }),
    h("div", { id: "toasts" }),
  );
  window.addEventListener("hashchange", route);
  route();
  // What prices did while the tab was closed goes into the welcome-back popup (with any
  // offline income); updates after that get a short toast each.
  let away: InventoryChange | null = null;
  onPrices((change) => (change.away ? (away = change) : priceToast(change)));
  startLive();
  showWelcome(pendingOffline, away);
  pendingOffline = null;
  showUnlocked(pendingUnlocked.splice(0));
}

function duration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Offline income that arrived before the app was on screen (at login). */
let pendingOffline: NonNullable<Account["offline"]> | null = null;
function showOffline(o: NonNullable<Account["offline"]>) {
  if (!document.querySelector(".topbar")) {
    pendingOffline = o;
    return;
  }
  showWelcome(o, null);
}

/** "Welcome back": offline income and how the inventory's prices moved meanwhile. */
function showWelcome(o: NonNullable<Account["offline"]> | null, prices: InventoryChange | null) {
  const priceEl = awaySection(prices);
  if (!o && !priceEl) return;
  openModal(
    "Welcome back",
    h(
      "div",
      { class: "popup-body" },
      o
        ? h(
            "div",
            { class: "popup-hero" },
            h("div", { class: "popup-label" }, `You were away for ${duration(o.seconds)}`),
            h("div", { class: "popup-value" }, `+${money(o.earned)}`),
            h("div", { class: "popup-was" }, "offline income. ", h("a", { href: "#/tree" }, "Earn more"), " in the upgrade tree."),
          )
        : null,
      priceEl,
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

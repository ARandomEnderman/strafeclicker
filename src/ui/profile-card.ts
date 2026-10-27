import { friendsAction, getProfile, getState, ServerError, type Profile } from "../state";
import { set as setFriends } from "../friends";
import { h, money, toast } from "./dom";
import { icon } from "./icons";

// Mini profiles. userLink() is the clickable name used wherever a player shows up;
// clicking it opens a small card with their profile. profileCard() is the same card,
// reused at full size on the profile page.

/** A stable colour per username for the avatar. */
function hue(user: string) {
  let x = 0;
  for (const ch of user.toLowerCase()) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}

export function avatar(user: string, name: string, size = 40) {
  const letter = [...(name || user).trim()][0]?.toUpperCase() ?? "?";
  return h("span", { class: "avatar", style: `--h:${hue(user)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px`, "aria-hidden": "true" }, letter);
}

/** A player's name that opens their mini profile. */
export function userLink(user: string, name = user, opts: { avatar?: boolean } = {}) {
  const el = h(
    "button",
    { type: "button", class: "user-link", title: name !== user ? `@${user}` : "View profile" },
    ...(opts.avatar ? [avatar(user, name, 18)] : []),
    h("span", null, name),
  );
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openMiniProfile(user, el);
  });
  return el;
}

const cache = new Map<string, { at: number; p: Promise<Profile> }>();
function loadProfile(user: string, fresh = false) {
  const hit = cache.get(user.toLowerCase());
  if (!fresh && hit && Date.now() - hit.at < 20_000) return hit.p;
  const p = getProfile(user);
  cache.set(user.toLowerCase(), { at: Date.now(), p });
  p.catch(() => cache.delete(user.toLowerCase()));
  return p;
}

const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** The profile card: avatar, names, online state, stats, and what you can do with them. */
export function profileCard(p: Profile, opts: { compact?: boolean; onChange?: () => void } = {}) {
  const me = p.relation === "self";
  const friendAction = async (action: "request" | "accept", done: string) => {
    try {
      setFriends(await friendsAction(action, p.user));
      toast(done);
      opts.onChange?.();
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };
  const status =
    p.online == null
      ? null
      : h("span", { class: `presence${p.online ? " on" : ""}` }, h("i"), p.online ? "Online" : "Offline");

  const stat = (label: string, value: string) => h("div", { class: "pc-stat" }, h("span", null, label), h("b", null, value));
  const stats = [
    ...(p.balance != null ? [stat("Balance", money(p.balance)), stat("Inventory", `${money(p.inventoryValue!)} · ${p.itemCount} items`)] : []),
    stat("Cases opened", p.stats.opened.toLocaleString("en-US")),
    stat("Battles won", String(p.stats.battlesWon)),
    stat("Achievements", `${p.stats.achievements} / ${p.stats.achievementsTotal}`),
    ...(p.stats.best ? [stat("Best item", `${p.stats.best.name} (${money(p.stats.best.value)})`)] : []),
  ];

  const actions: HTMLElement[] = [];
  if (opts.compact) actions.push(h("a", { class: "btn btn-sm", href: `#/u/${encodeURIComponent(p.user)}` }, icon("user", 14), me ? " Your profile" : p.balance != null ? " Profile & inventory" : " Profile"));
  if (p.relation === "friends") actions.push(h("a", { class: "btn btn-sm", href: `#/trade?with=${encodeURIComponent(p.user)}` }, icon("trade", 14), " Trade"));
  if (p.relation === "none") actions.push(h("button", { class: "btn btn-primary btn-sm", onclick: () => void friendAction("request", `Friend request sent to ${p.name}`) }, icon("friends", 14), " Add friend"));
  if (p.relation === "incoming") actions.push(h("button", { class: "btn btn-primary btn-sm", onclick: () => void friendAction("accept", `You and ${p.name} are now friends`) }, icon("friends", 14), " Accept friend request"));
  if (p.relation === "outgoing") actions.push(h("span", { class: "pc-note" }, "Friend request sent"));

  return h(
    "div",
    { class: `profile-card${opts.compact ? " compact" : ""}` },
    h(
      "div",
      { class: "pc-head" },
      avatar(p.user, p.name, opts.compact ? 44 : 64),
      h(
        "div",
        { class: "pc-names" },
        h("b", { class: "pc-name" }, p.name, me ? h("span", { class: "pc-you" }, "you") : ""),
        h("span", { class: "pc-user" }, `@${p.user}`),
        h("span", { class: "pc-meta" }, ...(status ? [status, " · "] : []), `Joined ${fmtDate(p.joinedAt)}`),
      ),
    ),
    h("div", { class: "pc-stats" }, ...stats),
    ...(p.balance == null && !me ? [h("p", { class: "pc-note" }, "Become friends to see their balance and inventory.")] : []),
    ...(actions.length ? [h("div", { class: "pc-actions" }, ...actions)] : []),
  );
}

// ---------- the popover ----------

let open: { el: HTMLElement; close: () => void } | null = null;

export async function openMiniProfile(user: string, anchor: HTMLElement) {
  open?.close();
  const pop = h("div", { class: "mini-profile", role: "dialog", "aria-label": `Profile of ${user}` }, h("div", { class: "pc-loading" }, "Loading..."));
  document.body.append(pop);

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const hgt = pop.offsetHeight;
    let x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    let y = r.bottom + 6;
    if (y + hgt > window.innerHeight - 8) y = Math.max(8, r.top - hgt - 6);
    pop.style.left = `${x}px`;
    pop.style.top = `${y}px`;
  };
  const onDown = (e: Event) => !pop.contains(e.target as Node) && e.target !== anchor && close();
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  const close = () => {
    pop.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", close);
    window.removeEventListener("resize", place);
    if (open?.el === pop) open = null;
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey);
  window.addEventListener("hashchange", close);
  window.addEventListener("resize", place);
  open = { el: pop, close };
  place();

  const render = async (fresh = false) => {
    try {
      const p = await loadProfile(user, fresh);
      if (open?.el !== pop) return;
      pop.replaceChildren(profileCard(p, { compact: true, onChange: () => void render(true) }));
      place();
    } catch (e) {
      if (e instanceof ServerError) pop.replaceChildren(h("div", { class: "pc-loading" }, e.message));
      else throw e;
    }
  };
  await render();
}

/** For your own name: a fresh profile next time anyone opens it (e.g. after renaming). */
export const forgetProfile = (user: string) => cache.delete(user.toLowerCase());

export const isMe = (user: string) => user.toLowerCase() === getState().username.toLowerCase();

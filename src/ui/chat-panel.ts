import { CHAT_MAX_LEN, RAIN_LEVELS } from "../../shared/game.js";
import { chatMessages, onChat, type ChatMessage } from "../chat";
import { friendLists } from "../friends";
import { adminAction, getState, InsufficientFunds, playerNames, sendChat, ServerError } from "../state";
import { onTags, tagOf } from "../tags";
import { onLooks } from "../looks";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { avatar, openMiniProfile, userLink } from "./profile-card";
import { rainClasses, rainFx } from "./rain-fx";
import { playPing } from "./sound";

// The global chat: a column on the right on wide screens, a drawer on narrow ones.
// /rain and /pay are typed here (the Rain button types /rain for you).

const OPEN_KEY = "strafeclicker:chat";
const COMMANDS = [
  { cmd: "/rain ", usage: "/rain <amount>", text: "Split your money among everyone online" },
  { cmd: "/pay ", usage: "/pay <user> <amount>", text: "Send money to one player" },
];

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const MENTION = /(@[A-Za-z0-9_]{3,20})\b/;
/** Whether a chat message @mentions you (not counting your own messages). */
const mentionsMe = (m: ChatMessage) => {
  const me = getState().username.toLowerCase();
  return m.kind === "msg" && m.user?.toLowerCase() !== me && m.text.split(/(@[A-Za-z0-9_]{3,20})\b/).some((p) => p.toLowerCase() === `@${me}`);
};
/** Message text with each @name drawn as a link to that player (yours stands out). */
function withMentions(text: string, names: Record<string, string> = {}) {
  const me = getState().username.toLowerCase();
  return text.split(new RegExp(MENTION.source)).map((part, i) => {
    if (i % 2 === 0) return part;
    const name = part.slice(1);
    // Shown as @DisplayName when it's a real player (the server says who).
    const shown = names[name.toLowerCase()];
    const el = h("button", { type: "button", class: `chat-mention${name.toLowerCase() === me ? " me" : ""}`, title: shown ? `@${name}` : "View profile" }, shown ? `@${shown}` : part);
    el.addEventListener("click", () => void openMiniProfile(name, el));
    return el;
  });
}

let input: HTMLInputElement | null = null;
const openListeners = new Set<(open: boolean) => void>();
let unread = 0;
const unreadListeners = new Set<(n: number) => void>();

export const isChatOpen = () => document.body.classList.contains("chat-open");
export function setChatOpen(open: boolean) {
  document.body.classList.toggle("chat-open", open);
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // ignore
  }
  if (open) {
    unread = 0;
    unreadListeners.forEach((fn) => fn(0));
  }
  openListeners.forEach((fn) => fn(open));
}
export function onUnread(fn: (n: number) => void) {
  unreadListeners.add(fn);
}

/** Open the chat with something already typed, e.g. "/pay flashy ". */
export function openChat(prefill?: string) {
  setChatOpen(true);
  if (input && prefill != null) {
    input.value = prefill;
    input.dispatchEvent(new Event("input"));
  }
  input?.focus();
}

function messageEl(m: ChatMessage) {
  const del = getState().isAdmin
    ? h("button", { class: "chat-del", title: "Delete message", onclick: () => void adminAction("chatDelete", { id: m.id }).catch((e) => toast(e.message, "error")) }, icon("trash", 13))
    : "";
  if (m.kind === "system") return h("div", { class: "chat-msg system" }, icon("announce", 14), h("span", null, m.text), del);
  if (m.kind === "rain") {
    const level = m.level ?? 0;
    const you = m.mine ? "You rained this" : m.yours != null ? `You got ${money(m.yours)}` : "You weren't online for this one";
    return h(
      "div",
      { class: `chat-msg rain lv${level} ${rainClasses(level)}` },
      h("div", { class: "chat-rain-icon" }, icon("rain", 20)),
      h(
        "div",
        { class: "chat-rain-body" },
        h("div", null, userLink(m.user!, m.name ?? m.user!), m.house ? " rained (on the house) " : " rained ", h("b", null, money(m.amount ?? 0)), ` on ${m.count} player${m.count === 1 ? "" : "s"}`),
        h("div", { class: "chat-rain-foot" }, h("span", { class: "chat-rain-tag" }, RAIN_LEVELS[level]), h("span", { class: m.yours ? "chat-rain-you got" : "chat-rain-you" }, you)),
      ),
      del,
    );
  }
  if (m.kind === "pay") {
    return h(
      "div",
      { class: "chat-msg pay" },
      icon("pay", 16),
      m.fromMe ? h("span", null, "You paid ", userLink(m.toUser!, m.toName), " ", h("b", null, money(m.amount ?? 0))) : h("span", null, userLink(m.user!, m.name ?? m.user!), " paid you ", h("b", null, money(m.amount ?? 0))),
      h("span", { class: "chat-private" }, "only you two see this"),
    );
  }
  const me = m.user === getState().username;
  return h(
    "div",
    { class: `chat-msg${me ? " me" : ""}${m.admin ? " admin" : ""}${mentionsMe(m) ? " mentioned" : ""}` },
    avatar(m.user!, m.name ?? m.user!, 26),
    h(
      "div",
      { class: "chat-body" },
      h("div", { class: "chat-meta" }, userLink(m.user!, m.name ?? m.user!), m.admin ? h("span", { class: "chat-admin" }, "admin") : "", h("time", null, time(m.at))),
      h("div", { class: "chat-text" }, ...withMentions(m.text, m.mentions)),
    ),
    del,
  );
}

export function chatPanel() {
  const list = h("div", { class: "chat-list" });
  const hints = h("div", { class: "chat-hints", hidden: true });
  input = h("input", { class: "chat-input", placeholder: "Say something, or /rain, /pay", maxlength: String(CHAT_MAX_LEN), autocomplete: "off" }) as HTMLInputElement;
  const field = input;
  let sending = false;

  // Global or your clan's channel (the tabs only show while you're in a clan).
  let channel: "global" | "clan" = "global";
  const inClan = () => !!tagOf(getState().username);
  const tabBtn = (c: typeof channel, label: string) =>
    h(
      "button",
      {
        type: "button",
        class: `chat-tab${channel === c ? " active" : ""}`,
        onclick: () => {
          channel = c;
          drawTabs();
          redraw();
        },
      },
      label,
    );
  const tabs = h("div", { class: "chat-tabs" });
  const drawTabs = () => {
    if (!inClan()) channel = "global";
    tabs.hidden = !inClan();
    tabs.replaceChildren(tabBtn("global", "Global"), tabBtn("clan", `Clan [${tagOf(getState().username) ?? ""}]`));
    field.placeholder = channel === "clan" ? "Message your clan, or /rain on them" : "Say something, or /rain, /pay";
  };
  onTags(() => {
    drawTabs();
    redraw();
  });
  // Someone changed their picture.
  onLooks(() => redraw());

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const redraw = () => {
    // Private /pay notes show in both channels.
    const msgs = chatMessages().filter((m) => m.kind === "pay" || (m.channel ?? "global") === channel);
    list.replaceChildren(...(msgs.length ? msgs.map(messageEl) : [h("div", { class: "chat-empty" }, "No messages yet. Say hi.")]));
    list.scrollTop = list.scrollHeight;
  };
  onChat((m) => {
    if (!m) return redraw();
    // Everyone online sees a rain, chat open or not.
    if (m.kind === "rain") rainFx(m);
    if (m.kind === "pay" && !m.fromMe) toast(`${m.name ?? m.user} paid you ${money(m.amount ?? 0)}`);
    // Mentioned: a ping, and a toast if the chat is closed or showing the other channel.
    if (mentionsMe(m)) {
      playPing();
      if (!isChatOpen() || (m.channel ?? "global") !== channel) toast(`${m.name ?? m.user} mentioned you: ${m.text.slice(0, 80)}`, "info", 5000);
    }
    if (m.kind !== "pay" && (m.channel ?? "global") !== channel) return;
    const stick = nearBottom();
    list.querySelector(".chat-empty")?.remove();
    list.append(messageEl(m));
    while (list.children.length > 150) list.firstElementChild!.remove();
    if (stick || m.user === getState().username) list.scrollTop = list.scrollHeight;
    if (!isChatOpen() && m.kind !== "pay") {
      unread++;
      unreadListeners.forEach((fn) => fn(unread));
    }
  });

  const drawHints = () => {
    const v = field.value;
    const show = v.startsWith("/") && !v.includes(" ");
    const match = COMMANDS.filter((c) => c.cmd.startsWith(v.toLowerCase()) || v === "/");
    hints.hidden = !show || !match.length;
    hints.replaceChildren(
      ...match.map((c) =>
        h(
          "button",
          {
            type: "button",
            class: "chat-hint",
            onmousedown: (e: Event) => {
              e.preventDefault();
              field.value = c.cmd;
              drawHints();
              field.focus();
            },
          },
          h("b", null, c.usage),
          h("span", null, c.text),
        ),
      ),
    );
  };
  field.addEventListener("input", drawHints);
  field.addEventListener("blur", () => (hints.hidden = true));

  // Names: @ and the start of a username or display name lists matching players as you
  // type (display name first); Tab, Enter or a click fills in @username (shown as
  // @DisplayName once sent). Tab with no pick open completes the word before the cursor,
  // and Tab again (Shift+Tab back) goes through the other matches. People in the chat and
  // your friends come first, then anyone else the server finds.
  type Person = { username: string; name: string };
  const known = (prefix: string): Person[] => {
    const p = prefix.toLowerCase();
    const me = getState().username.toLowerCase();
    const seen = new Set<string>();
    const out: Person[] = [];
    const add = (username?: string | null, name?: string | null) => {
      const k = username?.toLowerCase();
      if (!username || !k || k === me || seen.has(k)) return;
      if (!k.startsWith(p) && !(name ?? "").toLowerCase().startsWith(p)) return;
      seen.add(k);
      out.push({ username, name: name || username });
    };
    [...chatMessages()].reverse().forEach((m) => (add(m.user, m.name), add(m.toUser, m.toName)));
    friendLists().friends.forEach((f) => add(f.user, f.name));
    return out;
  };
  /** The people we know, then the server's matches (if it answers), at most 8. */
  const lookup = async (prefix: string) => {
    const local = known(prefix);
    if (local.length >= 8) return local.slice(0, 8);
    try {
      const me = getState().username.toLowerCase();
      const more = (await playerNames(prefix)).filter((x) => x.username.toLowerCase() !== me && !local.some((l) => l.username.toLowerCase() === x.username.toLowerCase()));
      return [...local, ...more].slice(0, 8);
    } catch {
      return local; // offline: the names we know will do
    }
  };

  // The list above the box: shared by Tab and @.
  let pick: { start: number; people: Person[]; i: number; via: "tab" | "at" } | null = null;
  const drawList = () => {
    const l = pick;
    hints.hidden = !l || (l.via === "tab" && l.people.length < 2);
    if (!l) return;
    hints.replaceChildren(
      ...l.people.map((p, i) =>
        h(
          "button",
          {
            type: "button",
            class: `chat-hint name${i === l.i ? " on" : ""}`,
            onmousedown: (e: Event) => {
              e.preventDefault();
              l.i = i;
              fill(true);
            },
          },
          h("b", null, p.name),
          p.name !== p.username ? h("span", null, `@${p.username}`) : "",
        ),
      ),
    );
  };
  /** Put the chosen @username in place of the word being typed; `done` closes the pick. */
  const fill = (done: boolean) => {
    const l = pick!;
    const caret = field.selectionStart ?? field.value.length;
    const name = l.people[l.i].username;
    const after = field.value.slice(caret).replace(/^[A-Za-z0-9_]*/, "").replace(/^ /, "");
    field.value = `${field.value.slice(0, l.start)}${name} ${after}`;
    const at = l.start + name.length + 1;
    field.setSelectionRange(at, at);
    if (done) pick = null;
    drawList();
    field.focus();
  };

  let looking = false;
  let lookupTimer = 0;
  field.addEventListener("input", () => {
    clearTimeout(lookupTimer);
    const caret = field.selectionStart ?? field.value.length;
    const m = field.value.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) {
      if (pick?.via === "at") ((pick = null), drawList());
      return;
    }
    const prefix = m[1];
    const start = caret - prefix.length;
    const show = (people: Person[]) => {
      pick = people.length ? { start, people, i: 0, via: "at" } : null;
      drawList();
    };
    show(known(prefix).slice(0, 8));
    if (!prefix) return;
    // Ask the server too, after a short pause in typing.
    lookupTimer = setTimeout(async () => {
      const people = await lookup(prefix);
      const now = field.value.slice(0, field.selectionStart ?? field.value.length).match(/@([^\s@]*)$/);
      if (now?.[1] === prefix) show(people);
    }, 150);
  });
  field.addEventListener("blur", () => {
    pick = null;
    drawList();
  });
  // Registered before the Enter-to-send handler, so picking a name doesn't send.
  field.addEventListener(
    "keydown",
    async (e) => {
      if (pick?.via === "at") {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          pick.i = (pick.i + (e.key === "ArrowDown" ? 1 : pick.people.length - 1)) % pick.people.length;
          drawList();
        } else if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          e.stopImmediatePropagation();
          fill(true);
        } else if (e.key === "Escape") {
          pick = null;
          drawList();
        }
        return;
      }
      if (e.key !== "Tab") {
        if (e.key !== "Shift" && pick?.via === "tab") ((pick = null), drawList());
        return;
      }
      e.stopImmediatePropagation();
      if (looking) return e.preventDefault();
      // Tab again: the next (Shift: previous) match.
      if (pick?.via === "tab") {
        e.preventDefault();
        pick.i = (pick.i + (e.shiftKey ? pick.people.length - 1 : 1)) % pick.people.length;
        return fill(false);
      }
      const caret = field.selectionStart ?? field.value.length;
      const before = field.value.slice(0, caret);
      // "/pa" + Tab: finish the command instead.
      const cmd = /^\/\w*$/.test(before) && COMMANDS.find((c) => c.cmd.startsWith(before.toLowerCase()));
      if (cmd) {
        e.preventDefault();
        field.value = cmd.cmd + field.value.slice(caret);
        field.setSelectionRange(cmd.cmd.length, cmd.cmd.length);
        return drawHints();
      }
      const word = before.match(/@?([A-Za-z0-9_]+)$/);
      if (!word) return;
      e.preventDefault();
      const prefix = word[1];
      const start = caret - prefix.length;
      looking = true;
      const people = await lookup(prefix);
      looking = false;
      // Typing went on while we asked the server.
      if (field.value.slice(start, caret) !== prefix || !people.length) return;
      pick = { start, people, i: 0, via: "tab" };
      fill(false);
    },
    { capture: true },
  );

  const send = async () => {
    const text = field.value.trim();
    if (!text || sending) return;
    if (text === "/help" || text === "/") {
      field.value = "/";
      drawHints();
      return;
    }
    sending = true;
    try {
      await sendChat(text, channel);
      field.value = "";
      drawHints();
    } catch (e) {
      if (e instanceof InsufficientFunds) toast(e.message || "Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      sending = false;
    }
  };
  field.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  });

  const rainBtn = h(
    "button",
    {
      type: "button",
      class: "btn btn-sm chat-rain-btn",
      title: "Make it rain: split your own money among everyone online",
      onclick: () => {
        field.value = "/rain ";
        drawHints();
        field.focus();
      },
    },
    icon("rain", 15),
    h("span", null, "Rain"),
  );

  const panel = h(
    "section",
    { class: "chat", "aria-label": "Chat" },
    h("div", { class: "chat-head" }, icon("chat", 14), h("b", null, "Chat"), tabs),
    list,
    h("div", { class: "chat-compose" }, hints, h("div", { class: "chat-row" }, rainBtn, field, h("button", { class: "btn btn-primary btn-sm icon-btn", "aria-label": "Send", onclick: () => void send() }, icon("send", 15)))),
  );
  openListeners.add((open) => open && requestAnimationFrame(() => (list.scrollTop = list.scrollHeight)));
  drawTabs();
  redraw();

  // Open by default on screens wide enough to keep it beside the page.
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(OPEN_KEY);
  } catch {
    // ignore
  }
  setChatOpen(saved ? saved === "1" : matchMedia("(min-width: 1280px)").matches);
  return panel;
}

/** The topbar button that opens and closes the right column (live wins and chat), with an unread count. */
export function chatButton() {
  const badge = h("span", { class: "dot-badge", hidden: true });
  onUnread((n) => {
    badge.hidden = !n;
    badge.textContent = n > 99 ? "99+" : String(n);
  });
  return h("button", { class: "btn btn-ghost btn-sm icon-btn", title: "Chat", "aria-label": "Chat", onclick: () => setChatOpen(!isChatOpen()) }, icon("chat"), badge);
}

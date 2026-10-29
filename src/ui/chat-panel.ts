import { CHAT_MAX_LEN, RAIN_LEVELS } from "../../shared/game.js";
import { chatMessages, onChat, type ChatMessage } from "../chat";
import { friendLists } from "../friends";
import { adminAction, getState, InsufficientFunds, playerNames, sendChat, ServerError } from "../state";
import { onTags, tagOf } from "../tags";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { avatar, openMiniProfile, userLink } from "./profile-card";
import { rainFx } from "./rain-fx";
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
function withMentions(text: string) {
  const me = getState().username.toLowerCase();
  return text.split(new RegExp(MENTION.source)).map((part, i) => {
    if (i % 2 === 0) return part;
    const name = part.slice(1);
    const el = h("button", { type: "button", class: `chat-mention${name.toLowerCase() === me ? " me" : ""}`, title: "View profile" }, part);
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
      { class: `chat-msg rain lv${level}` },
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
      h("div", { class: "chat-text" }, ...withMentions(m.text)),
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

  // Tab completes a username: the word before the cursor (an @ in front stays). Press Tab
  // again (Shift+Tab back) to go through the other matches. People in the chat and your
  // friends come first, then anyone else the server knows.
  let tab: { start: number; end: number; names: string[]; i: number } | null = null;
  let looking = false;
  const knownNames = (prefix: string) => {
    const p = prefix.toLowerCase();
    const me = getState().username.toLowerCase();
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (n?: string | null) => {
      const k = n?.toLowerCase();
      if (!n || !k!.startsWith(p) || k === me || seen.has(k!)) return;
      seen.add(k!);
      out.push(n);
    };
    [...chatMessages()].reverse().forEach((m) => (add(m.user), add(m.toUser)));
    friendLists().friends.forEach((f) => add(f.user));
    return out;
  };
  const applyTab = () => {
    const t = tab!;
    const name = t.names[t.i];
    const v = field.value;
    const after = v.slice(t.end).replace(/^ /, "");
    field.value = `${v.slice(0, t.start)}${name} ${after}`;
    t.end = t.start + name.length + 1;
    field.setSelectionRange(t.end, t.end);
    hints.hidden = t.names.length < 2;
    hints.replaceChildren(
      ...t.names.map((n, i) =>
        h(
          "button",
          {
            type: "button",
            class: `chat-hint name${i === t.i ? " on" : ""}`,
            onmousedown: (e: Event) => {
              e.preventDefault();
              t.i = i;
              applyTab();
              field.focus();
            },
          },
          h("b", null, n),
        ),
      ),
    );
  };
  field.addEventListener("keydown", async (e) => {
    if (e.key !== "Tab") {
      if (e.key !== "Shift") tab = null;
      return;
    }
    if (looking) return e.preventDefault();
    if (tab) {
      e.preventDefault();
      tab.i = (tab.i + (e.shiftKey ? tab.names.length - 1 : 1)) % tab.names.length;
      return applyTab();
    }
    const caret = field.selectionStart ?? field.value.length;
    // "/pa" + Tab: finish the command instead.
    const cmd = field.value.slice(0, caret).match(/^\/\w*$/) && COMMANDS.find((c) => c.cmd.startsWith(field.value.slice(0, caret).toLowerCase()));
    if (cmd) {
      e.preventDefault();
      field.value = cmd.cmd + field.value.slice(caret);
      field.setSelectionRange(cmd.cmd.length, cmd.cmd.length);
      return drawHints();
    }
    const word = field.value.slice(0, caret).match(/@?([A-Za-z0-9_]+)$/);
    if (!word) return;
    e.preventDefault();
    const prefix = word[1];
    const start = caret - prefix.length;
    let names = knownNames(prefix);
    if (names.length < 8) {
      looking = true;
      try {
        const more = await playerNames(prefix);
        const me = getState().username.toLowerCase();
        names = [...names, ...more.filter((n) => n.toLowerCase() !== me && !names.some((x) => x.toLowerCase() === n.toLowerCase()))];
      } catch {
        // offline: the names we know will do
      } finally {
        looking = false;
      }
    }
    // Typing went on while we asked the server.
    if (field.value.slice(start, caret) !== prefix || !names.length) return;
    tab = { start, end: caret, names, i: 0 };
    applyTab();
  });

  // Typing @ and the start of a name lists matching players as you type (no Tab needed):
  // Up/Down to choose, Tab or Enter to fill it in, Esc to close.
  let suggest: { start: number; names: string[]; i: number } | null = null;
  let suggestTimer = 0;
  const drawSuggest = () => {
    const sg = suggest;
    hints.hidden = !sg;
    if (!sg) return;
    hints.replaceChildren(
      ...sg.names.map((n, i) =>
        h(
          "button",
          {
            type: "button",
            class: `chat-hint name${i === sg.i ? " on" : ""}`,
            onmousedown: (e: Event) => {
              e.preventDefault();
              sg.i = i;
              pickSuggest();
            },
          },
          h("b", null, `@${n}`),
        ),
      ),
    );
  };
  const pickSuggest = () => {
    const sg = suggest!;
    const caret = field.selectionStart ?? field.value.length;
    const name = sg.names[sg.i];
    const after = field.value.slice(caret).replace(/^[A-Za-z0-9_]*/, "").replace(/^ /, "");
    field.value = `${field.value.slice(0, sg.start)}${name} ${after}`;
    const at = sg.start + name.length + 1;
    field.setSelectionRange(at, at);
    suggest = null;
    tab = null;
    drawSuggest();
    field.focus();
  };
  field.addEventListener("input", () => {
    clearTimeout(suggestTimer);
    const caret = field.selectionStart ?? field.value.length;
    const m = field.value.slice(0, caret).match(/(?:^|\s)@([A-Za-z0-9_]*)$/);
    if (!m) {
      if (suggest) ((suggest = null), drawSuggest());
      return;
    }
    const prefix = m[1];
    const start = caret - prefix.length;
    const show = (names: string[]) => {
      suggest = names.length ? { start, names: names.slice(0, 8), i: 0 } : null;
      drawSuggest();
    };
    show(knownNames(prefix));
    // Ask the server for anyone else (after a short pause in typing).
    if (prefix && (suggest?.names.length ?? 0) < 8) {
      suggestTimer = setTimeout(async () => {
        try {
          const more = await playerNames(prefix);
          const now = field.value.slice(0, field.selectionStart ?? field.value.length).match(/@([A-Za-z0-9_]*)$/);
          if (now?.[1] !== prefix) return;
          const me = getState().username.toLowerCase();
          const local = knownNames(prefix);
          show([...local, ...more.filter((n) => n.toLowerCase() !== me && !local.some((x) => x.toLowerCase() === n.toLowerCase()))]);
        } catch {
          // offline: the names we know will do
        }
      }, 150);
    }
  });
  field.addEventListener("blur", () => {
    suggest = null;
    drawSuggest();
  });
  // Registered before the Enter-to-send handler, so picking a name doesn't send.
  field.addEventListener(
    "keydown",
    (e) => {
      if (!suggest) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        suggest.i = (suggest.i + (e.key === "ArrowDown" ? 1 : suggest.names.length - 1)) % suggest.names.length;
        drawSuggest();
      } else if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        e.stopImmediatePropagation();
        pickSuggest();
      } else if (e.key === "Escape") {
        suggest = null;
        drawSuggest();
      }
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

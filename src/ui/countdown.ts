import { getStatus, isConnected, onStatus, serverNow } from "../live";
import { h } from "./dom";

/** "Prices in 0:42" with a thin progress bar. Driven entirely by the server's schedule. */
export function countdown() {
  const label = h("span", { class: "cd-label" }, "Prices");
  const time = h("b", { class: "cd-time" }, "–:––");
  const bar = h("i");
  const el = h("div", { class: "countdown", title: "Market prices refresh on the server once a minute" }, label, time, h("div", { class: "cd-bar" }, bar));

  const draw = () => {
    const s = getStatus();
    el.classList.toggle("offline", !isConnected() || !!s?.error);
    if (!isConnected()) {
      time.textContent = "offline";
      el.title = "Lost connection to the price server, reconnecting…";
      return;
    }
    if (!s?.nextUpdateAt) return;
    const left = Math.max(0, s.nextUpdateAt - serverNow());
    const secs = Math.ceil(left / 1000);
    time.textContent = left === 0 ? "updating…" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    bar.style.width = `${(1 - left / s.intervalMs) * 100}%`;
    const last = s.lastUpdateAt ? `Last update ${new Date(s.lastUpdateAt).toLocaleTimeString()}` : "No update yet";
    el.title = s.error ? `${last}. Last attempt failed: ${s.error}` : `${last}. Prices refresh on the server once a minute.`;
  };

  onStatus(draw);
  setInterval(draw, 250);
  draw();
  return el;
}

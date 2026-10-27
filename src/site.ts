import { onServerEvent } from "./live";
import { h } from "./ui/dom";
import { icon } from "./ui/icons";

// Site-wide notices from the admin: an announcement, and maintenance mode.

export interface SiteState {
  maintenance: boolean;
  announcement: string | null;
}

let state: SiteState = { maintenance: false, announcement: null };
const banner = h("div", { class: "site-banner", hidden: true });

export const siteState = () => state;

/** The banner shown at the top of every page. */
export function siteBanner() {
  return banner;
}

function draw() {
  const parts: HTMLElement[] = [];
  if (state.maintenance) parts.push(h("div", { class: "site-note maint" }, icon("admin", 16), h("span", null, "Paused for maintenance: no new bets or openings for now. Cash-outs, selling and trading still work.")));
  if (state.announcement) parts.push(h("div", { class: "site-note" }, icon("announce", 16), h("span", null, state.announcement)));
  banner.replaceChildren(...parts);
  banner.hidden = !parts.length;
}

onServerEvent<SiteState>("site", (s) => {
  state = s;
  draw();
});

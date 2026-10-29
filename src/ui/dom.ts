type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

/** Tiny hyperscript: h("div", { class: "x", onclick: fn }, child, …) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k in el && k !== "style") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

/**
 * A money / multiplier field. Not type="number": browsers show those with the system's
 * decimal separator (10,00 in much of Europe), while the site writes 10.00 everywhere.
 * Typing a comma is still fine; it's read as a decimal point.
 */
export function decimalInput(attrs: Attrs) {
  const el = h("input", { ...attrs, type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: false }) as HTMLInputElement;
  el.addEventListener("input", () => {
    const clean = el.value.replace(/,/g, ".").replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    if (clean !== el.value) el.value = clean;
  });
  return el;
}
/** Read a decimalInput (or anything typed with "," or "."); NaN when empty or invalid. */
export const parseDecimal = (s: string) => (s.trim() ? Number(s.trim().replace(/,/g, ".")) : NaN);

const round2 = (n: number) => Math.round(n * 100) / 100;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/**
 * Attributes for a field that looks up other players: browsers and password managers
 * otherwise take it for a login box and fill in your own username.
 */
export const NO_AUTOFILL = { type: "search", autocomplete: "off", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other" };

export const money = (n: number) => usd.format(n);

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
/** A multiplier: "1.65x", and from 1,000 up "12.5Kx", "3.24Mx". */
export const mult = (x: number) => `${x >= 1000 ? compact.format(x) : x.toFixed(2)}x`;

export function toast(text: string, kind: "info" | "error" | "achievement" | "up" | "down" = "info", ms = 3000) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const el = h("div", { class: `toast toast-${kind}` }, text);
  host.append(el);
  setTimeout(() => el.classList.add("out"), ms - 400);
  setTimeout(() => el.remove(), ms);
}

/** Signed change with an arrow, so direction never relies on color alone. */
export function deltaLine(before: number, after: number, compact = false) {
  const d = round2(after - before);
  const pct = before > 0 ? (d / before) * 100 : 0;
  const dir = d > 0 ? "up" : d < 0 ? "down" : "flat";
  const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "•";
  return h(
    "span",
    { class: `delta delta-${dir}${compact ? " compact" : ""}` },
    `${arrow} ${d > 0 ? "+" : ""}${money(d)}`,
    compact ? null : ` (${pct > 0 ? "+" : ""}${pct.toFixed(2)}%)`,
  );
}

// Keyboard shortcuts for the single-player games: Space presses the page's main button
// (bet, drop, deal, cash out), R presses it only when it starts a new round with the
// same bet. Pages mark their buttons with hotkey(); only visible, enabled ones count.

const label: Record<string, string> = { space: "Space", r: "R" };

/** Mark a button as the target of some keys ("space", "r" or "space r"). */
export function hotkey<T extends HTMLElement>(btn: T, keys: string): T {
  btn.dataset.hotkey = keys;
  btn.title = `Shortcut: ${keys
    .split(" ")
    .map((k) => label[k] ?? k)
    .join(" or ")}`;
  return btn;
}

document.addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  const key = e.code === "Space" ? "space" : e.code === "KeyR" && !e.shiftKey ? "r" : null;
  if (!key) return;
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, select, [contenteditable]") || document.querySelector(".modal-backdrop")) return;
  const btn = [...document.querySelectorAll<HTMLButtonElement>("[data-hotkey]")].find(
    (b) => b.dataset.hotkey!.split(" ").includes(key) && !b.disabled && !b.hidden && b.offsetParent !== null,
  );
  if (!btn) return;
  e.preventDefault();
  // A focused button would also get Space; take focus off it so the press counts once.
  (document.activeElement as HTMLElement | null)?.blur?.();
  btn.click();
});

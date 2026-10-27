import { h } from "./dom";

/** Centered dialog over a dimmed page. Esc, the × button or a backdrop click closes it. */
export function openModal(title: string, body: Node, opts: { wide?: boolean; onClose?: () => void } = {}) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();

  const dialog = h(
    "div",
    { class: `modal${opts.wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "modal-head" }, h("h2", null, title), h("button", { class: "btn btn-ghost btn-sm", "aria-label": "Close", onclick: close }, "✕")),
    body,
  );
  const backdrop = h("div", { class: "modal-backdrop", onclick: (e: Event) => e.target === backdrop && close() }, dialog);
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);
  return close;
}

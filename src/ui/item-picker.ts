import { getItem, imageOf, priceOf, round2 } from "../catalog";
import { getState, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { displayName } from "./item-card";

/** A grid of your inventory to pick items from (most valuable first). */
export function itemPicker(opts: { max: number; onChange?: () => void; initial?: string[] }) {
  const picked = new Set<string>(opts.initial ?? []);
  const grid = h("div", { class: "trade-grid picker-grid" });
  const draw = () => {
    const inv = [...getState().inventory].sort((a, b) => priceOf(b) - priceOf(a));
    for (const uid of [...picked]) if (!inv.some((it) => it.uid === uid)) picked.delete(uid);
    grid.replaceChildren(
      ...(inv.length
        ? inv.map((it) => {
            const item = getItem(it.itemId);
            const n = displayName(item, it);
            return h(
              "button",
              {
                type: "button",
                class: `trade-item${picked.has(it.uid) ? " selected" : ""}`,
                style: `--rarity:${item.color}`,
                onclick: () => {
                  if (picked.has(it.uid)) picked.delete(it.uid);
                  else if (picked.size >= opts.max) return toast(`Up to ${opts.max} items`, "error");
                  else picked.add(it.uid);
                  draw();
                  opts.onChange?.();
                },
              },
              h("img", { src: imageOf(it), alt: "", loading: "lazy" }),
              h("span", { class: "trade-item-name" }, n.weapon),
              h("span", { class: "trade-item-finish" }, `${n.finish}${it.wear ? ` · ${it.wear}` : ""}`),
              h("b", null, money(priceOf(it))),
            );
          })
        : [h("p", { class: "fb-empty" }, "Your inventory is empty. Open some cases first.")]),
    );
  };
  const unsubscribe = subscribe(draw);
  draw();
  return {
    el: grid,
    uids: () => [...picked],
    value: () => round2(getState().inventory.filter((it) => picked.has(it.uid)).reduce((s, it) => s + priceOf(it), 0)),
    count: () => picked.size,
    clear: () => {
      picked.clear();
      draw();
      opts.onChange?.();
    },
    destroy: unsubscribe,
  };
}

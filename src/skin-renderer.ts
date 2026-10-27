import type { Item } from "./types";
import { imageOf } from "./catalog";

/**
 * Everything the UI knows about a skin when it needs a picture of it.
 * `float`/`seed` are only set for a concrete drop (inventory, unbox result);
 * case previews and the spinner reel pass just the item.
 */
export interface SkinRenderRequest {
  item: Item;
  phase?: string | null;
  float?: number | null;
  seed?: number;
  stattrak?: boolean;
  size: "sm" | "md" | "lg";
}

/**
 * Plug point for a skin texture generator. Return any element (img, canvas, svg…);
 * it gets placed inside a fixed-size box and should fill it (width/height 100%).
 */
export type SkinRenderer = (req: SkinRenderRequest) => HTMLElement;

/** Default: the item's official inventory icon. */
const imageRenderer: SkinRenderer = ({ item, phase }) => {
  const img = document.createElement("img");
  img.src = imageOf({ itemId: item.id, phase: phase ?? null });
  img.alt = item.name;
  img.loading = "lazy";
  img.decoding = "async";
  img.draggable = false;
  img.onerror = () => img.replaceWith(placeholder(item));
  return img;
};

function placeholder(item: Item): HTMLElement {
  const el = document.createElement("div");
  el.className = "skin-placeholder";
  el.textContent = item.weapon;
  return el;
}

let renderer: SkinRenderer = imageRenderer;

export function setSkinRenderer(r: SkinRenderer | null) {
  renderer = r ?? imageRenderer;
}

export function renderSkin(req: SkinRenderRequest): HTMLElement {
  try {
    return renderer(req);
  } catch (err) {
    console.error("Skin renderer failed, using default", err);
    return imageRenderer(req);
  }
}

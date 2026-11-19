// Breadcrumb menus. The build emits one flat layer of panels; this controller
// alone opens, places and closes them, so no hover state can resize an open
// panel while the pointer is inside it.
import { onNavigate } from "./spa.js";

const GAP = 5;
const CHILD_GAP = 4;
const EDGE = 8;
const OPEN_DELAY = 110;
const CLOSE_DELAY = 240;

interface Panel {
  el: HTMLElement;
  trigger: HTMLElement;
  anchor: HTMLElement;
  parent: Panel | null;
  depth: number;
}

let layer: HTMLElement | null = null;
let holder: HTMLElement | null = null;
let panels = new Map<string, Panel>();
let openChain: Panel[] = [];
let openTimer = 0;
let closeTimer = 0;
let focusInside = false;
let lastX = 0;
let lastY = 0;

/** Fixed-position coordinates are relative to the nearest ancestor with a
 *  transform/filter/backdrop-filter. Panels live under the glass header, so all
 *  geometry here is viewport coordinates minus the holder's own origin. */
function origin(): { x: number; y: number } {
  const r = holder?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: r.left, y: r.top };
}

function collect(): void {
  openChain = [];
  panels = new Map();
  layer = document.querySelector<HTMLElement>("[data-crumb-layer]");
  holder = layer;
  if (!layer) return;
  layer.hidden = true;
  const found: Panel[] = [];
  for (const trigger of document.querySelectorAll<HTMLElement>("[data-crumb-key]")) {
    const id = trigger.dataset.crumbKey!;
    const el = layer.querySelector<HTMLElement>(`.crumb-panel[data-crumb-panel="${CSS.escape(id)}"]`);
    if (!el) continue;
    found.push({
      el,
      trigger,
      anchor: trigger.querySelector<HTMLElement>(".crumb-item-link, .crumb-label") ?? trigger,
      parent: null,
      depth: id.split(".").length - 1,
    });
    panels.set(id, found[found.length - 1]);
  }
  // Parents are emitted before their children, but the chain is built by key.
  for (const p of found) {
    const id = p.el.dataset.crumbPanel!;
    p.parent = panels.get(id.slice(0, id.lastIndexOf("."))) ?? null;
  }
}

/** Lay out the open chain as one unit: panels run right of their parent, or —
 *  when the chain would not fit — leftward from the root. Placement happens
 *  once here, so nothing moves while the pointer is inside the chain. */
function layout(chain: Panel[]): void {
  if (!chain.length || !layer) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  layer.hidden = false;
  for (const p of chain) {
    p.el.hidden = false;
    p.el.classList.add("open");
    p.el.style.visibility = "hidden";
    p.el.style.left = "0px";
    p.el.style.top = "0px";
    p.el.style.maxHeight = "";
  }
  const nat = new Map<Panel, DOMRect>();
  for (const p of chain) nat.set(p, p.el.getBoundingClientRect());
  const n = (p: Panel): DOMRect => nat.get(p)!;

  // Chain x positions come from the natural sizes, so they are viewport-space.
  const row = chain[0].anchor.getBoundingClientRect();
  let x = row.left;
  const xs: number[] = [x];
  for (let i = 1; i < chain.length; i++) {
    x += n(chain[i - 1]).width + CHILD_GAP;
    xs.push(x);
  }
  if (xs[xs.length - 1] + n(chain[chain.length - 1]).width > vw - EDGE) {
    // No room rightward; lay out leftward instead.
    x = row.left;
    xs[0] = x;
    for (let i = 1; i < chain.length; i++) {
      x -= CHILD_GAP + n(chain[i]).width;
      xs[i] = x;
    }
    if (xs[xs.length - 1] < EDGE) {
      // The chain cannot fit on either side. Close rather than stack panels.
      clearTimers();
      setOpen(null);
      return;
    }
  }

  let top = row.bottom + GAP;
  if (top + Math.min(n(chain[0]).height, vh) > vh - EDGE && row.top - GAP > vh - row.bottom) {
    top = Math.max(EDGE, row.top - GAP - n(chain[0]).height);
  }

  const o = origin();
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const box = n(p);
    const pTop = i === 0 ? top : Math.max(EDGE, Math.min(p.anchor.getBoundingClientRect().top, vh - EDGE - box.height));
    const left = Math.max(EDGE, Math.min(xs[i], vw - EDGE - box.width));
    const cap = parseFloat(getComputedStyle(p.el).maxHeight);
    p.el.style.left = `${left - o.x}px`;
    p.el.style.top = `${pTop - o.y}px`;
    p.el.style.maxHeight = `${Math.max(96, Math.min(Number.isFinite(cap) ? cap : Infinity, vh - pTop - EDGE))}px`;
    p.el.style.visibility = "";
    p.trigger.classList.add("is-open");
    p.trigger.setAttribute("aria-expanded", "true");
  }
}

function hide(p: Panel): void {
  p.el.hidden = true;
  p.el.classList.remove("open");
  p.trigger.classList.remove("is-open");
  p.trigger.setAttribute("aria-expanded", "false");
}

function chainOf(p: Panel | null): Panel[] {
  const chain: Panel[] = [];
  for (let cur = p; cur; cur = cur.parent) chain.unshift(cur);
  return chain;
}

function setOpen(target: Panel | null): void {
  if (!layer) return;
  const chain = chainOf(target);
  const keep = new Set(chain);
  for (const p of openChain) if (!keep.has(p)) hide(p);
  layer.hidden = chain.length === 0;
  layout(chain);
  openChain = chain;
}

function clearTimers(): void {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}

function closeNow(): void {
  clearTimers();
  setOpen(null);
}

function panelOf(trigger: HTMLElement | null): Panel | null {
  const id = trigger?.dataset.crumbKey;
  return id ? (panels.get(id) ?? null) : null;
}

const TRIGGER = ".crumb-item.has-sub, .crumb[data-crumb-key]";

function triggerIn(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>(TRIGGER) ?? null;
}

function scheduleOpen(p: Panel): void {
  clearTimers();
  if (chainOf(p).every((c) => openChain.includes(c))) return;
  openTimer = window.setTimeout(() => setOpen(p), OPEN_DELAY);
}

/** The open chain's bounding span, padded: a pointer crossing the few pixels
 *  between a panel and its child is still "inside" and must not start closing. */
function inSafeZone(t: Element | null): boolean {
  if (!t) return false;
  for (const p of openChain) {
    const r = p.el.getBoundingClientRect();
    if (t === p.el || (r.left - 4 <= lastX && lastX <= r.right + 4 && r.top - 2 <= lastY && lastY <= r.bottom + 2)) return true;
  }
  return false;
}

function scheduleClose(): void {
  clearTimers();
  closeTimer = window.setTimeout(() => {
    if (focusInside || layer?.matches(":hover, :focus-within") || inSafeZone(document.elementFromPoint(lastX, lastY))) return;
    closeNow();
  }, CLOSE_DELAY);
}

function initEvents(): void {
  document.addEventListener(
    "pointerover",
    (e) => {
      lastX = e.clientX;
      lastY = e.clientY;
      const t = e.target;
      if (!(t instanceof Element)) return;
      const trigger = triggerIn(t);
      const p = panelOf(trigger);
      if (p) {
        if (openChain.includes(p)) clearTimers();
        else scheduleOpen(p);
        return;
      }
      // Over a leaf row: retreat to the panel holding it. Panel background and
      // the short crossing to a child panel leave the chain untouched.
      const host = t.closest<HTMLElement>(".crumb-panel");
      if (host) {
        clearTimers();
        if (t.closest(".crumb-item")) setOpen(panels.get(host.dataset.crumbPanel!) ?? null);
        return;
      }
      if (openChain.length) scheduleClose();
    },
    { passive: true },
  );

  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    if (!triggerIn(t) && !layer?.contains(t as Node)) closeNow();
  });

  document.addEventListener("focusin", (e) => {
    const t = e.target as Element;
    if (layer?.contains(t) || t.closest(".crumbs")) {
      focusInside = true;
      clearTimers();
      // Items nested directly in the layer (panel rows) are not inside any
      // panel box, so the owning panel is resolved from its data attribute.
      const host = t.closest<HTMLElement>(".crumb-panel");
      const p = host ? (panels.get(host.dataset.crumbPanel!) ?? null) : panelOf(triggerIn(t));
      if (p) setOpen(p);
      return;
    }
    if (focusInside) {
      focusInside = false;
      closeNow();
    }
  });

  document.addEventListener("focusout", (e) => {
    const t = e.target as Element;
    if (!(layer?.contains(t) || t.closest(".crumbs"))) return;
    const next = e.relatedTarget as Node | null;
    if (next && (layer?.contains(next) || (next instanceof Element && next.closest(".crumbs")))) return;
    focusInside = false;
    scheduleClose();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openChain.length) {
      e.preventDefault();
      const trigger = openChain[openChain.length - 1].trigger;
      closeNow();
      (trigger.querySelector<HTMLElement>(".crumb-item-link") ?? trigger).focus();
      return;
    }
    // Row triggers sit before the layer in DOM order, so Tab would run past a
    // whole row before reaching the open panel. Bridge in both directions.
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const t = document.activeElement;
      const row = t instanceof HTMLElement ? t.closest<HTMLElement>(".crumbs [data-crumb-key]") : null;
      const p = panelOf(row);
      if (p && openChain.includes(p) && !e.shiftKey) {
        const first = p.el.querySelector<HTMLElement>(":scope > .crumb-item > .crumb-item-link");
        if (first) {
          e.preventDefault();
          first.focus();
          return;
        }
      }
      // Reverse: the first row of a panel, or a nested trigger row, goes back
      // to the entry that opened this panel.
      const host = t instanceof HTMLElement ? t.closest<HTMLElement>(".crumb-panel") : null;
      if (host && e.shiftKey) {
        const first = host.querySelector<HTMLElement>(":scope > .crumb-item > .crumb-item-link");
        const doorway = (first && t === first) || (t instanceof HTMLElement && t.closest(".crumb-item.has-sub"));
        const trigger = doorway ? panels.get(host.dataset.crumbPanel!)?.trigger : null;
        if (trigger) {
          e.preventDefault();
          (trigger.querySelector<HTMLElement>(".crumb-item-link") ?? trigger).focus();
        }
      }
      // Landing on a nested trigger row opens it and steps to its first child;
      // the row itself stays reachable going backwards.
      const item = t instanceof HTMLElement ? t.closest<HTMLElement>(".crumb-panel .crumb-item.has-sub") : null;
      const nested = panelOf(item);
      if (nested) {
        setOpen(nested);
        const firstChild = nested.el.querySelector<HTMLElement>(":scope > .crumb-item > .crumb-item-link");
        if (firstChild) {
          e.preventDefault();
          firstChild.focus();
        }
        return;
      }
    }
  });

  window.addEventListener("resize", () => {
    if (openChain.length) layout(openChain);
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!openChain.length) return;
      const row = openChain[0].anchor.getBoundingClientRect();
      if (row.bottom <= 0 || row.top >= window.innerHeight) closeNow();
    },
    { passive: true },
  );
}

export function initCrumbMenu(): void {
  // Registered unconditionally: a page without breadcrumbs (the home page) can
  // still soft-navigate to one that has them.
  initEvents();
  collect();
  onNavigate(() => {
    closeNow();
    collect();
  });
}

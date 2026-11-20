// Breadcrumb menus. The build emits one flat layer of panels; this controller
// alone opens, places and closes them, so no hover state can resize an open
// panel while the pointer is inside it.
import { onNavigate } from "./spa.js";

const GAP = 5;
const EDGE = 8;
const OPEN_DELAY = 110;
const CLOSE_DELAY = 240;
// Mirrors the `@media (hover: none)` rule that drops the layer: with no hover
// there is no pointer path into it, so the keyboard bridge stays out too.
const MQ_NO_HOVER = window.matchMedia("(hover: none)");

interface Panel {
  el: HTMLElement;
  trigger: HTMLElement;
  anchor: HTMLElement;
  parent: Panel | null;
  depth: number;
}

let layer: HTMLElement | null = null;
let panels = new Map<string, Panel>();
let openChain: Panel[] = [];
let openSide: "right" | "left" = "right";
let openTimer = 0;
let closeTimer = 0;
let focusInside = false;
let lastX = 0;
let lastY = 0;

/** Fixed-position coordinates are relative to the nearest ancestor with a
 *  transform/filter/backdrop-filter. Panels live under the glass header, so all
 *  geometry here is viewport coordinates minus the layer's own origin. */
function origin(): { x: number; y: number } {
  const r = layer?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: r.left, y: r.top };
}

function collect(): void {
  openChain = [];
  panels = new Map();
  layer = document.querySelector<HTMLElement>("[data-crumb-layer]");
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
  // The chain is built by key, so parent links resolve in a second pass.
  for (const p of found) {
    const id = p.el.dataset.crumbPanel!;
    p.parent = panels.get(id.slice(0, id.lastIndexOf("."))) ?? null;
  }
}

function chainXs(chain: Panel[], dir: "right" | "left", nat: Map<Panel, DOMRect>): number[] {
  const xs = [chain[0].anchor.getBoundingClientRect().left];
  for (let i = 1; i < chain.length; i++) {
    xs.push(dir === "right" ? xs[i - 1] + nat.get(chain[i - 1])!.width : xs[i - 1] - nat.get(chain[i])!.width);
  }
  return xs;
}

function fits(chain: Panel[], dir: "right" | "left", nat: Map<Panel, DOMRect>): boolean {
  const xs = chainXs(chain, dir, nat);
  const vw = window.innerWidth;
  return dir === "right"
    ? xs[xs.length - 1] + nat.get(chain[chain.length - 1])!.width <= vw - EDGE
    : xs[xs.length - 1] >= EDGE;
}

/** Place every panel of the chain. Returns false (leaving nothing painted) when
 *  the chain cannot fit on the chosen side; the caller then closes it. */
function place(chain: Panel[]): boolean {
  if (!chain.length || !layer) return false;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
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

  // Keep the side chosen when the chain first opened; only switch it when the
  // current side no longer fits, so a panel under the pointer never jumps.
  if (!fits(chain, openSide, nat)) {
    const other = openSide === "right" ? "left" : "right";
    if (!fits(chain, other, nat)) return false;
    openSide = other;
  }
  const xs = chainXs(chain, openSide, nat);
  const row = chain[0].anchor.getBoundingClientRect();
  let top = row.bottom + GAP;
  if (top + Math.min(nat.get(chain[0])!.height, vh) > vh - EDGE && row.top - GAP > vh - row.bottom) {
    top = Math.max(EDGE, row.top - GAP - nat.get(chain[0])!.height);
  }

  const o = origin();
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const box = nat.get(p)!;
    const pTop = i === 0 ? top : Math.max(EDGE, Math.min(p.anchor.getBoundingClientRect().top, vh - EDGE - box.height));
    const left = Math.max(EDGE, Math.min(xs[i], vw - EDGE - box.width));
    const cap = parseFloat(getComputedStyle(p.el).maxHeight);
    p.el.style.left = `${left - o.x}px`;
    p.el.style.top = `${pTop - o.y}px`;
    p.el.style.maxHeight = `${Math.max(96, Math.min(Number.isFinite(cap) ? cap : Infinity, vh - pTop - EDGE))}px`;
    p.el.style.visibility = "";
    p.el.dataset.side = openSide;
    p.trigger.classList.add("is-open");
    p.trigger.setAttribute("aria-expanded", "true");
  }
  return true;
}

function hide(p: Panel): void {
  p.el.hidden = true;
  p.el.classList.remove("open");
  p.el.style.visibility = "";
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
  if (chain.length && MQ_NO_HOVER.matches) return;
  if (!chain.length) openSide = "right";
  const keep = new Set(chain);
  for (const p of openChain) if (!keep.has(p)) hide(p);
  layer.hidden = chain.length === 0;
  if (chain.length && !place(chain)) {
    // Fits on neither side: nothing may stay painted.
    for (const p of chain) hide(p);
    layer.hidden = true;
    openChain = [];
    return;
  }
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

function firstRow(panel: Panel): HTMLElement | null {
  return panel.el.querySelector<HTMLElement>(":scope > .crumb-item > .crumb-item-link");
}

function focusTrigger(trigger: HTMLElement): void {
  (trigger.querySelector<HTMLElement>(".crumb-item-link, .crumb-label") ?? trigger).focus();
}

function scheduleOpen(p: Panel): void {
  if (MQ_NO_HOVER.matches) return;
  clearTimers();
  if (chainOf(p).every((c) => openChain.includes(c))) return;
  openTimer = window.setTimeout(() => setOpen(p), OPEN_DELAY);
}

/** A pointer crossing the few pixels between a panel and its child is still
 *  "inside" the open chain and must not start closing it. */
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
      if (MQ_NO_HOVER.matches) return;
      const t = e.target;
      if (!(t instanceof Element)) return;
      const p = panelOf(triggerIn(t));
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
    // A press on a nested trigger row is a menu action, not an outside click.
    if (layer?.contains(t as Node)) return;
    closeNow();
  });

  // A nested trigger row inside a panel toggles its submenu. The breadcrumb row
  // itself is left alone: Home, ai, … must keep navigating. Capture phase: the
  // soft-navigation router also listens for clicks and would start its fetch
  // before a bubble-phase handler could cancel the event.
  document.addEventListener(
    "click",
    (e) => {
      if (MQ_NO_HOVER.matches) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const label = e.target instanceof Element ? e.target.closest<HTMLElement>(".crumb-panel .crumb-item-link") : null;
      const p = panelOf(triggerIn(label));
      if (!p) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(openChain.includes(p) ? p.parent : p);
    },
    true,
  );

  document.addEventListener("focusin", (e) => {
    const t = e.target as Element;
    if (layer?.contains(t) || t.closest(".crumbs")) {
      focusInside = true;
      clearTimers();
      if (MQ_NO_HOVER.matches) return;
      // Rows nested directly in the layer are not inside any panel box, so the
      // owning panel is resolved from its data attribute.
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
    if (!MQ_NO_HOVER.matches) scheduleClose();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openChain.length) {
      e.preventDefault();
      const trigger = openChain[openChain.length - 1].trigger;
      closeNow();
      focusTrigger(trigger);
      return;
    }
    if (MQ_NO_HOVER.matches) return;
    if (e.key === "Enter") {
      // Only nested trigger rows: a breadcrumb row link keeps Enter = navigate.
      const label = document.activeElement instanceof Element ? document.activeElement.closest<HTMLElement>(".crumb-panel .crumb-item-link") : null;
      const p = panelOf(triggerIn(label));
      if (p) {
        e.preventDefault();
        setOpen(openChain.includes(p) ? p.parent : p);
        return;
      }
    }
    // Row triggers sit before the layer in DOM order; bridge Tab in both
    // directions between a breadcrumb row and the panel it opens.
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = document.activeElement;
    if (!(t instanceof HTMLElement)) return;
    const rowPanel = panelOf(t.closest<HTMLElement>(".crumbs [data-crumb-key]"));
    if (rowPanel && openChain.includes(rowPanel) && !e.shiftKey) {
      const first = firstRow(rowPanel);
      if (first) {
        e.preventDefault();
        first.focus();
        return;
      }
    }
    const host = t.closest<HTMLElement>(".crumb-panel");
    if (!host) return;
    const hostPanel = panels.get(host.dataset.crumbPanel!);
    // Backwards out of the first row, or a nested trigger row, to its opener —
    // and nothing further, so the direction cannot invert.
    if (e.shiftKey) {
      const isDoorway = t === firstRow(hostPanel!) || !!t.closest(".crumb-item.has-sub");
      if (isDoorway && hostPanel?.trigger) {
        e.preventDefault();
        focusTrigger(hostPanel.trigger);
        return;
      }
    }
    // Forward onto a nested trigger row: open it and step into its children.
    const nested = panelOf(t.closest<HTMLElement>(".crumb-panel .crumb-item.has-sub"));
    if (nested) {
      setOpen(nested);
      const firstChild = firstRow(nested);
      if (firstChild) {
        e.preventDefault();
        firstChild.focus();
      }
    }
  });

  window.addEventListener("resize", () => {
    if (!openChain.length) return;
    const current = place(openChain);
    // A resize can leave the chain fitting on neither side; close it then.
    if (!current) closeNow();
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

// TOC: scrollspy tracking, pin/expand state, and the phone drawer.
import { readStore, writeStore } from "./store.js";
import { onNavigate } from "./spa.js";

const root = document.documentElement;
const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

interface HeadingRef {
  el: HTMLElement;
  id: string;
}

let scrollspyObserver: IntersectionObserver | null = null;
let scrollspyRailObserver: MutationObserver | null = null;
const scrollspyCleanups: (() => void)[] = [];

function teardownScrollspy(): void {
  scrollspyObserver?.disconnect();
  scrollspyObserver = null;
  scrollspyRailObserver?.disconnect();
  scrollspyRailObserver = null;
  while (scrollspyCleanups.length) scrollspyCleanups.pop()!();
}

export function setupScrollspy(): void {
  teardownScrollspy();

  // Applied even on pages without a rail; they share the .post-layout track.
  const mqColumn = window.matchMedia("(min-width: 1420px)");
  const mqDock = window.matchMedia("(min-width: 1080px)");
  const applyColumn = (): void => {
    const pref = readStore(localStorage, "toc");
    const on = (pref !== "collapsed" && mqColumn.matches) || (pref === "expanded" && mqDock.matches);
    if (on) root.dataset.column = "true";
    else delete root.dataset.column;
  };
  const onMqChange = (): void => applyColumn();
  mqColumn.addEventListener?.("change", onMqChange);
  mqDock.addEventListener?.("change", onMqChange);
  scrollspyCleanups.push(() => mqColumn.removeEventListener?.("change", onMqChange));
  scrollspyCleanups.push(() => mqDock.removeEventListener?.("change", onMqChange));
  applyColumn();

  const rail = document.querySelector<HTMLElement>(".toc-rail");
  const toggle = rail?.querySelector<HTMLElement>(".toc-toggle") ?? null;
  const pinBtn = rail?.querySelector<HTMLElement>(".toc-pin") ?? null;
  const column = (): boolean => root.dataset.column === "true";

  const syncToggle = (): void => {
    toggle?.setAttribute("aria-expanded", String(column()));
    toggle?.setAttribute("aria-label", column() ? "Collapse table of contents" : "Expand table of contents");
  };

  toggle?.addEventListener("click", () => {
    writeStore(localStorage, "toc", column() ? "collapsed" : "expanded");
    applyColumn();
    syncToggle();
  });

  pinBtn?.addEventListener("click", () => {
    if (column()) return;
    writeStore(localStorage, "toc", "expanded");
    applyColumn();
    syncToggle();
  });

  syncToggle();
  const onColumnChange = (): void => syncToggle();
  mqColumn.addEventListener?.("change", onColumnChange);
  mqDock.addEventListener?.("change", onColumnChange);
  scrollspyCleanups.push(() => mqColumn.removeEventListener?.("change", onColumnChange));
  scrollspyCleanups.push(() => mqDock.removeEventListener?.("change", onColumnChange));

  const main = document.getElementById("main");
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".toc a[href^='#']")];
  if (!main || !links.length) return;

  const byId = new Map<string, HTMLAnchorElement[]>();
  for (const a of links) {
    const id = decodeURIComponent(a.getAttribute("href")!.slice(1));
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id)!.push(a);
  }

  const headings: HeadingRef[] = [...main.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], section[id] > h1, section[id] > h2, section[id] > h3")]
    .map((el) => ({ el, id: el.id || el.closest("section")?.id || "" }))
    .filter((h) => h.id && byId.has(h.id));
  if (!headings.length) return;

  let active: string | null = null;
  const marks = document.querySelectorAll<HTMLElement>(".toc-marks .m");
  const activate = (id: string | null): void => {
    if (active === id) return;
    active = id;
    for (const targets of byId.values()) {
      for (const a of targets) {
        a.classList.remove("active");
        a.removeAttribute("aria-current");
      }
    }
    for (const a of (id && byId.get(id)) || []) {
      a.classList.add("active");
      a.setAttribute("aria-current", "location");
    }
    const key = id ? encodeURIComponent(id) : "";
    for (const m of marks) m.classList.toggle("active", m.dataset.for === key);
  };

  const visible = new Set<HTMLElement>();
  const findByBand = (): string | null => {
    if (visible.size) {
      const first = headings.find((h) => visible.has(h.el));
      if (first) return first.id;
    }
    const line = window.innerHeight * 0.3;
    let current: HeadingRef | null = null;
    for (const h of headings) if (h.el.getBoundingClientRect().top <= line) current = h;
    return current ? current.id : null;
  };

  let locked = false;
  let lockTimer = 0;
  const release = (): void => {
    locked = false;
    clearTimeout(lockTimer);
  };
  const lock = (): void => {
    locked = true;
    clearTimeout(lockTimer);
    lockTimer = window.setTimeout(release, 1400);
  };

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) visible.add(en.target as HTMLElement);
        else visible.delete(en.target as HTMLElement);
      }
      if (!locked) activate(findByBand());
    },
    { rootMargin: "-84px 0px -70% 0px", threshold: 0 }
  );

  for (const h of headings) io.observe(h.el);
  scrollspyObserver = io;

  const onScrollEnd = (): void => release();
  window.addEventListener("scrollend", onScrollEnd, { passive: true });
  scrollspyCleanups.push(() => window.removeEventListener("scrollend", onScrollEnd));

  const onClick = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest?.('a[href^="#"]');
    if (!a) return;
    const id = decodeURIComponent(a.getAttribute("href")!.slice(1));
    if (!id || !byId.has(id)) return;
    activate(id);
    lock();
  };
  document.addEventListener("click", onClick);
  scrollspyCleanups.push(() => document.removeEventListener("click", onClick));

  if (!rail) return;

  const panel = rail.querySelector<HTMLElement>(".toc-panel");

  const box = panel ?? rail;
  const overflowing = (): boolean => box.scrollHeight > box.clientHeight + 1;
  const keepInView = (smooth: boolean): void => {
    if (!overflowing()) return;
    const current = box.querySelector<HTMLElement>("a.active");
    if (!current) {
      if (box.scrollTop > 0) box.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
      return;
    }
    const r = current.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const topEdge = b.top + 8;
    const behavior = smooth ? "smooth" : "auto";
    if (r.top < topEdge) box.scrollBy({ top: r.top - topEdge, behavior });
    else if (r.bottom > b.bottom - 8) box.scrollBy({ top: r.bottom - b.bottom + 8, behavior });
  };
  const railObserver = new MutationObserver(() => keepInView(!mqReduced.matches));
  railObserver.observe(rail, { subtree: true, attributes: true, attributeFilter: ["class"] });
  scrollspyRailObserver = railObserver;
  const onRailScrollEnd = (): void => keepInView(false);
  window.addEventListener("scrollend", onRailScrollEnd, { passive: true });
  scrollspyCleanups.push(() => window.removeEventListener("scrollend", onRailScrollEnd));
}

// Phone TOC drawer, mirroring the sidebar's. Delegated at document level:
// soft navigation replaces the header (and the rail) wholesale.
export function initTocDrawer(): void {
  const mqDrawer = window.matchMedia("(max-width: 767.98px)");
  const backdrop = document.getElementById("nav-backdrop");
  let lastFocus: HTMLElement | null = null;

  const isOpen = (): boolean => root.dataset.tocOpen === "true";
  const toggleBtn = (): HTMLElement | null => document.getElementById("toc-btn");

  const open = (): void => {
    if (isOpen()) return;
    lastFocus = document.activeElement as HTMLElement | null;
    root.dataset.tocOpen = "true";
    toggleBtn()?.setAttribute("aria-expanded", "true");
    if (backdrop) backdrop.hidden = false;
    document.querySelector<HTMLElement>(".toc-panel")?.focus({ preventScroll: true });
  };

  const close = (restore = true): void => {
    if (!isOpen()) return;
    delete root.dataset.tocOpen;
    toggleBtn()?.setAttribute("aria-expanded", "false");
    if (backdrop) setTimeout(() => (backdrop.hidden = true), 240);
    if (restore) lastFocus?.focus?.({ preventScroll: true });
  };

  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest?.("[data-toc-toggle]")) {
      if (mqDrawer.matches) isOpen() ? close() : open();
      return;
    }
    if (!isOpen()) return;
    // Entry taps navigate in-page; anything outside the drawer closes it.
    if (!target?.closest?.(".toc-rail")) close();
    else if (target?.closest?.('.toc a[href^="#"]')) close(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // Never strand an open drawer above phone width.
  mqDrawer.addEventListener?.("change", (e) => {
    if (!e.matches) close(false);
  });

  onNavigate(() => close(false));
}

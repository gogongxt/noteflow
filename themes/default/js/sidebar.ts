// Sidebar collapse, resize, and scroll restoration.
import { readStore, writeStore } from "./store.js";
import { onNavigate } from "./spa.js";

const root = document.documentElement;

export function initSidebarCollapse(): void {
  if (!document.querySelector("[data-sidebar-collapse]")) return;

  const mqWide = window.matchMedia("(min-width: 1080px)");
  const isCollapsed = (): boolean => root.dataset.sidebar === "collapsed";

  const sync = (): void => {
    if (!mqWide.matches) return; // narrow viewports: the drawer module owns the button
    const collapsed = isCollapsed();
    for (const b of document.querySelectorAll<HTMLElement>("[data-sidebar-collapse]")) {
      b.setAttribute("aria-expanded", String(!collapsed));
      b.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
      b.title = `${collapsed ? "Expand" : "Collapse"} sidebar (\\)`;
    }
  };
  window.matchMedia("(min-width: 1080px)").addEventListener?.("change", sync);

  const apply = (collapsed: boolean): void => {
    if (collapsed) root.dataset.sidebar = "collapsed";
    else delete root.dataset.sidebar;
    writeStore(localStorage, "sidebar", collapsed ? "collapsed" : "expanded");
    sync();
  };

  // Delegated: soft navigation replaces the header.
  document.addEventListener("click", (e) => {
    if (!(e.target as Element | null)?.closest?.("[data-sidebar-collapse]")) return;
    if (mqWide.matches) apply(!isCollapsed());
  });

  onNavigate(sync);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "\\" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (!mqWide.matches) return;
    apply(!isCollapsed());
  });

  sync();
}

export function initSidebarResize(): void {
  const handle = document.querySelector<HTMLElement>("[data-sidebar-resizer]");
  const sidebar = document.getElementById("sidebar");
  if (!handle || !sidebar) return;

  const KEY = "sidebar-w";
  const mqWide = window.matchMedia("(min-width: 1080px)");
  // Custom properties resolve to tokens ("17rem"); parse rem against root size.
  const toPx = (raw: string): number => {
    const v = parseFloat(raw);
    if (!Number.isFinite(v)) return 0;
    const rootPx = parseFloat(getComputedStyle(root).fontSize) || 16;
    return /rem\b/.test(raw.trim()) ? v * rootPx : v;
  };
  const width = (): number => sidebar.getBoundingClientRect().width;
  const min = (): number => toPx(getComputedStyle(root).getPropertyValue("--sidebar-w-min"));
  const max = (): number => Math.max(min(), Math.min(window.innerWidth * 0.5, window.innerWidth - 480));

  const set = (px: number): number => {
    const clamped = Math.round(Math.min(max(), Math.max(min(), px)));
    root.style.setProperty("--sidebar-w", clamped + "px");
    return clamped;
  };

  const commit = (): void => writeStore(localStorage, KEY, String(Math.round(width())));

  handle.addEventListener("pointerdown", (e) => {
    if (!mqWide.matches || e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    root.dataset.resizing = "";
    const startX = e.clientX;
    const startW = width();

    const move = (ev: PointerEvent): void => {
      set(startW + ev.clientX - startX);
    };
    const end = (): void => {
      delete root.dataset.resizing;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      commit();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });

  handle.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 48 : 16;
    switch (e.key) {
      case "ArrowLeft":
        set(width() - step);
        break;
      case "ArrowRight":
        set(width() + step);
        break;
      case "Home":
        set(min());
        break;
      case "End":
        set(max());
        break;
      default:
        return;
    }
    e.preventDefault();
    commit();
  });

  handle.addEventListener("dblclick", () => {
    set(min());
    commit();
  });

  let raf = 0;
  window.addEventListener("resize", () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (width() > max()) set(max());
    });
  });
}

export function initSidebarScroll(): void {
  const nav = document.querySelector<HTMLElement>(".sidebar .sidebar-nav");
  if (!nav) return;

  const KEY = "sidebar-scroll";
  const stored = (): number => Number(readStore(sessionStorage, KEY));

  const revealCurrent = (): void => {
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    const top = nav.scrollTop + active.getBoundingClientRect().top - nav.getBoundingClientRect().top;
    const bottom = top + active.offsetHeight;
    if (top < nav.scrollTop || bottom > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = Math.max(0, top - nav.clientHeight / 3);
    }
  };

  const restore = (value: number): void => {
    if (Number.isFinite(value) && value > 0) nav.scrollTop = value;
    else revealCurrent();
  };

  restore(stored());
  window.addEventListener("pagereveal", () => restore(stored() || NaN));
  window.addEventListener("load", () => restore(stored()));

  const persist = (): void => writeStore(sessionStorage, KEY, String(nav.scrollTop));
  window.addEventListener("pagehide", persist);

  let raf = 0;
  nav.addEventListener(
    "scroll",
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        persist();
      });
    },
    { passive: true }
  );
}

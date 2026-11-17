// Narrow-viewport sidebar drawer (open/close, backdrop, Escape, focus restore).
import { onNavigate } from "./spa.js";

export function initDrawer(): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const backdrop = document.getElementById("nav-backdrop");
  const mqDrawer = window.matchMedia("(max-width: 1079.98px)");
  let lastFocus: HTMLElement | null = null;

  const isOpen = (): boolean => document.body.classList.contains("nav-open");
  // The menu button lives in the header, which soft navigation replaces.
  const toggle = (): HTMLElement | null => document.getElementById("menu-toggle");

  const open = (): void => {
    if (isOpen()) return;
    lastFocus = document.activeElement as HTMLElement | null;
    document.body.classList.add("nav-open");
    toggle()?.setAttribute("aria-expanded", "true");
    if (backdrop) backdrop.hidden = false;
    sidebar.querySelector<HTMLElement>("a, summary, button")?.focus({ preventScroll: true });
  };

  const close = (restore = true): void => {
    if (!isOpen()) return;
    document.body.classList.remove("nav-open");
    toggle()?.setAttribute("aria-expanded", "false");
    if (backdrop) setTimeout(() => !isOpen() && (backdrop.hidden = true), 220);
    if (restore) lastFocus?.focus?.({ preventScroll: true });
  };

  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest?.("#menu-toggle")) {
      if (mqDrawer.matches) isOpen() ? close() : open();
      return;
    }
    if (target?.closest?.("#nav-backdrop")) close();
  });

  sidebar.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a[href]") && mqDrawer.matches) close(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // The button reflects the drawer only on narrow screens.
  const syncBtn = (): void => {
    if (mqDrawer.matches) toggle()?.setAttribute("aria-expanded", String(isOpen()));
  };
  window.matchMedia("(min-width: 1080px)").addEventListener?.("change", (e) => {
    if (e.matches) close(false);
    else syncBtn();
  });

  // Close an open drawer so the swapped-in page is not hidden behind it.
  onNavigate(() => close(false));
  onNavigate(syncBtn);
  syncBtn();
}

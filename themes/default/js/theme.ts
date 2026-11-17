// Theme toggle; delegated because soft navigation replaces the header.
import { readStore, writeStore } from "./store.js";
import { onNavigate } from "./spa.js";

const root = document.documentElement;
const mqDark = window.matchMedia("(prefers-color-scheme: dark)");

export function initTheme(): void {
  if (!document.querySelector("[data-theme-toggle]")) return;

  const effective = (): string => root.dataset.theme || (mqDark.matches ? "dark" : "light");

  const sync = (): void => {
    const dark = effective() === "dark";
    for (const btn of document.querySelectorAll<HTMLElement>("[data-theme-toggle]")) {
      btn.setAttribute("aria-pressed", String(dark));
      btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    }
  };

  document.addEventListener("click", (e) => {
    if (!(e.target as Element | null)?.closest?.("[data-theme-toggle]")) return;
    const next = effective() === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    writeStore(localStorage, "theme", next);
    sync();
  });

  const onScheme = (): void => {
    if (!readStore(localStorage, "theme")) sync();
  };
  mqDark.addEventListener?.("change", onScheme);

  sync();
  onNavigate(sync);
}

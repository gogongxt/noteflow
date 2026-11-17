// Progressive enhancement for `::: {.tabs}` groups. The build emits every panel
// visible under its data-title (the whole no-JS experience); this module
// upgrades each group to an ARIA tab widget. Panels are hidden, never removed,
// so they stay in the DOM and the search index.

import { jumpTo } from "./anchor.js";

const READY = "data-tabs-ready";

function enhance(root: HTMLElement, index: number): void {
  if (root.hasAttribute(READY)) return;

  const tabs = [...root.children].filter(
    (c): c is HTMLElement => c instanceof HTMLElement && c.classList.contains("tab"),
  );
  if (!tabs.length) return;
  root.setAttribute(READY, "");

  const labels = tabs.map((tab, i) => tab.dataset.title?.trim() || `标签 ${i + 1}`);

  const nav = document.createElement("div");
  nav.className = "tabs-nav";
  nav.setAttribute("role", "tablist");

  const prefix = `tabs-${index}`;
  const buttons = tabs.map((tab, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-link";
    btn.textContent = labels[i];
    btn.id = `${prefix}-tab-${i}`;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", `${prefix}-panel-${i}`);
    tab.id = `${prefix}-panel-${i}`;
    tab.setAttribute("role", "tabpanel");
    tab.setAttribute("aria-labelledby", btn.id);
    nav.append(btn);
    return btn;
  });

  const select = (at: number, focus = false): void => {
    buttons.forEach((btn, i) => {
      const active = i === at;
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
      tabs[i].hidden = !active;
    });
    if (focus) buttons[at].focus();
  };

  nav.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>(".tab-link");
    if (!btn) return;
    const i = buttons.indexOf(btn as HTMLButtonElement);
    if (i >= 0) select(i);
  });

  // W3C tabs pattern: arrows move, Home/End jump to the ends.
  nav.addEventListener("keydown", (e) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    else return;
    e.preventDefault();
    select(next, true);
  });

  root.prepend(nav);
  // A deep link into a hidden panel must select it before the browser scrolls.
  let hash = location.hash.slice(1);
  try {
    hash = decodeURIComponent(hash);
  } catch {
    /* keep the raw fragment */
  }
  const target = hash ? document.getElementById(hash) : null;
  const initial = target ? tabs.indexOf(target.closest<HTMLElement>(".tab") as HTMLElement) : -1;
  select(initial >= 0 ? initial : 0);
  // Hiding the other panels moves the target; scroll to it once more.
  if (target && initial >= 0 && root.contains(target)) jumpTo(target);
}

export function initTabs(doc: Document = document): void {
  let index = 0;
  for (const root of doc.querySelectorAll<HTMLElement>(".post-body .tabs")) enhance(root, index++);
}

/**
 * Reveal the group that owns the heading `id`, so a link into a hidden panel
 * scrolls somewhere visible. Returns true when a group handled it.
 */
export function revealAnchor(id: string): boolean {
  const target = document.getElementById(id);
  const tab = target?.closest<HTMLElement>(".tab");
  const root = tab?.parentElement;
  const nav = root?.querySelector<HTMLElement>(":scope > .tabs-nav");
  if (!tab || !root || !nav) return false;
  const idx = [...root.children].filter((c) => c.classList.contains("tab")).indexOf(tab);
  const btn = nav.querySelectorAll<HTMLButtonElement>(".tab-link")[idx];
  if (!btn) return false;
  btn.click();
  return true;
}

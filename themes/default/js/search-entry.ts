// The header button and Ctrl/Cmd-K open the lazily loaded search dialog;
// clicks are delegated because soft navigation replaces the header.
import { onNavigate } from "./spa.js";

export function initSearchEntry(): void {
  if (!document.querySelector("[data-search-open]")) return;

  let loader: Promise<unknown> | null = null;
  const load = (): Promise<unknown> => {
    loader ??= import("./search.js").then((m) => m.initSearch());
    return loader;
  };

  const api = (): { open: () => void } | undefined =>
    (window as unknown as { __NOTEFLOW_SEARCH__?: { open: () => void } }).__NOTEFLOW_SEARCH__;

  const isTyping = (t: EventTarget | null): boolean => {
    const el = t as HTMLElement | null;
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  };

  const fromShortcut = (e: KeyboardEvent): boolean =>
    ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) || (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target));

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (!fromShortcut(e)) return;
    e.preventDefault();
    if (api()) void api()!.open();
    else void load().then(() => api()?.open());
  });

  document.addEventListener(
    "click",
    (e) => {
      const trigger = (e.target as Element).closest?.("[data-search-open]");
      if (!trigger) return;
      e.preventDefault();
      if (api()) void api()!.open();
      else void load().then(() => api()?.open());
    },
    true
  );

  const prefetch = (): void => void load();

  const bindPrefetch = (): void => {
    const trigger = document.querySelector<HTMLElement>("[data-search-open]");
    if (!trigger) return;
    trigger.addEventListener("pointerenter", prefetch, { once: true });
    trigger.addEventListener("focus", prefetch, { once: true });
  };
  bindPrefetch();
  onNavigate(bindPrefetch);
}

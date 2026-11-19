// Soft navigation: fetch the next page and swap only what changes (<main>, the
// header's inner bar, the sidebar highlight, title, page kind), then run the
// registered onNavigate hooks. The router owns no page markup of its own.

import { flashTarget, jumpTo } from "./anchor.js";
import { revealAnchor } from "./tabs.js";
import { revealCodeFold } from "./code-block.js";

interface SpaConfig {
  /** Content-hashed diagram stylesheet, added under `<head>` on demand. */
  diagramsCss?: string;
  /** URL-space base path ('' or '/repo'); internal URLs carry it. */
  basePath?: string;
}

// Injected by src/build/static-assets.ts at build time. Declared so the file typechecks
// as-is; the build replaces the whole initializer.
declare const __NOTEFLOW_SPA_CONFIG__: SpaConfig;
const __SPA__ = __NOTEFLOW_SPA_CONFIG__;
const CONFIG: SpaConfig = __SPA__;

export type NavigateHook = (root: Document) => void;

const hooks: NavigateHook[] = [];

/** Register work that must run against freshly swapped content. */
export function onNavigate(hook: NavigateHook): void {
  hooks.push(hook);
}

let controller: AbortController | null = null;
let pendingUrl: string | null = null;

// Beside the theme toggle; appears only after a short delay so instant
// navigations show nothing.
const SPINNER_DELAY = 160;
const spinner = (() => {
  if (typeof document === "undefined") return { start() {}, done() {}, fail() {} };
  let timer = 0;
  let running = false;

  const el = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-nav-spinner]");

  const show = (): void => {
    running = true;
    const node = el();
    if (!node) return;
    node.dataset.state = "run";
    node.setAttribute("aria-hidden", "false");
  };

  const hide = (failed: boolean): void => {
    running = false;
    clearTimeout(timer);
    const node = el();
    if (!node) return;
    node.dataset.state = failed ? "error" : "idle";
    node.setAttribute("aria-hidden", "true");
  };

  const start = (): void => {
    if (running) return;
    running = true;
    // Do not flash anything for navigations that finish within the delay.
    timer = window.setTimeout(show, SPINNER_DELAY);
  };

  const finish = (failed: boolean): void => {
    const wasVisible = running && el()?.dataset.state === "run";
    clearTimeout(timer);
    running = false;
    if (!wasVisible && !failed) hide(false); // never-visible: cancel the timer
    else hide(failed);
  };

  return {
    start,
    done: (): void => finish(false),
    fail: (): void => finish(true),
  };
})();

/** Same-origin, GET-only, not a file download or a cross-document hash jump. */
function isSoftNavigable(a: HTMLAnchorElement, e: MouseEvent): boolean {
  if (e.defaultPrevented || e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  if (a.target && a.target !== "_self") return false;
  if (a.hasAttribute("download")) return false;
  const raw = a.getAttribute("href");
  if (!raw || raw.startsWith("#")) return false;
  let url: URL;
  try {
    url = new URL(a.href, location.href);
  } catch {
    return false;
  }
  if (url.origin !== location.origin) return false;
  // The base path lives on every internal URL; strip it before the shape checks.
  const base = CONFIG.basePath ?? "";
  const path = base && url.pathname.startsWith(base + "/") ? url.pathname.slice(base.length) : url.pathname;
  // Static assets, the feed and anything else non-page stays a normal request.
  if (path.startsWith("/static/") || path.startsWith("/assets/")) return false;
  if (/\.(xml|json|txt|woff2?|png|jpe?g|gif|webp|avif|svg|ico|pdf)$/i.test(path)) return false;
  return true;
}

/** Hash-only links (TOC, heading anchors) are handled in-page, not fetched. */
function sameDocument(url: URL): boolean {
  return url.pathname === location.pathname && url.search === location.search;
}

function parsePage(html: string): Document {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (!doc.querySelector("main#main")) {
    throw new Error("Unexpected page structure (missing main#main)");
  }
  // No <base>: CSP forbids base-uri; every URL is root-absolute anyway.
  return doc;
}

function setCurrentInSidebar(root: Document): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const current = (root.getElementById("sidebar")?.querySelector('[aria-current="page"]') as HTMLElement | null) ?? null;
  const target = current?.getAttribute("href") ?? null;
  for (const a of sidebar.querySelectorAll<HTMLElement>(".tree-link")) {
    if (a.getAttribute("href") === target && target) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }

  // Only ever *open* ancestors: server groups ship closed, so walk the current
  // link's ancestors in the fetched sidebar and map them by relPath key.
  const nextLink = current?.closest('#sidebar');
  for (const d of nextLink?.querySelectorAll<HTMLDetailsElement>('details[data-href]') ?? []) {
    if (!d.querySelector('[aria-current="page"]')) continue;
    const key = d.dataset.key;
    if (!key) continue;
    const local = sidebar.querySelector<HTMLDetailsElement>(`details[data-key="${CSS.escape(key)}"]`);
    if (local && !local.open) local.open = true;
  }

  const active = sidebar.querySelector<HTMLElement>('[aria-current="page"]');
  const nav = sidebar.querySelector<HTMLElement>(".sidebar-nav");
  if (!active || !nav) return;
  const top = nav.scrollTop + active.getBoundingClientRect().top - nav.getBoundingClientRect().top;
  const bottom = top + active.offsetHeight;
  if (top < nav.scrollTop || bottom > nav.scrollTop + nav.clientHeight) {
    nav.scrollTop = Math.max(0, top - nav.clientHeight / 3);
  }
}

/** Replace the header's contents, not the element: it keeps its identity, so
 *  the sticky backdrop is never repainted. */
function setHeader(root: Document): void {
  const next = root.querySelector(".site-header > .header-inner");
  const current = document.querySelector(".site-header > .header-inner");
  if (!next || !current) return;
  current.replaceWith(document.importNode(next, true));
  // The search trigger carries the index URL; re-bind the one-shot prefetch.
  document.dispatchEvent(new CustomEvent("noteflow:header", { bubbles: false }));
}

/** Swapped rather than kept: it renders from config, so a profile change shows
 *  without a reload. */
function setFooter(root: Document): void {
  const next = root.querySelector(".site-footer[data-region='footer']");
  const current = document.querySelector(".site-footer[data-region='footer']");
  if (!next) {
    current?.remove();
    return;
  }
  if (current) {
    current.replaceWith(document.importNode(next, true));
    return;
  }
  // A stale cached page has no footer of its own; keep the old one.
  const shell = document.querySelector(".shell");
  if (shell) shell.appendChild(document.importNode(next, true));
}

function ensureStyles(root: Document): void {
  for (const link of root.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const href = link.getAttribute("href");
    if (!href || document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(href)}"]`)) continue;
    document.head.appendChild(document.importNode(link, true));
  }
  // Only a first soft navigation *into* a diagram page adds the stylesheet.
  const needsDiagrams = !!root.querySelector(".post-body svg[data-mmd]");
  if (needsDiagrams && CONFIG.diagramsCss && !document.querySelector(`link[href="${CSS.escape(CONFIG.diagramsCss)}"]`)) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CONFIG.diagramsCss;
    document.head.appendChild(link);
  }
}

const titleOf = (root: Document): string => root.querySelector("title")?.textContent || document.title;

/** Per-page head tags: the canonical URL, the description (giscus sends it to
 *  its widget) and the social-preview tags. CSP, the inline scripts and the
 *  stylesheet are build output and stay. Each tag is identified by the
 *  attribute that names it (rel / name / property). */
const NAV_TECH_HEAD = "link[rel='canonical'], meta[name='description'], meta[property^='og:'], meta[name^='twitter:']";

function headKey(el: Element): string {
  return el.tagName + "\0" + (el.getAttribute("rel") || el.getAttribute("property") || el.getAttribute("name") || "");
}

function setHeadMeta(root: Document): void {
  const current = new Map<string, Element>();
  for (const el of document.head.querySelectorAll(NAV_TECH_HEAD)) current.set(headKey(el), el);
  const seen = new Set<string>();
  for (const el of root.head.querySelectorAll(NAV_TECH_HEAD)) {
    const key = headKey(el);
    seen.add(key);
    current.get(key)?.replaceWith(document.importNode(el, true));
  }
  for (const [key, el] of current) if (!seen.has(key)) el.remove();
}

async function navigate(url: URL, opts: { replace?: boolean; pop?: boolean } = {}): Promise<void> {
  const href = url.pathname + url.search;
  if (pendingUrl === href) return;
  pendingUrl = href;
  controller?.abort();
  const ac = new AbortController();
  controller = ac;
  spinner.start();

  try {
    const res = await fetch(url.href, {
      signal: ac.signal,
      credentials: "same-origin",
      headers: { accept: "text/html" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const root = parsePage(await res.text());

    const main = document.getElementById("main");
    const nextMain = root.getElementById("main");
    if (!main || !nextMain) throw new Error("Page is missing main#main");

    const hash = url.hash;
    document.title = titleOf(root);
    setHeadMeta(root);
    const pageKind = root.body.dataset.page;
    if (pageKind) document.body.dataset.page = pageKind;

    main.replaceWith(document.importNode(nextMain, true));
    setHeader(root);
    setFooter(root);
    setCurrentInSidebar(root);
    ensureStyles(root);

    // Hooks reshape the layout (table wrappers, tab panels): run before measuring.
    for (const hook of hooks) {
      try {
        hook(root);
      } catch (err) {
        console.error("[soft-nav] hook failed", err);
      }
    }

    // Back/forward restores the saved position; a fresh push goes to the top
    // or the link's heading (revealed before measuring).
    const savedY = opts.pop ? Number(history.state?.y ?? 0) : 0;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      /* keep the raw fragment */
    }
    const target = id ? document.getElementById(id) : null;
    if (target) {
      revealAnchor(id);
      revealCodeFold(target);
      jumpTo(target);
      flashTarget(id);
    } else {
      window.scrollTo({ top: savedY, behavior: "instant" as ScrollBehavior });
    }

    if (opts.replace) history.replaceState({ soft: true, y: window.scrollY }, "", url.href);
    else if (opts.pop) history.replaceState({ ...(history.state || {}), soft: true, y: window.scrollY }, "", url.href);
    else history.pushState({ soft: true, y: 0 }, "", url.href);

    document.dispatchEvent(new CustomEvent("noteflow:navigated", { detail: { url: url.href } }));
    spinner.done();
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    // Any failure falls back to a real navigation so the site stays usable.
    spinner.fail();
    console.error("[soft-nav] falling back to full navigation", err);
    location.assign(url.href);
  } finally {
    if (pendingUrl === href) pendingUrl = null;
  }
}

export function initSoftNav(): void {
  // Baseline features; the escape hatch is for debugging.
  if (typeof history?.pushState !== "function" || typeof fetch !== "function") return;
  if (document.documentElement.dataset.softNav === "off") return;
  document.documentElement.dataset.softNav = "on";

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !isSoftNavigable(a, e as MouseEvent)) return;
    const url = new URL(a.href, location.href);
    if (sameDocument(url)) return; // in-page anchor: leave it to the anchors module
    e.preventDefault();
    void navigate(url);
  });

  window.addEventListener("popstate", (e) => {
    // Only our own entries carry `soft`; a full-load entry needs a real reload.
    if (!e.state?.soft) {
      location.reload();
      return;
    }
    void navigate(new URL(location.href), { pop: true });
  });

  const prefetched = new Set<string>();
  const prefetch = (e: Event): void => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || !isSoftNavigable(a, { defaultPrevented: false, button: 0 } as MouseEvent)) return;
    const url = new URL(a.href, location.href);
    if (sameDocument(url) || prefetched.has(url.href)) return;
    prefetched.add(url.href);
    void fetch(url.href, { credentials: "same-origin", priority: "low" } as RequestInit).catch(() => {});
  };
  document.addEventListener("pointerover", prefetch, { passive: true });
  document.addEventListener("focusin", prefetch, { passive: true });

  history.replaceState({ ...(history.state || {}), soft: true, y: window.scrollY }, "", location.href);

  addEventListener("pagehide", () => {
    history.replaceState({ ...(history.state || {}), y: window.scrollY }, "", location.href);
  });
}

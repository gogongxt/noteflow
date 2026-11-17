// Article-body enhancements: code copy, table scrolling wrappers, breadcrumb
// flyout flipping, heading permalink buttons, and smooth in-page anchors.
import { glideToAnchor } from "./anchor.js";
import { revealAnchor } from "./tabs.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const svgIcon = (d: string, extra: Record<string, string> = {}): SVGSVGElement => {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("aria-hidden", "true");
  for (const [k, v] of Object.entries(extra)) s.setAttribute(k, v);
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", d);
  s.appendChild(p);
  return s;
};

const ICON_CHECK = "M5 12.5l4.5 4.5L19 7.5";
const ICON_LINK = "M10 13.5a4 4 0 0 0 5.7 0l2.4-2.4a4 4 0 0 0-5.7-5.7l-1.2 1.2 M14 10.5a4 4 0 0 0-5.7 0l-2.4 2.4a4 4 0 0 0 5.7 5.7l1.2-1.2";

type CopyButton = HTMLButtonElement & { _t?: ReturnType<typeof setTimeout> };

function copyText(text: string, btn: CopyButton): void {
  const done = (): void => {
    btn.dataset.copied = "true";
    const label = btn.querySelector(".code-copy-label");
    if (label) label.textContent = "Copied";
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.dataset.copied = "false";
      if (label) label.textContent = "Copy";
    }, 1600);
  };

  const fallback = (): void => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.setAttribute("aria-hidden", "true");
    ta.tabIndex = -1;
    ta.className = "clipboard-fallback";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
    } finally {
      ta.remove();
    }
  };

  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}

// Build ships div.sourceCode > .code-wrap > (.code-head + pre); only the click is wired here,
// delegated once so it survives <main> swaps.
export function initCodeCopy(): void {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest?.(".code-copy");
    if (!(btn instanceof HTMLButtonElement)) return;
    const pre = btn.closest(".code-wrap")?.querySelector("pre");
    if (!pre) return;
    const code = (pre.querySelector("code") || pre) as HTMLElement;
    copyText(code.innerText.replace(/\n$/, ""), btn as CopyButton);
  });
}

export function setupTables(): void {
  const scope = document.getElementById("main");
  if (!scope) return;
  for (const table of scope.querySelectorAll<HTMLTableElement>("table")) {
    if (table.closest(".table-wrap, figure, .callout, .pager, .child-list")) continue;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", table.caption?.textContent?.trim() || "Table");
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

export function initCrumbFlyouts(): void {
  // CSS keeps the flyout usable; flipping only avoids clipping at the edge.
  const flip = (sub: HTMLElement): void => {
    sub.classList.remove("flip");
    if (sub.getBoundingClientRect().right > window.innerWidth - 8) sub.classList.add("flip");
  };
  const onEnter = (e: Event): void => {
    const li = e.currentTarget as HTMLElement;
    const sub = li.querySelector<HTMLElement>(":scope > .crumb-sub");
    if (sub) flip(sub);
  };
  for (const li of document.querySelectorAll<HTMLElement>(".crumb-menu .has-sub")) {
    li.addEventListener("mouseenter", onEnter);
    li.addEventListener("focusin", onEnter);
  }
}

export function setupHeadingLinks(): void {
  const body = document.querySelector<HTMLElement>(".post-body");
  if (!body) return;

  for (const h of body.querySelectorAll<HTMLElement>("h2, h3, h4")) {
    if (h.closest(".callout, .demo, .sourceCode, figure, .toc")) continue;
    if (h.querySelector(":scope > .heading-anchor")) continue;
    const section = h.closest<HTMLElement>("section[id]");
    const id = h.id || section?.id;
    if (!id) continue;

    const btn = document.createElement("button") as CopyButton;
    btn.type = "button";
    btn.className = "heading-anchor";
    btn.title = "Copy link to this section";
    btn.setAttribute("aria-label", "Copy link to this section");
    btn.dataset.copied = "false";

    const iconLink = svgIcon(ICON_LINK);
    const iconCheck = svgIcon(ICON_CHECK);
    iconCheck.classList.add("icon-done");
    btn.append(iconLink, iconCheck);

    btn.addEventListener("click", () => {
      const url = new URL(location.href);
      url.hash = encodeURIComponent(id);
      copyText(url.href, btn);
      try {
        history.replaceState(null, "", url.hash);
      } catch {
      }
    });
    h.append(btn);
  }
}

export function initAnchors(): void {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as Element).closest?.('a[href^="#"]');
    if (!a || a.hasAttribute("aria-hidden")) return;
    const id = decodeURIComponent(a.getAttribute("href")!.slice(1));
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    revealAnchor(id);
    glideToAnchor(id);
    try {
      history.pushState(null, "", "#" + encodeURIComponent(id));
    } catch {
      location.hash = id;
    }
  });
}

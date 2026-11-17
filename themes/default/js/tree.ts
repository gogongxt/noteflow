// Sidebar tree: open-state persistence, toggle animation, and the name filter.
import { writeStore } from "./store.js";

export function initTree(): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  let stored: Record<string, boolean> = {};
  try {
    stored = JSON.parse(localStorage.getItem("tree-open") || "{}") || {};
  } catch {
    stored = {};
  }
  const save = (): void => writeStore(localStorage, "tree-open", JSON.stringify(stored));
  const keyOf = (details: HTMLDetailsElement): string => details.dataset.href || "";

  const animate = (details: HTMLDetailsElement): void => {
    details.classList.add("tree-anim");
    setTimeout(() => details.classList.remove("tree-anim"), 200);
  };

  for (const details of sidebar.querySelectorAll<HTMLDetailsElement>("details")) {
    const key = keyOf(details);
    if (key && key in stored && !details.open) details.open = stored[key] === true;

    // Persist only explicit toggles (not programmatic open changes from the
    // filter or the router).
    const persist = (): void => {
      if (key) {
        stored[key] = details.open;
        save();
      }
    };

    const tw = details.querySelector<HTMLElement>(":scope > summary > .tw");
    tw?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      animate(details);
      details.open = !details.open;
      persist();
    });

    const label = details.querySelector<HTMLElement>(":scope > summary > .tree-link");
    label?.addEventListener("click", (e) => {
      if (details.open) return;
      e.preventDefault();
      animate(details);
      details.open = true;
      persist();
      tw?.focus({ preventScroll: true });
    });

    details.addEventListener("toggle", () => {
      tw?.setAttribute("aria-expanded", String(details.open));
    });
    tw?.setAttribute("aria-expanded", String(details.open));
  }

  (function filter(): void {
    const input = sidebar.querySelector<HTMLInputElement>("#tree-filter");
    const clearBtn = sidebar.querySelector<HTMLElement>(".tf-clear");
    const countEl = sidebar.querySelector<HTMLElement>(".tf-count");
    if (!input || !clearBtn || !countEl) return;

    const labelOf = (li: Element): Element | null =>
      li.querySelector(
        ":scope > details > summary > .tree-link, :scope > details > summary > .tree-label, :scope > .tree-link"
      );

    const allItems = sidebar.querySelectorAll("li.tree-item");
    const allLinks = sidebar.querySelectorAll("a.tree-link");
    const allDetails = sidebar.querySelectorAll<HTMLDetailsElement>("details");
    const tree = sidebar.querySelector("ul.tree");
    const originals = new Map<Element, string>();
    // Open states captured at filter start; restore verbatim when cleared.
    let snapshot: boolean[] | null = null;

    const restoreLabels = (): void => {
      for (const [el, text] of originals) if (el.isConnected) el.textContent = text;
      originals.clear();
    };

    const highlight = (label: Element, q: string): void => {
      const text = label.textContent ?? "";
      const hay = text.toLowerCase();
      if (!hay.includes(q)) return;
      originals.set(label, text);
      const frag = document.createDocumentFragment();
      let i = 0;
      for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, i)) {
        frag.append(text.slice(i, at));
        const mark = document.createElement("mark");
        mark.className = "tf-mark";
        mark.textContent = text.slice(at, at + q.length);
        frag.append(mark);
        i = at + q.length;
      }
      frag.append(text.slice(i));
      label.replaceChildren(frag);
    };

    // `force` = an ancestor matched, so every descendant stays visible.
    let visibleNotes = 0;
    const walk = (li: Element, q: string, force: boolean): boolean => {
      const label = labelOf(li);
      const own = force || ((label?.textContent ?? "").trim().toLowerCase().includes(q));
      const details = li.querySelector<HTMLDetailsElement>(":scope > details");
      let any = own;
      if (details) {
        const ul = details.querySelector(":scope > ul");
        for (const child of ul?.children ?? []) any = walk(child, q, own) || any;
        if (any) details.open = true;
      }
      li.toggleAttribute("hidden", !any);
      if (any) {
        if (label instanceof HTMLAnchorElement) visibleNotes++;
        if (label) highlight(label, q);
      }
      return any;
    };

    const clearFilter = (): void => {
      if (snapshot) {
        allDetails.forEach((d, i) => {
          d.open = snapshot![i] || !!d.querySelector("[aria-current='page']");
        });
        snapshot = null;
      }
      for (const li of allItems) li.removeAttribute("hidden");
      restoreLabels();
      clearBtn.hidden = true;
      countEl.textContent = String(allLinks.length);
    };

    const applyFilter = (): void => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        clearFilter();
        return;
      }
      if (!snapshot) snapshot = Array.from(allDetails, (d) => d.open);
      restoreLabels();
      visibleNotes = 0;
      for (const child of tree?.children ?? []) walk(child, q, false);
      clearBtn.hidden = false;
      countEl.textContent = `${visibleNotes} / ${allLinks.length}`;
    };

    countEl.textContent = String(allLinks.length);

    let composing = false;
    input.addEventListener("compositionstart", () => {
      composing = true;
    });
    input.addEventListener("compositionend", () => {
      composing = false;
      applyFilter();
    });
    input.addEventListener("input", () => {
      if (!composing) applyFilter();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        applyFilter();
      }
    });
    clearBtn.addEventListener("click", () => {
      input.value = "";
      applyFilter();
      input.focus({ preventScroll: true });
    });
  })();
}

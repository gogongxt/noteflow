// Sidebar tree: click-to-open-and-navigate, per-level open persistence, the
// name filter, and the expand/collapse-all control.
import { writeStore } from "./store.js";

const KEY = "tree-open";

function readOpen(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function initTree(): void {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const detailsOf = (): HTMLDetailsElement[] => [...sidebar.querySelectorAll<HTMLDetailsElement>("details[data-key]")];
  const keyOf = (d: HTMLDetailsElement): string => d.dataset.key || "";
  const save = (open: Record<string, boolean>): void => writeStore(localStorage, KEY, JSON.stringify(open));

  const animate = (d: HTMLDetailsElement): void => {
    d.classList.add("tree-anim");
    setTimeout(() => d.classList.remove("tree-anim"), 200);
  };

  const open = (d: HTMLDetailsElement): void => {
    if (d.open) return;
    animate(d);
    d.open = true;
    const k = keyOf(d);
    if (k) save({ ...readOpen(), [k]: true });
  };

  const toggle = (d: HTMLDetailsElement): void => {
    animate(d);
    d.open = !d.open;
    const k = keyOf(d);
    if (k) save({ ...readOpen(), [k]: d.open });
  };

  // The title is a link *and* the group's opener; the caret only expands.
  sidebar.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (!target) return;
    const d = target.closest<HTMLDetailsElement>("details[data-key]");
    if (!d) return;
    if (target.closest(".tw")) {
      e.preventDefault();
      toggle(d);
      return;
    }
    if (!target.closest("summary > .tree-link") || e.button !== 0) return;
    if (!d.open) open(d);
  });

  sidebar.addEventListener("toggle", (e) => {
    const d = e.target as HTMLDetailsElement;
    d.querySelector<HTMLElement>(":scope > summary > .tw")?.setAttribute("aria-expanded", String(d.open));
  }, true);
  for (const d of detailsOf()) {
    d.querySelector<HTMLElement>(":scope > summary > .tw")?.setAttribute("aria-expanded", String(d.open));
  }

  const allBtn = sidebar.querySelector<HTMLElement>("[data-tree-all]");
  const groups = (): string[] => {
    try {
      const v = JSON.parse(sidebar.dataset.treeGroups || "[]");
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const syncAll = (): void => {
    if (!allBtn) return;
    const open = readOpen();
    const keys = groups();
    const every = keys.length > 0 && keys.every((k) => open[k]);
    allBtn.setAttribute("aria-expanded", String(every));
    allBtn.setAttribute("aria-label", every ? "Collapse all" : "Expand all");
    allBtn.title = allBtn.getAttribute("aria-label") || "";
    allBtn.classList.toggle("is-open", every);
  };
  allBtn?.addEventListener("click", () => {
    const keys = groups();
    const every = allBtn.getAttribute("aria-expanded") === "true";
    const next: Record<string, boolean> = {};
    for (const k of keys) next[k] = !every;
    save(next);
    for (const d of detailsOf()) d.open = next[keyOf(d)] === true;
    syncAll();
  });
  syncAll();

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
        detailsOf().forEach((d, i) => {
          d.open = snapshot![i];
        });
        snapshot = null;
      }
      for (const li of allItems) li.removeAttribute("hidden");
      restoreLabels();
      clearBtn.hidden = true;
      countEl.textContent = String(allLinks.length);
      syncAll();
    };

    const applyFilter = (): void => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        clearFilter();
        return;
      }
      if (!snapshot) snapshot = detailsOf().map((d) => d.open);
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
const SVG_NS = "http://www.w3.org/2000/svg";
const ID_PREFIX = "mv-";
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 12;
const DIAGRAM_PAD = 22;
// Zoom lays the media out at the target size and only uses a transform during
// the gesture: Chromium caches a composited layer's raster at a capped scale,
// so a pure CSS scale leaves text blurry. Input idle for this long commits the
// transform into layout, which re-rasterizes the text as vectors.
const COMMIT_DELAY = 140;
// A laid-out layer above this many pixels on either side costs too much
// memory; past it the zoom stays a transform (bitmap scaling).
const MAX_LAYOUT_PX = 8192;

const ICON = {
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  zoomIn: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.4-4.4M11 8.2v5.6M8.2 11h5.6",
  zoomOut: "M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.4-4.4M8.2 11h5.6",
  fit: "M4.5 9V5.5a1 1 0 0 1 1-1H9M19.5 9V5.5a1 1 0 0 0-1-1H15M4.5 15v3.5a1 1 0 0 0 1 1H9M19.5 15v3.5a1 1 0 0 1-1 1H15",
  rotate: "M20.5 14.5a8.5 8.5 0 1 1-2-8.4M20.5 4v7h-7",
  copy: "M9.5 9.5h9v9h-9z M5.5 15V5.5h9",
  download: "M12 4.5v10M8.2 10.8l3.8 3.8 3.8-3.8M5 19h14",
  prev: "M14.5 6.5L9 12l5.5 5.5",
  next: "M9.5 6.5L15 12l-5.5 5.5",
} as const;

interface Item {
  kind: "diagram" | "image";
  label: string;
  width: number;
  height: number;
  origin: Element;
  media: SVGSVGElement | HTMLImageElement;
  thumb: Element;
  source?: string;
  href?: string;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const p = document.createElementNS(SVG_NS, "path");
  p.setAttribute("d", path);
  svg.appendChild(p);
  return svg;
}

function renameIds(svg: SVGSVGElement): void {
  const nodes: Element[] = [svg, ...svg.querySelectorAll("[id]")];
  for (const el of nodes) if (el.id) el.id = ID_PREFIX + el.id;
  for (const el of nodes) {
    for (const attr of [...el.attributes]) {
      if (attr.value.includes("url(#")) attr.value = attr.value.replace(/url\(#/g, `url(#${ID_PREFIX}`);
    }
  }
}

function hostOf(origin: Element): HTMLElement {
  const host = origin instanceof SVGSVGElement ? origin.closest(".diagram-frame") ?? origin : origin;
  return host as HTMLElement;
}

function diagramSize(svg: SVGSVGElement): { width: number; height: number } {
  const vb = svg.viewBox.baseVal;
  if (vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  const r = svg.getBoundingClientRect();
  return { width: r.width || 640, height: r.height || 400 };
}

function collectItems(): Item[] {
  const body = document.querySelector(".post-body");
  if (!body) return [];

  const items: Item[] = [];
  const seen = new Set<Element>();

  for (const svg of body.querySelectorAll<SVGSVGElement>("svg[data-mmd]")) {
    if (seen.has(svg)) continue;
    seen.add(svg);
    const { width, height } = diagramSize(svg);
    const caption = svg.closest(".diagram")?.querySelector(".diagram-caption")?.textContent?.trim();
    const thumb = svg.cloneNode(true) as SVGSVGElement;
    renameIds(thumb);
    items.push({
      kind: "diagram",
      label: caption || "Diagram",
      width,
      height,
      origin: svg,
      media: svg,
      thumb,
      source: svg.outerHTML,
    });
  }

  for (const img of body.querySelectorAll<HTMLImageElement>("img")) {
    if (seen.has(img)) continue;
    if (img.hasAttribute("data-inline")) continue;
    if (img.closest(".diagram, .callout, .sourceCode, .mv")) continue;
    seen.add(img);
    const attr = (name: string): number => Number(img.getAttribute(name)) || 0;
    const box = img.getBoundingClientRect();
    const thumb = new Image();
    thumb.src = img.currentSrc || img.src;
    thumb.alt = "";
    thumb.decoding = "async";
    items.push({
      kind: "image",
      label: img.alt?.trim() || "Image",
      width: img.naturalWidth || attr("width") || Math.round(box.width) || 1200,
      height: img.naturalHeight || attr("height") || Math.round(box.height) || 800,
      origin: img,
      media: img,
      thumb,
      href: img.currentSrc || img.src,
    });
  }

  return items;
}

export function initMediaViewer(): () => void {
  const items = collectItems();
  if (!items.length) return () => {};

  let index = 0;
  let isOpen = false;
  let scale = 1;
  let layoutScale = 1;
  let fitScale = 1;
  /** Quarter turns clockwise; 90/270 swap the media's displayed width and height. */
  let rotation = 0;
  let panX = 0;
  let panY = 0;
  let baseW = 0;
  let baseH = 0;
  let card: HTMLElement | null = null;
  let canvas: SVGSVGElement | HTMLImageElement | null = null;
  let commitTimer = 0;
  let lastFocus: HTMLElement | null = null;

  const overlay = document.createElement("div");
  overlay.className = "mv";
  overlay.hidden = true;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Media viewer");

  const stage = document.createElement("div");
  stage.className = "mv-stage";
  stage.tabIndex = -1;

  const rail = document.createElement("div");
  rail.className = "mv-rail";
  rail.setAttribute("role", "tablist");
  rail.setAttribute("aria-label", "Media on this page");

  const toolbar = document.createElement("div");
  toolbar.className = "mv-bar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Zoom and actions");

  const counter = document.createElement("span");
  counter.className = "mv-count";

  const tabs = document.createElement("div");
  tabs.className = "mv-tabs";
  rail.append(counter, tabs);

  const makeButton = (cls: string, label: string, path: string): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.appendChild(icon(path));
    return b;
  };

  const closeBtn = makeButton("mv-btn mv-close", "Close (Esc)", ICON.close);
  const zoomOutBtn = makeButton("mv-btn", "Zoom out (-)", ICON.zoomOut);
  const zoomInBtn = makeButton("mv-btn", "Zoom in (+)", ICON.zoomIn);
  const fitBtn = makeButton("mv-btn", "Fit to window (0)", ICON.fit);
  const copyBtn = makeButton("mv-btn", "Copy selection (or diagram source)", ICON.copy);
  const downloadBtn = makeButton("mv-btn", "Download", ICON.download);
  const rotateBtn = makeButton("mv-btn", "Rotate 90° (R)", ICON.rotate);
  const prevBtn = makeButton("mv-btn mv-prev", "Previous (←)", ICON.prev);
  const nextBtn = makeButton("mv-btn mv-next", "Next (→)", ICON.next);

  toolbar.append(zoomOutBtn, zoomInBtn, fitBtn, rotateBtn, copyBtn, downloadBtn);
  stage.append(toolbar, prevBtn, nextBtn);
  overlay.append(stage, rail, closeBtn);
  document.body.appendChild(overlay);

  const item = (): Item => items[index];
  const padOf = (it: Item): number => (it.kind === "diagram" ? DIAGRAM_PAD : 0);
  const upright = (): boolean => rotation % 180 === 0;
  /** The media's displayed footprint: a quarter turn transposes it. */
  const boxW = (it: Item): number => (upright() ? it.width : it.height);
  const boxH = (it: Item): number => (upright() ? it.height : it.width);

  const isTextTarget = (target: EventTarget | null): boolean => {
    const el = target instanceof Element ? target : null;
    if (!el || !el.closest(".mv-card")) return false;
    return !!el.closest("foreignObject, text");
  };

  const selectedText = (): string => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el || !overlay.contains(el)) return "";
    return sel.toString().trim();
  };

  // While a gesture is in flight the card stays at its laid-out size and a
  // transform on the card does the scaling, which the compositor handles without
  // layout or raster work. commit() then moves the same scale into layout, so
  // the text is rasterized at its final size; both states put the card's
  // top-left at (panX, panY), so the swap does not move anything on screen.
  const place = (): void => {
    if (!card || !canvas) return;
    const it = item();
    const pad = padOf(it);
    const settled = Math.abs(scale - layoutScale) < 0.002;
    // The card's box is the media's *displayed* footprint: a quarter turn
    // transposes it, so the fit rect and the card border both hug the rotated
    // picture. The canvas itself rotates about its center inside that box.
    const w = `${boxW(it) * layoutScale + pad * 2}px`;
    const h = `${boxH(it) * layoutScale + pad * 2}px`;
    const style = card.style;
    if (style.width !== w) style.width = w;
    if (style.height !== h) style.height = h;
    const t = settled
      ? `translate3d(${panX}px, ${panY}px, 0)`
      : `translate3d(${panX}px, ${panY}px, 0) scale(${scale / layoutScale})`;
    if (style.transform !== t) style.transform = t;
    // Center the upright canvas in its (possibly transposed) box.
    const left = `${pad + ((boxW(it) - it.width) * layoutScale) / 2}px`;
    const top = `${pad + ((boxH(it) - it.height) * layoutScale) / 2}px`;
    if (canvas.style.left !== left) canvas.style.left = left;
    if (canvas.style.top !== top) canvas.style.top = top;
    const rot = rotation ? `rotate(${rotation}deg)` : "";
    if (canvas.style.transform !== rot) canvas.style.transform = rot;
  };

  const sizeCanvas = (at: number): void => {
    if (!canvas) return;
    layoutScale = at;
    canvas.style.width = `${baseW * at}px`;
    canvas.style.height = `${baseH * at}px`;
  };

  const commit = (): void => {
    commitTimer = 0;
    if (!isOpen || !canvas || !card) return;
    const w = baseW * scale;
    const h = baseH * scale;
    if (w <= MAX_LAYOUT_PX && h <= MAX_LAYOUT_PX && Math.abs(scale - layoutScale) > 0.002) {
      sizeCanvas(scale);
    }
    place();
  };

  const scheduleCommit = (): void => {
    if (commitTimer) window.clearTimeout(commitTimer);
    commitTimer = window.setTimeout(commit, COMMIT_DELAY);
  };

  const cancelCommit = (): void => {
    if (commitTimer) window.clearTimeout(commitTimer);
    commitTimer = 0;
  };

  const fit = (): void => {
    cancelCommit();
    const it = item();
    const pad = padOf(it);
    const inset = window.innerWidth < 768 ? 20 : 56;
    const availW = Math.max(40, stage.clientWidth - inset * 2);
    const availH = Math.max(40, stage.clientHeight - inset * 2);
    fitScale = Math.min(
      availW / (boxW(it) + pad * 2),
      availH / (boxH(it) + pad * 2),
      it.kind === "image" ? 1 : 1.5,
    );
    scale = fitScale;
    panX = (stage.clientWidth - (boxW(it) * scale + pad * 2)) / 2;
    panY = (stage.clientHeight - (boxH(it) * scale + pad * 2)) / 2;
    sizeCanvas(scale);
    place();
  };

  const zoomAt = (factor: number, cx: number, cy: number): void => {
    const next = clamp(scale * factor, ZOOM_MIN, ZOOM_MAX);
    const k = next / scale;
    panX = cx - (cx - panX) * k;
    panY = cy - (cy - panY) * k;
    scale = next;
    place();
    scheduleCommit();
  };

  const zoomCenter = (factor: number): void => {
    zoomAt(factor, stage.clientWidth / 2, stage.clientHeight / 2);
  };

  /** A quarter turn, then refit: the rotated picture gets its own fit scale. */
  const rotate = (): void => {
    rotation = (rotation + 90) % 360;
    fit();
  };

  const renderStage = (): void => {
    cancelCommit();
    card?.remove();
    card = null;
    canvas = null;
    const it = item();

    const node = it.media.cloneNode(true) as SVGSVGElement | HTMLImageElement;
    node.classList.add("mv-canvas");
    node.dataset.kind = it.kind;
    rotation = 0;
    if (node instanceof SVGSVGElement) {
      renameIds(node);
    } else {
      node.removeAttribute("loading");
      node.removeAttribute("width");
      node.removeAttribute("height");
      node.draggable = false;
    }

    const box = document.createElement("div");
    box.className = "mv-card";
    box.dataset.kind = it.kind;
    box.appendChild(node);
    stage.appendChild(box);
    card = box;
    canvas = node;

    baseW = it.width;
    baseH = it.height;
    fit();

    if (node instanceof HTMLImageElement) {
      const sync = (): void => {
        if (!node.naturalWidth || it !== item()) return;
        it.width = node.naturalWidth;
        it.height = node.naturalHeight;
        baseW = it.width;
        baseH = it.height;
        fit();
      };
      if (node.complete) sync();
      else node.addEventListener("load", sync, { once: true });
    }

    copyBtn.hidden = it.kind !== "diagram";
    downloadBtn.hidden = !it.href;
    counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : "";
    box.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 150,
      easing: "cubic-bezier(0.32, 0.72, 0, 1)",
    });

    for (const [i, tab] of [...rail.querySelectorAll<HTMLElement>(".mv-tab")].entries()) {
      tab.setAttribute("aria-selected", i === index ? "true" : "false");
      tab.tabIndex = i === index ? 0 : -1;
      if (i === index) tab.scrollIntoView({ block: "nearest", inline: "center" });
    }
  };

  const goTo = (next: number): void => {
    if (items.length < 2) return;
    index = (next + items.length) % items.length;
    renderStage();
  };

  const open = (start: number, from: HTMLElement): void => {
    index = start;
    lastFocus = from;
    isOpen = true;
    document.body.classList.add("mv-open");
    overlay.hidden = false;
    renderStage();
    requestAnimationFrame(() => {
      fit();
      closeBtn.focus({ preventScroll: true });
    });
  };

  const close = (): void => {
    if (!isOpen) return;
    isOpen = false;
    cancelCommit();
    overlay.hidden = true;
    document.body.classList.remove("mv-open");
    card?.remove();
    card = null;
    canvas = null;
    lastFocus?.focus?.({ preventScroll: true });
    lastFocus = null;
  };

  items.forEach((it, i) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mv-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-label", it.label);
    tab.title = it.label;
    tab.dataset.kind = it.kind;
    tab.appendChild(it.thumb);
    tab.addEventListener("click", () => {
      if (i !== index) goTo(i);
    });
    tab.addEventListener("dblclick", () => {
      // Focus the host so close() restores focus at the media's place.
      const target = hostOf(it.origin);
      lastFocus = target;
      close();
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    tabs.appendChild(tab);
  });
  if (items.length < 2) {
    rail.hidden = true;
    prevBtn.hidden = true;
    nextBtn.hidden = true;
    overlay.dataset.single = "";
  }

  closeBtn.addEventListener("click", close);
  prevBtn.addEventListener("click", () => goTo(index - 1));
  nextBtn.addEventListener("click", () => goTo(index + 1));
  zoomOutBtn.addEventListener("click", () => zoomCenter(1 / 1.4));
  zoomInBtn.addEventListener("click", () => zoomCenter(1.4));
  fitBtn.addEventListener("click", fit);
  rotateBtn.addEventListener("click", rotate);
  copyBtn.addEventListener("click", () => {
    const text = selectedText() || item().source;
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => {
        copyBtn.dataset.done = "yes";
        window.setTimeout(() => delete copyBtn.dataset.done, 1400);
      },
      () => {},
    );
  });
  downloadBtn.addEventListener("click", () => {
    const it = item();
    const a = document.createElement("a");
    a.download = it.label.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "media";
    if (it.href) {
      a.href = it.href;
    } else if (it.source) {
      a.href = URL.createObjectURL(new Blob([it.source], { type: "image/svg+xml" }));
      a.download += ".svg";
      window.setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }
    a.click();
  });

  const onResize = (): void => {
    if (isOpen) fit();
  };
  window.addEventListener("resize", onResize);

  const pointers = new Map<number, { x: number; y: number }>();
  let panFrom: { x: number; y: number; panX: number; panY: number } | null = null;
  let pinchFrom: { distance: number; scale: number } | null = null;
  let moved = false;
  let backdropDown: { x: number; y: number } | null = null;

  const stageCenter = (e: PointerEvent): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  stage.addEventListener("pointerdown", (e) => {
    if (!isOpen) return;
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as Element;
    if (target.closest("button")) return;
    // A new gesture owns the scale; the pending commit would land mid-drag.
    cancelCommit();

    // Mouse drags over label text select it; touch always pans (the stage's
    // touch-action:none would block native touch selection anyway), and the
    // middle button pans over text too.
    if (e.button === 0 && e.pointerType !== "touch" && isTextTarget(target)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    backdropDown =
      e.button === 0 && !target.closest(".mv-card") ? { x: e.clientX, y: e.clientY } : null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchFrom = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
      panFrom = null;
      return;
    }
    if (pointers.size > 2) return;
    panFrom = { x: e.clientX, y: e.clientY, panX, panY };
    moved = false;
    stage.setPointerCapture(e.pointerId);
    stage.dataset.dragging = "yes";
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinchFrom && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const p = stageCenter(e);
      const target = clamp((pinchFrom.scale * distance) / pinchFrom.distance, ZOOM_MIN, ZOOM_MAX);
      const k = target / scale;
      panX = p.x - (p.x - panX) * k;
      panY = p.y - (p.y - panY) * k;
      scale = target;
      moved = true;
      place();
      scheduleCommit();
      return;
    }
    if (!panFrom) return;
    const dx = e.clientX - panFrom.x;
    const dy = e.clientY - panFrom.y;
    if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
    if (!moved) return;
    panX = panFrom.panX + dx;
    panY = panFrom.panY + dy;
    place();
  });

  const endPointer = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    try {
      stage.releasePointerCapture(e.pointerId);
    } catch {
    }

    if (pointers.size === 1) {
      const [only] = [...pointers.values()];
      panFrom = { x: only.x, y: only.y, panX, panY };
      pinchFrom = null;
      return;
    }
    if (pointers.size > 0) return;

    delete stage.dataset.dragging;
    if (e.pointerType === "touch" && moved && scale <= fitScale * 1.02) {
      const dx = e.clientX - (panFrom?.x ?? e.clientX);
      const dy = e.clientY - (panFrom?.y ?? e.clientY);
      if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4 && Math.abs(dx) < 160) {
        goTo(index + (dx < 0 ? 1 : -1));
      }
    } else if (backdropDown && !moved) {
      close();
    }
    panFrom = null;
    pinchFrom = null;
    backdropDown = null;
    moved = false;
    // A release ends the gesture: rasterize now instead of waiting out the idle timer.
    if (Math.abs(scale - layoutScale) > 0.002) commit();
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", (e) => {
    backdropDown = null;
    endPointer(e);
  });
  // The middle button pans; its mousedown default is autoscroll.
  stage.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  stage.addEventListener(
    "wheel",
    (e) => {
      if (!isOpen) return;
      e.preventDefault();
      const p = stageCenter(e as unknown as PointerEvent);
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), p.x, p.y);
    },
    { passive: false },
  );

  stage.addEventListener("dblclick", (e) => {
    const target = e.target as Element;
    if (target.closest("button") || isTextTarget(target)) return;
    if (scale > fitScale * 1.02) fit();
    else zoomCenter(2);
  });

  const onKeydown = (e: KeyboardEvent): void => {
    if (!isOpen) return;
    // Ctrl+R, Alt+← and friends are browser shortcuts, not viewer input.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "ArrowLeft":
        e.preventDefault();
        goTo(index - 1);
        return;
      case "ArrowRight":
        e.preventDefault();
        goTo(index + 1);
        return;
      case "0":
        e.preventDefault();
        fit();
        return;
      case "r":
      case "R":
        e.preventDefault();
        rotate();
        return;
      case "+":
      case "=":
        e.preventDefault();
        zoomCenter(1.4);
        return;
      case "-":
        e.preventDefault();
        zoomCenter(1 / 1.4);
        return;
      case "Tab": {
        const focusable = [...overlay.querySelectorAll<HTMLElement>("button:not([hidden])")];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      default:
        return;
    }
  };
  document.addEventListener("keydown", onKeydown);

  const originIndex = new Map<Element, number>();
  items.forEach((it, i) => originIndex.set(it.origin, i));

  for (const [origin, at] of originIndex) {
    const host = hostOf(origin);
    host.dataset.zoomable = "";
    host.tabIndex = 0;
    host.setAttribute("role", "button");
    host.setAttribute("aria-label", items[at].kind === "diagram" ? "Zoom in on diagram" : "Zoom in on image");

    host.addEventListener("click", () => {
      // A finished text selection lands here as a click; copying must not open.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString()) return;
      open(at, host);
    });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(at, host);
      }
    });
  }

  // Soft navigation disposes the overlay and listeners before re-hydrating.
  return (): void => {
    if (isOpen) close();
    cancelCommit();
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
    window.removeEventListener("resize", onResize);
  };
}

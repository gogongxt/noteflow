// In-page anchors own their motion: the native smooth scroll stretches with
// distance (~1.5s on a long post), so the glide is JS-eased and capped, and
// the landing flash starts once the page has settled, not when the link fires.

const INSTANT = "instant" as ScrollBehavior;
const GLIDE_MAX_MS = 1000;
const GLIDE_MIN_MS = 240;
const GLIDE_PER_PX = 0.25;
const FLASH_MS = 1800;

const mqReduced = window.matchMedia("(prefers-reduced-motion: reduce)");

export interface AnchorOpts {
  /** Space kept below the fixed header, on top of the header's own height. */
  gap?: number;
}

const headerH = (): number => document.querySelector<HTMLElement>(".site-header")?.offsetHeight ?? 52;

function topOf(target: Element, opts: AnchorOpts): number {
  const y = target.getBoundingClientRect().top - headerH() - (opts.gap ?? 24);
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return Math.max(0, Math.min(max, y + window.scrollY));
}

/** Land on `target` without motion. Cancels a glide in flight: a programmatic
 *  jump (e.g. popstate restore) must win, or the glide's frames keep scrolling
 *  toward the previous document's target and the page ends up somewhere else. */
export function jumpTo(target: Element, opts: AnchorOpts = {}): void {
  cancelGlide?.();
  window.scrollTo({ top: topOf(target, opts), behavior: INSTANT });
}

const INTERRUPTS: (keyof WindowEventMap)[] = ["wheel", "touchstart", "pointerdown", "keydown"];

let cancelGlide: (() => void) | null = null;

/** Glide to `target` over at most GLIDE_MAX_MS. Resolves true when it landed
 *  and false when reader input took over mid-flight. */
export function glideTo(target: Element, opts: AnchorOpts = {}): Promise<boolean> {
  cancelGlide?.();
  const from = window.scrollY;
  const to = topOf(target, opts);
  if (mqReduced.matches || from === to) {
    window.scrollTo({ top: to, behavior: INSTANT });
    return Promise.resolve(true);
  }
  const ms = Math.min(GLIDE_MAX_MS, GLIDE_MIN_MS + Math.abs(to - from) * GLIDE_PER_PX);
  return new Promise((resolve) => {
    const start = performance.now();
    let raf = 0;
    let done = false;
    const finish = (landed: boolean): void => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      for (const type of INTERRUPTS) window.removeEventListener(type, stop);
      cancelGlide = null;
      resolve(landed);
    };
    function stop(): void {
      finish(false);
    }
    const frame = (now: number): void => {
      const t = Math.min(1, (now - start) / ms);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      window.scrollTo({ top: from + (to - from) * eased, behavior: INSTANT });
      if (t < 1) raf = requestAnimationFrame(frame);
      else finish(true);
    };
    for (const type of INTERRUPTS) window.addEventListener(type, stop, { passive: true });
    cancelGlide = stop;
    raf = requestAnimationFrame(frame);
  });
}

/** Glide to an in-page anchor and tint it once the page has landed. */
export function glideToAnchor(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  void glideTo(target).then((landed) => {
    if (landed) flashTarget(id);
  });
}

let flashEl: HTMLElement | null = null;
let flashTimer = 0;

/** Briefly tint the target of an in-page link. Class-driven because pushState
 *  never moves :target; a section anchor would light a whole subtree. */
export function flashTarget(id: string): void {
  const node = document.getElementById(id);
  if (!node) return;
  // An equation owns its id; a heading's id lives on its wrapping <section>,
  // so only the section itself resolves to the heading inside it. Anything
  // else (a footnote <li>, an inline .footnote-ref) owns the id itself.
  const el =
    node.closest<HTMLElement>(".equation") ??
    (node.matches("section[id]") ? node.querySelector<HTMLElement>(":scope > :is(h1, h2, h3, h4, h5, h6)") : null) ??
    node.closest<HTMLElement>(":is(h1, h2, h3, h4, h5, h6)") ??
    node;
  if (!el) return;
  if (flashEl) {
    clearTimeout(flashTimer);
    flashEl.classList.remove("anchor-flash");
  }
  void el.offsetWidth; // restart the animation when the same target is clicked twice
  el.classList.add("anchor-flash");
  flashEl = el;
  flashTimer = window.setTimeout(() => {
    el.classList.remove("anchor-flash");
    flashEl = null;
  }, FLASH_MS);
}
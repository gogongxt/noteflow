// Scroll-reveal for `.w-reveal`. The pre-land state hides only under
// `html[data-js]` (set pre-paint), so without scripting — or in print —
// everything is simply visible; this adds the entrance only.
// One observer is reused across soft navigations and re-takes every mount,
// so detached pages do not pile up as retained targets.

const io: IntersectionObserver | null = "IntersectionObserver" in window
  ? new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add("is-in");
          io!.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px" },
    )
  : null;

export function initReveal(): void {
  const els = document.querySelectorAll<HTMLElement>(".w-reveal:not(.is-in)");
  io?.disconnect();
  if (!els.length) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !io) {
    for (const el of els) el.classList.add("is-in");
    return;
  }
  for (const el of els) io.observe(el);
}
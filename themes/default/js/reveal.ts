// Scroll-reveal for `.w-reveal`. The observer is re-pointed at every hydrate
// (soft navigation) so the pages left behind are not retained.

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
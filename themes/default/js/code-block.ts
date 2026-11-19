// Long code blocks. The build ships them folded — the clamp, the fade and the
// toggle are markup added by src/render/code-blocks.ts — so this module only
// flips the state; the theme CSS owns what folded and expanded look like.
//
// theme-init.ts sets `data-js` pre-paint, so the clamp applies from the first
// frame (a 500-line block never flashes open) and does not apply at all when
// scripting is off, in which case every block renders in full.

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)");

function setExpanded(block: HTMLElement, expanded: boolean): void {
  block.classList.toggle("is-expanded", expanded);
  block.querySelector(".code-fold-btn")?.setAttribute("aria-expanded", String(expanded));
}

/** Reveal `node`'s code block if the clamp hides it. A line anchor or a
 *  footnote that lands inside a folded block is scrolled to nowhere — the
 *  browser cannot scroll to a clipped line. */
export function revealCodeFold(node: Element): void {
  const block = node.closest<HTMLElement>(".code-fold");
  if (block && !block.classList.contains("is-expanded")) setExpanded(block, true);
}

/** One delegated listener: it survives <main> swaps without re-binding. */
export function initCodeFold(): void {
  document.addEventListener("click", (e) => {
    const btn = (e.target as Element | null)?.closest?.(".code-fold-btn");
    if (!(btn instanceof HTMLButtonElement)) return;
    const block = btn.closest<HTMLElement>(".code-fold");
    if (!block) return;

    if (!block.classList.contains("is-expanded")) {
      // Expanding only grows content below the toggle, so the reader's place
      // holds and the revealed lines start right under the button.
      setExpanded(block, true);
      return;
    }

    // Collapsing removes every line below the clamp, so wherever the reader
    // was inside the block, they now sit past its foot. Land on the folded
    // block's head — the same inset a heading anchor lands at — unless that
    // head is already comfortably in view.
    const head = document.querySelector(".site-header")?.clientHeight ?? 52;
    setExpanded(block, false);
    const top = block.getBoundingClientRect().top;
    if (top < head) {
      window.scrollBy({ top: top - head - 24, behavior: REDUCED.matches ? "instant" : "smooth" });
    }
  });
}

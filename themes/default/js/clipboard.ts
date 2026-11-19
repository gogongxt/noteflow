// One clipboard path for every copy affordance: the async Clipboard API where
// it exists (secure contexts), a hidden textarea otherwise. A button carrying
// data-copied="true" themes itself for the confirmation window.

type CopyTarget = HTMLElement & { _copyTimer?: number };

const DONE_MS = 1600;

function fallbackCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.tabIndex = -1;
  ta.className = "clipboard-fallback";
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}

/** Copy `text`, then flash the target as done. Returns whether it landed. */
export function copyText(text: string, el: CopyTarget): Promise<boolean> {
  const done = (ok: boolean): boolean => {
    if (!ok) return false;
    el.dataset.copied = "true";
    const label = el.querySelector<HTMLElement>(".code-copy-label");
    if (label) label.textContent = "Copied";
    clearTimeout(el._copyTimer);
    el._copyTimer = window.setTimeout(() => {
      delete el.dataset.copied;
      if (label) label.textContent = "Copy";
    }, DONE_MS);
    return true;
  };

  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(
      () => done(true),
      () => done(fallbackCopy(text)),
    );
  }
  return Promise.resolve(done(fallbackCopy(text)));
}

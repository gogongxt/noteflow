// Lazy loaders for the media viewer and comments: both wait for reader intent
// (with an idle fallback); soft navigation disposes the previous instance.
import { glideTo } from "./anchor.js";

const mediaTriggers = ["pointerdown", "keydown", "focusin", "pointerover"];
let disposeMedia: (() => void) | null = null;
let mediaStarted = false;

function startMedia(): void {
  if (!document.querySelector(".post-body svg[data-mmd], .post-body img:not([data-inline])")) return;
  disposeMedia?.();
  disposeMedia = null;
  void import("./media.js").then((m) => {
    const dispose = m.initMediaViewer();
    disposeMedia = typeof dispose === "function" ? dispose : null;
  });
}

export function armMedia(): void {
  if (mediaStarted) {
    startMedia();
    return;
  }
  const start = (): void => {
    if (mediaStarted) return;
    mediaStarted = true;
    for (const type of mediaTriggers) document.removeEventListener(type, start, true);
    startMedia();
  };
  for (const type of mediaTriggers) document.addEventListener(type, start, true);
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number })
    .requestIdleCallback;
  if (idle) idle(() => start(), { timeout: 1200 });
  else setTimeout(start, 300);
}

// The iframe is created on demand, never server-rendered.
let disposeComments: (() => void) | null = null;
let commentsStarted = false;

function startComments(): void {
  const mount = document.querySelector<HTMLElement>("[data-giscus]");
  if (!mount) {
    disposeComments?.();
    disposeComments = null;
    return;
  }
  disposeComments?.();
  disposeComments = null;
  void import("./comments.js").then((m) => {
    disposeComments = m.initComments()?.dispose ?? null;
  });
}

export function armComments(): void {
  if (!document.querySelector("[data-giscus]")) {
    disposeComments?.();
    disposeComments = null;
    return;
  }
  if (commentsStarted) {
    startComments();
    return;
  }
  commentsStarted = true;
  // Wait for intent, with an idle fallback.
  const start = (): void => {
    for (const type of mediaTriggers) document.removeEventListener(type, start, true);
    startComments();
  };
  for (const type of mediaTriggers) document.addEventListener(type, start, true);
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number })
    .requestIdleCallback;
  if (idle) idle(() => start(), { timeout: 1600 });
  else setTimeout(start, 600);
}

// Jump-to-comments: scroll there and make sure the module is loading.
function setupCommentJumps(): void {
  const handler = (e: Event): void => {
    if (!(e.target as Element).closest?.("[data-scroll-comments]")) return;
    const target = document.getElementById("comments");
    if (!target) return;
    e.preventDefault();
    armComments();
    startComments();
    void glideTo(target, { gap: 16 });
    try {
      history.replaceState(history.state, "", "#comments");
    } catch {}
  };
  document.addEventListener("click", handler);

}
setupCommentJumps();

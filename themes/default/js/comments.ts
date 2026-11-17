// Hand-rolled giscus embed: the official client injects giscus.app scripts and
// styles, which `script-src/style-src 'self'` forbids (and we do not relax).
// What remains is the iframe, whose height arrives over postMessage. This file
// reproduces the parts of client.ts that matter: the ?giscus=<session> OAuth
// handoff (without it sign-in silently fails in the parent), signOut reload,
// resize, and theme sync. The term comes from the build's data-term, never
// location.pathname, so the discussion key survives URL-shape changes.

const GISCUS_ORIGIN = "https://giscus.app";
const SESSION_KEY = "giscus-session";

/** Mirrors the CSS .giscus defaults; avoids shipping giscus.app/default.css. */
const FRAME_CSS = "width:100%;border:0;display:block;min-height:180px;color-scheme:light dark";

interface Mount {
  root: HTMLElement;
  frame: HTMLIFrameElement;
  params: Map<string, string>;
  origin: string;
  langPath: string;
}

interface SessionStore {
  read(): string | null;
  write(session: string): void;
  clear(): void;
}

function store(): SessionStore {
  const read = (): string | null => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  };
  return {
    read,
    write: (s) => {
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      } catch {}
    },
    clear: () => {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {}
    },
  };
}

/** Recover the session GitHub handed back as `?giscus=<session>`; mirror client.ts. */
function adoptSession(): string {
  const sessions = store();
  const url = new URL(location.href);
  const incoming = url.searchParams.get("giscus");
  if (incoming) {
    sessions.write(incoming);
    url.searchParams.delete("giscus");
    try {
      history.replaceState(history.state, document.title, url.toString());
    } catch {}
    return incoming;
  }
  const saved = sessions.read();
  if (!saved) return "";
  try {
    return JSON.parse(saved) as string;
  } catch {
    sessions.clear();
    return "";
  }
}

function currentTheme(): string {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function readConfig(root: HTMLElement): Mount | null {
  const repo = root.dataset.repo;
  const repoId = root.dataset.repoId;
  if (!repo || !repoId) return null;

  // giscus echoes `origin` back as its frame-ancestors: use the build-time
  // canonical (stable key) but only when actually served from that host.
  const canonical = root.dataset.canonical || "";
  let origin = location.origin + location.pathname;
  if (canonical) {
    try {
      if (new URL(canonical).host === location.host) origin = canonical;
    } catch {}
  }
  const params = new Map<string, string>([
    ["origin", origin],
    ["theme", currentTheme()],
    ["reactionsEnabled", root.dataset.reactions === "0" ? "0" : "1"],
    ["emitMetadata", "0"],
    ["inputPosition", root.dataset.inputPosition === "top" ? "top" : "bottom"],
    ["repo", repo],
    ["repoId", repoId],
    ["category", root.dataset.category || ""],
    ["categoryId", root.dataset.categoryId || ""],
    ["strict", "1"],
    ["description", document.querySelector('meta[name="description"]')?.getAttribute("content") || ""],
    ["backLink", origin],

  ]);
  params.set("term", root.dataset.term || "");
  const lang = root.dataset.lang || "zh-CN";
  const langPath = lang ? `/${encodeURIComponent(lang)}` : "";

  const frame = document.createElement("iframe");
  frame.className = "giscus-frame giscus-frame--loading";
  frame.title = "Comments";
  frame.scrolling = "no";
  frame.allow = "clipboard-write";
  frame.setAttribute("loading", "lazy");
  // Set through CSSOM (not a style attribute) so the CSP stays free of inline styles.
  frame.style.cssText = FRAME_CSS;
  frame.addEventListener("load", () => {
    frame.style.removeProperty("opacity");
    frame.classList.remove("giscus-frame--loading");
  });
  return { root, frame, params, origin, langPath };
}

function frameSrc(mount: Mount, session: string): string {
  const p = new Map(mount.params);
  p.set("session", session);
  const query = new URLSearchParams();
  for (const [k, v] of p) if (v) query.set(k, v);
  return `${GISCUS_ORIGIN}${mount.langPath}/widget?${query.toString()}`;
}

function setTheme(mount: Mount, theme: string): void {
  mount.frame.contentWindow?.postMessage({ giscus: { setConfig: { theme } } }, GISCUS_ORIGIN);
}

export interface CommentsHandle {
  dispose(): void;
}

export function initComments(): CommentsHandle | null {
  const root = document.querySelector<HTMLElement>("[data-giscus]");
  if (!root || root.dataset.giscusMounted === "1") return null;
  const mount = readConfig(root);
  if (!mount) return null;
  root.dataset.giscusMounted = "1";

  const sessions = store();
  let session = adoptSession();

  const load = (): void => {
    mount.frame.src = frameSrc(mount, session);
  };
  load();
  root.replaceChildren(mount.frame);

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== GISCUS_ORIGIN) return;
    const data = event.data as { giscus?: Record<string, unknown> } | null;
    if (!data || typeof data !== "object" || !data.giscus) return;
    const msg = data.giscus;

    if (typeof msg.resizeHeight === "number" && msg.resizeHeight > 0) {
      mount.frame.style.height = `${Math.round(msg.resizeHeight)}px`;
    }

    if (msg.signOut) {
      sessions.clear();
      session = "";
      load();
      return;
    }

    const error = typeof msg.error === "string" ? msg.error : "";
    if (!error) return;
    // Drop stale/rotated sessions; everything else is logged, as client.ts does.
    if (/Bad credentials|Invalid state value|State has expired/.test(error) && sessions.read() !== null) {
      sessions.clear();
      session = "";
      load();
    }
  };
  window.addEventListener("message", onMessage);


  const themeObserver = new MutationObserver(() => setTheme(mount, currentTheme()));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  return {
    dispose(): void {
      window.removeEventListener("message", onMessage);
      themeObserver.disconnect();
      delete root.dataset.giscusMounted;
    },
  };
}
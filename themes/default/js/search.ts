export interface SearchDoc {
  u: string;
  t: string;
  f: string;
  h: string;
  p: string[];
  g: string[];
  d: string;
  k: "note" | "index";
  x: string;
}

interface SearchIndex {
  v: number;
  docs: SearchDoc[];
}

interface Prepared {
  doc: SearchDoc;
  idx: number;
  page: string;
  lt: string;
  lf: string;
  lh: string;
  lg: string;
  lp: string;
  lx: string;
  ct: string;
  ch: string;
  cx: string;
}

interface Hit {
  start: number;
  end: number;
}

interface SearchGlobal {
  __NOTEFLOW_SEARCH__?: { open: () => void };
}

const PAGE_LIMIT = 80;
const SECTION_LIMIT = 8;
const MAX_TEXT = 5000;
const SNIPPET_WIDTH = 132;

let prepared: Prepared[] | null = null;
let loading: Promise<void> | null = null;
let loadFailed = false;

let dialog: HTMLDialogElement | null = null;
let input: HTMLInputElement | null = null;
let listBox: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let footerNote: HTMLElement | null = null;
let footerEl: HTMLElement | null = null;
let rows: HTMLElement[] = [];
let active = -1;
let lastFocus: HTMLElement | null = null;
let composingNow = false;

const lower = (s: string): string => s.normalize("NFKC").toLowerCase();
const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim();
// "单用户 root 模式" (spaces around Latin) must match a query typed without them
const compact = (s: string): string => s.replace(/\s+/g, "");

export function prepare(doc: SearchDoc, idx: number): Prepared {
  const x = normalizeText(doc.x).slice(0, MAX_TEXT);
  const lt = lower(doc.t);
  const lh = lower(doc.h);
  const lx = lower(x);
  return {
    doc: { ...doc, x },
    idx,
    page: doc.u.split("#")[0] || doc.u,
    lt,
    lf: lower(doc.f || ""),
    lh,
    lg: lower(doc.g.join(" ")),
    lp: lower(doc.p.join(" ")),
    lx,
    ct: compact(lt),
    ch: compact(lh),
    cx: compact(lx),
  };
}

const HISTORY_KEY = "search-history";
const HISTORY_LIMIT = 8;

function readHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((q) => typeof q === "string" && q.trim()) : [];
  } catch {
    return [];
  }
}

function writeHistory(list: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
  } catch {
    /* private mode etc. — history is best-effort */
  }
}

function recordHistory(query: string): void {
  const q = normalizeText(query);
  if (!q) return;
  writeHistory([q, ...readHistory().filter((h) => h !== q)].slice(0, HISTORY_LIMIT));
}

function indexUrl(): string {
  const el = document.querySelector<HTMLElement>("[data-search-index]");
  return el?.dataset.searchIndex || "";
}

function ensureLoaded(): Promise<void> {
  if (prepared) return Promise.resolve();
  if (loading) return loading;
  const url = indexUrl();
  if (!url) {
    loadFailed = true;
    return Promise.resolve();
  }
  loading = fetch(url, { credentials: "same-origin" })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<SearchIndex>;
    })
    .then((index) => {
      const docs = Array.isArray(index?.docs) ? index.docs : [];
      prepared = docs.map((doc, i) => prepare(doc, i));
      loadFailed = false;
    })
    .catch(() => {
      loadFailed = true;
      prepared = null;
      loading = null;
      throw new Error("index load failed");
    });
  return loading.catch(() => undefined);
}

// Ranking is tiered, not additive: title > section heading/filename > tag >
// body. The score only orders pages within a tier, and a doc's tier is only as
// good as its weakest token's best field.
const TIER_TITLE = 0;
const TIER_NAME = 1;
const TIER_TAG = 2;
const TIER_BODY = 3;

interface DocMatch {
  tier: number;
  score: number;
  /** Matched on this doc's own fields (heading/body), not just page metadata. */
  own: boolean;
}

export interface PageHit {
  tier: number;
  score: number;
  /** Index of the page's first matching doc; keeps ties in content order. */
  order: number;
  pageDoc: Prepared;
  sections: { prep: Prepared; score: number }[];
}

/** 0 = exact, 1 = contains, 2 = contains once whitespace is stripped, 3 = no match. */
function grade(v: string, cv: string, tok: string): number {
  if (v === tok) return 0;
  if (v.includes(tok)) return 1;
  if (cv.includes(tok)) return 2;
  return 3;
}

function matchDoc(doc: Prepared, tokens: string[]): DocMatch | null {
  let score = 0;
  let tier = TIER_TITLE;
  let own = false;
  for (const tok of tokens) {
    let s = 0;
    let tokTier = TIER_BODY;
    const gt = grade(doc.lt, doc.ct, tok);
    if (gt < 3) {
      s += gt === 0 ? 26 : 11;
      tokTier = TIER_TITLE;
    }
    const gh = grade(doc.lh, doc.ch, tok);
    if (gh < 3) {
      s += gh === 0 ? 34 : 16;
      tokTier = Math.min(tokTier, TIER_NAME);
      own = true;
    }
    const gf = grade(doc.lf, "", tok);
    if (gf < 3) {
      s += gf === 0 ? 20 : 9;
      tokTier = Math.min(tokTier, TIER_NAME);
    }
    if (doc.lg.includes(tok)) {
      s += 8;
      tokTier = Math.min(tokTier, TIER_TAG);
    }
    if (doc.lp.includes(tok)) s += 5;
    const at = doc.lx.indexOf(tok);
    if (at >= 0) {
      let hits = 0;
      let pos = at;
      while (pos >= 0 && hits < 4) {
        hits++;
        pos = doc.lx.indexOf(tok, pos + tok.length);
      }
      s += 3 + (hits - 1) + (at < 60 ? 3 : at < 180 ? 1 : 0);
      own = true;
    } else if (doc.cx.includes(tok)) {
      s += 3;
      own = true;
    }
    if (!s) return null;
    score += s;
    tier = Math.max(tier, tokTier);
  }
  if (tokens.length > 1) {
    const phrase = tokens.join(" ");
    if (doc.lh.includes(phrase)) score += 12;
    if (doc.lt.includes(phrase)) score += 8;
  }
  return { tier, score, own };
}

// The map is fixed once the index loads; built once per `prepared` array.
const pageDocMaps = new WeakMap<Prepared[], Map<string, Prepared>>();

function pageDocMap(docs: Prepared[]): Map<string, Prepared> {
  let m = pageDocMaps.get(docs);
  if (!m) {
    m = new Map();
    for (const p of docs) if (!p.doc.h) m.set(p.page, p);
    pageDocMaps.set(docs, m);
  }
  return m;
}

export function rankPages(docs: Prepared[], tokens: string[], tagMode: boolean): PageHit[] {
  const pageDocs = pageDocMap(docs);
  const pages = new Map<string, PageHit>();
  for (const prep of docs) {
    let m: DocMatch;
    if (tagMode) {
      if (!prep.doc.g.some((g) => lower(g) === tokens[0])) continue;
      m = { tier: TIER_TAG, score: 0, own: false };
    } else {
      const r = matchDoc(prep, tokens);
      if (!r) continue;
      m = r;
    }
    let ph = pages.get(prep.page);
    if (!ph) {
      ph = {
        tier: m.tier,
        score: m.score,
        order: prep.idx,
        pageDoc: pageDocs.get(prep.page) ?? prep,
        sections: [],
      };
      pages.set(prep.page, ph);
    } else {
      ph.tier = Math.min(ph.tier, m.tier);
      ph.score = Math.max(ph.score, m.score);
    }
    // Section rows need the section's own heading/body match; a title or tag
    // hit belongs to the page, not to every section under it.
    if (prep.doc.h && m.own) ph.sections.push({ prep, score: m.score });
  }
  for (const ph of pages.values()) {
    ph.sections.sort((a, b) => b.score - a.score || a.prep.idx - b.prep.idx);
  }
  return [...pages.values()].sort(
    (a, b) => a.tier - b.tier || b.score - a.score || a.order - b.order
  );
}

function findHits(text: string, tokens: string[]): Hit[] {
  const hay = lower(text);
  if (hay.length !== text.length) return [];
  const hits: Hit[] = [];
  for (const tok of tokens) {
    if (!tok) continue;
    let found = false;
    let at = hay.indexOf(tok);
    while (at >= 0) {
      found = true;
      hits.push({ start: at, end: at + tok.length });
      if (hits.length > 48) break;
      at = hay.indexOf(tok, at + tok.length);
    }
    if (!found) hits.push(...compactHits(hay, tok));
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Hit[] = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h.start <= prev.end) prev.end = Math.max(prev.end, h.end);
    else merged.push({ ...h });
  }
  return merged;
}

/** Occurrences of tok ignoring whitespace; ranges span the skipped whitespace. */
function compactHits(text: string, tok: string): Hit[] {
  const hits: Hit[] = [];
  let ti = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    if (ch === tok[ti]) {
      if (ti === 0) start = i;
      ti++;
      if (ti === tok.length) {
        hits.push({ start, end: i + 1 });
        if (hits.length > 48) break;
        ti = 0;
        start = -1;
      }
    } else {
      ti = 0;
      if (ch === tok[0]) {
        start = i;
        ti = 1;
      }
    }
  }
  return hits;
}

function appendHighlighted(parent: HTMLElement | DocumentFragment, text: string, hits: Hit[]): void {
  let cursor = 0;
  for (const hit of hits) {
    const start = Math.max(cursor, Math.min(hit.start, text.length));
    const end = Math.max(start, Math.min(hit.end, text.length));
    if (start > cursor) parent.append(text.slice(cursor, start));
    if (end > start) {
      const mark = document.createElement("mark");
      mark.className = "sr-hit";
      mark.textContent = text.slice(start, end);
      parent.append(mark);
    }
    cursor = end;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

function snippet(text: string, tokens: string[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const clean = normalizeText(text);
  if (!clean) return frag;
  const hay = lower(clean);
  let at = -1;
  if (hay.length === clean.length) {
    for (const tok of tokens) {
      const i = hay.indexOf(tok);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
  }
  if (at < 0) {
    for (const tok of tokens) {
      const h = compactHits(hay, tok)[0];
      if (h && (at < 0 || h.start < at)) at = h.start;
    }
  }
  if (at < 0) {
    frag.append(clean.length > SNIPPET_WIDTH ? clean.slice(0, SNIPPET_WIDTH) + "…" : clean);
    return frag;
  }
  const start = Math.max(0, Math.min(at - 28, clean.length - SNIPPET_WIDTH, at));
  const end = Math.min(clean.length, start + SNIPPET_WIDTH);
  const piece = clean.slice(start, end);
  const lead = start > 0 ? "…" : "";
  const tail = end < clean.length ? "…" : "";
  const local = findHits(piece, tokens).map((h) => ({ start: h.start + lead.length, end: h.end + lead.length }));
  appendHighlighted(frag, lead + piece + tail, local);
  return frag;
}

function topTags(docs: Prepared[], limit: number): [string, number][] {
  const counts = new Map<string, number>();
  for (const d of docs) {
    if (!d.doc.h) for (const tag of d.doc.g) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function pathOf(doc: SearchDoc): string {
  return doc.p.filter(Boolean).join(" / ");
}

function setFooter(note: string, status: string): void {
  if (footerNote) footerNote.textContent = note;
  if (statusEl) statusEl.textContent = status;
  if (footerEl) footerEl.hidden = !note && !status;
}

function setActive(next: number): void {
  if (!rows.length) {
    active = -1;
    input?.removeAttribute("aria-activedescendant");
    return;
  }
  const clamped = Math.max(0, Math.min(rows.length - 1, next));
  if (active >= 0 && rows[active]) {
    rows[active].classList.remove("is-active");
    rows[active].setAttribute("aria-selected", "false");
  }
  active = clamped;
  const el = rows[active];
  el.classList.add("is-active");
  el.setAttribute("aria-selected", "true");
  input?.setAttribute("aria-activedescendant", el.id);
  el.scrollIntoView({ block: "nearest" });
}

function moveActive(delta: number): void {
  if (!rows.length) return;
  const base = active < 0 ? (delta > 0 ? -1 : 0) : active;
  setActive(base + delta);
}

function resultRow(prep: Prepared, tokens: string[], isPageRow: boolean): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = "sr-row";
  a.href = prep.doc.u;
  a.id = `sr-opt-${rows.length}`;
  a.setAttribute("role", "option");
  a.setAttribute("aria-selected", "false");
  // Group headers are presentation-only in the listbox; each option names itself.
  a.setAttribute("aria-label", prep.doc.h ? `${prep.doc.t} — ${prep.doc.h}` : prep.doc.t);

  const main = document.createElement("span");
  main.className = "sr-row-main";
  // The group header already shows the title, so the page row carries only the
  // lead snippet; the title stands in for a page with no lead text at all.
  const headText = isPageRow ? (prep.doc.x ? "" : prep.doc.t) : prep.doc.h;
  if (headText) {
    const head = document.createElement("span");
    head.className = "sr-row-head";
    appendHighlighted(head, headText, findHits(headText, tokens));
    main.append(head);
  }
  const snip = document.createElement("span");
  snip.className = "sr-row-snip";
  snip.append(snippet(prep.doc.x, tokens));
  main.append(snip);
  a.append(main);

  const go = document.createElement("span");
  go.className = "sr-row-go";
  go.setAttribute("aria-hidden", "true");
  go.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  a.append(go);

  a.addEventListener("pointermove", () => {
    const i = rows.indexOf(a);
    if (i >= 0 && i !== active) setActive(i);
  });
  rows.push(a);
  return a;
}

function groupHeader(prep: Prepared, tokens: string[]): HTMLElement {
  const head = document.createElement("div");
  head.className = "sr-group";
  head.setAttribute("role", "presentation");

  const icon = document.createElement("span");
  icon.className = "sr-group-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/></svg>';

  const text = document.createElement("span");
  text.className = "sr-group-text";

  const title = document.createElement("a");
  title.className = "sr-group-title";
  title.href = prep.page;
  appendHighlighted(title, prep.doc.t, findHits(prep.doc.t, tokens));
  text.append(title);

  const path = pathOf(prep.doc);
  const tags = prep.doc.g
    .filter((g) => !path.split(" / ").includes(g))
    .map((g) => "#" + g)
    .join(" ");
  const meta = [path, prep.doc.d, tags].filter(Boolean).join(" · ");
  if (meta) {
    const m = document.createElement("span");
    m.className = "sr-group-meta";
    m.textContent = meta;
    text.append(m);
  }

  head.append(icon, text);
  return head;
}

function messageBox(title: string, note: string, retry: boolean): HTMLElement {
  const box = document.createElement("div");
  box.className = "sr-empty";
  const h = document.createElement("p");
  h.className = "sr-empty-title";
  h.textContent = title;
  box.append(h);
  if (note) {
    const p = document.createElement("p");
    p.className = "sr-empty-note";
    p.textContent = note;
    box.append(p);
  }
  if (retry) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn";
    btn.textContent = "Retry";
    btn.addEventListener("click", () => {
      loading = null;
      runSearch(input?.value || "");
    });
    box.append(btn);
  }
  return box;
}

function resetResults(): void {
  listBox?.replaceChildren();
  rows = [];
  active = -1;
  input?.removeAttribute("aria-activedescendant");
  listBox?.setAttribute("aria-busy", "false");
}

function renderEmpty(): void {
  if (!listBox) return;
  resetResults();
  const history = readHistory();
  const tags = topTags(prepared || [], 14);
  if (!history.length && !tags.length) {
    renderMessage("Search notes", "Type keywords to search notes; prefix # to search tags only.", false);
    return;
  }

  const box = document.createElement("div");
  box.className = "sr-empty";

  if (history.length) {
    const ul = document.createElement("ul");
    ul.className = "sr-hist";
    ul.setAttribute("role", "presentation");
    for (const q of history) {
      const li = document.createElement("li");
      li.className = "sr-hist-item";
      li.setAttribute("role", "presentation");

      const run = document.createElement("button");
      run.type = "button";
      run.className = "sr-hist-run";
      run.id = `sr-opt-${rows.length}`;
      run.setAttribute("role", "option");
      run.setAttribute("aria-selected", "false");
      run.title = q;
      run.textContent = q;
      li.addEventListener("pointermove", () => {
        const i = rows.indexOf(run);
        if (i >= 0 && i !== active) setActive(i);
      });
      run.addEventListener("click", () => {
        if (!input) return;
        input.value = q;
        runSearch(q);
      });
      rows.push(run);

      const x = document.createElement("button");
      x.type = "button";
      x.className = "sr-hist-x";
      x.setAttribute("aria-label", `Remove “${q}” from history`);
      x.textContent = "×";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        writeHistory(readHistory().filter((h) => h !== q));
        renderEmpty();
        input?.focus({ preventScroll: true });
      });

      li.append(run, x);
      ul.append(li);
    }
    box.append(ul);
  }

  if (tags.length) {
    const tagHead = document.createElement("p");
    tagHead.className = "sr-empty-title sr-tag-head";
    tagHead.textContent = "Browse by tag";
    const cloud = document.createElement("div");
    cloud.className = "sr-tags";
    for (const [tag, count] of tags) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sr-tag";
      btn.textContent = tag;
      const n = document.createElement("span");
      n.className = "sr-tag-count";
      n.textContent = String(count);
      btn.append(n);
      btn.addEventListener("click", () => {
        if (!input) return;
        input.value = "#" + tag;
        input.focus({ preventScroll: true });
        runSearch(input.value);
      });
      cloud.append(btn);
    }
    box.append(tagHead, cloud);
  }
  listBox.append(box);
  setFooter("", "");
}

function renderMessage(title: string, note: string, retry: boolean): void {
  if (!listBox) return;
  resetResults();
  listBox.append(messageBox(title, note, retry));
  setFooter("", "");
}

function runSearch(raw: string): void {
  if (!listBox) return;
  const query = normalizeText(raw);
  if (!prepared) {
    if (loadFailed) renderMessage("Failed to load search index", "Check your connection and try again.", true);
    else renderMessage("Loading index…", "", false);
    return;
  }
  if (!query) {
    renderEmpty();
    return;
  }

  const tagMatch = /^#(\S+)$/.exec(query);
  const tagMode = !!tagMatch;
  const tokens = tagMode ? [lower(tagMatch[1])] : lower(query).split(/\s+/).filter(Boolean);
  if (!tokens[0]) {
    renderEmpty();
    return;
  }

  const ranked = rankPages(prepared, tokens, tagMode);

  resetResults();

  if (!ranked.length) {
    renderMessage("No matching notes", `Nothing matches “${query}”. Try a different keyword.`, false);
    listBox.setAttribute("aria-label", "Search results: 0");
    setFooter("", "0 results");
    return;
  }

  let shown = 0;
  let pagesShown = 0;
  let truncated = false;
  for (const ph of ranked) {
    const budget = PAGE_LIMIT - shown;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const sections = ph.sections.slice(0, Math.min(SECTION_LIMIT, budget - 1));
    if (sections.length < ph.sections.length) truncated = true;
    // Skip the page row when it has no lead text and section rows exist; a
    // group always keeps at least one row as its keyboard option.
    const showPageRow = !!ph.pageDoc.doc.x || sections.length === 0;

    const group = document.createElement("div");
    group.className = "sr-result-group";
    group.setAttribute("role", "presentation");
    group.append(groupHeader(ph.pageDoc, tokens));
    const opts = document.createElement("div");
    opts.className = "sr-options";
    if (showPageRow) opts.append(resultRow(ph.pageDoc, tokens, true));
    for (const s of sections) opts.append(resultRow(s.prep, tokens, false));
    group.append(opts);
    listBox.append(group);
    shown += (showPageRow ? 1 : 0) + sections.length;
    pagesShown += 1;
  }

  listBox.setAttribute("aria-label", `Search results: ${ranked.length}`);
  setFooter(
    truncated ? `Showing first ${pagesShown} of ${ranked.length} notes only` : "",
    `${ranked.length} result${ranked.length === 1 ? "" : "s"}`
  );
  if (rows.length) setActive(0);
}

function svgIcon(paths: string[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "sr-bar-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const ICON_SEARCH = ["M10.8 4.6a6.2 6.2 0 1 0 0 12.4 6.2 6.2 0 0 0 0-12.4Z", "M15.4 15.4 19.4 19.4"];

function buildDialog(): HTMLDialogElement {
  const d = document.createElement("dialog");
  d.className = "search-dialog";
  d.setAttribute("aria-label", "Search notes");

  const bar = document.createElement("div");
  bar.className = "sr-bar";

  const field = document.createElement("input");
  field.type = "text";
  field.className = "sr-input";
  field.id = "sr-input";
  field.placeholder = "Search notes… (# for tags)";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("role", "combobox");
  field.setAttribute("aria-expanded", "true");
  field.setAttribute("aria-controls", "sr-results");
  field.setAttribute("aria-autocomplete", "list");
  field.setAttribute("aria-label", "Search keywords");

  const esc = document.createElement("button");
  esc.type = "button";
  esc.className = "sr-esc";
  esc.setAttribute("aria-label", "Close search");
  esc.textContent = "Esc";
  esc.addEventListener("click", () => dialog?.close());

  bar.append(svgIcon(ICON_SEARCH), field, esc);

  const results = document.createElement("div");
  results.className = "sr-results";
  results.id = "sr-results";
  results.setAttribute("role", "listbox");
  results.setAttribute("aria-label", "Search results");

  const foot = document.createElement("div");
  foot.className = "sr-foot";
  const note = document.createElement("span");
  note.className = "sr-foot-note";
  const status = document.createElement("span");
  status.className = "sr-status";
  status.setAttribute("aria-live", "polite");
  foot.append(note, status);
  foot.hidden = true;

  d.append(bar, results, foot);
  document.body.append(d);

  input = field;
  listBox = results;
  statusEl = status;
  footerNote = note;
  footerEl = foot;

  const composing = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;

  field.addEventListener("compositionstart", () => {
    composingNow = true;
  });
  field.addEventListener("compositionend", () => {
    composingNow = false;
    runSearch(field.value);
  });

  field.addEventListener("input", () => {
    if (!composingNow) runSearch(field.value);
  });

  field.addEventListener("keydown", (e) => {
    if (composing(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      d.close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "Enter") {
      const target = rows[Math.max(0, active)];
      if (target) {
        e.preventDefault();
        target.click();
      }
    }
  });

  // Esc cancels the IME candidate first; only a second Esc closes the dialog.
  d.addEventListener("cancel", (e) => {
    if (composingNow) e.preventDefault();
  });

  d.addEventListener("close", () => {
    document.documentElement.classList.remove("search-open");
    lastFocus?.focus?.({ preventScroll: true });
    lastFocus = null;
  });

  d.addEventListener("click", (e) => {
    if (e.target === d) d.close();
  });

  results.addEventListener("click", (e) => {
    if ((e.target as Element).closest("a")) {
      recordHistory(input?.value || "");
      d.close();
    }
  });

  return d;
}

function open(): void {
  if (!dialog) dialog = buildDialog();
  if (dialog.open) return;
  lastFocus = (document.activeElement as HTMLElement | null) ?? null;
  document.documentElement.classList.add("search-open");
  dialog.showModal();
  if (input) input.value = "";
  input?.focus({ preventScroll: true });
  if (prepared) runSearch("");
  else {
    renderMessage(loadFailed ? "Failed to load search index" : "Loading index…", "", loadFailed);
    void ensureLoaded().then(() => {
      if (dialog?.open) runSearch("");
    });
  }
}

export function initSearch(): void {
  const existing = (window as unknown as SearchGlobal).__NOTEFLOW_SEARCH__;
  if (existing) return;

  (window as unknown as SearchGlobal).__NOTEFLOW_SEARCH__ = { open };
}

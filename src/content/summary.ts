// The `summary` field is plain text, not Markdown: a blank line ends the block,
// `- ` / `1. ` lines start lists, an unmarked line continues the item above.
// The card and the search snippet share this parse.

type SummaryBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; start: number; items: string[] };

// Two digits max: `2026. 年我们发布了…` is prose, not item 2026 of a list.
const MARKER_RE = /^([-*•]|\d{1,2}[.)])\s+(.*)$/;

// Joined without a space when either side is CJK: notes wrap Chinese prose
// across lines, and a space there lands mid-sentence after a full stop.
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
function joinLines(a: string, b: string): string {
  return CJK.test(a.slice(-1)) || CJK.test(b.slice(0, 1)) ? a + b : `${a} ${b}`;
}

export function parseSummary(text: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  let para: string[] = [];
  let list: SummaryBlock | null = null;
  let afterBlank = false;

  const flush = (): void => {
    if (para.length) {
      blocks.push({ kind: 'p', text: para.reduce(joinLines) });
      para = [];
    }
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) {
      afterBlank = true;
      flush();
      continue;
    }

    const marker = MARKER_RE.exec(line);
    if (marker) {
      if (para.length) flush();
      const ordered = !/^[-*•]$/.test(marker[1]);
      const kind = ordered ? 'ol' : 'ul';
      if (!list || list.kind !== kind || afterBlank) {
        if (list) flush();
        list = { kind, start: ordered ? Number.parseInt(marker[1], 10) : 1, items: [] };
      }
      list.items.push(marker[2].trim());
      afterBlank = false;
      continue;
    }

    // No blank line since the list began: this line is that item's continuation.
    if (list) list.items[list.items.length - 1] = joinLines(list.items[list.items.length - 1], line);
    else para.push(line);
    afterBlank = false;
  }
  flush();
  return blocks;
}

/** One line for search: block structure flattened, list markers dropped. */
export function summaryPlainText(text: string): string {
  return parseSummary(text)
    .map((b) => (b.kind === 'p' ? b.text : b.items.join(' ')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
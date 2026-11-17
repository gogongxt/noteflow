// Writing abbrlink is the only operation that touches source bytes: insert one
// line before the closing delimiter, keep BOM/CRLF, change nothing else.
import matter from 'gray-matter';
import { BuildError } from '../core/util.ts';
import type { Frontmatter } from '../core/types.ts';

const BOM = '﻿';
const BOM_RE = /^﻿/;
const FIELD_RE = /(^|\n)abbrlink[ \t]*:/;
const CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/m;

interface FrontmatterSpan {
  start: number;
  end: number;
  closeLen: number;
  newline: string;
}

interface SplitSource {
  bom: string;
  body: string;
  yaml: string;
  content: string;
  fm: FrontmatterSpan | null;
}

function splitBom(text: string): { bom: string; body: string } {
  return BOM_RE.test(text) ? { bom: BOM, body: text.replace(BOM_RE, '') } : { bom: '', body: text };
}

function locateFrontmatter(body: string): FrontmatterSpan | null {
  const open = body.match(/^---[ \t]*(\r?\n|$)/);
  if (!open) return null;
  const start = open[0].length;
  const re = new RegExp(CLOSE_RE.source, 'gm');
  re.lastIndex = start;
  const m = re.exec(body);
  if (!m) return null;
  // A blank line right after the opener means the `---` lines are thematic
  // breaks, not frontmatter: only the leading blank line disqualifies.
  const yamlText = body.slice(start, m.index);
  if (/^[ \t]*\r?\n/.test(yamlText)) return null;
  return { start, end: m.index, closeLen: m[0].length, newline: body.includes('\r\n') ? '\r\n' : '\n' };
}

export function splitSource(raw: string): SplitSource {
  const { bom, body } = splitBom(raw);
  const fm = locateFrontmatter(body);
  if (!fm) return { bom, body, yaml: '', content: body, fm: null };
  const yaml = body.slice(fm.start, fm.end);
  const afterClose = fm.end + fm.closeLen;
  const content = body.slice(afterClose).replace(/^\r?\n/, '');
  return { bom, body, yaml, content, fm };
}

function parseYaml(yaml: string): Frontmatter {
  if (!yaml.trim()) return {};
  try {
    const d = matter(`---\n${yaml}\n---\n`).data as unknown;
    return (d && typeof d === 'object' ? d : {}) as Frontmatter;
  } catch (err) {
    throw new BuildError(`frontmatter parse failed: ${(err as Error).message}`);
  }
}

interface ParseNoteResult {
  data: Frontmatter | null;
  content: string;
  error: string | null;
}

export function parseNote(raw: string): ParseNoteResult {
  try {
    const { yaml, content } = splitSource(raw);
    return { data: parseYaml(yaml), content, error: null };
  } catch (err) {
    return { data: null, content: '', error: (err as Error).message };
  }
}

export function readAbbrlink(data: Frontmatter | null | undefined): string | null {
  const v = data?.abbrlink;
  if (v == null) return null;
  const s = String(v);
  return s === '' ? null : s;
}

/** label is for errors only — never pass a private title. */
export function injectAbbrlink(raw: string, abbrlink: string, label = ''): string {
  const { bom, body } = splitBom(raw);
  const fm = locateFrontmatter(body);
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const line = `abbrlink: "${abbrlink}"${nl}`;

  let inserted: string;
  if (!fm) {
    if (FIELD_RE.test(body)) {
      throw new BuildError(`${label}: top-level abbrlink key found in body, but there is no frontmatter block wrapped in ---`);
    }
    inserted = `---${nl}${line}---${nl}${body}`;
  } else {
    const yamlText = body.slice(fm.start, fm.end);
    // An existing EMPTY abbrlink (`abbrlink:` / `abbrlink: ""`) is not a
    // refusal case: replace the empty line instead of bricking the note.
    const emptyField = /(^|\n)(abbrlink[ \t]*:[ \t]*(""\r?\n|''\r?\n|\r?\n))/.exec(yamlText);
    if (emptyField) {
      inserted = body.slice(0, fm.start) + yamlText.replace(emptyField[0], emptyField[1] + line.trimEnd() + (emptyField[2].endsWith('\r\n') ? '\r\n' : '\n')) + body.slice(fm.end);
    } else if (FIELD_RE.test(yamlText)) {
      throw new BuildError(`${label}: frontmatter already has an abbrlink field; not overwriting (fill in the value manually)`);
    } else {
      inserted = body.slice(0, fm.end) + line + body.slice(fm.end);
    }
  }

  const reparsed = parseNote(inserted);
  if (reparsed.error) throw new BuildError(`${label}: cannot re-parse after write-back: ${reparsed.error}`);
  const got = readAbbrlink(reparsed.data);
  if (got !== abbrlink) throw new BuildError(`${label}: write-back verification failed (expected ${abbrlink}, read ${got})`);
  if (reparsed.content !== parseNote(raw).content) {
    throw new BuildError(`${label}: body changed after write-back; aborted (nothing written)`);
  }
  return bom + inserted;
}

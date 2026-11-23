// CSS a note writes is hashed into the CSP, but CSS can still fetch
// (`url()`/`image-set()`) or run code on legacy engines (`expression()`), and
// `@import` pulls a whole sheet. A scan of the raw text is not enough: the
// browser decodes escape sequences, so `\75 rl(…)` reads as `url(…)`.

const FETCH_OR_SCRIPT = /expression\s*\(|url\s*\(|image(?:-set)?\s*\(|@import/i;
// CSS Syntax §4.3.7: an escape is 1–6 hex digits + one optional whitespace, or
// a single escaped character.
const ESCAPE = /\\(?:([0-9a-f]{1,6}) ?|([\s\S]))/gi;

export function decodeEscapes(text: string): string {
  return text.replace(ESCAPE, (_m: string, hex?: string, ch?: string) => {
    if (hex) {
      const cp = Number.parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    }
    // A backslash-newline is a line continuation, not a character.
    return ch && !/[\n\r\f]/.test(ch) ? ch : '';
  });
}

export function cssValueUnsafe(value: string): boolean {
  return FETCH_OR_SCRIPT.test(decodeEscapes(value));
}
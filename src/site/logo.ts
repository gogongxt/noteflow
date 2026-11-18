import { esc } from '../core/util.ts';

/** The theme artwork's intrinsic ratio (see `scripts/icons.sh`). */
const ART_WIDTH = 144;
const ART_HEIGHT = 144;

// The noteflow mark, shared by the header brand and the footer's theme credit.
// The artwork is a detailed render, so it ships as one hashed PNG the browser
// caches forever rather than inline SVG repeated on every page.
export function logoMark(opts: { src: string; height?: number; className?: string }): string {
  const { src, height = 26, className = 'logo-mark' } = opts;
  const width = Math.round((height * ART_WIDTH) / ART_HEIGHT);
  return `<img class="${esc(className)}" src="${esc(src)}" width="${width}" height="${height}" alt="" decoding="async">`;
}
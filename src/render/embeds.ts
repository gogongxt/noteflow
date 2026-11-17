// External video embeds. A note writes an ordinary link to a YouTube or
// Bilibili watch page and marks it `.embed`; the build swaps it for the
// provider's privacy-friendly iframe. Only the origins in EMBED_ORIGINS get a
// frame (the CSP's frame-src lists exactly those), and the iframe is sandboxed
// so a hostile provider page cannot reach the parent.
import { append, element, getAttr, setAttr, type P5Any } from '../core/dom.ts';
import { markExternal } from './links.ts';

export interface Embed {
  provider: 'youtube' | 'bilibili';
  /** iframe src; always an EMBED_ORIGINS URL. */
  src: string;
  title: string;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const BILIBILI_HOSTS = new Set(['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']);

function parseYouTube(u: URL): string | null {
  const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') ?? u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1];
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const t = u.searchParams.get('t');
  const start = t && /^\d+$/.test(t) ? `&start=${t}` : '';
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0${start}`;
}

function parseBilibili(u: URL): string | null {
  const bvid = u.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})/)?.[1];
  if (bvid) {
    const page = u.searchParams.get('p');
    return `https://player.bilibili.com/player.html?bvid=${bvid}&high_quality=1&danmaku=0${page && /^\d+$/.test(page) ? `&p=${page}` : ''}`;
  }
  if (u.hostname === 'player.bilibili.com') return u.toString();
  return null;
}

/** Recognise an author link as an embeddable video, or null to leave it a link. */
export function parseEmbed(href: string): Embed | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host) || host === 'youtu.be') {
    const src = parseYouTube(u);
    return src ? { provider: 'youtube', src, title: 'YouTube video' } : null;
  }
  if (BILIBILI_HOSTS.has(host) || host === 'player.bilibili.com') {
    const src = parseBilibili(u);
    return src ? { provider: 'bilibili', src, title: 'Bilibili video' } : null;
  }
  return null;
}

/** Replace an `a.embed` link with the provider iframe (plus its fallback link). */
export function expandEmbed(node: P5Any, embed: Embed): P5Any {
  const wrap = element('div', 'embed');
  wrap.childNodes = [];
  setAttr(wrap, 'data-embed', embed.provider);

  const frame = element('iframe');
  setAttr(frame, 'src', embed.src);
  setAttr(frame, 'title', embed.title);
  setAttr(frame, 'loading', 'lazy');
  setAttr(frame, 'referrerpolicy', 'strict-origin-when-cross-origin');
  // autoplay is granted to the frame so the provider's player initialises; the
  // page itself still never autoplays, the reader clicks play.
  setAttr(frame, 'allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen; presentation');
  setAttr(frame, 'allowfullscreen', '');
  // No sandbox: Bilibili's player cannot initialise in a sandboxed frame (it
  // needs same-origin storage; allowing both same-origin and scripts is no
  // sandbox at all). Containment is CSP instead — frame-src names exactly the
  // provider origins, the audit rejects any other iframe, and Permissions-
  // Policy withholds camera/microphone/geolocation from the framed page.
  append(wrap, frame);

  const fallback = element('a', 'embed-fallback');
  setAttr(fallback, 'href', getAttr(node, 'href') ?? embed.src);
  fallback.childNodes = [];
  const label = `Watch on ${embed.provider === 'youtube' ? 'YouTube' : 'Bilibili'}`;
  fallback.childNodes.push({ nodeName: '#text', value: label, parentNode: fallback });
  markExternal(fallback);
  append(wrap, fallback);
  return wrap;
}
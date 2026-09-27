/**
 * routes/verse/browser/browser-address.ts — what the Browser pane's address
 * bar does with what the operator typed. Pure; no React.
 *
 *   5173, :5173                 → http://localhost:5173/
 *   localhost:3000/x, 127.0.0.1 → http://…         (loopback)
 *   app.localhost:3000          → http://…         (RFC 6761: always loopback)
 *   example.com/path            → https://example.com/path
 *   http(s)://…                 → as typed
 *   two words                   → a web search (DuckDuckGo)
 *   javascript:, file:, data:…  → invalid
 *   Verse's own address         → refused ("self"): the pane would be showing
 *                                 the console that drives it.
 *
 * `frameable` is the plain-browser fallback's rule: the Verse page's CSP
 * lets it frame `http://localhost:*` and `http://127.0.0.1:*` and nothing
 * else (core/web/server.ts), and most real sites forbid framing anyway
 * (X-Frame-Options), so everything else is offered as "Open externally".
 */
import { isLoopbackHost } from '../../../../core/verse/browser-types.js';
import { isLoopbackPreviewUrl } from '../../../../core/verse/workbench-types.js';

export type BrowserAddress =
  | { kind: 'url'; url: string; loopback: boolean; frameable: boolean }
  | { kind: 'self'; url: string }
  | { kind: 'invalid'; reason: string };

export const SEARCH_URL = 'https://duckduckgo.com/?q=';

function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/** True when `url` points at the Verse server this page came from. */
export function isVerseAddress(url: URL, verseOrigin: string): boolean {
  let verse: URL;
  try {
    verse = new URL(verseOrigin);
  } catch {
    return false;
  }
  if (!isLoopbackHost(verse.hostname) || !isLoopbackHost(url.hostname)) return url.origin === verse.origin;
  return portOf(url) === portOf(verse);
}

export function parseBrowserAddress(input: string, verseOrigin: string): BrowserAddress {
  const raw = input.trim();
  if (raw.length === 0) return { kind: 'invalid', reason: 'Type an address, like localhost:5173.' };
  if (raw.length > 2048) return { kind: 'invalid', reason: 'That address is too long.' };

  let candidate: string;
  if (/^:?\d{2,5}$/.test(raw)) {
    candidate = `http://localhost:${raw.replace(':', '')}/`;
  } else if (/^(?:localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)(?::\d{1,5})?(?:[/?#].*)?$/i.test(raw)) {
    candidate = `http://${raw}`;
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(?:javascript|data|file|about|blob|vbscript):/i.test(raw)) {
    candidate = raw;
  } else if (/\s/.test(raw) || !/^[\w-]+(?:\.[\w-]+)+(?::\d{1,5})?(?:[/?#]\S*)?$/.test(raw)) {
    // Words, not an address: search for them (a browser, not a URL validator).
    return { kind: 'url', url: `${SEARCH_URL}${encodeURIComponent(raw)}`, loopback: false, frameable: false };
  } else {
    candidate = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { kind: 'invalid', reason: 'That is not an address this browser can open.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'Only http and https pages open here.' };
  }
  if (url.username || url.password) return { kind: 'invalid', reason: 'Addresses with a username or password are refused.' };
  if (isVerseAddress(url, verseOrigin)) return { kind: 'self', url: url.href };
  const loopback = isLoopbackHost(url.hostname);
  return { kind: 'url', url: url.href, loopback, frameable: isLoopbackPreviewUrl(url.href) };
}

/** "localhost:5173/admin" / "example.com/docs" — for tab titles and the history list. */
export function shortAddress(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}${url.search}`;
  } catch {
    return href;
  }
}

/** The origin of an http(s) URL, or null. */
export function originOf(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

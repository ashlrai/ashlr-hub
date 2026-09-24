/**
 * dock/preview/preview-client.ts — the Preview pane's reads (unit C4) and the
 * address-bar rule.
 *
 * Every call is a header-authenticated GET. An artifact shown in an <iframe>
 * or <img> goes through a short-lived FRAME TICKET (preview.ts "WHY
 * TICKETS"): the element's own request cannot carry the read-client header.
 */
import type { VersePreviewArtifactKind, VersePreviewTargetsResponse } from '../../../../data/api-types.js';
import { getReadClientProof, reportSessionExpired } from '../../../../data/auth-store.js';
import { ApiError, apiGet } from '../../../../data/client.js';
import {
  VERSE_PREVIEW_RAW_PATH,
  VERSE_PREVIEW_TARGETS_PATH,
  isLoopbackPreviewUrl,
} from '../../../../../core/verse/workbench-types.js';

export const VERSE_PREVIEW_TICKET_PATH = '/api/verse/preview/ticket';

export interface PreviewTicket {
  url: string;
  expiresAt: string;
  kind: VersePreviewArtifactKind;
}

export interface PreviewApi {
  targets(sessionId: string, signal?: AbortSignal): Promise<VersePreviewTargetsResponse>;
  ticket(sessionId: string, path: string): Promise<PreviewTicket>;
  /** A markdown artifact's text (rendered by the pane, sanitised). */
  text(sessionId: string, path: string): Promise<string>;
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export const previewApi: PreviewApi = {
  targets: (sessionId, signal) => apiGet<VersePreviewTargetsResponse>(`${VERSE_PREVIEW_TARGETS_PATH}?${query({ sessionId })}`, signal),
  ticket: (sessionId, path) => apiGet<PreviewTicket>(`${VERSE_PREVIEW_TICKET_PATH}?${query({ sessionId, path })}`),
  text: async (sessionId, path) => {
    const url = `${VERSE_PREVIEW_RAW_PATH}?${query({ sessionId, path })}`;
    const res = await fetch(url, { credentials: 'same-origin', headers: { 'x-ashlr-read-client': getReadClientProof() } });
    if (res.status === 401) {
      reportSessionExpired();
      throw new ApiError('Read session expired.', 401, url);
    }
    if (!res.ok) throw new ApiError(`GET ${url} failed (HTTP ${res.status}).`, res.status, url);
    return res.text();
  },
};

// ---------------------------------------------------------------------------
// The address bar
// ---------------------------------------------------------------------------

export type PreviewAddress =
  | { kind: 'loopback'; url: string }
  /** Not loopback http: offered as "Open in browser ↗", never framed. */
  | { kind: 'external'; url: string }
  /** Verse's own server: it refuses to be framed, and framing it would only confuse. */
  | { kind: 'self'; url: string }
  | { kind: 'invalid' };

function portOf(url: URL): string {
  return url.port || (url.protocol === 'https:' ? '443' : '80');
}

/**
 * What the operator typed → where it goes. Shorthands: `5173` and `:5173`
 * are localhost ports; `localhost:3000/x` gets `http://`. A bare domain is an
 * EXTERNAL https page. Anything that is not http(s) (javascript:, file:,
 * data:) is invalid. `verseOrigin` is `window.location.origin`.
 */
export function parsePreviewAddress(input: string, verseOrigin: string): PreviewAddress {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > 2048 || /\s/.test(raw)) return { kind: 'invalid' };
  let candidate = raw;
  if (/^:?\d{2,5}$/.test(raw)) candidate = `http://localhost:${raw.replace(':', '')}/`;
  else if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:[/?#].*)?$/i.test(raw)) candidate = `http://${raw}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    if (!/^[\w-]+(?:\.[\w-]+)+(?::\d{1,5})?(?:[/?#].*)?$/.test(raw)) return { kind: 'invalid' };
    candidate = `https://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { kind: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'invalid' };
  if (isLoopbackPreviewUrl(url.href)) {
    let verse: URL | null = null;
    try { verse = new URL(verseOrigin); } catch { verse = null; }
    const loopbackVerse = verse && (verse.hostname === 'localhost' || verse.hostname === '127.0.0.1');
    if (loopbackVerse && portOf(verse!) === portOf(url)) return { kind: 'self', url: url.href };
    return { kind: 'loopback', url: url.href };
  }
  if (url.username || url.password) return { kind: 'invalid' };
  return { kind: 'external', url: url.href };
}

/** "localhost:5173/admin" — the tab and history label for a loopback URL. */
export function shortUrl(href: string): string {
  try {
    const url = new URL(href);
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.host}${path}${url.search}`;
  } catch {
    return href;
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

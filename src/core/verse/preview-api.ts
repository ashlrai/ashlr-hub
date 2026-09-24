/**
 * core/verse/preview-api.ts — `/api/verse/preview*` (V3.10, unit C4), mounted
 * by verse-api.ts's workbench table (workbench-types.ts §9).
 *
 *   GET /api/verse/preview/targets?sessionId=   → VersePreviewTargetsResponse
 *   GET /api/verse/preview/raw?sessionId=&path= → the file (≤ 5 MB, nosniff, sandboxed)
 *   GET /api/verse/preview/ticket?sessionId=&path= → { url, expiresAt }
 *   GET /api/verse/preview/frame/<ticket>       → the file, for an <iframe>
 *
 * `raw` is the header-authenticated read (the pane fetches markdown text
 * through it). `ticket` + `frame` exist because an <iframe src> can carry
 * neither the read-client header nor, off the EventSource paths, the query
 * proof: see preview.ts "WHY TICKETS". `frame` is the one path server.ts lets
 * past its read boundary, and it answers only a live ticket presented with the
 * cookie of the read session that minted it.
 *
 * Every file is served under a CSP `sandbox` (an opaque origin — see
 * preview.ts ARTIFACT_CSP), `nosniff`, framable by Verse alone, and only from
 * inside the chat's own roots after symlinks are resolved.
 *
 * Read-only: nothing here starts a server or writes a file. Dev-server Start
 * goes through the terminal (terminal-api.ts `devServerId`).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  ARTIFACT_CSP,
  PDF_CSP,
  VERSE_PREVIEW_FRAME_PATH_RE,
  VERSE_PREVIEW_TICKET_PATH,
  artifactContentType,
  discoverDevServers,
  listArtifacts,
  mintFrameTicket,
  publicDevServer,
  redeemFrameTicket,
  resolveArtifactFile,
  sessionRoots,
  type DevServerDiscoveryDeps,
} from './preview.js';
import type { VerseSession } from './types.js';
import { getVerseEngine } from './verse-api.js';
import { VERSE_SESSION_ID_RE } from './verse-stream.js';
import {
  VERSE_PREVIEW_RAW_PATH,
  VERSE_PREVIEW_TARGETS_PATH,
  type VersePreviewTargetsResponse,
} from './workbench-types.js';

let discoveryDeps: DevServerDiscoveryDeps | undefined;

/** Test hook: fake lsof / port probes (null restores the real ones). */
export function setPreviewDiscoveryDepsForTest(deps: DevServerDiscoveryDeps | null): void {
  discoveryDeps = deps ?? undefined;
}

/** Single-valued query parameters; a repeated key is ambiguous and refused. */
function queryOf(req: IncomingMessage): Map<string, string> | null {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (out.has(key)) return null;
    out.set(key, value);
  }
  return out;
}

async function sessionFor(res: ServerResponse, rawId: string | undefined): Promise<VerseSession | null> {
  if (typeof rawId !== 'string' || !VERSE_SESSION_ID_RE.test(rawId)) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'sessionId is required' });
    return null;
  }
  const session = (await getVerseEngine()).getSession(rawId);
  if (!session) {
    sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found' });
    return null;
  }
  return session;
}

/** ASCII-only, quote-free file name for Content-Disposition. */
function dispositionName(path: string): string {
  const name = basename(path).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
  return name.length > 0 ? name : 'artifact';
}

async function serveArtifact(res: ServerResponse, session: VerseSession, relPath: string): Promise<void> {
  const resolved = resolveArtifactFile(sessionRoots(session), relPath);
  if (!resolved.ok) {
    sendJson(res, resolved.status, { code: resolved.status === 413 ? 'VERSE_TOO_LARGE' : 'VERSE_INVALID', error: resolved.error });
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(resolved.abs);
  } catch {
    sendJson(res, 404, { code: 'VERSE_INVALID', error: 'file could not be read' });
    return;
  }
  // Re-check after the read: the file may have grown between stat and read.
  if (body.length > 5 * 1024 * 1024) {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'file is larger than 5 MB' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': artifactContentType(resolved.rel),
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Overrides the server-wide CSP / DENY for THIS response only: framable by
    // Verse, and an opaque origin inside the frame (PDF: see PDF_CSP).
    'Content-Security-Policy': resolved.kind === 'pdf' ? PDF_CSP : ARTIFACT_CSP,
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Content-Disposition': `inline; filename="${dispositionName(resolved.rel)}"`,
  });
  res.end(body);
}

export const handlePreviewApi: ApiModule = async (ctx, req, res, path, method) => {
  const frame = VERSE_PREVIEW_FRAME_PATH_RE.exec(path);
  if (frame) {
    if (method !== 'GET') return false;
    // Redeemed ONLY with the cookie of the read session that minted it. The
    // same refusal for every failure: nothing tells a prober which part failed.
    const redeemed = redeemFrameTicket(frame[1]!, typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined);
    if (!redeemed) {
      sendJson(res, 403, { error: 'preview link expired — reopen it from the Preview pane' });
      return true;
    }
    const session = (await getVerseEngine()).getSession(redeemed.sessionId);
    if (!session) {
      sendJson(res, 404, { code: 'VERSE_SESSION_NOT_FOUND', error: 'session not found' });
      return true;
    }
    await serveArtifact(res, session, redeemed.path);
    return true;
  }

  if (path !== VERSE_PREVIEW_TARGETS_PATH && path !== VERSE_PREVIEW_RAW_PATH && path !== VERSE_PREVIEW_TICKET_PATH) return false;
  if (method !== 'GET') return false;
  const query = queryOf(req);
  if (!query) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid query' });
    return true;
  }

  if (path === VERSE_PREVIEW_TARGETS_PATH) {
    for (const key of query.keys()) {
      if (key !== 'sessionId') {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${key.slice(0, 40)}` });
        return true;
      }
    }
    const session = await sessionFor(res, query.get('sessionId'));
    if (!session) return true;
    const roots = sessionRoots(session);
    const engine = await getVerseEngine();
    // Verse's own port is never offered: framing Verse inside itself is refused
    // by its own frame-ancestors, and would only ever confuse.
    const ownPort = req.socket?.localPort;
    const devServers = await discoverDevServers(roots, {
      excludePorts: typeof ownPort === 'number' ? [ownPort] : [],
      ...(discoveryDeps ? { deps: discoveryDeps } : {}),
    });
    let artifacts: VersePreviewTargetsResponse['artifacts'] = [];
    try {
      artifacts = listArtifacts(session, () => engine.getEvents(session.id), roots);
    } catch {
      artifacts = [];
    }
    const body: VersePreviewTargetsResponse = { devServers: devServers.map(publicDevServer), artifacts };
    sendJson(res, 200, body);
    return true;
  }

  for (const key of query.keys()) {
    if (key !== 'sessionId' && key !== 'path') {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${key.slice(0, 40)}` });
      return true;
    }
  }
  const session = await sessionFor(res, query.get('sessionId'));
  if (!session) return true;
  const relPath = query.get('path') ?? '';

  if (path === VERSE_PREVIEW_RAW_PATH) {
    await serveArtifact(res, session, relPath);
    return true;
  }

  // ticket
  if (!ctx.readSession) {
    sendJson(res, 400, { code: 'VERSE_INVALID', error: 'a preview link needs a browser read session' });
    return true;
  }
  const resolved = resolveArtifactFile(sessionRoots(session), relPath);
  if (!resolved.ok) {
    sendJson(res, resolved.status, { code: resolved.status === 413 ? 'VERSE_TOO_LARGE' : 'VERSE_INVALID', error: resolved.error });
    return true;
  }
  const minted = mintFrameTicket({ sessionId: session.id, path: resolved.rel, readSession: ctx.readSession });
  // Written directly, NOT through sendJson: its public-JSON scrubber redacts
  // long base64-looking runs, which a random ticket can be — and this body
  // holds nothing but our own URL, a timestamp and a kind.
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify({ url: minted.url, expiresAt: minted.expiresAt, kind: resolved.kind }));
  return true;
};

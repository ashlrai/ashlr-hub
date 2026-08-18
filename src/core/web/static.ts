/**
 * core/web/static.ts — M14 path-traversal-safe static file server.
 *
 * serveStatic(req, res, dir) serves a file from `dir` for the request URL.
 *
 * Returns true if a response was written (file served), false if the asset
 * was not found / the path was rejected (caller writes its own 404).
 *
 * SECURITY:
 *  - Resolves the requested path WITHIN `dir`; any path that escapes `dir`
 *    (`..`, absolute paths, encoded traversal) is rejected -> returns false.
 *  - Rejects null-byte injection.
 *  - Never serves directories (only regular files); "/" maps to index.html.
 *  - NEVER throws — all errors are caught and surface as `false`.
 *  - No outward calls; pure local fs read bounded to the assets dir.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join, sep, normalize, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Content-Type mapping (only the handful of extensions the SPA ships).
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Path extraction — pull the pathname from the request URL, never throws.
// ---------------------------------------------------------------------------

function extractPathname(rawUrl: string | undefined): string | null {
  try {
    const raw = rawUrl ?? '/';
    // Prepend a dummy base so the URL parser can handle path-only inputs.
    const parsed = new URL(raw, 'http://localhost');
    // parsed.pathname is already percent-decoded for path segments by URL,
    // but %2e etc. inside a single-encoded path are decoded here, which is
    // exactly what we want to inspect for traversal.
    let pathname = decodeURIComponent(parsed.pathname);
    // Null-byte injection — reject outright.
    if (pathname.includes('\x00')) return null;
    if (!pathname.startsWith('/')) pathname = '/' + pathname;
    return pathname;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// serveStatic
// ---------------------------------------------------------------------------

export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  dir: string,
  beforeDescriptorOpen: (() => void) | undefined = undefined,
): boolean {
  try {
    const rootDir = resolve(dir);

    const pathname = extractPathname(req.url);
    if (pathname === null) return false;

    // "/" (or empty) -> index.html (SPA shell).
    let rel = pathname === '/' ? '/index.html'
      : (pathname === '/next' || pathname === '/next/') ? '/next/index.html'
      : pathname;

    // Reject null bytes anywhere in the relative path.
    if (rel.includes('\x00')) return false;

    // Strip the leading slash so join treats it as relative to rootDir.
    // Normalize collapses ".." / "." segments so we can detect escapes.
    const cleaned = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    rel = cleaned.replace(/^[/\\]+/, '');

    // Resolve the candidate path and confirm it stays within rootDir.
    const candidate = resolve(join(rootDir, rel));

    // Containment check: candidate must equal rootDir or live under it
    // (rootDir + path separator). Defends against `..` escapes and prefix
    // collisions (e.g. /assets vs /assets-secret).
    const rootWithSep = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
    if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) {
      return false;
    }

    // Open first without following a replacement final symlink. All named-path
    // containment and identity checks happen after descriptor custody is held,
    // so the bytes are never read through a separately checked pathname.
    let fd: number | undefined;
    try {
      const realRoot = realpathSync(rootDir);
      beforeDescriptorOpen?.();
      fd = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const openedBefore = fstatSync(fd);
      if (!openedBefore.isFile()) return false;
      const realCandidate = realpathSync(candidate);
      const realRootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
      if (!realCandidate.startsWith(realRootWithSep)) return false;
      const namedBefore = lstatSync(candidate);
      if (namedBefore.isSymbolicLink() || !namedBefore.isFile() ||
        openedBefore.dev !== namedBefore.dev || openedBefore.ino !== namedBefore.ino) return false;
      const body = readFileSync(fd);
      const openedAfter = fstatSync(fd);
      const realCandidateAfter = realpathSync(candidate);
      const namedAfter = lstatSync(candidate);
      if (!openedAfter.isFile() || !realCandidateAfter.startsWith(realRootWithSep) ||
        namedAfter.isSymbolicLink() || !namedAfter.isFile() ||
        openedBefore.dev !== openedAfter.dev || openedBefore.ino !== openedAfter.ino ||
        openedAfter.dev !== namedAfter.dev || openedAfter.ino !== namedAfter.ino ||
        openedBefore.size !== openedAfter.size ||
        openedBefore.mtimeMs !== openedAfter.mtimeMs ||
        openedBefore.ctimeMs !== openedAfter.ctimeMs ||
        openedAfter.size !== namedAfter.size ||
        openedAfter.mtimeMs !== namedAfter.mtimeMs ||
        openedAfter.ctimeMs !== namedAfter.ctimeMs) return false;
      res.setHeader('Content-Type', contentTypeFor(candidate));
      res.writeHead(200, {
        'Content-Type': contentTypeFor(candidate),
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
      return true;
    } catch {
      return false; // ENOENT and friends -> not found.
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    }
  } catch {
    // NEVER throw — any unexpected error means "not served".
    return false;
  }
}

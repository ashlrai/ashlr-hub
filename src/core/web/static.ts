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
import { readFileSync, statSync } from 'node:fs';
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
): boolean {
  try {
    const rootDir = resolve(dir);

    const pathname = extractPathname(req.url);
    if (pathname === null) return false;

    // "/" (or empty) -> index.html (SPA shell).
    let rel = pathname === '/' ? '/index.html' : pathname;

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

    // Stat — must be an existing regular file (never a directory).
    let stat;
    try {
      stat = statSync(candidate);
    } catch {
      return false; // ENOENT and friends -> not found.
    }
    if (!stat.isFile()) return false;

    const body = readFileSync(candidate);

    // Set Content-Type via setHeader (case-insensitive in real Node http) so
    // downstream readers can look it up by the canonical lowercase name.
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
    // NEVER throw — any unexpected error means "not served".
    return false;
  }
}

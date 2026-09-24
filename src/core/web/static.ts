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
 *
 * CACHING + COMPRESSION (3.10):
 *  - Vite's content-hashed chunks under /next/assets/ (`name-<8 char hash>.ext`)
 *    are served `public, max-age=31536000, immutable`: their bytes can never
 *    change under that name, so a relaunch re-downloads nothing and WebKit's
 *    bytecode cache can keep them. Everything else (index.html, the legacy
 *    app) stays `no-cache` but carries a strong ETag, so revalidation is a
 *    bodyless 304.
 *  - Text assets are sent brotli- or gzip-encoded per Accept-Encoding. The
 *    compression runs on the libuv threadpool (never the request thread): the
 *    first request for a file is served identity-encoded while the encoded
 *    copy is built; later requests get it from a bounded in-memory cache keyed
 *    on the file's (dev, ino, size, mtime, ctime) identity.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join, sep, normalize, extname } from 'node:path';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';

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
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Cache policy, validators, compression
// ---------------------------------------------------------------------------

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

/** Vite's default chunk/asset naming: `<name>-<8 url-safe base64 chars>.<ext>`. */
const HASHED_ASSET_RE = /^\/next\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/** Only content-hashed build output is immutable; a stable name never is. */
export function isImmutableAssetPath(pathname: string): boolean {
  return HASHED_ASSET_RE.test(pathname);
}

// TTF and ICO are uncompressed formats (woff/woff2 and raster images are not).
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.ttf', '.ico']);
/** Below this, encoding overhead outweighs the saving. */
const MIN_COMPRESS_BYTES = 1024;
/** Upper bound on the encoded-body cache. */
const MAX_COMPRESSED_CACHE_BYTES = 64 * 1024 * 1024;
/** Never try to encode something absurdly large in memory. */
const MAX_COMPRESS_INPUT_BYTES = 16 * 1024 * 1024;

type Encoding = 'br' | 'gzip';

const compressedCache = new Map<string, Buffer>();
const compressionInFlight = new Set<string>();
let compressedCacheBytes = 0;

function rememberCompressed(key: string, body: Buffer): void {
  const previous = compressedCache.get(key);
  if (previous) {
    compressedCacheBytes -= previous.byteLength;
    compressedCache.delete(key);
  }
  while (compressedCache.size > 0 && compressedCacheBytes + body.byteLength > MAX_COMPRESSED_CACHE_BYTES) {
    const oldest = compressedCache.keys().next().value as string;
    compressedCacheBytes -= compressedCache.get(oldest)!.byteLength;
    compressedCache.delete(oldest);
  }
  if (body.byteLength > MAX_COMPRESSED_CACHE_BYTES) return;
  compressedCache.set(key, body);
  compressedCacheBytes += body.byteLength;
}

/** Build the encoded copy on the threadpool; errors just leave it uncached. */
function scheduleCompression(key: string, encoding: Encoding, body: Buffer): void {
  if (compressionInFlight.has(key)) return;
  compressionInFlight.add(key);
  const done = (err: Error | null, out: Buffer): void => {
    compressionInFlight.delete(key);
    // Keep the encoded copy only when it actually saves bytes.
    if (!err && out.byteLength < body.byteLength) rememberCompressed(key, out);
  };
  try {
    if (encoding === 'br') {
      brotliCompress(body, {
        params: {
          [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
          [zlibConstants.BROTLI_PARAM_QUALITY]: 10,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
        },
      }, done);
    } else {
      gzip(body, { level: 9 }, done);
    }
  } catch {
    compressionInFlight.delete(key);
  }
}

/**
 * Pick the best encoding the client accepts (q > 0). Brotli first — it is
 * ~15-20% smaller than gzip on JS — then gzip. Unparseable header: identity.
 */
export function negotiateEncoding(acceptEncoding: string | string[] | undefined): Encoding | null {
  const raw = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) return null;
  const accepted = new Map<string, number>();
  for (const part of raw.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (m) q = Number(m[1]);
    }
    if (Number.isFinite(q)) accepted.set(name.trim(), q);
  }
  const allows = (name: string): boolean => {
    const q = accepted.get(name) ?? accepted.get('*');
    return q !== undefined && q > 0;
  };
  if (allows('br')) return 'br';
  if (allows('gzip')) return 'gzip';
  return null;
}

/** Strong validator from the file identity that was verified during the read. */
function etagFor(stat: { ino: number; size: number; mtimeMs: number }): string {
  return `"${stat.ino.toString(36)}-${stat.size.toString(36)}-${Math.floor(stat.mtimeMs * 1000).toString(36)}"`;
}

function ifNoneMatchHits(header: string | string[] | undefined, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || raw.length === 0) return false;
  if (raw.trim() === '*') return true;
  return raw.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

/** Drop encoded bodies (tests). */
export function clearStaticCompressionCache(): void {
  compressedCache.clear();
  compressionInFlight.clear();
  compressedCacheBytes = 0;
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
    // "/next" and "/verse" (Ashlr Verse console, src/web-ui/routes/verse/)
    // both resolve to the new console shell; the SPA picks the app by pathname.
    let rel = pathname === '/' ? '/index.html'
      : (pathname === '/next' || pathname === '/next/') ? '/next/index.html'
      : (pathname === '/verse' || pathname === '/verse/') ? '/next/index.html'
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
      const contentType = contentTypeFor(candidate);
      const cacheControl = isImmutableAssetPath(pathname) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
      const etag = etagFor(openedAfter);
      const compressible = COMPRESSIBLE_EXTENSIONS.has(extname(candidate).toLowerCase()) &&
        body.byteLength >= MIN_COMPRESS_BYTES && body.byteLength <= MAX_COMPRESS_INPUT_BYTES;
      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        'ETag': etag,
        'X-Content-Type-Options': 'nosniff',
      };
      if (compressible) headers['Vary'] = 'Accept-Encoding';
      const reqHeaders = req.headers ?? {};
      res.setHeader('Content-Type', contentType);
      if (ifNoneMatchHits(reqHeaders['if-none-match'], etag)) {
        res.writeHead(304, headers);
        res.end();
        return true;
      }
      let payload: Buffer = body;
      if (compressible) {
        const encoding = negotiateEncoding(reqHeaders['accept-encoding']);
        if (encoding) {
          const key = `${encoding}\0${candidate}\0${openedAfter.dev}:${openedAfter.ino}:${openedAfter.size}:${openedAfter.mtimeMs}:${openedAfter.ctimeMs}`;
          const encoded = compressedCache.get(key);
          if (encoded) {
            payload = encoded;
            headers['Content-Encoding'] = encoding;
          } else {
            scheduleCompression(key, encoding, body);
          }
        }
      }
      headers['Content-Length'] = String(payload.byteLength);
      res.writeHead(200, headers);
      res.end(payload);
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

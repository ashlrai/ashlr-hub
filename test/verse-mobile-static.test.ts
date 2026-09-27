/**
 * test/verse-mobile-static.test.ts — the phone surface's server paths
 * (src/web-ui/routes/verse/mobile/, served by core/web/static.ts).
 *
 *   /verse/m, /verse/m/   → the same SPA shell as /verse (the SPA picks the
 *                           mobile app by pathname)
 *   /verse/m/sw.js        → the service worker, served from INSIDE the scope
 *                           it controls, so no Service-Worker-Allowed header
 *                           has to widen anything
 *   *.webmanifest         → application/manifest+json, never octet-stream
 *
 * Nothing here loosens the path containment: the new names map to fixed
 * files under next/, and every other /verse/m/* path is still a literal file
 * lookup that 404s.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serveStatic, VERSE_MOBILE_SW_PATH } from '../src/core/web/static.js';

let assetsDir: string;

beforeEach(() => {
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-mobile-static-'));
  fs.mkdirSync(path.join(assetsDir, 'next', 'verse-m'), { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'next', 'index.html'), '<html><div id="root"></div></html>');
  fs.writeFileSync(path.join(assetsDir, 'next', 'verse-m', 'sw.js'), '/* verse mobile sw */ self.addEventListener("fetch", () => {});');
  fs.writeFileSync(path.join(assetsDir, 'next', 'verse-m', 'manifest.webmanifest'), JSON.stringify({ name: 'Ashlr Verse', start_url: '/verse/m/' }));
});

afterEach(() => {
  fs.rmSync(assetsDir, { recursive: true, force: true });
});

function get(url: string): { handled: boolean; status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let status = 200;
  const req = { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
  const res = {
    writeHead(code: number, h?: Record<string, string>) {
      status = code;
      for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v;
    },
    setHeader(name: string, value: string) { headers[name.toLowerCase()] = value; },
    write(chunk: Buffer | string) { chunks.push(Buffer.from(chunk)); return true; },
    end(chunk?: Buffer | string) { if (chunk) chunks.push(Buffer.from(chunk)); },
  } as unknown as ServerResponse;
  const handled = serveStatic(req, res, assetsDir);
  return { handled, status, headers, body: Buffer.concat(chunks).toString() };
}

describe('serveStatic — Verse on a phone', () => {
  it('serves the console shell for /verse/m and /verse/m/', () => {
    for (const url of ['/verse/m', '/verse/m/']) {
      const r = get(url);
      expect(r.handled).toBe(true);
      expect(r.body).toContain('id="root"');
      expect(r.headers['content-type']).toContain('text/html');
      // The shell is never immutable: a new build must reach the phone.
      expect(r.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves the service worker from inside its own scope, revalidated every load', () => {
    expect(VERSE_MOBILE_SW_PATH).toBe('/verse/m/sw.js');
    const r = get(VERSE_MOBILE_SW_PATH);
    expect(r.handled).toBe(true);
    expect(r.body).toContain('verse mobile sw');
    expect(r.headers['content-type']).toContain('application/javascript');
    expect(r.headers['cache-control']).toBe('no-cache');
    // No scope widening: the worker's own path already covers /verse/m/.
    expect(r.headers['service-worker-allowed']).toBeUndefined();
  });

  it('types the web app manifest as application/manifest+json', () => {
    const r = get('/next/verse-m/manifest.webmanifest');
    expect(r.handled).toBe(true);
    expect(r.headers['content-type']).toContain('application/manifest+json');
    expect(JSON.parse(r.body).start_url).toBe('/verse/m/');
  });

  it('keeps every other /verse/m/* path a literal lookup (404, never the shell)', () => {
    for (const url of ['/verse/m/agents', '/verse/m/../../etc/passwd', '/verse/m/sw.js/../index.html']) {
      expect(get(url).handled).toBe(false);
    }
  });
});

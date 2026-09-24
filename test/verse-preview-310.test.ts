/**
 * V3.10 Preview pane (unit C4) — core/verse/preview.ts, preview-api.ts and
 * the server.ts changes it needs (frame-src, the frame-ticket exception).
 *
 * No real dev server is started and lsof is never run: listeners are injected
 * (SPEC-310C §7 C4). The route half runs the REAL server under a relocated HOME
 * and mints a REAL read session, because the frame ticket is bound to it.
 *
 * Under test:
 *   - dev servers from launch.json, package.json scripts (ports, package
 *     manager, quoting) and listening processes inside the chat's roots;
 *   - artifacts = previewable files this chat's tool calls wrote, inside its roots;
 *   - raw: sandboxed (`CSP: sandbox allow-scripts`), nosniff, ≤ 5 MB, limited
 *     to session roots — no `..`, no absolute paths, no symlink escapes;
 *   - tickets: minted only under a browser read session, redeemed only with
 *     that session's cookie, and the ONE exception to the read boundary;
 *   - the page CSP allows loopback frames and nothing else; loopback-only URLs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AshlrConfig } from '../src/core/types.js';
import type { VerseEngineHandle } from '../src/core/verse/session-engine.js';
import type { VerseEvent, VerseSession } from '../src/core/verse/types.js';
import {
  ARTIFACT_CSP,
  collectWrittenPaths,
  discoverDevServers,
  inferScriptPort,
  isPreviewFramePath,
  listArtifacts,
  mintFrameTicket,
  packageManagerFor,
  parseLsofCwds,
  parseLsofListeners,
  readLaunchJson,
  readPackageScripts,
  readSessionCookie,
  redeemFrameTicket,
  resetPreviewCaches,
  resolveArtifactFile,
  shellQuote,
} from '../src/core/verse/preview.js';
import { setPreviewDiscoveryDepsForTest } from '../src/core/verse/preview-api.js';
import { invalidateVerseSeatCache, resetVerseEngine } from '../src/core/verse/verse-api.js';
import { isLoopbackPreviewUrl } from '../src/core/verse/workbench-types.js';
import { createHash } from 'node:crypto';
import { readAuthHeaders, readSseAuth, startServer } from './helpers/authenticated-web-server.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-preview-310-')));
  resetPreviewCaches();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): string {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// ---------------------------------------------------------------------------
// Dev servers
// ---------------------------------------------------------------------------

describe('dev servers — package.json scripts', () => {
  it('knows the ports of common dev-server tools, and a port a script states', () => {
    const cases: Array<[string, number | null]> = [
      ['vite', 5173],
      ['vite preview', 4173],
      ['next dev', 3000],
      ['next dev -p 4001', 4001],
      ['astro dev', 4321],
      ['storybook dev -p 6007', 6007],
      ['react-scripts start', 3000],
      ['ng serve', 4200],
      ['python3 -m http.server 9000', 9000],
      ['PORT=3100 node server.js', 3100],
      ['tsc -p tsconfig.json', null],
      ['vitest run', null],
      ['node dist/cli/index.js', null],
    ];
    for (const [command, port] of cases) expect([command, inferScriptPort(command, tmp, 'dev')]).toEqual([command, port]);
  });

  it('only counts a stated port as a server when the script is NAMED like one', () => {
    expect(inferScriptPort('docker run -p 5432:5432 postgres', tmp, 'db')).toBeNull();
    expect(inferScriptPort('node server.js --port 8123', tmp, 'serve')).toBe(8123);
    expect(inferScriptPort('node server.js --port 8123', tmp, 'dev:api')).toBe(8123);
  });

  it('reads a vite config\'s pinned port as text (never executes it)', () => {
    write('vite.config.web.ts', 'export default { server: { port: 5183, strictPort: false } }');
    expect(inferScriptPort('vite --config vite.config.web.ts', tmp, 'dev:web')).toBe(5183);
    write('vite.config.ts', 'export default { preview: { port: 4999 } }');
    expect(inferScriptPort('vite preview', tmp, 'preview')).toBe(4999);
  });

  it('runs scripts through the project\'s package manager and quotes odd script names', () => {
    write('package.json', JSON.stringify({ scripts: { dev: 'vite', test: 'vitest', "x'; rm -rf ~": 'next start' } }));
    expect(packageManagerFor(tmp)).toBe('npm');
    const rows = readPackageScripts(tmp);
    expect(rows.map((r) => [r.label, r.port])).toEqual([["npm run dev", 5173], ["npm run 'x'\\''; rm -rf ~'", 3000]]);
    write('pnpm-lock.yaml', '');
    expect(readPackageScripts(tmp)[0]!.command).toBe('pnpm run dev');
    expect(shellQuote('dev:web')).toBe('dev:web');
  });

  it('ignores an unreadable or huge package.json', () => {
    write('package.json', '{ not json');
    expect(readPackageScripts(tmp)).toEqual([]);
  });
});

describe('dev servers — .claude/launch.json', () => {
  it('reads configurations; loopback urls only; a cwd may only narrow the root', () => {
    fs.mkdirSync(path.join(tmp, 'web'));
    write('.claude/launch.json', JSON.stringify({
      version: '0.0.1',
      configurations: [
        { name: 'web', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'], port: 5173, cwd: 'web' },
        { name: 'escape', runtimeExecutable: 'npm', runtimeArgs: ['start'], port: 3000, cwd: '../..' },
        { name: 'remote', url: 'https://example.com', runtimeExecutable: 'x' },
        { name: 'by-url', url: 'http://127.0.0.1:8088/app', runtimeExecutable: 'serve' },
        { runtimeExecutable: 'nameless', port: 1 },
      ],
    }));
    const rows = readLaunchJson(tmp);
    expect(rows.map((r) => [r.label, r.port, r.url, r.command, path.relative(tmp, r.cwd)])).toEqual([
      ['web', 5173, 'http://localhost:5173/', 'npm run dev', 'web'],
      ['escape', 3000, 'http://localhost:3000/', 'npm start', ''],
      ['by-url', 8088, 'http://127.0.0.1:8088/app', 'serve', ''],
    ]);
  });
});

describe('dev servers — discovery', () => {
  it('parses lsof output: loopback / wildcard listeners only', () => {
    const out = 'p100\ncnode\nn*:5173\nn127.0.0.1:5173\np200\ncollama\nn127.0.0.1:11434\np300\ncjava\nn192.168.1.4:8080\np400\ncpython\nn[::1]:8000\n';
    expect(parseLsofListeners(out)).toEqual([
      { pid: 100, command: 'node', port: 5173 },
      { pid: 200, command: 'ollama', port: 11434 },
      { pid: 400, command: 'python', port: 8000 },
    ]);
    expect(parseLsofCwds('p100\nfcwd\nn/Users/op/proj\np200\nfcwd\nn/\n')).toEqual(new Map([[100, '/Users/op/proj'], [200, '/']]));
  });

  it('marks declared servers running, adds listeners started inside the roots, and never offers Verse itself', async () => {
    write('package.json', JSON.stringify({ scripts: { dev: 'vite', storybook: 'storybook dev' } }));
    const rows = await discoverDevServers([tmp], {
      excludePorts: [7970],
      deps: {
        listListeners: async () => [
          { pid: 1, command: 'node', port: 5173, cwd: tmp },
          { pid: 2, command: 'bun', port: 8787, cwd: path.join(tmp, 'api') },
          { pid: 3, command: 'ollama', port: 11434, cwd: '/' },
          { pid: 4, command: 'ashlr', port: 7970, cwd: tmp },
        ],
      },
    });
    expect(rows.map((r) => [r.source, r.label, r.port, r.running])).toEqual([
      ['package-json', 'npm run dev', 5173, true],
      ['package-json', 'npm run storybook', 6006, false],
      ['listening', 'bun :8787', 8787, true],
    ]);
    expect(rows[2]!.command).toBe('');
  });

  it('without lsof, probes the declared ports directly', async () => {
    write('package.json', JSON.stringify({ scripts: { dev: 'vite', start: 'next start' } }));
    const probed: number[] = [];
    const rows = await discoverDevServers([tmp], {
      deps: { listListeners: async () => null, probePort: async (p) => { probed.push(p); return p === 3000; } },
    });
    expect(probed.sort()).toEqual([3000, 5173]);
    expect(rows.map((r) => [r.port, r.running])).toEqual([[5173, false], [3000, true]]);
  });

  it('shares one loopback-only rule with the URL bar', () => {
    expect(isLoopbackPreviewUrl('http://localhost:5173/')).toBe(true);
    expect(isLoopbackPreviewUrl('http://127.0.0.1:3000/x')).toBe(true);
    expect(isLoopbackPreviewUrl('https://localhost:5173/')).toBe(false);
    expect(isLoopbackPreviewUrl('http://example.com/')).toBe(false);
    expect(isLoopbackPreviewUrl('http://user:pw@localhost:1/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function toolUse(seq: number, name: string, input: unknown): VerseEvent {
  return { seq, at: '2026-09-24T00:00:00.000Z', type: 'tool-use', turnId: 't', toolUseId: `u${seq}`, name, input } as VerseEvent;
}

describe('artifacts', () => {
  it('collects the paths a chat\'s tool calls wrote, across engines, at their last write', () => {
    const events: VerseEvent[] = [
      toolUse(1, 'Write', { file_path: '/p/report.html', content: '' }),
      toolUse(2, 'Read', { file_path: '/p/secret.html' }),
      toolUse(3, 'file_change', { changes: [{ path: '/p/chart.svg', kind: 'add' }, { path: '/p/old.md', kind: 'delete' }] }),
      toolUse(4, 'write_file', { path: 'notes.md' }),
      toolUse(5, 'Edit', { file_path: '/p/report.html' }),
    ];
    expect(collectWrittenPaths(events)).toEqual(['/p/chart.svg', 'notes.md', '/p/report.html']);
  });

  it('lists previewable files that still exist inside the roots, newest first', () => {
    write('out/report.html', '<h1>hi</h1>');
    write('notes.md', '# notes');
    write('src/app.ts', 'x');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-preview-out-'));
    fs.writeFileSync(path.join(outside, 'leak.html'), 'x');
    fs.symlinkSync(path.join(outside, 'leak.html'), path.join(tmp, 'link.html'));
    const events = [
      toolUse(1, 'Write', { file_path: path.join(tmp, 'out/report.html') }),
      toolUse(2, 'Write', { file_path: path.join(tmp, 'src/app.ts') }),
      toolUse(3, 'Write', { file_path: path.join(outside, 'leak.html') }),
      toolUse(4, 'Write', { file_path: path.join(tmp, 'link.html') }),
      toolUse(5, 'Write', { file_path: 'notes.md' }),
      toolUse(6, 'Write', { file_path: path.join(tmp, 'gone.html') }),
    ];
    const session = { id: 's', projectPath: tmp, updatedAt: 'a', turnCount: 1 };
    const artifacts = listArtifacts(session, () => events, [tmp]);
    expect(artifacts).toEqual([
      { path: 'notes.md', kind: 'md', bytes: 7 },
      { path: 'out/report.html', kind: 'html', bytes: 11 },
    ]);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('resolves only regular files of previewable kinds inside the roots', () => {
    write('a.html', 'x');
    write('big.pdf', Buffer.alloc(5 * 1024 * 1024 + 1));
    write('run.sh', 'x');
    fs.symlinkSync('/etc/hosts', path.join(tmp, 'hosts.html'));
    expect(resolveArtifactFile([tmp], 'a.html')).toMatchObject({ ok: true, kind: 'html', bytes: 1 });
    expect(resolveArtifactFile([tmp], '../a.html')).toMatchObject({ ok: false, status: 400 });
    expect(resolveArtifactFile([tmp], path.join(tmp, 'a.html'))).toMatchObject({ ok: false, status: 400 });
    expect(resolveArtifactFile([tmp], 'run.sh')).toMatchObject({ ok: false, status: 400 });
    expect(resolveArtifactFile([tmp], 'big.pdf')).toMatchObject({ ok: false, status: 413 });
    expect(resolveArtifactFile([tmp], 'hosts.html')).toMatchObject({ ok: false, status: 404 });
    expect(resolveArtifactFile([tmp], 'missing.html')).toMatchObject({ ok: false, status: 404 });
  });
});

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

describe('frame tickets', () => {
  const cookie = 'v1.GET./api/.x';
  const sessionId = createHash('sha256').update(cookie, 'utf8').digest('hex');

  it('redeem only with the minting read session\'s cookie, and only until expiry', () => {
    const minted = mintFrameTicket({ sessionId: 's-1', path: 'a.html', readSession: { id: sessionId, expiresAt: Date.now() + 60_000 } });
    expect(isPreviewFramePath(minted.url)).toBe(true);
    expect(redeemFrameTicket(minted.ticket, `ashlr_read_session=${cookie}`)).toEqual({ sessionId: 's-1', path: 'a.html' });
    expect(redeemFrameTicket(minted.ticket, 'ashlr_read_session=someone-else')).toBeNull();
    expect(redeemFrameTicket(minted.ticket, undefined)).toBeNull();
    // Duplicate cookies are ambiguous: refused.
    expect(redeemFrameTicket(minted.ticket, `ashlr_read_session=${cookie}; ashlr_read_session=${cookie}`)).toBeNull();
    expect(redeemFrameTicket(minted.ticket, `ashlr_read_session=${cookie}`, Date.now() + 61_000)).toBeNull();
    expect(redeemFrameTicket('A'.repeat(43), `ashlr_read_session=${cookie}`)).toBeNull();
  });

  it('never outlives the read session it was minted under', () => {
    const minted = mintFrameTicket({ sessionId: 's', path: 'a.html', readSession: { id: sessionId, expiresAt: Date.now() + 1_000 } });
    expect(Date.parse(minted.expiresAt)).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it('reads exactly one session cookie', () => {
    expect(readSessionCookie('a=1; ashlr_read_session=xyz; b=2')).toBe('xyz');
    expect(readSessionCookie('a=1')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Routes through the real server
// ---------------------------------------------------------------------------

interface HttpResult { status: number; body: Buffer; json: unknown; headers: http.IncomingHttpHeaders }

function request(port: number, method: string, urlPath: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json: unknown = null;
        try { json = JSON.parse(body.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, body, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function makeConfig(accountsRoot: string): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: 'http://localhost:1234', ollama: 'http://127.0.0.1:1', providerChain: ['ollama'] },
    telemetry: {},
    tools: {},
    verse: { accountsRoot },
  } as unknown as AshlrConfig;
}

describe('preview routes through the real server', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let project: string;
  let handles: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    tmpHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-preview-home-')));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    project = path.join(tmpHome, 'proj');
    fs.mkdirSync(path.join(project, 'out'), { recursive: true });
    fs.writeFileSync(path.join(project, 'out', 'report.html'), '<script>document.title="ran"</script><h1>Report</h1>');
    fs.writeFileSync(path.join(project, 'doc.pdf'), '%PDF-1.4\n');
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    fs.writeFileSync(path.join(tmpHome, 'outside.html'), 'secret');
    const session = {
      id: 's-1', title: 'chat', projectPath: project, engine: 'claude', accountId: 'a', seatId: 'claude-a', model: 'm',
      nativeSessionId: null, createdAt: 'x', updatedAt: 'y', status: 'idle', turnCount: 1, usage: {}, lastError: null,
    } as unknown as VerseSession;
    const events = [toolUse(1, 'Write', { file_path: path.join(project, 'out', 'report.html') })];
    resetVerseEngine({
      listSessions: () => [session],
      getSession: (id: string) => (id === 's-1' ? session : null),
      getEvents: () => events,
      subscribe: () => () => {},
      close: () => {},
    } as unknown as VerseEngineHandle);
    invalidateVerseSeatCache();
    setPreviewDiscoveryDepsForTest({ listListeners: async () => [{ pid: 9, command: 'node', port: 5173, cwd: project }] });
    handles = [];
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.close(); } catch { /* ignore */ } }
    setPreviewDiscoveryDepsForTest(null);
    resetVerseEngine(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function boot() {
    const cfgRoot = path.join(tmpHome, '.ashlr', 'account-connections');
    fs.mkdirSync(cfgRoot, { recursive: true });
    fs.writeFileSync(path.join(cfgRoot, 'connections.json'), JSON.stringify({ accounts: [] }));
    const handle = await startServer(makeConfig(cfgRoot), { port: 0, open: false, allowDispatch: true });
    handles.push(handle);
    return handle;
  }

  it('the page CSP frames loopback dev servers and itself — nothing else — and still refuses to be framed', async () => {
    const handle = await boot();
    const res = await request(handle.port, 'GET', '/api/health');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("frame-src 'self' http://127.0.0.1:* http://localhost:*");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('targets: dev servers (running from the listener) and this chat\'s artifacts', async () => {
    const handle = await boot();
    const res = await request(handle.port, 'GET', '/api/verse/preview/targets?sessionId=s-1', readAuthHeaders(handle.port));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      // `command` is what Start will type — shown before the click (C4 → C0 contract addition).
      devServers: [{ id: expect.stringMatching(/^dev-/), label: 'npm run dev', command: 'npm run dev', url: 'http://localhost:5173/', port: 5173, source: 'package-json', running: true, root: '~/proj' }],
      artifacts: [{ path: 'out/report.html', kind: 'html', bytes: 52 }],
    });
    expect((await request(handle.port, 'GET', '/api/verse/preview/targets?sessionId=nope', readAuthHeaders(handle.port))).status).toBe(404);
    expect((await request(handle.port, 'GET', '/api/verse/preview/targets?sessionId=s-1&x=1', readAuthHeaders(handle.port))).status).toBe(400);
    expect((await request(handle.port, 'GET', '/api/verse/preview/targets?sessionId=s-1')).status).toBe(401);
  });

  it('raw: sandboxed, nosniff, framable only by Verse, limited to the chat\'s roots', async () => {
    const handle = await boot();
    const read = readAuthHeaders(handle.port);
    const ok = await request(handle.port, 'GET', '/api/verse/preview/raw?sessionId=s-1&path=out%2Freport.html', read);
    expect(ok.status).toBe(200);
    expect(ok.body.toString()).toContain('<h1>Report</h1>');
    expect(ok.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(ok.headers['content-security-policy']).toBe(ARTIFACT_CSP);
    expect(ARTIFACT_CSP.startsWith('sandbox allow-scripts;')).toBe(true);
    expect(ARTIFACT_CSP).not.toContain('allow-same-origin');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['x-frame-options']).toBe('SAMEORIGIN');
    const pdf = await request(handle.port, 'GET', '/api/verse/preview/raw?sessionId=s-1&path=doc.pdf', read);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(String(pdf.headers['content-security-policy'])).toContain("frame-ancestors 'self'");
    for (const bad of ['..%2Foutside.html', encodeURIComponent(path.join(tmpHome, 'outside.html')), 'package.json']) {
      const res = await request(handle.port, 'GET', `/api/verse/preview/raw?sessionId=s-1&path=${bad}`, read);
      expect([bad, res.status]).toEqual([bad, 400]);
      expect(res.body.toString()).not.toContain('secret');
    }
    expect((await request(handle.port, 'GET', '/api/verse/preview/raw?sessionId=s-1&path=out%2Freport.html')).status).toBe(401);
  });

  it('a frame ticket is minted under a browser read session and redeemed only with that session\'s cookie', async () => {
    const handle = await boot();
    const sse = await readSseAuth(handle);
    const proof = new URLSearchParams(sse.query.slice(1)).get('client')!;
    const browser = { ...sse.headers, 'x-ashlr-read-client': proof };

    // A header-token client (no browser session) cannot mint one.
    expect((await request(handle.port, 'GET', '/api/verse/preview/ticket?sessionId=s-1&path=out%2Freport.html', readAuthHeaders(handle.port))).status).toBe(400);

    const minted = await request(handle.port, 'GET', '/api/verse/preview/ticket?sessionId=s-1&path=out%2Freport.html', browser);
    expect(minted.status).toBe(200);
    const { url, kind } = minted.json as { url: string; kind: string };
    expect(kind).toBe('html');
    expect(isPreviewFramePath(url)).toBe(true);

    // The iframe's request: the cookie rides along, no header proof.
    const framed = await request(handle.port, 'GET', url, { Cookie: sse.headers['Cookie']! });
    expect(framed.status).toBe(200);
    expect(framed.headers['content-security-policy']).toBe(ARTIFACT_CSP);
    expect(framed.body.toString()).toContain('<h1>Report</h1>');

    // The URL alone, or with another session's cookie, is worthless.
    expect((await request(handle.port, 'GET', url)).status).toBe(403);
    const other = await readSseAuth(handle);
    expect((await request(handle.port, 'GET', url, other.headers)).status).toBe(403);
    // The exception is exactly that path shape: every other /api GET is still 401 without a session.
    expect((await request(handle.port, 'GET', `${url}x`)).status).toBe(401);
    expect((await request(handle.port, 'GET', '/api/verse/preview/frame/short')).status).toBe(401);
    expect((await request(handle.port, 'GET', '/api/verse/terminal')).status).toBe(401);
    // A ticket cannot name a file outside the roots in the first place.
    expect((await request(handle.port, 'GET', '/api/verse/preview/ticket?sessionId=s-1&path=..%2Foutside.html', browser)).status).toBe(400);
  });
});

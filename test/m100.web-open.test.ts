/**
 * m100.web-open.test.ts — POST /api/open handler (M100).
 *
 * Units under test:
 *   handleApi — POST /api/open route in src/core/web/api.ts.
 *
 * Security model verified:
 *   - 404 when allowDispatch:false.
 *   - 401 when token is missing or wrong.
 *   - 415 when Content-Type is not application/json.
 *   - 400 on missing/invalid body fields.
 *   - 403 when repo is not enrolled (path-traversal safe).
 *   - 403 when file path escapes the repo root.
 *   - 200 + openInEditor called for action:'editor' on enrolled repo.
 *   - 200 + openInFinder called for action:'finder' on enrolled repo.
 *
 * open.ts + policy.ts are mocked so no real FS or subprocess calls occur.
 * HOME is relocated to a fresh tmp dir per test (mirrors m61/m90 pattern).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AshlrConfig } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// vi.mock factories — must not reference variables declared outside the factory
// (Vitest hoists these calls to the top of the file before variable init).
// ---------------------------------------------------------------------------

vi.mock('../src/cli/open.js', () => ({
  openInEditor: vi.fn(),
  openInFinder: vi.fn(),
  openInTerminal: vi.fn(),
  editorDeepLink: vi.fn((p: string) => `cursor://file${p}`),
}));

vi.mock('../src/core/sandbox/policy.js', async () => {
  const { resolve: resolvePath } = await import('node:path');
  const enrolled = [resolvePath('/enrolled/repo-a'), resolvePath('/enrolled/repo-b')];
  return {
    listEnrolled: () => enrolled,
    isEnrolled: (r: string) => enrolled.includes(r),
    assertMayMutate: vi.fn(),
    enroll: vi.fn(),
    unenroll: vi.fn(),
    killSwitchOn: () => false,
    enrollmentPath: () => resolvePath('/tmp/enrollment.json'),
    killSwitchPath: () => resolvePath('/tmp/KILL'),
  };
});

// Import AFTER mocks are registered.
import { handleApi } from '../src/core/web/api.js';
import * as openMod from '../src/cli/open.js';

// ---------------------------------------------------------------------------
// Config + HOME isolation
// ---------------------------------------------------------------------------

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: ['/tmp'],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: [],
    },
    telemetry: {},
    tools: {},
  } as AshlrConfig;
}

const TEST_TOKEN = 'test-token-m100';

let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m100-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  vi.mocked(openMod.openInEditor).mockClear();
  vi.mocked(openMod.openInFinder).mockClear();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// Minimal IncomingMessage / ServerResponse fakes
// ---------------------------------------------------------------------------

interface FakeResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  ended: boolean;
}

function makeFakeReqRes(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
}): { req: IncomingMessage; res: ServerResponse; captured: FakeResponse } {
  const captured: FakeResponse = { statusCode: 200, body: '', headers: {}, ended: false };

  const req = new EventEmitter() as IncomingMessage;
  req.method = opts.method ?? 'POST';
  req.url = opts.url ?? '/api/open';
  req.headers = opts.headers ?? {
    'content-type': 'application/json',
    'x-ashlr-token': TEST_TOKEN,
    'x-ashlr-operation-id': '00000000-0000-4000-8000-000000000100',
  };

  process.nextTick(() => {
    if (opts.body !== undefined) req.emit('data', Buffer.from(opts.body, 'utf8'));
    req.emit('end');
  });

  const res = {
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      captured.statusCode = status;
      if (headers) Object.assign(captured.headers, headers);
      this.headersSent = true;
    },
    end(data?: string) {
      if (data) captured.body += data;
      captured.ended = true;
    },
    write() { return true; },
  } as unknown as ServerResponse;

  return { req, res, captured };
}

function parsedBody(captured: FakeResponse): unknown {
  try { return JSON.parse(captured.body); } catch { return null; }
}

const ctx = { token: TEST_TOKEN, allowDispatch: true };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /api/open — security gates', () => {
  it('returns 404 when allowDispatch is false', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), { token: TEST_TOKEN, allowDispatch: false });
    expect(captured.statusCode).toBe(404);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 401 when x-ashlr-token is missing', async () => {
    const { req, res, captured } = makeFakeReqRes({
      headers: { 'content-type': 'application/json', 'x-ashlr-token': '' },
      body: JSON.stringify({ repo: '/enrolled/repo-a', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(401);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 401 when x-ashlr-token is wrong', async () => {
    const { req, res, captured } = makeFakeReqRes({
      headers: { 'content-type': 'application/json', 'x-ashlr-token': 'wrong-token' },
      body: JSON.stringify({ repo: '/enrolled/repo-a', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(401);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 415 when Content-Type is not application/json', async () => {
    const { req, res, captured } = makeFakeReqRes({
      headers: { 'content-type': 'text/plain', 'x-ashlr-token': TEST_TOKEN },
      body: JSON.stringify({ repo: '/enrolled/repo-a', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(415);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 403 when repo is not in the enrolled list', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/some/other/repo', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(403);
    const body = parsedBody(captured) as Record<string, unknown>;
    expect(body?.error).toMatch(/enrolled/i);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 403 for path traversal via repo field (resolves outside enrolled list)', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a/../../etc', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    // /enrolled/repo-a/../../etc resolves to /etc — not enrolled
    expect(captured.statusCode).toBe(403);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 403 when file path escapes the repo root', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a', file: '../../etc/passwd', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(403);
    const body = parsedBody(captured) as Record<string, unknown>;
    expect(body?.error).toMatch(/escapes|enrolled/i);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 403 when file path uses sibling-dir traversal', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a', file: '../repo-b/secret', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    // /enrolled/repo-a/../repo-b/secret → /enrolled/repo-b/secret — not under repo-a
    expect(captured.statusCode).toBe(403);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 400 when repo field is missing', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(400);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 400 when action is an arbitrary string (no exec)', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a', action: 'shell' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(400);
    const body = parsedBody(captured) as Record<string, unknown>;
    expect(body?.error).toMatch(/action/i);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON body', async () => {
    const { req, res, captured } = makeFakeReqRes({ body: 'not-json' });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(400);
  });
});

describe('POST /api/open — happy paths', () => {
  it('calls openInEditor and returns ok:true for action:editor on enrolled repo', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(200);
    const body = parsedBody(captured) as Record<string, unknown>;
    expect(body?.ok).toBe(true);
    expect(vi.mocked(openMod.openInEditor)).toHaveBeenCalledOnce();
    expect(vi.mocked(openMod.openInEditor)).toHaveBeenCalledWith(
      resolve('/enrolled/repo-a'),
      expect.objectContaining({ editor: 'cursor' }),
    );
    expect(vi.mocked(openMod.openInFinder)).not.toHaveBeenCalled();
  });

  it('calls openInFinder and returns ok:true for action:finder on enrolled repo', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-b', action: 'finder' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(200);
    const body = parsedBody(captured) as Record<string, unknown>;
    expect(body?.ok).toBe(true);
    expect(vi.mocked(openMod.openInFinder)).toHaveBeenCalledOnce();
    expect(vi.mocked(openMod.openInFinder)).toHaveBeenCalledWith(resolve('/enrolled/repo-b'));
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });

  it('opens a file within the repo root when file param is provided', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-a', file: 'src/index.ts', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(200);
    expect(vi.mocked(openMod.openInEditor)).toHaveBeenCalledWith(
      resolve('/enrolled/repo-a/src/index.ts'),
      expect.anything(),
    );
  });

  it('works for the second enrolled repo', async () => {
    const { req, res, captured } = makeFakeReqRes({
      body: JSON.stringify({ repo: '/enrolled/repo-b', action: 'editor' }),
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(200);
    expect(vi.mocked(openMod.openInEditor)).toHaveBeenCalledWith(
      resolve('/enrolled/repo-b'),
      expect.anything(),
    );
  });

  it('GET /api/open returns 404 (route only handles POST)', async () => {
    const { req, res, captured } = makeFakeReqRes({
      method: 'GET',
      url: '/api/open',
      body: '',
    });
    await handleApi(req, res, baseConfig(), ctx);
    expect(captured.statusCode).toBe(404);
    expect(vi.mocked(openMod.openInEditor)).not.toHaveBeenCalled();
  });
});

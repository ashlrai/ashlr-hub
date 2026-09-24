/**
 * V3.10 `handleSessionControlsApi` (SPEC-310C §7 route contracts, unit C3):
 * the route shapes, 400 on unknown keys, bypass confirmation, the raised body
 * cap on uploads only, sanitised output (home → `~`), and the queue / files
 * routes — driven straight through the module with a real engine whose child
 * processes are fakes (nothing launches). The mount's own gate (dispatch +
 * mutation token) is C0's and is tested with the mount.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { createFileIndex } from '../src/core/verse/file-index.js';
import {
  ATTACHMENT_BODY_MAX_BYTES,
  handleSessionControlsApi,
  setSessionControlsEngineForTest,
  setSessionControlsFileIndexForTest,
} from '../src/core/verse/session-controls-api.js';
import { createVerseEngine, type VerseEngineHandle, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseSeat } from '../src/core/verse/types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { VERSE_ATTACHMENT_MAX_BYTES } from '../src/core/verse/workbench-types.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly argv: string[]) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    setImmediate(() => this.emit('close', null));
    return true;
  }
  unref(): void {}
}

const HEALTH = { state: 'unknown' as const, summary: null, windows: [], observedAt: null };
const SEAT: VerseSeat = {
  id: 'claude-a', engine: 'claude', label: 'Claude', accountId: 'claude-a', contextWindow: 200_000, health: HEALTH, cliVersion: '2.1.280',
  models: [{ id: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 200_000 }],
};

let tmp: string;
let prevHome: string | undefined;
let engine: VerseEngineHandle;
let children: FakeChild[];
let sessionId: string;
let project: string;

const CTX = { cfg: {}, token: 't', allowDispatch: true } as unknown as VerseApiContext;

interface Reply { status: number; json: Record<string, unknown>; raw: string }

async function call(method: string, url: string, body?: unknown, rawBody?: string): Promise<Reply | null> {
  const payload = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
  const req = Readable.from(payload.length > 0 ? [Buffer.from(payload)] : []) as unknown as IncomingMessage;
  (req as { url?: string }).url = url;
  (req as { method?: string }).method = method;
  let status = 0;
  let raw = '';
  let sent = false;
  const res = {
    get headersSent() { return sent; },
    writeHead(code: number) { status = code; sent = true; return this; },
    end(chunk?: string) { raw = chunk ?? ''; },
  } as unknown as ServerResponse;
  const path = url.split('?')[0]!;
  const handled = await handleSessionControlsApi(CTX, req, res, path, method);
  if (!handled) return null;
  return { status, raw, json: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'verse-controls-api-'));
  prevHome = process.env.HOME;
  process.env.HOME = join(tmp, 'home');
  mkdirSync(process.env.HOME, { recursive: true });
  project = join(tmp, 'project');
  mkdirSync(project);
  children = [];
  engine = createVerseEngine({
    // Under HOME, so sanitised output shows `~`.
    root: join(process.env.HOME, '.ashlr', 'verse'),
    readiness: null,
    reasoningTap: null,
    preflight: null,
    processRegistry: false,
    loadConfig: () => undefined,
    log: () => {},
    spawn: ((bin: string, args: string[]) => {
      const child = new FakeChild([bin, ...args]);
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
  });
  const launch = { seat: SEAT, launcher: ['/usr/local/bin/node', '/nowhere/native-profiles/claude-a/launcher.mjs'], ollamaBaseUrl: 'http://127.0.0.1:11434', thinkingDisplay: false } as VerseSeatLaunch;
  sessionId = engine.createSession({ seatId: SEAT.id, projectPath: project }, launch).id;
  setSessionControlsEngineForTest(engine);
});

afterEach(() => {
  setSessionControlsEngineForTest(null);
  setSessionControlsFileIndexForTest(null);
  engine.close();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe('session-controls routes', () => {
  it('GET returns controls + options; POST changes them; unknown keys are 400', async () => {
    const got = await call('GET', `/api/verse/session-controls/${sessionId}`);
    expect(got!.status).toBe(200);
    expect(got!.json).toMatchObject({ sessionId, controls: { model: 'claude-opus-5-5', effort: null, permissionMode: 'accept-edits' }, appliesNextTurn: false });
    const post = await call('POST', `/api/verse/session-controls/${sessionId}`, { effort: 'high' });
    expect(post!.status).toBe(200);
    expect(post!.json['controls']).toMatchObject({ effort: 'high' });
    expect((await call('POST', `/api/verse/session-controls/${sessionId}`, { efort: 'high' }))!.status).toBe(400);
    expect((await call('POST', `/api/verse/session-controls/${sessionId}`, {}, '{bad'))!.status).toBe(400);
    expect((await call('GET', '/api/verse/session-controls/no-such-session'))!.status).toBe(404);
  });

  it('bypass without confirmBypass is a 400; with it, the chat is in bypass', async () => {
    const refused = await call('POST', `/api/verse/session-controls/${sessionId}`, { permissionMode: 'bypass' });
    expect(refused!.status).toBe(400);
    expect(refused!.json['error']).toMatch(/confirm/);
    const ok = await call('POST', `/api/verse/session-controls/${sessionId}`, { permissionMode: 'bypass', confirmBypass: true });
    expect(ok!.json['controls']).toMatchObject({ permissionMode: 'bypass' });
  });

  it('defaults: GET and POST, never bypass', async () => {
    expect((await call('GET', '/api/verse/session-controls/defaults'))!.json).toEqual({ global: {}, seats: {} });
    expect((await call('POST', '/api/verse/session-controls/defaults', { permissionMode: 'bypass' }))!.status).toBe(400);
    const saved = await call('POST', '/api/verse/session-controls/defaults', { seatId: 'claude-a', effort: 'low' });
    expect(saved!.json).toEqual({ global: {}, seats: { 'claude-a': { effort: 'low' } } });
  });

  it('declines paths and methods it does not serve (the mount answers 404)', async () => {
    expect(await call('DELETE', `/api/verse/session-controls/${sessionId}`)).toBeNull();
    expect(await call('GET', `/api/verse/session-controls/${sessionId}/extra`)).toBeNull();
    expect(await call('GET', '/api/verse/queue/../../etc')).toBeNull();
  });
});

describe('attachment routes', () => {
  it('uploads (201), lists, deletes; refs are sanitised to ~', async () => {
    const up = await call('POST', `/api/verse/attachments/${sessionId}`, { name: 'notes.md', mime: 'text/markdown', dataBase64: Buffer.from('# hi').toString('base64') });
    expect(up!.status).toBe(201);
    expect(up!.json['ref']).toMatch(new RegExp(`^@~/\\.ashlr/verse/attachments/${sessionId}/[0-9a-f]{8}-notes\\.md$`));
    expect(up!.raw).not.toContain(process.env.HOME!);
    const list = await call('GET', `/api/verse/attachments/${sessionId}`);
    expect((list!.json['items'] as unknown[]).length).toBe(1);
    const id = up!.json['id'] as string;
    const del = await call('POST', `/api/verse/attachments/${sessionId}/${id}/delete`, {});
    expect(del!.json['items']).toEqual([]);
    expect((await call('POST', `/api/verse/attachments/${sessionId}/${id}/delete`, {}))!.status).toBe(404);
  });

  it('raises the body cap for uploads only — an 8 MB file fits, a bigger body is 413', async () => {
    expect(ATTACHMENT_BODY_MAX_BYTES).toBeGreaterThan(Math.ceil((VERSE_ATTACHMENT_MAX_BYTES * 4) / 3));
    const big = Buffer.alloc(VERSE_ATTACHMENT_MAX_BYTES, 7).toString('base64');
    const ok = await call('POST', `/api/verse/attachments/${sessionId}`, { name: 'big.bin', mime: 'application/octet-stream', dataBase64: big });
    expect(ok!.status).toBe(201);
    const tooBig = await call('POST', `/api/verse/attachments/${sessionId}`, undefined, JSON.stringify({ name: 'x', mime: 'text/plain', dataBase64: 'A'.repeat(ATTACHMENT_BODY_MAX_BYTES) }));
    expect(tooBig!.status).toBe(413);
    // Every other route keeps the 64 KB cap.
    const queueBig = await call('POST', `/api/verse/queue/${sessionId}`, undefined, JSON.stringify({ text: 'x'.repeat(70 * 1024) }));
    expect(queueBig!.status).toBe(413);
    expect((await call('POST', `/api/verse/attachments/${sessionId}`, { name: 'a', mime: 'text/plain', dataBase64: 'eA==', extra: 1 }))!.status).toBe(400);
  });
});

describe('queue routes', () => {
  it('queues while a turn runs, sends when idle, deletes and sends a held item', async () => {
    engine.sendTurn(sessionId, 'running');
    const queued = await call('POST', `/api/verse/queue/${sessionId}`, { text: 'next please' });
    expect(queued!.status).toBe(200);
    expect(queued!.json).toMatchObject({ sentTurnId: null, held: false, items: [expect.objectContaining({ text: 'next please' })] });
    expect((await call('POST', `/api/verse/queue/${sessionId}`, { text: 'x', sendNow: 'yes' }))!.status).toBe(400);
    expect((await call('POST', `/api/verse/queue/${sessionId}`, { text: 'x', later: true }))!.status).toBe(400);
    const qid = (queued!.json['items'] as Array<{ id: string }>)[0]!.id;
    // Send now: stops the running turn; the item goes next.
    const now = await call('POST', `/api/verse/queue/${sessionId}/${qid}/send`, {});
    expect(now!.status).toBe(200);
    expect(children[0]!.signalCode).toBe('SIGINT');
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(children[1]!.argv.at(-1)).toBe('next please');
    expect((await call('GET', `/api/verse/queue/${sessionId}`))!.json['items']).toEqual([]);
    const missing = await call('POST', `/api/verse/queue/${sessionId}/${qid}/delete`, {});
    expect(missing!.status).toBe(404);
  });
});

describe('files route', () => {
  it('fuzzy-finds across the chat’s roots only, and validates its query', async () => {
    setSessionControlsFileIndexForTest(createFileIndex({ list: async () => ['src/Composer.tsx', 'README.md'] }));
    const found = await call('GET', `/api/verse/files?sessionId=${sessionId}&q=comp`);
    expect(found!.status).toBe(200);
    expect(found!.json).toMatchObject({ sessionId, query: 'comp', truncated: false, files: [{ path: 'src/Composer.tsx' }] });
    expect((await call('GET', '/api/verse/files?q=x'))!.status).toBe(400);
    expect((await call('GET', `/api/verse/files?sessionId=${sessionId}&q=${'x'.repeat(201)}`))!.status).toBe(400);
    expect((await call('GET', '/api/verse/files?sessionId=nope&q=x'))!.status).toBe(404);
  });
});

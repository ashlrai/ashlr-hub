/**
 * 3.15 Playbooks routes under /api/verse/playbooks (verse/playbooks-api.ts),
 * driven with in-memory requests (no socket). Everything lives in the
 * isolated HOME.
 */
import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';

import { saveRetro } from '../src/core/learn/retro/store.js';
import type { RetroV1 } from '../src/core/learn/retro/types.js';
import { builtinPlaybooks } from '../src/core/playbooks/store.js';
import { VERSE_PLAYBOOKS_PATH } from '../src/core/playbooks/types.js';
import { handlePlaybooksApi } from '../src/core/verse/playbooks-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const ctx = { cfg: {}, token: 'tok', allowDispatch: true } as unknown as VerseApiContext;

async function call(method: string, url: string, body?: unknown, over: Partial<VerseApiContext> = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const req = Object.assign(Readable.from(payload), {
    method,
    url,
    headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-ashlr-token': 'tok' },
  }) as unknown as IncomingMessage;
  let status = 0;
  let text = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { text = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  const handled = await handlePlaybooksApi({ ...ctx, ...over } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  expect(handled).toBe(true);
  return { status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

beforeEach(() => {
  rmSync(join(homedir(), '.ashlr'), { recursive: true, force: true });
});

describe('/api/verse/playbooks', () => {
  it('does not claim other paths', async () => {
    const res = { writeHead: () => res, end: () => res } as unknown as ServerResponse;
    expect(await handlePlaybooksApi(ctx, {} as IncomingMessage, res, '/api/verse/playbooksx', 'GET')).toBe(false);
  });

  it('GET lists the built-ins', async () => {
    const { status, body } = await call('GET', VERSE_PLAYBOOKS_PATH);
    expect(status).toBe(200);
    const rows = body!['playbooks'] as { id: string; builtin: boolean }[];
    expect(rows.map((r) => r.id)).toContain('fix-issue');
    expect(rows.every((r) => r.builtin)).toBe(true);
    expect((await call('GET', `${VERSE_PLAYBOOKS_PATH}?x=1`)).status).toBe(400);
  });

  it('GET one: the version, rendered, and per-version outcomes from retros', async () => {
    const sha = builtinPlaybooks().get('fix-issue')!.sha;
    await saveRetro({
      v: 1, id: 'rt_00000000000000000001', sourceKey: 'cloud:x:merged', source: 'cloud', taskId: 'x', repo: 'ashlrai/widget', endKind: 'merged',
      endedAt: '2026-09-26T10:00:00.000Z', taskKind: 'fix', asked: 'a', happened: 'h', rootCause: null, doDifferently: [], betterPrompt: null,
      candidates: [], paths: [], model: null, createdAt: '2026-09-26T10:00:00.000Z', playbookRef: { id: 'fix-issue', version: 1, sha },
    } as RetroV1);
    const { status, body } = await call('GET', `${VERSE_PLAYBOOKS_PATH}/fix-issue`);
    expect(status).toBe(200);
    expect(String(body!['rendered'])).toContain('## Playbook: Fix a reported bug');
    expect(body!['versions']).toEqual([expect.objectContaining({ version: 1, outcomes: { merged: 1, refused: 0, reverted: 0, failed: 0, total: 1 } })]);
    expect((await call('GET', `${VERSE_PLAYBOOKS_PATH}/fix-issue?version=2`)).status).toBe(404);
    expect((await call('GET', `${VERSE_PLAYBOOKS_PATH}/fix-issue?version=abc`)).status).toBe(400);
    expect((await call('GET', `${VERSE_PLAYBOOKS_PATH}/..%2Fetc`)).status).toBe(404);
    expect((await call('GET', `${VERSE_PLAYBOOKS_PATH}/no-such`)).status).toBe(404);
  });

  it('POST an edit writes a new version; validation failures come back field by field', async () => {
    const shipped = builtinPlaybooks().get('docs-sync')!.source;
    const edited = shipped.replace('auto: false', 'auto: true');
    const ok = await call('POST', VERSE_PLAYBOOKS_PATH, { source: edited, baseVersion: 1, note: 'auto on' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, playbook: { version: 2, meta: { id: 'docs-sync', auto: true } } });
    const detail = await call('GET', `${VERSE_PLAYBOOKS_PATH}/docs-sync`);
    expect((detail.body!['versions'] as { version: number; note: string | null; author: string | null }[]).map((v) => [v.version, v.note, v.author]))
      .toEqual([[1, 'Shipped with ashlr', 'ashlr'], [2, 'auto on', 'mason']]);

    const bad = await call('POST', VERSE_PLAYBOOKS_PATH, { source: '---\nid: x\n---\n' });
    expect(bad.status).toBe(200);
    expect(bad.body!['ok']).toBe(false);
    expect((bad.body!['errors'] as unknown[]).length).toBeGreaterThan(0);

    const stale = await call('POST', VERSE_PLAYBOOKS_PATH, { source: edited.replace('Sync docs', 'Sync the docs'), baseVersion: 1 });
    expect(stale.body).toMatchObject({ ok: false, errors: [{ field: 'version' }] });
  });

  it('POST refuses unknown keys, bad types, and is 404 without dispatch', async () => {
    expect((await call('POST', VERSE_PLAYBOOKS_PATH, { source: 'x', extra: 1 })).status).toBe(400);
    expect((await call('POST', VERSE_PLAYBOOKS_PATH, { source: 1 })).status).toBe(400);
    expect((await call('POST', VERSE_PLAYBOOKS_PATH, { source: 'x', baseVersion: 0 })).status).toBe(400);
    expect((await call('POST', VERSE_PLAYBOOKS_PATH, { source: 'x' }, { allowDispatch: false })).status).toBe(404);
    expect((await call('POST', `${VERSE_PLAYBOOKS_PATH}/fix-issue`, { source: 'x' })).status).toBe(404);
  });
});

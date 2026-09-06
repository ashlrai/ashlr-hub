import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import { handleApi } from '../src/core/web/api.js';
import { startServer } from '../src/core/web/server.js';
import { ReadProjectionError, type ReadProjectionReader } from '../src/core/web/read-projections.js';
import { readPublicDaemonObservation } from '../src/core/daemon/public-observation.js';

const cfg = (): AshlrConfig => ({
  version: 1, roots: [], editor: 'cursor', staleDays: 30, categories: {}, tidyRules: [], keepers: [],
  models: { lmstudio: '', ollama: '', providerChain: [] }, telemetry: {}, tools: {},
});

function reader(read = vi.fn()): ReadProjectionReader {
  return { read: read as ReadProjectionReader['read'], invalidate: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

async function call(path: string, projections: ReadProjectionReader) {
  const req = new EventEmitter() as IncomingMessage;
  req.method = 'GET'; req.url = path; req.headers = {};
  const output = { status: 0, body: '' };
  const res = {
    writeHead(status: number) { output.status = status; },
    end(body: string) { output.body = body; },
  } as unknown as ServerResponse;
  await handleApi(req, res, cfg(), { token: 'unused', allowDispatch: false, readProjections: projections });
  return { status: output.status, body: JSON.parse(output.body) as unknown };
}

describe('web background read integration', () => {
  it.each([
    ['/api/control', 'control'], ['/api/fleet-activity', 'fleet-activity'],
    ['/api/runs', 'runs'], ['/api/swarms', 'swarms'],
  ])('dispatches %s through its fixed reader operation', async (path, kind) => {
    const payload = { source: 'test-owned-projection' };
    const read = vi.fn(async () => payload);
    expect(await call(path, reader(read))).toEqual({ status: 200, body: payload });
    expect(read).toHaveBeenCalledExactlyOnceWith(kind);
  });

  it('preserves the fleet body verbatim and does not spread cache metadata into it', async () => {
    const status = { generatedAt: '2026-09-06T00:00:00Z', source: 'fixture' };
    const read = vi.fn(async () => ({ status, stale: true, ageMs: 10_000 }));
    expect(await call('/api/fleet', reader(read))).toEqual({ status: 200, body: status });
  });

  it('validates input before dispatch and keeps proposal filtering on the fixed read result', async () => {
    const read = vi.fn(async () => [
      { id: 'pending-one', status: 'pending', createdAt: '2026-09-06T00:00:00Z' },
      { id: 'applied-one', status: 'applied', createdAt: '2026-09-05T00:00:00Z' },
    ]);
    const projections = reader(read);
    expect((await call('/api/inbox?status=invalid', projections)).status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    const result = await call('/api/inbox?status=all&limit=1', projections);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ pending: 1, total: 2, truncated: true, proposals: [{ id: 'pending-one' }] });
    expect(read).toHaveBeenCalledExactlyOnceWith('proposals');
  });

  it('returns unavailable rather than success or private worker diagnostics on transport failure', async () => {
    const projections = reader(vi.fn(async () => { throw new ReadProjectionError('/private/fixture diagnostics'); }));
    expect(await call('/api/control', projections)).toEqual({
      status: 503,
      body: { code: 'READ_PROJECTION_UNAVAILABLE', error: 'read projection temporarily unavailable' },
    });
    const daemon = await call('/api/daemon-observation', projections);
    expect(daemon.status).toBe(200);
    expect(daemon.body).toMatchObject({ runtimeState: 'unknown', running: null });
  });

  it('reads final daemon authority only after the snapshot has resolved', async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });
    const read = vi.fn((kind: string) => kind === 'snapshot'
      ? pending : Promise.resolve(readPublicDaemonObservation(undefined)));
    const result = call('/api/snapshot', reader(read));
    expect(read.mock.calls).toEqual([['snapshot']]);
    finish({ generatedAt: '2026-09-06T00:00:00Z', inbox: { pending: 2 } });
    expect((await result).body).toMatchObject({ daemonObservation: { runtimeState: 'unknown', pendingProposals: 2 } });
    expect(read.mock.calls).toEqual([['snapshot'], ['daemon-observation']]);
  });

  it('invalidates after authorized mutation attempts even on non-success responses, but not unauthenticated requests', async () => {
    const projections = reader();
    const handle = await startServer(cfg(), { port: 0, open: false, allowDispatch: true }, { readProjections: projections });
    try {
      // An unknown route guarantees no state changes while exercising the same
      // post-handler invalidation used by partially successful 409/500 mutations.
      const url = `${handle.url}/api/test-nonexistent-mutation`;
      expect((await fetch(url, { method: 'POST', signal: AbortSignal.timeout(2000) })).status).toBe(404);
      expect(projections.invalidate).not.toHaveBeenCalled();
      expect((await fetch(url, { method: 'POST', headers: { 'x-ashlr-token': handle.token }, signal: AbortSignal.timeout(2000) })).status).toBe(404);
      expect(projections.invalidate).toHaveBeenCalledOnce();
    } finally { await handle.close(); }
  });

  it('closes its reader if the requested HTTP port cannot bind', async () => {
    const first = await startServer(cfg(), { port: 0, open: false, allowDispatch: false }, { readProjections: reader() });
    const projections = reader();
    try {
      await expect(startServer(cfg(), { port: first.port, open: false, allowDispatch: false }, { readProjections: projections }))
        .rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(projections.close).toHaveBeenCalledOnce();
    } finally { await first.close(); }
  });

  it('authenticates before reading and serves Universe while an unrelated projection is pending', async () => {
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });
    const read = vi.fn(() => { started(); return pending; });
    const projections = reader(read);
    const handle = await startServer(cfg(), { port: 0, open: false, allowDispatch: false }, { readProjections: projections });
    let background: Promise<Response> | undefined;
    try {
      const unauthorized = await fetch(`${handle.url}/api/control`, { signal: AbortSignal.timeout(2000) });
      expect(unauthorized.status).toBe(401);
      expect(read).not.toHaveBeenCalled();
      background = fetch(`${handle.url}/api/control`, { headers: { 'x-ashlr-token': handle.readToken }, signal: AbortSignal.timeout(5000) });
      await began;
      const universe = await fetch(`${handle.url}/api/universe`, {
        headers: { 'x-ashlr-token': handle.readToken }, signal: AbortSignal.timeout(2000),
      });
      expect(universe.status).toBe(200);
      expect(await universe.json()).toMatchObject({ schemaVersion: 1 });
      expect(read).toHaveBeenCalledExactlyOnceWith('control');
      finish({ fixture: 'completed' });
      expect(await (await background).json()).toEqual({ fixture: 'completed' });
    } finally {
      finish({ fixture: 'cleanup' });
      await background?.catch(() => undefined);
      await handle.close();
    }
    expect(projections.close).toHaveBeenCalledOnce();
  });
});

/** Real CLI, loopback HTTP, ledger and archive; no provider or evaluator execution. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cmdResourceConsole } from '../src/cli/resource-console.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceQuotaScopeAccess, type ResourcePoolState } from '../src/core/resources/pool-runtime.js';
import type { ResourcePool } from '../src/core/resources/pool-policy.js';
import type { ResourceBinding } from '../src/core/resources/worker.js';
import type { ResourceConsoleSnapshot, ResourceConsoleTaskInput, ResourceConsoleTaskStatus,
  ResourceConsoleTranscript, ResourceSupervisorJobsPage } from '../src/core/resources/console-types.js';
import type { ResourceConsoleHistoryDescriptor } from '../src/core/resources/console-history-view.js';

type Startup = { port: number; readToken: string; controlToken: string };
async function http<T>(startup: Startup, path: string, input?: unknown, expected = 200): Promise<T> {
  const value = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: startup.port, path, agent: false,
      method: input === undefined ? 'GET' : 'POST', headers: {
        'x-ashlr-token': input === undefined ? startup.readToken : startup.controlToken,
        ...(input === undefined ? {} : { 'content-type': 'application/json' }),
      } }, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.setTimeout(15_000, () => req.destroy(new Error('Fixture HTTP timeout')));
    req.end(input === undefined ? undefined : JSON.stringify(input));
  });
  expect(value.status).toBe(expected);
  return JSON.parse(value.text) as T;
}

describe.skipIf(process.platform === 'win32')('explicit CLI history compaction over HTTP', () => {
  it('admits identity257, pages archived history, restarts and deletes text without replay or quota reset', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'console-compaction-cli-')));
    const root = join(base, 'ledger'); const workspace = join(base, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    const worker = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.end(JSON.stringify({ choices: [{ message: { content: 'PRIVATE_LOCAL_ANSWER' } }],
          usage: { prompt_tokens: 8, completion_tokens: 4 } }));
      });
    });
    await new Promise<void>(done => worker.listen(0, '127.0.0.1', done));
    const address = worker.address(); if (!address || typeof address === 'string') throw new Error('Fixture worker unavailable');
    const bounds = { maxConcurrent: 1, maxTasksPerWindow: 10, taskWindowMs: 600_000, priority: 1, reservePercent: 25 };
    const pool: ResourcePool = { schemaVersion: 1, id: 'cli-compaction', workers: [
      { ...bounds, id: 'local', provider: 'local', model: 'fixture' },
      { ...bounds, id: 'general', provider: 'codex', model: 'gpt-6-astra', quotaScope: 'codex-general-v1' },
      { ...bounds, id: 'spark', provider: 'codex', model: 'gpt-5.3-codex-spark', quotaScope: 'codex-spark-v1' },
    ] };
    const bindings: ResourceBinding[] = [
      { workerId: 'local', capacityKey: 'fixture-local', kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` },
      ...['general', 'spark'].map(workerId => ({ workerId, capacityKey: 'personal', kind: 'native-cli' as const,
        command: ['/test-owned/inert-never-spawned'] })),
    ];
    const observedAt = Date.now();
    const observations = [{ workerId: 'local', health: 'ready' as const, windows: [], retryAfter: null,
      observedAt: new Date(observedAt).toISOString(), expiresAt: new Date(observedAt + 300_000).toISOString() }];
    const poolFile = join(base, 'pool.json'); const bindingsFile = join(base, 'bindings.json'); const observationsFile = join(base, 'observations.json');
    for (const [path, value] of [[poolFile, pool], [bindingsFile, bindings], [observationsFile, observations]] as const) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    }
    const allocation = setResourcePoolAllocation(root, pool, bindings, 75, 0);
    const access = setResourceQuotaScopeAccess(root, pool, bindings, [{ capacityKey: 'personal', quotaScope: 'codex-general-v1' }], 0);
    const ledger = () => JSON.parse(readFileSync(join(root, 'pool-state.json'), 'utf8')) as ResourcePoolState;
    const task = (id: string, patch: Partial<ResourceConsoleTaskInput> = {}): ResourceConsoleTaskInput => ({
      id, prompt: `PRIVATE_CLI_REQUEST_${id}`, allowedWorkerIds: ['local'], mode: 'read-only',
      timeoutMs: 5000, maxOutputTokens: 100, retainHistory: true, ...patch,
    });
    // Startup capabilities are captured privately, never printed to test output.
    const output: string[] = []; const errors: unknown[][] = [];
    const log = vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
    const err = vi.spyOn(console, 'error').mockImplementation((...values) => { errors.push(values); });
    const closers: Array<() => Promise<void>> = [];
    const start = async (archiveHistory = false) => {
      const prior = process.listeners('SIGTERM'); const index = output.length;
      const running = cmdResourceConsole(['--root', root, '--pool', poolFile, '--bindings', bindingsFile,
        '--observations', observationsFile, '--execute', '--workspace', workspace, '--port', '0', '--json',
        ...(archiveHistory ? ['--archive-history'] : [])]);
      let closed = false;
      const close = async () => {
        if (closed) return;
        const added = process.listeners('SIGTERM').filter(listener => !prior.includes(listener));
        // Invoke only this CLI's handler: never signal this test runner or other owners.
        if (added.length === 1) added[0]!('SIGTERM');
        const code = await running; expect(code).toBe(0); closed = true;
        expect(process.listeners('SIGTERM').filter(listener => !prior.includes(listener))).toHaveLength(0);
      };
      closers.push(close);
      await vi.waitFor(() => expect(output.length).toBe(index + 1), { timeout: 10_000 });
      const startup = JSON.parse(output[index]!) as Startup;
      if (!Number.isInteger(startup.port) || !startup.readToken || !startup.controlToken) throw new Error('Fixture CLI did not start');
      return { startup, close };
    };
    const settled = async (startup: Startup, id: string) => {
      await vi.waitFor(async () => expect((await http<ResourceConsoleTaskStatus>(startup, `/api/resources/tasks/${id}`)).job)
        .toMatchObject({ id, state: 'settled', outcome: 'completed' }), { timeout: 10_000, interval: 50 });
    };
    let cleanupConfirmed = false;
    let failure: unknown; let cleanupFailure: unknown;
    try {
      const first = await start(true); const parent = task('parent');
      await http(first.startup, '/api/resources/tasks', parent, 202); await settled(first.startup, parent.id);
      const history = await http<ResourceConsoleTranscript>(first.startup, '/api/resources/tasks/parent/history');
      const receipt = structuredClone(ledger().attempts[0]!);
      await http(first.startup, '/api/resources/queue', { paused: true });
      for (let index = 0; index < 255; index++) {
        const filler = task(`filler-${index}`, { retainHistory: false, prompt: `filler ${index}` });
        await http(first.startup, '/api/resources/tasks', filler, 202);
        await http(first.startup, `/api/resources/tasks/${filler.id}/cancel`, {});
      }
      const child = task('child257', { parent: { taskId: parent.id, expectedTranscriptDigest: history.transcriptDigest! } });
      await http(first.startup, '/api/resources/tasks', child, 202);
      const descriptor = JSON.parse(readFileSync(join(root, 'resource-console-state.json'), 'utf8')) as ResourceConsoleHistoryDescriptor;
      expect(descriptor.kind).toBe('resource-console-history-descriptor'); expect(descriptor.order).toHaveLength(257);
      expect(descriptor.currentJobs.length).toBeLessThanOrEqual(256);
      expect(descriptor.order.filter(row => row.source === 'archive')).toHaveLength(8);
      expect(descriptor.currentJobs.some(row => row.id === parent.id)).toBe(false);
      const view = await http<ResourceConsoleSnapshot>(first.startup, '/api/resources');
      expect(view.supervisor?.jobs).toHaveLength(256);
      expect(view.supervisor?.jobWindow).toEqual({ totalJobs: 257, visibleJobs: 256, omittedJobs: 1 });
      expect(view.supervisor?.jobs.some(row => row.id === child.id)).toBe(true);
      expect(view.supervisor?.jobs.some(row => row.id === parent.id)).toBe(false);
      const ids: string[] = []; let path = '/api/resources/tasks?limit=64';
      while (path) {
        const page = await http<ResourceSupervisorJobsPage>(first.startup, path); expect(page.totalJobs).toBe(257);
        ids.push(...page.items.map(row => row.id));
        path = page.nextBefore ? `/api/resources/tasks?limit=64&before=${encodeURIComponent(page.nextBefore.enqueuedAt)}&beforeId=${page.nextBefore.id}` : '';
      }
      expect(new Set(ids).size).toBe(257); expect(ids).toHaveLength(257); expect(ids).toContain(parent.id);
      expect(requests).toHaveLength(1); expect(ledger().attempts).toEqual([receipt]);
      await first.close();
      const next = await start(); // Reopening a descriptor is not renewed compaction permission.
      const status = await http<ResourceConsoleTaskStatus>(next.startup, '/api/resources/tasks/parent');
      expect(status.supervisor.paused).toBe(true); expect(Object.hasOwn(status.supervisor, 'jobs')).toBe(false);
      expect(status.job).toMatchObject({ id: parent.id, state: 'settled' });
      await http(next.startup, '/api/resources/tasks', parent, 202);
      await http(next.startup, '/api/resources/tasks', { ...parent, prompt: 'changed' }, 409);
      await http(next.startup, '/api/resources/tasks/parent/history/delete', {});
      await http(next.startup, '/api/resources/tasks/parent/history', undefined, 404);
      const frozen = await http<ResourceConsoleTranscript>(next.startup, '/api/resources/tasks/child257/history');
      expect(frozen.context?.[0]?.prompt).toBe(parent.prompt);
      await http(next.startup, '/api/resources/tasks', task('deleted-parent-child', { parent: child.parent }), 404);
      await http(next.startup, '/api/resources/tasks', child, 202);
      expect(requests).toHaveLength(1); expect(ledger().attempts).toEqual([receipt]);
      await http(next.startup, '/api/resources/queue', { paused: false }); await settled(next.startup, child.id);
      expect(requests).toHaveLength(2); expect(requests[1]!.messages[0]!.content).toContain(parent.prompt);
      const receipts = structuredClone(ledger().attempts); expect(receipts.map(row => row.id)).toEqual([parent.id, child.id]);
      await http(next.startup, '/api/resources/tasks/child257/history/delete', {}); await next.close();
      const last = await start();
      for (const input of [parent, child]) {
        await http(last.startup, '/api/resources/tasks', input, 202);
        await http(last.startup, `/api/resources/tasks/${input.id}/history`, undefined, 404);
      }
      expect(ledger().attempts).toEqual(receipts); expect(requests).toHaveLength(2);
      const final = resourcePoolStatus(root, pool, bindings, observations);
      expect(final.allocation).toEqual(allocation); expect(final.quotaScopeAccess).toEqual(access);
      expect(final.plan.exclusions.find(row => row.workerId === 'general')?.reasons).toContain('operator-quota-scope-excluded');
      expect(receipts.every(row => row.workerId === 'local')).toBe(true);
      await last.close(); expect(errors).toHaveLength(0);
    } catch (error) { failure = error; }
    finally {
      try { for (const close of closers.reverse()) await close(); cleanupConfirmed = true; }
      catch (error) { cleanupFailure = error; }
      finally {
        log.mockRestore(); err.mockRestore(); worker.closeAllConnections();
        await new Promise<void>(done => worker.close(() => done()));
        // Retain fixture evidence if an owner did not confirm shutdown.
        if (cleanupConfirmed) rmSync(base, { recursive: true, force: true });
      }
    }
    if (failure) throw failure;
    if (cleanupFailure) throw cleanupFailure;
  }, 180_000);
});

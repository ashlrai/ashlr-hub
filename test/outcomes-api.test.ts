import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleOutcomesApiWithDeps } from '../src/core/verse/outcomes-api.js';
import { executeOutcomeOperation, outcomeView } from '../src/core/verse/outcomes-operations.js';
import { runOutcomeOperation } from '../src/core/verse/outcomes-io.js';
import { normalizeOutcomeOperation } from '../src/core/verse/outcomes-input.js';
import type { OutcomeOperation, OutcomesRead } from '../src/core/verse/outcomes-api-types.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { outcomeDirectory } from '../src/core/goals/outcome-runtime.js';
import { OutcomeStore } from '../src/core/goals/outcome-store.js';
import { OutcomeCoordinator } from '../src/core/goals/outcome-coordinator.js';

let home: string;
let repo: string;
let context: VerseApiContext;
const token = 'outcome-test-token';
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'outcomes-api-')));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ASHLR_HOME', join(home, '.ashlr'));
  mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
  repo = join(home, 'repo'); mkdirSync(repo);
  writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [repo] }), { mode: 0o600 });
  context = { token, allowDispatch: true, readSession: { id: 'read-session', expiresAt: Date.now() + 60_000 } } as VerseApiContext;
});
afterEach(() => { vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const scope = () => ({ desiredOutcome: 'Ship a useful improvement', targetRepos: [repo], acceptance: ['Meaningful tests pass and the change is merged'] });
const start = (): Extract<OutcomeOperation, { kind: 'start' }> => ({ kind: 'start', id: 'outcome-test', commandId: 'start-test', expectedRevision: 0, scope: scope() });
function assertWrite(result: ReturnType<typeof executeOutcomeOperation>) {
  if (!('ok' in result) || !result.ok) throw new Error('Expected recorded write');
  return result;
}
async function request(path = '/api/verse/outcomes', method = 'GET', body?: unknown, headers = { 'x-ashlr-token': token, 'content-type': 'application/json' }, run = async (operation: OutcomeOperation) => executeOutcomeOperation(operation)) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
  req.url = path; req.headers = headers;
  const captured = { status: 0, value: null as unknown };
  const res = { writeHead(status: number) { captured.status = status; }, end(text: string) { captured.value = JSON.parse(text); } } as unknown as ServerResponse;
  await handleOutcomesApiWithDeps(context, req, res, path.split('?')[0]!, method, { run });
  return captured;
}

describe('durable outcome API', () => {
  it('reads a known missing root without creating directories', async () => {
    const result = await request();
    expect(result.status).toBe(200);
    expect(result.value).toEqual({ v: 1, sourceState: 'missing', outcomes: [], enrollment: { sourceState: 'healthy', repos: ['~/repo'] } });
    expect(existsSync(dirname(outcomeDirectory('root')))).toBe(false);
  });
  it('round-trips the public home alias to the exact physical enrolled repository', async () => {
    const overview = (await request()).value as OutcomesRead;
    const { kind: _kind, ...body } = start();
    const response = await request('/api/verse/outcomes/start', 'POST', { ...body,
      scope: { ...scope(), targetRepos: overview.enrollment.repos } });
    expect(response.status).toBe(201);
    expect(new OutcomeStore(outcomeDirectory('outcome-test')).read().state?.scope.targetRepos).toEqual([repo]);
  });
  it('starts only a desired outcome, replays the command, and observes the later current revision', async () => {
    const { kind: _kind, ...body } = start();
    const created = await request('/api/verse/outcomes/start', 'POST', body);
    expect(created.status).toBe(201);
    expect(created.value).toMatchObject({ disposition: 'recorded', outcome: { revision: 1, status: 'waiting-plan', tasks: [] } });
    const store = new OutcomeStore(outcomeDirectory('outcome-test'));
    expect(store.read().state).toMatchObject({ graph: null, planRevision: 0, nodes: {}, activeNodeIds: [] });
    expect(await request('/api/verse/outcomes/outcome-test/pause', 'POST', { commandId: 'pause-test', expectedRevision: 1 })).toMatchObject({ status: 200 });
    expect((await request('/api/verse/outcomes/start', 'POST', body)).value).toMatchObject({ disposition: 'replayed' });
    expect(store.read().records).toHaveLength(2);
    expect((await request()).value).toMatchObject({ outcomes: [{ revision: 2, status: 'paused' }] });
  });
  it('refuses a stale edit and preserves the winning durable scope', async () => {
    assertWrite(executeOutcomeOperation(start()));
    const edit = { commandId: 'edit-first', expectedRevision: 1, scope: { ...scope(), desiredOutcome: 'First result' } };
    expect((await request('/api/verse/outcomes/outcome-test/edit', 'POST', edit)).status).toBe(200);
    expect((await request('/api/verse/outcomes/outcome-test/edit', 'POST', { ...edit, commandId: 'edit-stale', scope: scope() })).status).toBe(409);
    expect(new OutcomeStore(outcomeDirectory('outcome-test')).read().state?.scope.desiredOutcome).toBe('First result');
  });
  it('checks current exact enrollment at mutation time rather than trusting a previous overview', async () => {
    await request();
    writeFileSync(join(home, '.ashlr', 'enrollment.json'), JSON.stringify({ repos: [] }));
    const { kind: _kind, ...body } = start();
    expect((await request('/api/verse/outcomes/start', 'POST', body)).status).toBe(409);
    expect(existsSync(outcomeDirectory('outcome-test'))).toBe(false);
  });
  it.each(['corrupt-enrollment', 'partial-ledger', 'unsafe-parent', 'symlink-root'] as const)('keeps %s unknown rather than inventing an empty result', async variant => {
    if (variant === 'corrupt-enrollment') writeFileSync(join(home, '.ashlr', 'enrollment.json'), '{bad');
    if (variant === 'partial-ledger') mkdirSync(outcomeDirectory('outcome-test'), { recursive: true, mode: 0o700 });
    if (variant === 'unsafe-parent') chmodSync(join(home, '.ashlr'), 0o744);
    if (variant === 'symlink-root') symlinkSync(repo, dirname(outcomeDirectory('root')));
    expect((await request()).value).toMatchObject({ sourceState: 'degraded', outcomes: null });
  });
  it('reads corrupt history as unknown without repairing it', async () => {
    assertWrite(executeOutcomeOperation(start()));
    const file = join(outcomeDirectory('outcome-test'), 'ledger', '0000000000000001.json');
    writeFileSync(file, '{bad');
    expect((await request()).value).toMatchObject({ sourceState: 'degraded', outcomes: null });
    expect(readFileSync(file, 'utf8')).toBe('{bad');
  });
  it.each([undefined, { id: 'expired', expiresAt: 0 }, { id: 'invalid', expiresAt: NaN }])('requires a current read session', async readSession => {
    context.readSession = readSession;
    const run = vi.fn();
    expect((await request('/api/verse/outcomes', 'GET', undefined, undefined, run)).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it('enforces dispatch, token and JSON gates before invoking metadata IO', async () => {
    const run = vi.fn();
    const { kind: _kind, ...body } = start();
    context.allowDispatch = false;
    expect((await request('/api/verse/outcomes/start', 'POST', body, undefined, run)).status).toBe(404);
    context.allowDispatch = true;
    expect((await request('/api/verse/outcomes/start', 'POST', body, { 'x-ashlr-token': 'wrong', 'content-type': 'application/json' }, run)).status).toBe(401);
    expect((await request('/api/verse/outcomes/start', 'POST', body, { 'x-ashlr-token': token, 'content-type': 'text/plain' }, run)).status).toBe(415);
    expect(run).not.toHaveBeenCalled();
  });
  it.each([{ graph: {} }, { kind: 'refine' }, { expectedRevision: 1 }, { id: '../escape' }, { id: 'Uppercase' }, { id: 'x'.repeat(81) }, { scope: { ...scope(), planner: {} } }])('rejects invalid or execution-capable start fields: %j', async extra => {
    const { kind: _kind, ...body } = start();
    const run = vi.fn();
    expect((await request('/api/verse/outcomes/start', 'POST', { ...body, ...extra }, undefined, run)).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['/api/verse/outcomes?repo=/tmp/probe', '/api/verse/outcomes/outcome-test/plan', '/api/verse/outcomes/%2e%2e/pause'])('refuses arbitrary queries and action paths: %s', async path => {
    const run = vi.fn();
    await request(path, path.includes('?') ? 'GET' : 'POST', { commandId: 'test', expectedRevision: 0 }, undefined, run);
    expect(run).not.toHaveBeenCalled();
  });
  it('does not serve HEAD as an unauthenticated read', async () => {
    const run = vi.fn();
    expect((await request('/api/verse/outcomes', 'HEAD', undefined, undefined, run)).status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });
  it('reports unavailable metadata IO rather than success', async () => {
    const run = vi.fn().mockRejectedValue(new Error('worker failed'));
    expect((await request('/api/verse/outcomes', 'GET', undefined, undefined, run)).status).toBe(503);
  });
  it('normalizes neither arbitrary modules nor execution graphs into worker operations', () => {
    expect(() => normalizeOutcomeOperation({ kind: 'read', module: '/tmp/arbitrary' })).toThrow();
    expect(() => normalizeOutcomeOperation({ ...start(), graph: {} })).toThrow();
  });
  it('holds completion until durable node completion or gate evidence exists', () => {
    assertWrite(executeOutcomeOperation(start()));
    const store = new OutcomeStore(outcomeDirectory('outcome-test'));
    const coordinator = new OutcomeCoordinator(store);
    const result = coordinator.refinePlan({ commandId: 'plan', expectedRevision: 1 }, {
      missionKey: 'outcome-test', title: 'Improve', objective: scope().desiredOutcome, createdAt: new Date().toISOString(),
      nodes: [{ kind: 'work', key: 'a', title: 'Implement', objective: 'Build', deliverable: 'Change', riskClass: 'low',
        targetRepo: repo, acceptance: ['Pass tests'], dependsOn: [] }],
    }, { sourceState: 'healthy', complete: true, repos: [repo] });
    expect(result.ok).toBe(true);
    expect(outcomeView(store.read().state!).status).toBe('queued');
  });
  it('runs actual fixed metadata operations in a worker while leaving the event loop responsive', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      const result = await runOutcomeOperation(start());
      expect(result).toMatchObject({ ok: true, outcome: { status: 'waiting-plan', tasks: [] } });
      const read = await runOutcomeOperation({ kind: 'read' }) as OutcomesRead;
      expect(read.outcomes?.[0]?.revision).toBe(1);
      expect(ticks).toBeGreaterThan(0);
    } finally { clearInterval(timer); }
  });
});

/** Actual mission -> console -> local transport -> evaluated Git delivery, with a stopped/restarted owner. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateKey } from '../src/core/foundry/provenance.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { writePrivateFileAtomically } from '../src/core/util/private-file-write.js';
import { createResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { resourcePoolStatus, setResourcePoolAllocation, setResourceWorkerAccess } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { checkResourceEngineeringAutonomousSetup, prepareResourceEngineeringAutonomousSetup } from '../src/core/resources/engineering-autonomous-setup.js';
import { runResourceEngineeringMission } from '../src/core/resources/engineering-mission.js';
import { readEngineeringMissionRecords, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import { readEngineeringMissionInvocations } from '../src/core/resources/engineering-mission-invocations.js';
import type { ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation-types.js';

// Delegate the real mission requests unchanged; a failed outcome otherwise
// hides fetch causes during fixture cleanup. Keep only bounded closed metadata.
const missionDiagnostics = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>, sequence: 0,
  latestQueue: null as Record<string, unknown> | null,
  latestSuccessors: null as Record<string, unknown> | null,
  requestTimings: new Map<string, { calls: number; threw: number; unknownDuration: number; durationMs: number }>(),
  requestTimingIncomplete: false,
}));
vi.mock('../src/core/resources/engineering-mission-console.js', async () => {
  const actual = await vi.importActual<typeof import('../src/core/resources/engineering-mission-console.js')>(
    '../src/core/resources/engineering-mission-console.js');
  const { performance } = await import('node:perf_hooks');
  const closed = (value: unknown, allowed: readonly string[]): string =>
    typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
  const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1800_000 ? value : null;
  const project = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const event = (value: Record<string, unknown>): void => {
    missionDiagnostics.events.push(value); if (missionDiagnostics.events.length > 64) missionDiagnostics.events.shift();
    // Added measurements are isolated from the original delegated result/error.
    try {
      if (process.env.ASHLR_ACCEPTANCE_PHASE_TIMING !== '1' || (value.stage !== 'request-return' && value.stage !== 'request-error')) return;
      const route = closed(value.route, ['supervision', 'successors', 'other']);
      const elapsedMs = finite(value.elapsedMs); const prior = missionDiagnostics.requestTimings.get(route);
      const stats = { calls: (prior?.calls ?? 0) + 1, threw: (prior?.threw ?? 0) + Number(value.stage === 'request-error'),
        unknownDuration: (prior?.unknownDuration ?? 0) + Number(elapsedMs === null),
        durationMs: (prior?.durationMs ?? 0) + (elapsedMs ?? 0) };
      if (![stats.calls, stats.threw, stats.unknownDuration].every(count => Number.isSafeInteger(count) && count >= 0) ||
        !Number.isFinite(stats.durationMs) || stats.durationMs < 0) { missionDiagnostics.requestTimingIncomplete = true; return; }
      if (elapsedMs === null || route === 'unknown') missionDiagnostics.requestTimingIncomplete = true;
      missionDiagnostics.requestTimings.set(route, stats);
    } catch {
      try { missionDiagnostics.requestTimingIncomplete = true; } catch { /* Keep the original operation's outcome. */ }
    }
  };
  return { ...actual, async requestEngineeringMissionConsole(options: Parameters<typeof actual.requestEngineeringMissionConsole>[0]) {
    const started = performance.now(); const sequence = missionDiagnostics.sequence = Math.min(1000_000, missionDiagnostics.sequence + 1);
    const route = options.path === '/api/resources/engineering-supervision' ? 'supervision' :
      options.path === '/api/resources/engineering-successors' ? 'successors' : 'other';
    try { event({ sequence, route, stage: 'request-start' }); } catch { /* Observations never change requests. */ }
    try {
      const value = await actual.requestEngineeringMissionConsole(options);
      try {
        const row = project(value); const entries = Array.isArray(row?.entries) ? row.entries.slice(0, 8).map(project) : [];
        if (route === 'supervision') missionDiagnostics.latestQueue = {
          state: closed(row?.state, ['idle', 'running', 'paused', 'completed', 'timed-out', 'closed', 'unavailable']),
          revision: typeof row?.revision === 'number' && Number.isSafeInteger(row.revision) && row.revision >= 0 ? row.revision : null,
          entryCount: Array.isArray(row?.entries) ? row.entries.length : null,
          sourceState: closed(row?.sourceState, ['healthy', 'degraded']), paused: typeof row?.paused === 'boolean' ? row.paused : null,
          entries: entries.map(entry => ({ state: closed(entry?.state, ['waiting', 'running', 'completed', 'held', 'stopped', 'unavailable']),
            attempts: finite(entry?.attempts), reasons: Array.isArray(entry?.reasons) ? entry.reasons.slice(0, 8).map(reason => closed(reason,
              ['not-started', 'waiting-for-readiness', 'supervisor-paused', 'running', 'completed', 'cancelled', 'deadline-exhausted',
                'unchanged-evidence', 'attempt-limit', 'evidence-unavailable', 'launch-unavailable', 'supervisor-closed'])) : [] })) };
        if (route === 'successors') {
          const observation = project(row?.observation), coordinator = project(observation?.coordinator);
          missionDiagnostics.latestSuccessors = {
            state: closed(row?.state, ['observing', 'idle', 'running', 'closed', 'timed-out', 'unavailable']),
            workerState: closed(observation?.workerState, ['connected', 'closing', 'exited', 'faulted']),
            coordinatorState: closed(coordinator?.state, ['idle', 'running', 'waiting', 'held', 'timed-out', 'closing', 'closed', 'faulted']),
            coordinatorReason: closed(coordinator?.reason, ['execution-guard-refused', 'signal-aborted', 'deadline-reached', 'coordinator-loop-failed',
              'close-unresolved', 'ownership-release-failed', 'proposal-workers-ineligible', 'proposal-admission-unavailable']),
            entries: entries.map(entry => ({ state: closed(entry?.state, ['intent-recorded', 'proposing', 'waiting-for-capacity', 'preparing',
              'admitting', 'held', 'proposed', 'prepared', 'admitted', 'stopped']), reason: closed(entry?.reason,
                ['proposal-output-unresolved', 'source-or-authority-unavailable', 'proposal-capacity-unavailable', 'successor-evidence-unavailable']) })) };
        }
        event({ sequence, route, stage: 'request-return', elapsedMs: finite(performance.now() - started) });
      } catch { /* Diagnostic projection cannot replace a real successful return. */ }
      return value;
    } catch (error) {
      try {
        const row = project(error); event({ sequence, route, stage: 'request-error', elapsedMs: finite(performance.now() - started),
          errorName: closed(row?.name, ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError', 'Error', 'MissionConsoleRequestError']),
          errorCode: closed(row?.code, ['ABORT_ERR', 'ERR_INVALID_STATE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOENT', 'EACCES', 'EAGAIN', 'ENOMEM']),
          causeCode: closed(project(row?.cause)?.code, ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
            'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']) });
      } catch { /* Always preserve the original rejection. */ }
      throw error;
    }
  } };
});

const cleanup: Array<() => Promise<void>> = [];
// Opt-in elapsed diagnostics only. Buffer until fixture cleanup settles so
// observation cannot manufacture output liveness during a stalled case.
const acceptanceTiming = process.env.ASHLR_ACCEPTANCE_PHASE_TIMING === '1';
type TimingPhase = 'fixture' | 'git.operation' | 'mission.first' | 'mission.second' | 'mission.replay' | 'cleanup.fixture';
type TimingStats = { calls: number; threw: number; durationMs: number; minMs: number; maxMs: number };
const acceptancePhases = new Map<TimingPhase, TimingStats>();
let acceptanceCase = 0;
let acceptanceIncomplete = false;
function timingClock(): number | null {
  if (!acceptanceTiming) return null;
  try {
    const value = performance.now();
    if (Number.isFinite(value)) return value;
    acceptanceIncomplete = true; return null;
  }
  catch { acceptanceIncomplete = true; return null; }
}
function observeTiming(phase: TimingPhase, started: number | null, threw: boolean): void {
  if (started === null) return;
  try {
    const ended = timingClock(); const durationMs = ended === null ? null : ended - started;
    if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) { acceptanceIncomplete = true; return; }
    const prior = acceptancePhases.get(phase);
    const stats = { calls: (prior?.calls ?? 0) + 1, threw: (prior?.threw ?? 0) + Number(threw),
      durationMs: (prior?.durationMs ?? 0) + durationMs, minMs: Math.min(prior?.minMs ?? durationMs, durationMs),
      maxMs: Math.max(prior?.maxMs ?? durationMs, durationMs) };
    if (![stats.calls, stats.threw].every(count => Number.isSafeInteger(count) && count >= 0) ||
      ![stats.durationMs, stats.minMs, stats.maxMs].every(value => Number.isFinite(value) && value >= 0)) {
      acceptanceIncomplete = true; return;
    }
    acceptancePhases.set(phase, stats);
  } catch { acceptanceIncomplete = true; }
}
function timedSync<T>(phase: TimingPhase, work: () => T): T {
  if (!acceptanceTiming) return work();
  const started = timingClock(); let threw = true;
  try { const value = work(); threw = false; return value; }
  finally { observeTiming(phase, started, threw); }
}
function timedAsync<T>(phase: TimingPhase, work: () => Promise<T>): Promise<T> {
  if (!acceptanceTiming) return work();
  const started = timingClock();
  return (async () => {
    let threw = true;
    try { const value = await work(); threw = false; return value; }
    finally { observeTiming(phase, started, threw); }
  })();
}
beforeEach(() => {
  if (!acceptanceTiming) return;
  acceptanceCase++; acceptancePhases.clear(); acceptanceIncomplete = false;
});
function emitAcceptanceTiming(): void {
  if (!acceptanceTiming) return;
  try {
    console.log('ACCEPTANCE_TIMINGS ' + JSON.stringify({ schemaVersion: 1, module: 'mission', caseIndex: acceptanceCase,
      scope: 'elapsed-inclusive', incomplete: acceptanceIncomplete || missionDiagnostics.requestTimingIncomplete,
      phases: [...acceptancePhases].map(([phase, stats]) => ({ phase, ...stats })), requestTimings: [...missionDiagnostics.requestTimings].map(([route, stats]) => ({ route, calls: stats.calls, threw: stats.threw,
        unknownDuration: stats.unknownDuration, reportedDurationMsSum: stats.calls > stats.unknownDuration ? stats.durationMs : null })),
      transitions: missionTransitions }));
  } catch { /* Diagnostics cannot replace an original result or cleanup error. */ }
}
type MissionInvocation = 'first' | 'second' | 'replay';
let timingInvocation: MissionInvocation = 'first';
let timingInvocationStarted: number | null = null;
const missionTransitions: Array<{ invocation: MissionInvocation; scope: number; phase: string; elapsedFromInvocationStartMs: number }> = [];
beforeEach(() => {
  if (!acceptanceTiming) return;
  missionTransitions.splice(0); missionDiagnostics.requestTimings.clear(); missionDiagnostics.requestTimingIncomplete = false; timingInvocationStarted = null;
});
function observeMissionTransition(value: { scope: number; phase: string }): void {
  if (!acceptanceTiming) return;
  try {
    const at = timingClock();
    if (at === null || timingInvocationStarted === null || at < timingInvocationStarted || !Number.isSafeInteger(value.scope) || value.scope < 0 ||
      !['preparing', 'executing', 'draining', 'verifying', 'reconciling', 'proposing'].includes(value.phase) || missionTransitions.length >= 64) {
      acceptanceIncomplete = true; return;
    }
    missionTransitions.push({ invocation: timingInvocation, scope: value.scope, phase: value.phase,
      elapsedFromInvocationStartMs: at - timingInvocationStarted });
  } catch { acceptanceIncomplete = true; }
}

afterEach(async () => {
  try { await timedAsync('cleanup.fixture', async () => { for (const close of cleanup.splice(0).reverse()) await close(); }); }
  finally { emitAcceptanceTiming(); }
});
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
function git(repo: string, ...args: string[]): string {
  return timedSync('git.operation', () => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim());
}
async function fixture() {
  expect(homedir()).not.toBe(process.env.ASHLR_VITEST_REAL_HOME);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-mission-')));
  const project = join(base, 'project'), transport = join(base, 'transport'), root = join(base, 'ledger');
  const output = join(base, 'initial'), missionRoot = join(base, 'mission');
  for (const dir of [project, transport, output, missionRoot]) mkdirSync(dir, { mode: 0o700 });
  for (const dir of [project, transport]) git(dir, 'init', '-q', '--template=', '--initial-branch=main');
  writeFileSync(join(project, 'value.json'), '0\n');
  writeFileSync(join(project, 'evaluate.mjs'), "import{readFileSync}from'node:fs';import{join}from'node:path';const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));console.log(JSON.stringify({passed:Number.isInteger(value)&&value>=0&&value<=3,score:value,metrics:{value},diagnostics:[]}));");
  git(project, 'add', '.'); git(project, '-c', 'user.name=Mission Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed evaluator');
  const revision = git(project, 'rev-parse', 'HEAD');
  const calls = { generation: 0, successor: 0, mission: 0 }; const errors: string[] = [];
  const worker = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); const raw = JSON.parse(body.messages[0].content);
        const context = Array.isArray(raw) ? JSON.parse(raw.find(row => row.role === 'user').content) : raw;
        let content: unknown;
        if (context.seedContext) {
          calls.generation++; const value = JSON.parse(context.files.find((row: { path: string }) => row.path === 'value.json').content);
          expect(value).toBe(calls.generation - 1);
          content = { operations: [{ op: 'replace', path: 'value.json', content: `${value + 1}\n` }] };
        } else if (context.kind === 'engineering-successor-proposal') {
          calls.successor++;
          content = calls.successor === 1 ? { action: 'propose', name: 'Second value', objective: 'Improve the measured result to two.' } : { action: 'stop' };
        } else {
          expect(context.kind).toBe('engineering-mission-proposal'); expect(calls.generation).toBe(2); calls.mission++;
          content = { action: 'propose', name: 'Third value', objective: 'Improve the delivered value to three.' };
        }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
      } catch { errors.push('Fixture protocol mismatch'); res.writeHead(500); res.end('Fixture refused'); }
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve()));
    const writable = (file: string): void => { if (!lstatSync(file).isDirectory()) return; chmodSync(file, 0o700); for (const child of readdirSync(file)) writable(join(file, child)); };
    writable(base); rmSync(base, { recursive: true, force: true });
  });
  const address = worker.address(); if (!address || typeof address === 'string') throw Error('Missing fixture listener');
  const pool = validateResourcePool({ schemaVersion: 1, id: 'mission-fixture', workers: ['repair', 'spare'].map(id => ({
    id, provider: 'local', model: 'fixture', maxConcurrent: 1, maxTasksPerWindow: 12, taskWindowMs: 3600_000, reservePercent: 25, priority: 1 })) });
  const bindings = validateResourceBindings(pool.workers.map(row => ({ workerId: row.id, capacityKey: row.id, kind: 'local-chat', endpoint: `http://127.0.0.1:${address.port}/v1` })), pool);
  const observations = pool.workers.map(row => ({ workerId: row.id, health: 'ready' as const, windows: [], retryAfter: null,
    observedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 290_000).toISOString() }));
  const paths = { pool: join(base, 'pool.json'), bindings: join(base, 'bindings.json'), observations: join(base, 'observations.json'), projects: join(base, 'projects.json'), runtime: join(base, 'runtime.json') };
  save(paths.pool, pool); save(paths.bindings, bindings); save(paths.observations, observations); save(paths.projects, { schemaVersion: 1, projects: [] });
  // The fixture owns a live local transport, so refresh its health observation
  // instead of inventing a quota observation longer than the five-minute bound.
  const refresh = setInterval(() => {
    if (!worker.listening) return;
    for (const observation of observations) {
      observation.observedAt = new Date(Date.now() - 1000).toISOString();
      observation.expiresAt = new Date(Date.now() + 290_000).toISOString();
    }
    writePrivateFileAtomically(join(base, 'observations-next.json'), paths.observations, canonical(observations) + '\n',
      { anchorPath: base, label: 'Mission fixture observations' });
  }, 60_000);
  cleanup.push(async () => { clearInterval(refresh); });
  save(paths.runtime, { schemaVersion: 1, root, workspace: transport, poolPath: paths.pool, bindingsPath: paths.bindings, observationsPath: paths.observations, capacityWaitMs: 1000 });
  const prior = await createResourcePoolSupervisor({ root, pool, bindings, workspace: project, projects: [], readObservations: () => observations }); await prior.close();
  const allocation = setResourcePoolAllocation(root, pool, bindings, 75, 0); const access = setResourceWorkerAccess(root, pool, bindings, ['spare'], 0); loadOrCreateKey();
  const recipe: ResourceEngineeringRecipe = { schemaVersion: 1, id: 'first', name: 'First value', objective: 'Improve the fixed integer score.', projectId: 'default',
    seedRevision: revision, metric: { name: 'value', direction: 'maximize', minImprovement: 1 }, evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3000 },
    trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 30_000, trialTimeoutMs: 15_000 },
    campaignBudget: { maxGenerations: 1, maxDurationMs: 90_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: 30 },
    generation: { files: ['value.json'], contextFiles: [], allowedWorkerIds: ['repair'], maxOutputTokens: 256,
      hypotheses: [{ id: 'improve', niche: 'value', hypothesis: 'Increase the integer by one' }] }, delivery: { branch: 'codex/first' },
    execution: { maxDurationMs: 120_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
    supervision: { maxDurationMs: 600_000, pollIntervalMs: 100, maxAttemptsPerEnrollment: 3 } };
  const setup = { recipe, policy: { schemaVersion: 1, id: 'initial-queue', registrationScope: 'initial-scope', profileId: 'fixed', label: 'Fixed integer',
    acceptance: 'Only the declared integer may change; the evaluator is fixed.', maxEnrollments: 2, maxConcurrent: 1,
    successors: { allowedWorkerIds: ['repair'], maxOutputTokens: 256, proposalTimeoutMs: 60_000, maxSuccessors: 1, pollIntervalMs: 100 } },
  output, resourceRuntime: paths.runtime, workspace: project, projectsFile: paths.projects };
  const plan = checkResourceEngineeringAutonomousSetup(setup); prepareResourceEngineeringAutonomousSetup({ ...setup, expectedPlanDigest: plan.planDigest });
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'measured-mission', root: missionRoot,
    initial: { setup, expectedPlanDigest: plan.planDigest }, deadlineAt: new Date(Date.now() + 1800_000).toISOString(), maxScopes: 2, pollIntervalMs: 100 };
  return { base, project, root, config, allocation, access, pool, bindings, observations, calls, errors, revision };
}

describe.runIf(process.platform === 'darwin')('actual standing engineering mission', () => {
  it('reconciles scope one after owner restart, proposes and executes scope two on the same ledger, then honors stop', async () => {
    const f = await timedAsync('fixture', fixture); const stop = new AbortController(); const phases: string[] = [];
    const failureDiagnostics = (invocation: 'first' | 'second'): void => {
      try {
        let attempts: Array<Record<string, unknown>> | null = null;
        try { attempts = resourcePoolStatus(f.root, f.pool, f.bindings, f.observations).attempts.slice(0, 16).map(row => ({
          status: ['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'].includes(row.status) ? row.status : 'unknown',
          durationMs: typeof row.execution?.durationMs === 'number' && Number.isFinite(row.execution.durationMs) && row.execution.durationMs >= 0 &&
            row.execution.durationMs <= 1800_000 ? row.execution.durationMs : null,
          outputPresent: row.outputDigest !== null, finished: row.finishedAt !== null,
        })); } catch { /* Missing diagnostics stay unknown; the assertion still owns failure. */ }
        console.error('[mission-fixture-diagnostics] ' + JSON.stringify({ invocation, events: missionDiagnostics.events,
          latestQueue: missionDiagnostics.latestQueue, latestSuccessors: missionDiagnostics.latestSuccessors, attempts }));
      } catch { /* Never replace the original outcome assertion. */ }
    };
    // This real two-scope mission can exceed the wrapper's five-minute silence
    // window. Report actual transitions, rather than a timer that hides stalls.
    let lastProgress = '';
    const reportPhase = (value: { scope: number; phase: string }): void => {
      // Keep repeated executing observations: source brackets console start with them.
      observeMissionTransition(value);
      const next = `${value.scope}:${value.phase}`;
      if (next === lastProgress) return;
      lastProgress = next;
      console.error(`[mission-fixture] scope ${value.scope} phase ${value.phase}`);
    };
    timingInvocation = 'first'; timingInvocationStarted = timingClock();
    const first = await timedAsync('mission.first', () => runResourceEngineeringMission(f.config, { signal: stop.signal, onProgress(value) {
      phases.push(`${value.scope}:${value.phase}`); if (value.scope === 1 && value.phase === 'verifying') stop.abort(); reportPhase(value);
    } }));
    if (first.state !== 'stopped' || first.scopesReserved !== 1 || first.deadlineAt !== f.config.deadlineAt ||
      f.calls.generation !== 2 || f.calls.successor !== 1 || f.calls.mission !== 0) failureDiagnostics('first');
    expect(first, JSON.stringify({ first, phases, calls: f.calls, errors: f.errors })).toMatchObject({ state: 'stopped', scopesReserved: 1, deadlineAt: f.config.deadlineAt });
    expect(f.calls).toEqual({ generation: 2, successor: 1, mission: 0 });
    expect(readEngineeringMissionInvocations(f.config)).toMatchObject({ count: 1, unfinishedCount: 0,
      latest: { outcome: { state: 'stopped', reason: first.reason } } });
    const firstRows = readEngineeringMissionRecords(f.config); expect(firstRows.some(row => row.kind === 'settled')).toBe(true);
    timingInvocation = 'second'; timingInvocationStarted = timingClock();
    const second = await timedAsync('mission.second', () => runResourceEngineeringMission(f.config, { onProgress(value) { phases.push(`${value.scope}:${value.phase}`); reportPhase(value); } }));
    if (second.state !== 'completed' || second.reason !== 'stop-requested' || second.scopesReserved !== 2 ||
      second.deadlineAt !== f.config.deadlineAt) failureDiagnostics('second');
    expect(second, JSON.stringify({ second, phases, calls: f.calls, errors: f.errors })).toMatchObject({ state: 'completed', reason: 'stop-requested', scopesReserved: 2, deadlineAt: f.config.deadlineAt });
    expect(second.tip).not.toBeNull(); expect(git(f.project, 'show', `${second.tip!.commit}:value.json`)).toBe('3');
    expect(git(f.project, 'rev-parse', 'HEAD')).toBe(f.revision); expect(git(f.project, 'status', '--porcelain=v1')).toBe('');
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 }); expect(f.errors).toEqual([]);
    const ledger = resourcePoolStatus(f.root, f.pool, f.bindings, f.observations);
    expect(ledger.attempts).toHaveLength(6); expect(ledger.attempts.every(row => row.status === 'completed' && row.workerId === 'repair')).toBe(true);
    expect(ledger.allocation).toEqual(f.allocation); expect(ledger.workerAccess).toEqual(f.access);
    const final = readEngineeringMissionRecords(f.config);
    for (const row of firstRows) expect(final.find(item => item.id === row.id)).toEqual(row);
    const scopes = final.filter(row => row.kind === 'reserved'); expect(scopes).toHaveLength(2);
    const next = scopes[1]!.payload as { setup: { recipe: ResourceEngineeringRecipe } };
    const prior = firstRows.find(row => row.kind === 'settled')!.payload as { tip: { commit: string } };
    expect(next.setup.recipe.seedRevision).toBe(prior.tip.commit);
    expect(phases).toContain('1:reconciling'); expect(phases).toContain('2:executing');
    expect(existsSync(join(f.config.root, '.mission.lock'))).toBe(false);
    expect(existsSync(join(f.root, '.resource-console.lock'))).toBe(false);
    expect(json(join(f.root, 'resource-console-state.json')).paused).toBe(false);
    // Completed history remains inspectable under an explicit stop; replay must
    // neither restart a console nor propose a replacement task on any scope.
    const stopped = new AbortController(); stopped.abort(); const replayPhases: string[] = []; const replayUrls: Array<string | null> = [];
    timingInvocation = 'replay'; timingInvocationStarted = timingClock();
    const replay = await timedAsync('mission.replay', () => runResourceEngineeringMission(f.config, { signal: stopped.signal,
      onProgress(value) { replayPhases.push(`${value.scope}:${value.phase}`); reportPhase(value); replayUrls.push(value.consoleUrl); } }));
    expect(replay).toEqual(second); expect(replayPhases).toContain('2:reconciling');
    // Observer exceptions are intentionally isolated by the runner, so assertions
    // belong outside that callback where a regression can actually fail the test.
    expect(replayUrls.every(url => url === null)).toBe(true);
    expect(f.calls).toEqual({ generation: 3, successor: 2, mission: 1 });
    expect(readEngineeringMissionRecords(f.config)).toEqual(final);
    const invocations = readEngineeringMissionInvocations(f.config);
    expect(invocations).toMatchObject({ count: 3, unfinishedCount: 0,
      latest: { index: 3, outcome: { state: 'completed', reason: 'stop-requested', scopesReserved: 2 } } });
    expect(invocations.latest!.timings.some(row => row.phase === 'reconciling')).toBe(true);
  }, 1800_000);
});

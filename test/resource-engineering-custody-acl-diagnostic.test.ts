/** Diagnostic, not a latency gate. Actual host ACL subprocesses and fixed proof/setup
 * workers remain enabled; no task, model or evaluator executes. Counts cover this
 * host thread only, not the separate workers' private-storage adapters. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { canonical } from '../src/core/universe/artifacts.js';
import { PRIVATE_STORAGE_TEST_CONTROL, _setPrivateStorageTestControlForTest } from '../src/core/util/private-storage.js';
import { createResourcePoolSupervisor, type ResourcePoolSupervisor } from '../src/core/resources/pool-supervisor.js';
import { createResourceWorkspaceCustody } from '../src/core/resources/workspace-custody.js';
import { validateResourcePool, type ResourceObservation } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';
import { resourcePoolStatus, setResourcePoolAllocation } from '../src/core/resources/pool-runtime.js';
import { checkResourceEngineeringAutonomousSetup, type ResourceEngineeringAutonomousSetupOptions } from '../src/core/resources/engineering-autonomous-setup.js';
import { readEngineeringMissionProof } from '../src/core/resources/engineering-mission-proof.js';
import { prepareEngineeringMissionSetup } from '../src/core/resources/engineering-setup.js';

type Phase = 'fixture' | 'direct-proof' | 'fixed-proof' | 'setup' | 'cleanup';
type Caller = 'setup-timer' | 'proof-timer' | 'rpc' | 'other';
type Measurement = { wallMs: number; aclCalls: number; aclMs: number; callers: Record<Caller, { count: number; ms: number }> };
const fresh = (): Measurement => ({ wallMs: 0, aclCalls: 0, aclMs: 0,
  callers: { 'setup-timer': { count: 0, ms: 0 }, 'proof-timer': { count: 0, ms: 0 }, rpc: { count: 0, ms: 0 }, other: { count: 0, ms: 0 } } });
const save = (path: string, value: unknown) => writeFileSync(path, `${canonical(value)}\n`, { mode: 0o600 });
function classifyCaller(stack: string): Caller {
  // V8 labels the original anonymous callback Timeout._onTimeout, but the
  // completion-relative helper's named callback Timeout.check [as _onTimeout].
  // Require both a timer frame and the fixed helper for the new spelling.
  const timer = stack.includes('Timeout._onTimeout') ||
    stack.includes('Timeout.') && /engineering-active-monitor\.(?:ts|js)/.test(stack);
  return timer && /engineering-setup\.(?:ts|js)/.test(stack) ? 'setup-timer'
    : timer && /engineering-mission-proof\.(?:ts|js)/.test(stack) ? 'proof-timer'
      : /engineering-worker-rpc\.(?:ts|js)/.test(stack) ? 'rpc' : 'other';
}
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args],
    { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}

describe.runIf(process.platform === 'darwin')('real host custody ACL diagnostic', () => {
  it('recognizes original and helper timer frames without reclassifying RPC', () => {
    for (const source of ['engineering-setup.ts', 'engineering-mission-proof.ts']) {
      const expected = source === 'engineering-setup.ts' ? 'setup-timer' : 'proof-timer';
      expect(classifyCaller(`at assertActive (${source}:49)\nat Timeout._onTimeout (${source}:74)`)).toBe(expected);
      expect(classifyCaller(`at assertActive (${source}:49)\nat Timeout.check [as _onTimeout] (engineering-active-monitor.ts:12)`)).toBe(expected);
      expect(classifyCaller(`at assertActive (${source}:49)\nat handle (engineering-worker-rpc.ts:20)`)).toBe('rpc');
    }
    expect(classifyCaller('at Timeout.check (unrelated.ts:12)')).toBe('other');
  });
  it('measures timer-attributed ACL work while preserving fixed-worker proof and setup results', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'custody-acl-diagnostic-')));
    const root = join(base, 'ledger'), workspace = join(base, 'project'), transport = join(base, 'transport'), output = join(base, 'setup');
    let phase: Phase = 'fixture'; let started = performance.now(); let owner: ResourcePoolSupervisor | undefined;
    const measurements: Record<Phase, Measurement> = { fixture: fresh(), 'direct-proof': fresh(), 'fixed-proof': fresh(), setup: fresh(), cleanup: fresh() };
    const next = (value: Phase) => { measurements[phase].wallMs += performance.now() - started; phase = value; started = performance.now(); };
    let observed = 0, called = 0; let caller: Caller = 'other';
    const oldStackLimit = Error.stackTraceLimit; Error.stackTraceLimit = 80;
    _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, {
      observeInvocation(invocation) {
        // Keep only fixed labels, never paths, arguments, output or stack text.
        expect(invocation.executable).toBe('/bin/ls'); expect(invocation.args[0]).toBe('-lde');
        caller = classifyCaller(new Error().stack ?? '');
        observed++; measurements[phase].aclCalls++; measurements[phase].callers[caller].count++;
      },
      runner(invocation) {
        // Exact default-runner options from private-storage.ts; results pass
        // straight back to its real ACL parser and fail-closed validation.
        const before = performance.now(); called++;
        try { return spawnSync(invocation.executable, invocation.args, {
          input: invocation.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          timeout: invocation.timeoutMs, maxBuffer: invocation.maxBuffer, windowsHide: true, shell: false,
          ...(invocation.env ? { env: invocation.env } : {}),
        }); } finally {
          const elapsed = performance.now() - before; measurements[phase].aclMs += elapsed; measurements[phase].callers[caller].ms += elapsed;
        }
      },
    });
    let passed = false, cleanupConfirmed = false;
    try {
      for (const path of [root, workspace, transport, output]) mkdirSync(path, { mode: 0o700 });
      for (const path of [workspace, transport]) git(path, 'init', '-q', '--template=', '--initial-branch=main');
      writeFileSync(join(workspace, 'value.json'), '0\n');
      writeFileSync(join(workspace, 'evaluate.mjs'), 'throw Error("Diagnostic must not execute evaluator");\n');
      git(workspace, 'add', '.'); git(workspace, '-c', 'user.name=Diagnostic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixed diagnostic seed');
      const pool = validateResourcePool({ schemaVersion: 1, id: 'diagnostic', workers: [{ id: 'worker', provider: 'local', model: 'inert',
        maxConcurrent: 1, reservePercent: 25, maxTasksPerWindow: 3, taskWindowMs: 60_000, priority: 1 }] });
      const bindings = validateResourceBindings([{ workerId: 'worker', capacityKey: 'fixture', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
      const at = Date.now(); const observations: ResourceObservation[] = [{ workerId: 'worker', health: 'ready', windows: [], retryAfter: null,
        observedAt: new Date(at - 100).toISOString(), expiresAt: new Date(at + 120_000).toISOString() }];
      const poolPath = join(base, 'pool.json'), bindingsPath = join(base, 'bindings.json'), observationsPath = join(base, 'observations.json');
      save(poolPath, pool); save(bindingsPath, bindings); save(observationsPath, observations);
      const resourceRuntime = join(base, 'runtime.json'), projectsFile = join(base, 'projects.json');
      save(resourceRuntime, { schemaVersion: 1, root, workspace: transport, poolPath, bindingsPath, observationsPath });
      save(projectsFile, { schemaVersion: 1, projects: [] }); setResourcePoolAllocation(root, pool, bindings, 75, 0);
      owner = await createResourcePoolSupervisor({ root, workspace, projects: [], pool, bindings, readObservations: () => observations });
      const custody = createResourceWorkspaceCustody(owner, null, () => {});
      const options: ResourceEngineeringAutonomousSetupOptions = { workspace, output, resourceRuntime, projectsFile,
        recipe: { schemaVersion: 1, id: 'repair', name: 'Diagnostic repair', objective: 'Improve measured value', projectId: 'default',
          seedRevision: git(workspace, 'rev-parse', 'HEAD'), metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
          evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 1000 },
          trialBudget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 10_000, trialTimeoutMs: 5000 },
          campaignBudget: { maxGenerations: 1, maxDurationMs: 20_000, maxModelRequests: 1, maxStagnantGenerations: 1, maxReportedTokens: null },
          generation: { files: ['value.json'], contextFiles: ['evaluate.mjs'], allowedWorkerIds: ['worker'], maxOutputTokens: 128,
            hypotheses: [{ id: 'first', niche: 'value', hypothesis: 'First approach' }] },
          delivery: { branch: 'codex/repair', allowInitialRepair: true },
          execution: { maxDurationMs: 30_000, constitutionVersion: 'fixture-v1', policyEpoch: 1 },
          supervision: { maxDurationMs: 60_000, pollIntervalMs: 1000, maxAttemptsPerEnrollment: 2 } },
        policy: { schemaVersion: 1, id: 'fleet', profileId: 'fixed', label: 'Fixed evaluation', acceptance: 'Measured fixture only',
          maxEnrollments: 2, maxConcurrent: 1, successors: { allowedWorkerIds: ['worker'], maxOutputTokens: 128,
            proposalTimeoutMs: 5000, maxSuccessors: 1, pollIntervalMs: 1000 } } };
      const consoleBefore = readFileSync(join(root, 'resource-console-state.json')); const poolBefore = readFileSync(join(root, 'pool-state.json'));
      next('direct-proof'); const expected = checkResourceEngineeringAutonomousSetup(options, custody);
      next('fixed-proof'); const proof = await readEngineeringMissionProof({ kind: 'setup', input: options }, {
        custody, lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
      expect(proof).toEqual(expected); expect(readdirSync(output)).toEqual([]);
      next('setup'); const result = await prepareEngineeringMissionSetup({ input: { ...options, expectedPlanDigest: expected.planDigest } }, {
        custody, lifetime: { deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
      expect(result).toMatchObject({ status: 'prepared', disposition: 'created', planDigest: expected.planDigest,
        executionStarted: false, providerContacted: false });
      expect(readFileSync(join(root, 'resource-console-state.json'))).toEqual(consoleBefore);
      expect(readFileSync(join(root, 'pool-state.json'))).toEqual(poolBefore);
      expect(resourcePoolStatus(root, pool, bindings, observations).attempts).toEqual([]);
      expect(owner.snapshot().jobs).toEqual([]);
      expect(measurements['fixed-proof'].callers['proof-timer'].count).toBeGreaterThan(0);
      expect(measurements.setup.callers['setup-timer'].count).toBeGreaterThan(0);
      expect(observed).toBe(called); passed = true;
    } finally {
      next('cleanup');
      try {
        if (owner) await owner.close();
        expect(existsSync(join(root, '.resource-console.lock'))).toBe(false);
        cleanupConfirmed = true;
      } finally {
        measurements.cleanup.wallMs += performance.now() - started;
        _setPrivateStorageTestControlForTest(PRIVATE_STORAGE_TEST_CONTROL, undefined); Error.stackTraceLimit = oldStackLimit;
        try {
          // Only our closed temporary fixture: immutable seed directories need
          // owner write permission before removal, as in setup acceptance tests.
          if (passed && cleanupConfirmed) {
            cleanupConfirmed = false;
            const writable = (path: string): void => {
              if (!lstatSync(path).isDirectory()) return;
              chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
            };
            writable(base); rmSync(base, { recursive: true, force: true });
            cleanupConfirmed = true;
          }
        } finally {
          // Sanitized counts/times only; unsuccessful fixtures remain private.
          process.stdout.write(`CUSTODY_ACL_DIAGNOSTIC ${JSON.stringify({ schemaVersion: 1, passed: passed && cleanupConfirmed,
            scope: 'host-thread-only-real-acl-subprocesses', observations: observed, calls: called, measurements })}\n`);
        }
      }
    }
  }, 120_000);
});

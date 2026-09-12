/** Real failed diagnostics establish custody, not accepted scores or full benchmark success.
 * The second case injects only loss of an already-returned evaluator fact. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectBuiltinActivity, type BuiltinActivityOwner } from '../scripts/evaluators/preparation-verification-activity.mjs';
import { resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { readBuiltinTrialCustody } from '../src/core/universe/builtin-trial-custody.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';
import { parsePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import { runUniverse } from '../src/core/universe/runner.js';
import { initUniverse, manifestRecord, parseEvaluation, readRecords, readUniverseOverview, universePath } from '../src/core/universe/store.js';

const cleanup = vi.hoisted(() => ({ paths: new Set<string>(), results: new Map<string, Array<string | null>>() }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    const path = typeof args[0] === 'string' && cleanup.paths.has(args[0]) ? args[0] : null;
    try {
      const result = actual.rmSync(...args);
      if (path) cleanup.results.set(path, [...cleanup.results.get(path) ?? [], null]);
      return result;
    } catch (error) {
      if (path) {
        const code = (error as NodeJS.ErrnoException).code;
        cleanup.results.set(path, [...cleanup.results.get(path) ?? [], typeof code === 'string' ? code : 'UNKNOWN']);
        console.info('BUILTIN_TRIAL_CLEANUP', JSON.stringify({ errorCode: typeof code === 'string' ? code : 'UNKNOWN' }));
      }
      throw error; // Observe only: native operation and thrown error are unchanged.
    }
  } };
});

const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const target = 'src/core/resources/engineering-preparation.ts';
let root: string | undefined;
let preserveRoot = false;

afterEach(() => {
  vi.restoreAllMocks();
  if (!root) return;
  if (preserveRoot) {
    console.warn(`Builtin trial custody acceptance retained potentially unsettled private fixture: ${root}`);
    root = undefined;
    return;
  }
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(root);
  rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture() {
  cleanup.paths.clear();
  cleanup.results.clear();
  preserveRoot = false;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'builtin-trial-custody-acceptance-')));
  const repo = join(root, 'repository'), store = join(root, 'universe');
  mkdirSync(join(repo, dirname(target)), { recursive: true, mode: 0o700 });
  // Real candidate initialization succeeds, then the first trusted comparison fails.
  writeFileSync(join(repo, target), 'export function checkResourceEngineeringPreparation() { return null; }\n' +
    'export function readPreparedResourceEngineeringMetadata() { return null; }\n', { mode: 0o600 });
  const installed = resolveBuiltinEvaluator('preparation-measurement-v1');
  const git = (...args: string[]) => execFileSync(installed.git.path,
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
      encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  git('init', '-q', '--template=', '--initial-branch=main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Deliberately invalid diagnostic candidate');
  const revision = git('rev-parse', 'HEAD');
  initUniverse({ schemaVersion: 1, id: 'custody', name: 'Builtin trial custody fixture', objective: 'Establish failed diagnostic custody, never a score',
    seed: { repo, revision }, metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 60000, trialTimeoutMs: 60000 },
    evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: 60000 },
    variants: [{ id: 'inert', niche: 'fixture', hypothesis: 'Leave candidate unchanged', command: [process.execPath, '-e', 'process.exit(0)'] }],
  }, { root: store });
  return { store, directory: universePath(store, 'custody') };
}

function assertFailedDiagnostic(result: Awaited<ReturnType<typeof evaluator.runFixedUniverseEvaluator>>) {
  expect(result.processGroupSettlement).toBe('group-exit-confirmed');
  expect(result.timedOut).toBe(false);
  expect(result.cancelled).toBe(false);
  expect(result.error).toBeUndefined();
  expect(parsePreparationMeasurementReport(result.stdout)).toMatchObject({ checksPassed: false,
    metrics: { correctness_checks: 0 }, workflows: [], diagnostics: [{ code: 'CANDIDATE_BEHAVIOR_FAILED' }] });
  expect(() => parseEvaluation(result.stdout)).toThrow();
}

function hasOwnedNonwritableDirectory(path: string): boolean {
  const pending = [path];
  let inspected = 0;
  while (pending.length) {
    if (++inspected > 4096) throw new Error('Cleanup fixture inspection limit exceeded');
    const current = pending.pop()!;
    const stat = lstatSync(current);
    // Read-only diagnosis: never follow links or change candidate-controlled modes.
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    if (stat.uid === process.getuid!() && (stat.mode & 0o200) === 0) return true;
    const names = readdirSync(current);
    if (inspected + pending.length + names.length > 4096) throw new Error('Cleanup fixture inspection limit exceeded');
    for (const name of names) pending.push(join(current, name));
  }
  return false;
}

describe.runIf(supported)('actual installed builtin ordinary-trial custody', () => {
  it('records confirmed failed diagnostics with best-effort scratch cleanup and admits the next generation without an elite', async () => {
    const f = fixture();
    const original = evaluator.runFixedUniverseEvaluator;
    const assertCleanup = (path: string): void => {
      const outcomes = cleanup.results.get(path);
      expect(outcomes).toHaveLength(1);
      if (!existsSync(path)) expect(outcomes).toEqual([null]);
      else {
        // The installed fixture freezes nested seed directories. Settlement is
        // process custody, not proof that the existing best-effort rm succeeded.
        // Node's recursive removal may surface ENOTEMPTY for the parent of a
        // protected descendant; the bounded mode check is still mandatory.
        expect(['EACCES', 'EPERM', 'ENOTEMPTY']).toContain(outcomes![0]);
        expect(hasOwnedNonwritableDirectory(path)).toBe(true);
      }
    };
    const observed: Array<Awaited<ReturnType<typeof original>>> = [];
    const call = vi.spyOn(evaluator, 'runFixedUniverseEvaluator').mockImplementation(async (...args) => {
      preserveRoot = true;
      cleanup.paths.add(dirname(args[4]));
      const result = await original(...args);
      observed.push(result);
      if (result.processGroupSettlement === 'group-exit-confirmed') preserveRoot = false;
      return result;
    });
    preserveRoot = true;
    const first = await runUniverse('custody', { root: f.store });
    expect(call).toHaveBeenCalledOnce();
    assertFailedDiagnostic(observed[0]!);
    expect(first).toMatchObject({ status: 'completed', generation: 1, trials: [{ status: 'failed', score: null, selected: false }] });
    const firstRows = readBuiltinTrialCustody(f.directory);
    expect(firstRows).toHaveLength(2);
    expect(firstRows.map(row => row.kind).sort()).toEqual(['intent', 'settlement']);
    const intent = firstRows.find(row => row.kind === 'intent')!.intent;
    expect(intent).toMatchObject({ runId: first.id, trialId: first.trials[0]!.id,
      evaluatorDigest: manifestRecord(f.directory).evaluationBuiltinDigest });
    expect(firstRows.find(row => row.kind === 'settlement')!.settlement?.state).toBe('group-exit-confirmed');
    assertCleanup(intent.scratchPath);
    expect(readUniverseOverview({ root: f.store }).universes[0]!.elites).toEqual([]);

    preserveRoot = true;
    const second = await runUniverse('custody', { root: f.store });
    expect(call).toHaveBeenCalledTimes(2);
    assertFailedDiagnostic(observed[1]!);
    expect(second).toMatchObject({ status: 'completed', generation: 2, trials: [{ status: 'failed', score: null, selected: false }] });
    const rows = readBuiltinTrialCustody(f.directory);
    expect(rows).toHaveLength(4);
    expect(rows.filter(row => row.intent.runId === first.id)).toEqual(firstRows);
    for (const row of rows.filter(row => row.kind === 'intent')) assertCleanup(row.intent.scratchPath);
    expect(readUniverseOverview({ root: f.store }).universes[0]!.elites).toEqual([]);
    expect(existsSync(join(f.directory, '.execution.lock'))).toBe(false);
  }, 180000);

  it('retains custody and scratch when the actual settled evaluator return is deliberately lost', async () => {
    const f = fixture();
    const original = evaluator.runFixedUniverseEvaluator;
    let actual: Awaited<ReturnType<typeof original>> | undefined;
    let evaluatorScratch: string | undefined;
    const call = vi.spyOn(evaluator, 'runFixedUniverseEvaluator').mockImplementation(async (...args) => {
      preserveRoot = true;
      evaluatorScratch = args[4];
      actual = await original(...args);
      // This is deliberately injected return loss, not a claim of real process leakage.
      // Keep the fixture if native custody itself was not confirmed.
      assertFailedDiagnostic(actual);
      throw new Error('Injected loss of confirmed evaluator return');
    });
    preserveRoot = true;
    const run = await runUniverse('custody', { root: f.store });
    expect(call).toHaveBeenCalledOnce();
    expect(actual).toBeDefined();
    assertFailedDiagnostic(actual!);
    expect(run).toMatchObject({ status: 'failed', trials: [{ score: null, selected: false }] });
    const rows = readBuiltinTrialCustody(f.directory);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'intent', settlement: null, intent: { runId: run.id } });
    expect(existsSync(rows[0]!.intent.scratchPath)).toBe(true);
    const activityNames = readdirSync(evaluatorScratch!).filter(name => name.startsWith('builtin-activity-'));
    expect(activityNames).toHaveLength(1);
    const activityRoot = join(evaluatorScratch!, activityNames[0]!);
    const owner = JSON.parse(readFileSync(join(activityRoot, 'owner.json'), 'utf8')) as BuiltinActivityOwner;
    expect(inspectBuiltinActivity(activityRoot, owner)).toBe(true);
    // Only this fresh kernel-backed aggregate check permits fixture cleanup.
    preserveRoot = false;
    expect(readUniverseOverview({ root: f.store }).universes[0]!.elites).toEqual([]);
    const records = readRecords(f.directory);
    await expect(runUniverse('custody', { root: f.store })).rejects.toThrow(/unresolved|unsettled|held/i);
    expect(call).toHaveBeenCalledOnce();
    expect(readRecords(f.directory)).toEqual(records);
    expect(readBuiltinTrialCustody(f.directory)).toEqual(rows);
    expect(existsSync(rows[0]!.intent.scratchPath)).toBe(true);
    expect(existsSync(join(f.directory, '.execution.lock'))).toBe(false);
  }, 120000);
});

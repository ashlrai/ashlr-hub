/** Real installed qualification, with fixed fixtures and no provider/model calls.
 * Counter regions remain diagnostic; these tests do not accept an optimization. */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactDigest, freezeArtifact } from '../src/core/universe/artifacts.js';
import { resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { runFixedUniverseEvaluator } from '../src/core/universe/fixed-evaluator.js';
import * as verify from '../src/core/run/verify-commands.js';
import { initUniverse, manifestRecord, parseEvaluation, readRecords, universePath } from '../src/core/universe/store.js';
import { parsePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import { extractPreparationScenarioVector, PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import { createBuiltinActivityTracker, initializeBuiltinActivity, inspectBuiltinActivity,
  type BuiltinActivityOwner } from '../scripts/evaluators/preparation-verification-activity.mjs';
import type { PreparationGitPin } from '../scripts/evaluators/preparation-verification-native.mjs';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const target = 'src/core/resources/engineering-preparation.ts';
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const DURATION = 900_000;
const TEST_DURATION = DURATION + 60_000; // Teardown allowance, never an evaluator/session renewal.
// Full diagnostic includes the benchmark and both qualification sessions. Worker trials and focused controls retain their own bound.
const FULL_DIAGNOSTIC_DURATION = 1_800_000;
const FULL_TEST_DURATION = FULL_DIAGNOSTIC_DURATION + 60_000;
const CHECKPOINTS = new Set(['initialize', 'manager:setup', 'manager:startup', 'manager:manager-open',
  'manager:bundle', 'manager:manager-check', 'manager:manager-replay', 'manager:manager-check:changed-evidence',
  'manager:manager-replay:changed-evidence', 'manager:close', 'manager:shutdown', 'successor:setup',
  'successor:startup', 'successor:successor-check', 'successor:successor-metadata', 'successor:successor-bundle',
  'successor:successor-metadata:changed-evidence', 'successor:shutdown', 'qualification:runtime-drift', 'qualification:source-drift']);
function executionDiagnostics(result: Awaited<ReturnType<typeof runFixedUniverseEvaluator>>, started: number) {
  let report: ReturnType<typeof parsePreparationMeasurementReport> | null = null;
  try { report = parsePreparationMeasurementReport(result.stdout); } catch { /* Unknown is not zero progress. */ }
  const reportedCheckpoint = report?.diagnostics[0]?.message.match(
    /^Pinned verification workload did not satisfy its fixed checks at ([a-z:-]+)\.$/)?.[1];
  const transport = { code: Number.isSafeInteger(result.exitCode) ? result.exitCode : null,
    signal: result.signal === null ? null : ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(result.signal) ? result.signal : 'other',
    hasRunnerError: result.error !== undefined, stderrBytes: Buffer.byteLength(result.stderr),
    timedOut: result.timedOut, cancelled: result.cancelled, hasTruncationFlag: result.outputTruncated !== undefined,
    settlement: ['not-started', 'group-exit-confirmed', 'unconfirmed'].includes(result.processGroupSettlement ?? '')
      ? result.processGroupSettlement : 'unknown' };
  // Emit before assertions; never expose runner errors, diagnostic prose, or fixture paths.
  console.log(JSON.stringify({ kind: 'qualification-native-execution', scope: 'diagnostic-only',
    elapsedMs: Math.round(performance.now() - started), ...transport,
    custodyBoundary: result.custodyDiagnostics?.boundary ?? null,
    reportBytes: Buffer.byteLength(result.stdout), reportSha256: createHash('sha256').update(result.stdout).digest('hex'),
    reportValid: report !== null, workload: report?.workload ?? null, checksPassed: report?.checksPassed ?? null,
    checks: report?.metrics.correctness_checks ?? null, diagnosticCodes: report?.diagnostics.map(row => row.code) ?? null,
    checkpoint: reportedCheckpoint && CHECKPOINTS.has(reportedCheckpoint) ? reportedCheckpoint : null,
    workflows: report?.workflows.map(row => ({ name: row.name, requests: row.requests.length })) ?? null,
    qualifications: report?.qualifications?.map(row => ({ name: row.name, requests: row.requests.length, injections: row.injections })) ?? null }));
  return transport;
}
type Counts = { processes: number; blobProcesses: number };
type Qualification = Counts & { name: 'runtime-drift' | 'source-drift'; injections: 1;
  requests: Array<Counts & { id: number; method: string }> };
type Activity = ReturnType<typeof createBuiltinActivityTracker>;
interface Fixture {
  options: { config?: { resourceRuntime: string }; [key: string]: unknown };
  runtime?: { capacityWaitMs: number };
  receipt?: { commit: string };
  revision?: string;
  git?: (...args: string[]) => string;
}
interface InstalledFixtures {
  createPreparationWorkflowFixture(kind: 'manager' | 'successor', base: string,
    options: { activity: Activity; signal: AbortSignal; deadlineAt: string }, gitPin: PreparationGitPin): Promise<{ fixture: Fixture }>;
}
interface InstalledQualifier {
  qualifyPreparationCandidate(options: {
    name: Qualification['name']; fixture: Fixture; bridge: unknown; bridgePath: string;
    candidateRoot: string; fixtureRoot: string; workRoot: string; activity: Activity; signal: AbortSignal;
    gitPin: PreparationGitPin; deadlineAt: number; deadlineMonotonicMs: number;
  }): Promise<Qualification>;
}
let root: string | undefined, safeToRemove = true;
function privateRoot(): string {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-qualified-acceptance-')));
  safeToRemove = true; return root;
}
function candidate(base: string, text: string): string {
  const path = join(base, 'candidate'); mkdirSync(join(path, dirname(target)), { recursive: true, mode: 0o700 });
  writeFileSync(join(path, target), text, { mode: 0o600 }); freezeArtifact(path); return path;
}
function assertActivity(directory: string, owner: BuiltinActivityOwner, key?: string): void {
  expect(inspectBuiltinActivity(directory, owner, key)).toBe(true);
  const spawned = readdirSync(directory).filter(name => /^spawned-[1-9][0-9]*\.json$/.test(name));
  expect(spawned.length).toBeGreaterThan(0);
  for (const name of spawned) {
    const row = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { pgid: number };
    expect(Number.isSafeInteger(row.pgid) && row.pgid > 0).toBe(true);
    if (owner.schemaVersion === 1) {
      let absent = false;
      try { process.kill(-row.pgid, 0); } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      expect(absent).toBe(true);
    }
  }
}
function assertQualification(row: Qualification, name: Qualification['name']): void {
  expect(Object.keys(row).sort()).toEqual(['blobProcesses', 'injections', 'name', 'processes', 'requests']);
  expect(row.name).toBe(name); expect(row.injections).toBe(1);
  const method = name === 'runtime-drift' ? 'metadata' : 'successor-metadata';
  expect(row.requests.map(request => [request.id, request.method])).toEqual([[1, method], [2, method]]);
  for (const request of row.requests) {
    expect(Object.keys(request).sort()).toEqual(['blobProcesses', 'id', 'method', 'processes']);
    expect(Number.isSafeInteger(request.processes) && request.processes > 0).toBe(true);
    expect(Number.isSafeInteger(request.blobProcesses) && request.blobProcesses >= 0 && request.blobProcesses <= request.processes).toBe(true);
  }
  expect(row.processes).toBe(row.requests.reduce((total, request) => total + request.processes, 0));
  expect(row.blobProcesses).toBe(row.requests.reduce((total, request) => total + request.blobProcesses, 0));
}
afterEach(() => {
  vi.restoreAllMocks();
  if (!root) return;
  if (!safeToRemove) { console.warn(`Qualification acceptance retained unconfirmed fixture: ${root}`); root = undefined; return; }
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(root); rmSync(root, { recursive: true, force: true }); root = undefined;
});

describe.runIf(supported)('installed qualified preparation workload', () => {
  it('runs the actual default builtin with 23 checks, two qualifications and the same fifteen benchmark regions', async () => {
    const dispatch = vi.spyOn(verify, 'runVerifySubprocessAsync'); // Call-through; retains key only in test memory.
    const base = privateRoot(), installed = resolveBuiltinEvaluator('preparation-measurement-v1');
    const source = readFileSync(join(repository, target), 'utf8');
    const repo = join(base, 'repository'), store = join(base, 'universe'), scratch = join(base, 'scratch');
    mkdirSync(join(repo, dirname(target)), { recursive: true, mode: 0o700 }); mkdirSync(scratch, { mode: 0o700 });
    writeFileSync(join(repo, target), source, { mode: 0o600 });
    const git = (...args: string[]) => execFileSync(installed.git.path,
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
      }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '--', target);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Unchanged qualification candidate');
    const revision = git('rev-parse', 'HEAD'), refs = git('for-each-ref', '--format=%(refname):%(objectname)');
    initUniverse({ schemaVersion: 1, id: 'qualified', name: 'Installed qualification acceptance', objective: 'Measure fixed correctness only',
      seed: { repo, revision }, metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: FULL_DIAGNOSTIC_DURATION, trialTimeoutMs: DURATION },
      evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: FULL_DIAGNOSTIC_DURATION },
      variants: [{ id: 'inert', niche: 'fixture', hypothesis: 'Never dispatched by this test', command: [process.execPath, '-e', 'process.exit(91)'] }],
    }, { root: store });
    const directory = universePath(store, 'qualified'), record = manifestRecord(directory), records = readRecords(directory);
    const before = artifactDigest(record.seedArtifact.path);
    expect(readFileSync(join(record.seedArtifact.path, target), 'utf8')).toBe(source);
    safeToRemove = false;
    const executionStarted = performance.now();
    const result = await runFixedUniverseEvaluator(record, store, record.seedArtifact.path, before, scratch,
      FULL_DIAGNOSTIC_DURATION, new AbortController().signal, { HOME: scratch, TMPDIR: scratch, ASHLR_UNIVERSE_CANDIDATE: record.seedArtifact.path }, true);
    const transport = executionDiagnostics(result, executionStarted);
    const activityNames = readdirSync(scratch).filter(name => name.startsWith('builtin-activity-'));
    expect(activityNames).toHaveLength(1);
    const activityRoot = join(scratch, activityNames[0]!);
    const owner = JSON.parse(readFileSync(join(activityRoot, 'owner.json'), 'utf8')) as BuiltinActivityOwner;
    const key = dispatch.mock.calls.find(([, options]) => options.cwd === scratch)?.[1].input;
    expect(typeof key).toBe('string'); expect(owner.schemaVersion).toBe(2);
    if (result.processGroupSettlement === 'group-exit-confirmed' && inspectBuiltinActivity(activityRoot, owner, key)) {
      assertActivity(activityRoot, owner, key); safeToRemove = true;
    }
    expect(transport).toEqual({
      code: 0, signal: null, hasRunnerError: false, stderrBytes: 0, timedOut: false, cancelled: false,
      hasTruncationFlag: false, settlement: 'group-exit-confirmed',
    });
    expect(safeToRemove).toBe(true);
    const parsed = parsePreparationMeasurementReport(result.stdout);
    expect(parsed).toMatchObject({ workload: 'preparation-workflows-v2', checksPassed: true, metrics: { correctness_checks: 23 }, diagnostics: [] });
    const qualifications = (parsed as unknown as { qualifications: Qualification[] }).qualifications;
    expect(qualifications.map(row => row.name)).toEqual(['runtime-drift', 'source-drift']);
    qualifications.forEach((row, index) => assertQualification(row, index ? 'source-drift' : 'runtime-drift'));
    const vector = extractPreparationScenarioVector(result.stdout);
    expect(vector.map(row => row.key)).toEqual(PREPARATION_SCENARIO_KEYS); expect(vector).toHaveLength(15);
    expect(parsed.workflows.map(row => row.requests.length)).toEqual([7, 4]);
    expect(vector.reduce((sum, row) => sum + row.processes, 0)).toBe(parsed.metrics.verification_processes! + parsed.metrics.workflow_processes!);
    expect(parsed.metrics.workflow_processes).toBe(parsed.workflows.reduce((sum, row) => sum + row.processes, 0));
    expect(() => parseEvaluation(result.stdout)).toThrow();
    expect(readRecords(directory)).toEqual(records); expect(artifactDigest(record.seedArtifact.path)).toBe(before);
    expect(git('for-each-ref', '--format=%(refname):%(objectname)')).toBe(refs);
    expect(resolveBuiltinEvaluator('preparation-measurement-v1').digest).toBe(installed.digest);
    console.log(JSON.stringify({ scope: 'diagnostic-only', workload: parsed.workload, checks: parsed.metrics.correctness_checks,
      benchmarkRegions: vector.length, benchmarkProcesses: vector.reduce((sum, row) => sum + row.processes, 0), qualifications,
      reportSha256: createHash('sha256').update(result.stdout).digest('hex'), settlement: result.processGroupSettlement }));
  }, FULL_TEST_DURATION);
});

function staleSource(source: string, name: Qualification['name']): string {
  const anchor = name === 'runtime-drift'
    ? "if (capture(options, successor).plan.planDigest !== expectedPlanDigest) fail('CONFLICT', 'Preparation inputs changed during inspection');"
    : "const assertSource = () => {\n    if (canonical(readUniverseCampaignDeliverySource(source, requestDigest)) !== canonical(origin)) fail('CONFLICT', 'Successor source changed');\n  };";
  expect(source.split(anchor)).toHaveLength(2);
  const changed = source.replace(anchor, name === 'runtime-drift' ? '// Deliberately omitted final capture.' : 'const assertSource = () => {};');
  expect(changed).not.toBe(source);
  const syntax = ts.transpileModule(changed, { fileName: 'engineering-preparation.ts', reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } });
  expect(syntax.diagnostics ?? []).toEqual([]); return changed;
}
describe.runIf(supported)('fixed packaged same-call qualification controls', () => {
  it.each([
    ['runtime-drift', 'current'], ['runtime-drift', 'stale'], ['source-drift', 'current'], ['source-drift', 'stale'],
  ] as const)('%s %s uses a proved mutation and distinguishes stale successful output from transport failure', async (name, kind) => {
    const base = privateRoot(), installed = resolveBuiltinEvaluator('preparation-measurement-v1');
    const bundle = dirname(installed.files.find(file => file.name === 'preparation-bridge.mjs')!.path);
    const bridgePath = join(bundle, 'preparation-bridge.mjs'), bridge: unknown = await import(pathToFileURL(bridgePath).href);
    const { createPreparationWorkflowFixture } = await import(pathToFileURL(join(bundle, 'preparation-verification-fixtures.mjs')).href) as InstalledFixtures;
    const { qualifyPreparationCandidate } = await import(pathToFileURL(join(bundle, 'preparation-verification-controller.mjs')).href) as InstalledQualifier;
    const original = readFileSync(join(repository, target), 'utf8');
    const candidateRoot = candidate(base, kind === 'current' ? original : staleSource(original, name));
    const candidateDigest = artifactDigest(candidateRoot);
    const fixtureRoot = join(base, 'fixture'), workRoot = join(base, 'work'), activityRoot = join(base, 'activity');
    for (const path of [fixtureRoot, workRoot, activityRoot]) mkdirSync(path, { mode: 0o700 });
    const deadlineAt = Date.now() + DURATION, deadlineMonotonicMs = performance.now() + DURATION;
    const key = randomBytes(32).toString('hex');
    const owner: BuiltinActivityOwner = { schemaVersion: 2, invocationId: randomBytes(32).toString('hex'),
      implementationDigest: installed.digest, deadlineAt: new Date(deadlineAt).toISOString() };
    initializeBuiltinActivity(activityRoot, owner); const activity = createBuiltinActivityTracker(activityRoot, key);
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), DURATION);
    safeToRemove = false;
    try {
      const { fixture } = await createPreparationWorkflowFixture(name === 'runtime-drift' ? 'manager' : 'successor', fixtureRoot,
        { activity, signal: abort.signal, deadlineAt: owner.deadlineAt }, installed.git);
      let returned: Qualification | undefined, error: unknown;
      try { returned = await qualifyPreparationCandidate({ name, fixture, bridge, bridgePath, candidateRoot, fixtureRoot, workRoot,
        activity, signal: abort.signal, gitPin: installed.git, deadlineAt, deadlineMonotonicMs }); }
      catch (caught) { error = caught; }
      // This production tracker and authenticated absence observations gate
      // teardown even when the expected result is a deliberate candidate refusal.
      activity.complete(); assertActivity(activityRoot, owner, key); safeToRemove = true;
      if (kind === 'current') { expect(error).toBeUndefined(); expect(returned).toBeDefined(); assertQualification(returned!, name); }
      else {
        expect(returned).toBeUndefined();
        // The fixed qualifier emits this code only after exactly one injected
        // mutation AND successful old metadata equality, followed by clean close.
        expect(error).toMatchObject({ code: 'CANDIDATE_QUALIFICATION_STALE_RESULT' });
      }
      if (name === 'runtime-drift') {
        const runtime = JSON.parse(readFileSync(fixture.options.config!.resourceRuntime, 'utf8')) as { capacityWaitMs: number };
        expect(runtime.capacityWaitMs).toBe(1000); expect(fixture.runtime!.capacityWaitMs).not.toBe(1000);
      } else expect(fixture.git!('rev-parse', '--verify', 'refs/heads/codex/upstream')).toBe(fixture.revision);
      expect(artifactDigest(candidateRoot)).toBe(candidateDigest);
      expect(readFileSync(join(repository, target), 'utf8')).toBe(original);
      expect(resolveBuiltinEvaluator('preparation-measurement-v1').digest).toBe(installed.digest);
    } finally { clearTimeout(timer); abort.abort(); }
  }, TEST_DURATION);
});

/** Actual failed diagnostic capture and immutable CLI replay; not full-success benchmark acceptance. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdUniverse } from '../src/cli/universe.js';
import { initUniverse, manifestRecord, parseEvaluation, readRecords, universePath } from '../src/core/universe/store.js';
import { artifactDigest } from '../src/core/universe/artifacts.js';
import { resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { readUniversePreparationMeasurementCapture } from '../src/core/universe/preparation-measurement-capture.js';
import { parsePreparationMeasurementReport } from '../src/core/universe/preparation-measurement-report.js';
import * as evaluator from '../src/core/universe/fixed-evaluator.js';

const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const target = 'src/core/resources/engineering-preparation.ts';
let root: string | undefined, preserveRoot = false;
function snapshot(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  return { ino: String(stat.ino), mode: String(stat.mode), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isSymbolicLink() ? { symlink: readlinkSync(path) } : stat.isDirectory()
      ? Object.fromEntries(readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]))
      : createHash('sha256').update(readFileSync(path)).digest('hex') };
}
afterEach(() => {
  vi.restoreAllMocks();
  if (!root) return;
  if (preserveRoot) { console.warn(`Capture acceptance retained unsettled private fixture: ${root}`); return; }
  const writable = (path: string): void => {
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700); for (const name of readdirSync(path)) writable(join(path, name));
  };
  writable(root); rmSync(root, { recursive: true, force: true }); root = undefined;
});

describe.runIf(supported)('installed failed diagnostic capture through the public CLI', () => {
  it('retains a real failed-check report, replays exact bytes into the inspector and never reruns the evaluator', async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-capture-acceptance-')));
    const repo = join(root, 'repository'), store = join(root, 'universe');
    mkdirSync(join(repo, dirname(target)), { recursive: true, mode: 0o700 });
    // Both required exports are callable. Startup succeeds and the first real
    // correctness comparison fails; no provider, model or candidate optimization.
    writeFileSync(join(repo, target), 'export function checkResourceEngineeringPreparation() { return null; }\n' +
      'export function readPreparedResourceEngineeringMetadata() { return null; }\n', { mode: 0o600 });
    const installed = resolveBuiltinEvaluator('preparation-measurement-v1');
    const git = (...args: string[]) => execFileSync(installed.git.path,
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-C', repo, ...args], {
        encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
      }).trim();
    git('init', '-q', '--template=', '--initial-branch=main'); git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Deliberately invalid diagnostic candidate');
    const revision = git('rev-parse', 'HEAD'), refs = git('for-each-ref', '--format=%(refname):%(objectname)');
    initUniverse({ schemaVersion: 1, id: 'capture', name: 'Diagnostic failure fixture', objective: 'Exercise diagnostic custody only',
      seed: { repo, revision }, metric: { name: 'verification_processes', direction: 'minimize', minImprovement: 1 },
      budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 60000, trialTimeoutMs: 60000 },
      evaluation: { builtin: 'preparation-measurement-v1', timeoutMs: 60000 },
      variants: [{ id: 'inert', niche: 'fixture', hypothesis: 'Never run this variant', command: [process.execPath, '-e', 'process.exit(91)'] }],
    }, { root: store });
    const directory = universePath(store, 'capture'), beforeRecords = readRecords(directory), record = manifestRecord(directory);
    const beforeRepo = snapshot(repo), beforeSeed = snapshot(record.seedArtifact.path);
    const run = vi.spyOn(evaluator, 'runFixedUniverseEvaluator'); // call-through; no evaluator seam override
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const args = ['preparation-measurement-capture', 'capture', '--root', store, '--capture', 'once'];
    preserveRoot = true;
    const exitCode = await cmdUniverse([...args, '--json']);
    const captured = readUniversePreparationMeasurementCapture({ root: store, universeId: 'capture', captureId: 'once' });
    // Only confirmed custody permits deleting a failed test's fixture later.
    if (captured.receipt?.processGroupSettlement === 'group-exit-confirmed' || captured.receipt?.processGroupSettlement === 'not-started') preserveRoot = false;
    expect(exitCode).toBe(1);
    expect(captured).toMatchObject({ state: 'recorded', scope: 'diagnostic-only', receipt: {
      outcome: 'captured', identityVerified: true, processGroupSettlement: 'group-exit-confirmed', report: { checksPassed: false },
      custodyDiagnostics: { boundary: 'completed', exitCode: 0, signalled: false },
    } });
    const work = join(directory, 'preparation-measurement-work', 'once');
    const activityRoot = join(work, readdirSync(work).find(name => name.startsWith('builtin-activity-'))!);
    expect(JSON.parse(readFileSync(join(activityRoot, 'owner.json'), 'utf8'))).toMatchObject({ schemaVersion: 2 });
    expect(JSON.parse(readFileSync(join(activityRoot, 'complete.json'), 'utf8'))).toMatchObject({
      schemaVersion: 2, settlementProof: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(run).toHaveBeenCalledOnce(); expect(errors).not.toHaveBeenCalled();
    const raw = captured.receipt!.report!.stdout;
    expect(parsePreparationMeasurementReport(raw)).toMatchObject({ checksPassed: false,
      metrics: { correctness_checks: 0 }, workflows: [], diagnostics: [{ code: 'CANDIDATE_BEHAVIOR_FAILED' }] });
    expect(() => parseEvaluation(raw)).toThrow();
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ scope: 'diagnostic-only', state: 'recorded',
      outcome: 'captured', disposition: 'created', report: { reportedChecksSatisfied: false } });
    expect(JSON.stringify(output.mock.calls)).not.toContain(root);
    expect(JSON.stringify(output.mock.calls)).not.toContain(parsePreparationMeasurementReport(raw).diagnostics[0]!.message);
    const recordRoot = join(directory, 'preparation-measurements', 'records');
    expect(readdirSync(recordRoot).sort()).toEqual(['once.intent.json', 'once.receipt.json']);
    for (const name of readdirSync(recordRoot)) expect(lstatSync(join(recordRoot, name)).mode & 0o777).toBe(0o600);
    expect(readRecords(directory)).toEqual(beforeRecords);
    expect(existsSync(join(store, 'campaigns'))).toBe(false);
    expect(existsSync(join(directory, '.execution.lock'))).toBe(false);
    expect(artifactDigest(record.seedArtifact.path)).toBe(record.seedArtifact.digest);
    expect(snapshot(record.seedArtifact.path)).toEqual(beforeSeed); expect(snapshot(repo)).toEqual(beforeRepo);

    const settled = snapshot(store);
    output.mockClear(); expect(await cmdUniverse([...args, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ disposition: 'replayed', state: 'recorded' });
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((...writeArgs: Parameters<typeof process.stdout.write>) => {
      const chunk = writeArgs[0]; chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const callback = writeArgs.find(value => typeof value === 'function'); if (typeof callback === 'function') callback();
      return true;
    });
    try { expect(await cmdUniverse([...args, '--report'])).toBe(1); }
    finally { stdout.mockRestore(); }
    expect(chunks.join('')).toBe(raw);
    expect(snapshot(store)).toEqual(settled); expect(run).toHaveBeenCalledOnce();
    const input = join(root, 'retained-report.json'); writeFileSync(input, chunks.join(''), { mode: 0o600 });
    output.mockClear(); expect(await cmdUniverse(['preparation-measurement', '--input', input, '--json'])).toBe(1);
    expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ scope: 'diagnostic-only', reportedChecksSatisfied: false,
      leafProcesses: null, workflowProcesses: null, diagnosticCodes: ['CANDIDATE_BEHAVIOR_FAILED'] });
    expect(readFileSync(input, 'utf8')).toBe(raw); expect(run).toHaveBeenCalledOnce();
    expect(snapshot(store)).toEqual(settled); expect(snapshot(repo)).toEqual(beforeRepo);
    expect(git('for-each-ref', '--format=%(refname):%(objectname)')).toBe(refs); expect(git('rev-parse', 'HEAD')).toBe(revision);
    expect(errors).not.toHaveBeenCalled();
  }, 120000);
});

/** Full real checkout/compiled-child acceptance, not preparation workload or
 * scoring acceptance. Calibration numbers/provenance below are synthetic input
 * to the explicit test authoring helper; no capture or score is installed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorPreparationTypecheckProject } from '../scripts/build-preparation-typecheck.mjs';
import { buildPreparationScoreBundle } from '../scripts/build-preparation-score.mjs';
import { createBuiltinActivityTracker, initializeBuiltinActivity, inspectBuiltinActivity } from '../scripts/evaluators/preparation-verification-activity.mjs';
import { runVerifySubprocessAsync } from '../src/core/run/verify-commands.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { deliveryGit } from '../src/core/universe/delivery-git.js';
import { inspectBuiltinEvaluatorBundle, inspectPreparationScoreBundle } from '../src/core/universe/builtin-evaluator-registry.js';
import { preparationCalibrationWorkload, type PreparationMeasurementCalibration } from '../src/core/universe/preparation-measurement-calibration.js';
import { PREPARATION_SCENARIO_KEYS } from '../src/core/universe/preparation-measurement-comparison.js';
import { PREPARATION_TYPECHECK_TARGET } from '../src/core/universe/preparation-typecheck-project.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
let root: string | undefined, output: string, source: string, sourceDigest: string, packageDigest: string, projectDigest: string, childDigest: string;
let preserve = false;
const measurements: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  if (!supported) return;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'preparation-full-project-typecheck-')));
  // Real immutable checkout inventory, not invented calibration scope. Run only
  // after committing this test and other tracked changes: authoring must refuse
  // a checkout that differs from the pinned HEAD, even outside compiler roots.
  const git = deliveryGit(repository);
  const sourceRevision = git.oid(['rev-parse', '--verify', 'HEAD^{commit}']);
  const sourceTree = git.oid(['rev-parse', '--verify', `${sourceRevision}^{tree}`]);
  const entries = git.readEntries(git.entries(sourceRevision));
  const expectedFiles = entries.map(entry => ({ path: entry.path, executable: entry.executable,
    bytes: entry.data.length, sha256: digest(entry.data) })).sort((a, b) => a.path.localeCompare(b.path));
  const inventoryDigest = digest(canonical(expectedFiles.map(file => ({ path: file.path, executable: file.executable,
    size: file.bytes, digest: file.sha256 }))));
  const target = entries.find(entry => entry.path === PREPARATION_TYPECHECK_TARGET);
  expect(target).toBeDefined();
  const workingSource = readFileSync(join(repository, PREPARATION_TYPECHECK_TARGET));
  expect(workingSource.equals(target!.data)).toBe(true);
  source = workingSource.toString('utf8'); sourceDigest = digest(workingSource);
  expect(digest(source)).toBe(sourceDigest);
  const authorStart = performance.now();
  const project = await authorPreparationTypecheckProject({ repository, expectedSourceSha256: sourceDigest, expectedFiles });
  const authorMs = performance.now() - authorStart;
  expect(git.oid(['rev-parse', '--verify', 'HEAD^{commit}'])).toBe(sourceRevision);
  // Read the parent's already-frozen installation. The real builder copies its
  // bytes to the private fixture; it never rebuilds or writes the shared bundle.
  const measurementDirectory = join(repository, 'dist/core/universe/builtins/preparation');
  const observed = inspectBuiltinEvaluatorBundle(measurementDirectory);
  const calibration: PreparationMeasurementCalibration = { schemaVersion: 1, kind: 'preparation-measurement-calibration',
    scope: 'diagnostic-only', universeId: 'synthetic-compiler-only', manifestDigest: '1'.repeat(64), comparatorDigest: '2'.repeat(64),
    baseline: { revision: sourceRevision, source: { path: PREPARATION_TYPECHECK_TARGET, sha256: sourceDigest },
      files: expectedFiles, artifactDigest: inventoryDigest },
    workload: preparationCalibrationWorkload(observed, 'preparation-workflows-v2'),
    provenance: [1, 2, 3].map(index => ({ captureId: `synthetic-${index}`, intentDigest: String(index).repeat(64),
      receiptDigest: String(index + 3).repeat(64), reportDigest: '9'.repeat(64), reportBytes: 100,
      startedAt: '2026-09-12T00:00:00.000Z', finishedAt: '2026-09-12T00:01:00.000Z' })),
    scenarios: PREPARATION_SCENARIO_KEYS.map(key => ({ key, processes: 10, blobProcesses: 1 })), totalProcesses: 150 };
  const calibrationFile = join(root, 'synthetic-calibration.json');
  writeFileSync(calibrationFile, JSON.stringify(calibration), { mode: 0o600 });
  output = join(root, 'score'); mkdirSync(output, { mode: 0o700 });
  const buildStart = performance.now();
  await buildPreparationScoreBundle({ repository, measurementDirectory, calibrationFile, output, typecheckProject: project });
  packageDigest = inspectPreparationScoreBundle(output).digest;
  projectDigest = digest(readFileSync(join(output, 'preparation-typecheck-project.json')));
  childDigest = digest(readFileSync(join(output, 'preparation-typecheck.mjs')));
  expect(inspectBuiltinEvaluatorBundle(measurementDirectory)).toEqual(observed);
  expect(inspectBuiltinEvaluatorBundle(join(output, 'measurement')).digest).toBe(observed.digest);
  expect(git.oid(['rev-parse', '--verify', 'HEAD^{commit}'])).toBe(sourceRevision);
  expect(git.treeDigest(sourceTree)).toBe(inventoryDigest);
  measurements.push({ phase: 'author-and-package', authorMs: Math.round(authorMs), packageMs: Math.round(performance.now() - buildStart),
    roots: project.rootNames.length, files: project.files.length, projectBytes: Buffer.byteLength(JSON.stringify(project)),
    compilerVersion: project.compilerVersion, packageDigest, projectDigest, childDigest, sourceDigest,
    sourceRevision, sourceTree, inventoryOrigin: 'pinned-head', expectedFilesBound: true, pinnedInventoryFiles: expectedFiles.length,
    pinnedInventoryBytes: expectedFiles.reduce((sum, file) => sum + file.bytes, 0), pinnedInventoryDigest: inventoryDigest,
    syntheticCalibration: true, concurrentWorkloadTiming: 'uncontrolled' });
}, 120_000);

afterAll(() => {
  if (!root) return;
  console.info(`PREPARATION_FULL_PROJECT_TYPECHECK ${JSON.stringify(measurements)}`);
  if (preserve) console.warn(`Full-project compiler custody unconfirmed; retained private fixture ${root}`);
  else rmSync(root, { recursive: true, force: true });
});

describe.runIf(supported)('real packaged fixed compiler against the full checkout project', () => {
  it.each(['baseline', 'ill-typed'] as const)('checks %s with a 1GiB heap and original 60s process-group deadline', async kind => {
    if (!root) throw new Error('Full-project compiler fixture missing');
    if (preserve) throw new Error('Earlier compiler custody is unresolved; no second dispatch');
    const candidate = kind === 'baseline' ? source : `${source}\nexport const __preparationTypecheckAcceptance: string = 1;\n`;
    const sourceSha256 = digest(candidate);
    const scratch = join(root, kind), activityRoot = join(scratch, 'activity');
    mkdirSync(scratch, { mode: 0o700 }); mkdirSync(activityRoot, { mode: 0o700 });
    const started = performance.now(), deadlineMonotonic = started + 60_000;
    const owner = { schemaVersion: 1 as const, invocationId: randomBytes(32).toString('hex'),
      implementationDigest: packageDigest, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
    initializeBuiltinActivity(activityRoot, owner);
    const activity = createBuiltinActivityTracker(activityRoot);
    const remaining = () => Math.floor(Math.min(Date.parse(owner.deadlineAt) - Date.now(), deadlineMonotonic - performance.now()));
    const signal = new AbortController(); const deadline = setTimeout(() => signal.abort(), Math.max(1, remaining()));
    preserve = true;
    try {
      const result = await runVerifySubprocessAsync([process.execPath, '--max-old-space-size=1024',
        join(output, 'preparation-typecheck.mjs'), join(output, 'preparation-typecheck-project.json')], {
        cwd: scratch, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, TMPDIR: scratch,
          LANG: 'C', LC_ALL: 'C' }, timeoutMs: Math.max(1, remaining()), maxOutputChars: 8192, signal: signal.signal,
        input: JSON.stringify({ schemaVersion: 1, source: candidate, sourceSha256, projectSha256: projectDigest }),
        requireProcessGroupExit: true, processGroupLifecycle: activity.lifecycle('tool'),
      });
      measurements.push({ phase: kind, elapsedMs: Math.round(performance.now() - started), exitCode: result.exitCode,
        signal: result.signal, timedOut: result.timedOut, cancelled: result.cancelled, outputTruncated: result.outputTruncated ?? false,
        processGroupSettlement: result.processGroupSettlement, errorPresent: result.error !== undefined,
        stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) });
      if (result.processGroupSettlement === 'group-exit-confirmed' || result.processGroupSettlement === 'not-started') {
        activity.complete();
        expect(inspectBuiltinActivity(activityRoot, owner)).toBe(true);
        // A runner settlement claim alone must never authorize fixture removal.
        // Keep custody retained if the independent journal/kernel proof fails.
        if (result.processGroupSettlement === 'group-exit-confirmed') {
          const spawned = JSON.parse(readFileSync(join(activityRoot, 'spawned-1.json'), 'utf8')) as { pgid: number };
          expect(Number.isSafeInteger(spawned.pgid) && spawned.pgid > 1).toBe(true);
          expect(() => process.kill(-spawned.pgid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
        } else {
          expect(existsSync(join(activityRoot, 'spawned-1.json'))).toBe(false);
        }
        preserve = false;
      }
      expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, cancelled: false, processGroupSettlement: 'group-exit-confirmed' });
      expect(result.error).toBeUndefined(); expect(result.outputTruncated).not.toBe(true); expect(result.stderr).toBe('');
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(8192);
      expect(preserve).toBe(false);
      const checked = JSON.parse(result.stdout) as { diagnosticCodes: number[] };
      expect(checked).toMatchObject({ schemaVersion: 1, kind: 'preparation-typecheck-result', passed: kind === 'baseline', sourceSha256, projectSha256: projectDigest });
      if (kind === 'baseline') expect(checked.diagnosticCodes).toEqual([]);
      else expect(checked.diagnosticCodes).toContain(2322);
      measurements[measurements.length - 1]!.diagnosticCodes = checked.diagnosticCodes;
      expect(JSON.parse(readFileSync(join(activityRoot, 'complete.json'), 'utf8'))).toMatchObject({ count: 1 });
      expect(inspectPreparationScoreBundle(output).digest).toBe(packageDigest);
      expect(digest(readFileSync(join(repository, PREPARATION_TYPECHECK_TARGET)))).toBe(sourceDigest);
    } finally { clearTimeout(deadline); signal.abort(); }
  }, 75_000);
});

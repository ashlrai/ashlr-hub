/** Diagnostic comparison of a selected artifact against its source-pinned baseline.
 * A default pass proves correct measurement/refusal, not an accepted optimization.
 * ASHLR_REQUIRE_BATCH_IMPROVEMENT=1 retains the original strict reduction gate. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkResourceEngineeringPreparation, prepareResourceEngineeringBundle, readPreparedResourceEngineeringMetadata,
  type ResourceEngineeringPreparationOptions, type ResourceEngineeringRecipe } from '../src/core/resources/engineering-preparation.js';
import { createPreparationCandidateHarness, snapshotPreparationFixture, type PreparationCandidateSession } from './helpers/preparation-candidate-harness.js';
import { createPreparationMutationInterceptor, type PreparationMutationRequest } from './helpers/preparation-mutation-interceptor.js';
import { preparationManagerFixture } from './helpers/preparation-workflow-manager-fixture.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const target = 'src/core/resources/engineering-preparation.ts';
const targetBlob = 'a5a6fcf36dd6990f309ee1f0e15072c63cce16d4';
const patchFile = join(repository, 'artifacts/hub-verification-batch-candidate.patch');
const supported = process.platform === 'darwin' && Number(process.versions.node.split('.')[0]) >= 24;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (text: string) => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const environment = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
  GIT_AUTHOR_DATE: '2026-09-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T00:00:00Z' };
let harness: Awaited<ReturnType<typeof createPreparationCandidateHarness>> | undefined;
let candidate: string, patchDigest: string;

beforeAll(async () => {
  if (!supported) return;
  const original = readFileSync(join(repository, target), 'utf8');
  expect(gitBlob(original)).toBe(targetBlob);
  harness = await createPreparationCandidateHarness(repository);
  expect(harness.source).toBe(original);
  const patch = readFileSync(patchFile); patchDigest = hash(patch);
  // Apply the actual patch, never approximate it with source replacements.
  // The private directory is outside any repository and has only this target.
  const root = join(harness.root, 'patch-application'); mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(root, dirname(target)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, target), original, { mode: 0o600 });
  const invoke = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'apply', ...args], {
    cwd: root, env: environment, encoding: 'utf8', input: patch, timeout: 10000, maxBuffer: 1024 * 1024,
  });
  expect(patch.toString('utf8').match(/^diff --git .+$/gm)).toEqual([`diff --git a/${target} b/${target}`]);
  const inventory = invoke('--numstat', '-').trim().split('\n');
  expect(inventory).toHaveLength(1); expect(inventory[0]!.split('\t').slice(2)).toEqual([target]);
  invoke('--check', '-'); invoke('-');
  expect(readdirSync(join(root, dirname(target)))).toEqual(['engineering-preparation.ts']);
  candidate = readFileSync(join(root, target), 'utf8');
  expect(candidate).not.toBe(original); expect(hash(readFileSync(patchFile))).toBe(patchDigest);
  // Compile the whole patched source against the current fixed dependencies,
  // without writing it into the live checkout or emitting build artifacts.
  const configFile = join(repository, 'tsconfig.json');
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, repository);
  expect(parsed.errors).toEqual([]);
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options), getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === join(repository, target)
    ? ts.createSourceFile(file, candidate, languageVersion, true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram(parsed.fileNames, options, host);
  expect(program.getSourceFile(join(repository, target))?.getFullText()).toBe(candidate);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
  expect(readFileSync(join(repository, target), 'utf8')).toBe(original);
}, 60000);

afterAll(() => {
  if (!harness) return;
  // Unsettled custody deliberately retains the private root rather than hiding it.
  harness.close();
  expect(gitBlob(readFileSync(join(repository, target), 'utf8'))).toBe(targetBlob);
  expect(hash(readFileSync(patchFile))).toBe(patchDigest);
});

type Sample = Awaited<ReturnType<PreparationCandidateSession['call']>>;
describe.runIf(supported)('selected batching candidate native diagnostic comparison', () => {
  it('preserves exact behavior and drift refusal while reporting whether batching improves work', async () => {
    if (!harness) throw new Error('Candidate harness unavailable');
    const fixtureRoot = join(harness.root, 'fixture'); mkdirSync(fixtureRoot, { mode: 0o700 });
    const fixture = await preparationManagerFixture(fixtureRoot, harness.gitPin);
    const { expectedPlanDigest: _existingPlanDigest, ...oneOptions } = fixture.bundleInput;
    const baseRecipe = oneOptions.recipe as ResourceEngineeringRecipe;
    const workspace = oneOptions.workspace;
    const git = (...args: string[]) => execFileSync(harness!.gitPin.path, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgsign=false', '-C', workspace, ...args], { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
    const evaluatorFiles = ['evaluate.mjs', 'fixed-1.mjs', 'fixed-2.mjs', 'fixed-3.mjs'];
    const evaluatorBytes = readFileSync(join(workspace, evaluatorFiles[0]!));
    for (const [index, file] of evaluatorFiles.slice(1).entries()) {
      // Retain one duplicate object while requiring exact path-to-payload
      // mapping for two distinct, still-valid protected JavaScript inputs.
      const bytes = index === 0 ? evaluatorBytes : Buffer.concat([evaluatorBytes, Buffer.from(`\n// distinct protected input ${index}\n`)]);
      writeFileSync(join(workspace, file), bytes, { mode: 0o600 });
    }
    chmodSync(join(workspace, evaluatorFiles[3]!), 0o755);
    git('add', '--', ...evaluatorFiles);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'four protected evaluator paths');
    const revision = git('rev-parse', 'HEAD');
    const evaluatorOids = evaluatorFiles.map(file => git('rev-parse', `${revision}:${file}`));
    expect(new Set(evaluatorOids).size).toBe(3);
    expect(evaluatorOids[0]).toBe(evaluatorOids[1]);
    expect(git('ls-tree', revision, '--', evaluatorFiles[3]!)).toMatch(/^100755 blob /);
    for (const file of evaluatorFiles) writeFileSync(join(workspace, file), '// dirty checkout is not comparator data\n');
    const fourOptions: ResourceEngineeringPreparationOptions = { ...oneOptions, output: join(fixtureRoot, 'four-file-bundle'),
      recipe: { ...baseRecipe, id: 'batch-four', name: 'Four-file comparator', seedRevision: revision,
        evaluation: { ...baseRecipe.evaluation, command: [process.execPath, ...evaluatorFiles] },
        generation: { ...baseRecipe.generation, contextFiles: evaluatorFiles }, delivery: { branch: 'codex/batch-four' } } };
    const onePlan = checkResourceEngineeringPreparation(oneOptions);
    const fourPlan = checkResourceEngineeringPreparation(fourOptions);
    const input = { ...fourOptions, expectedPlanDigest: fourPlan.planDigest };
    prepareResourceEngineeringBundle(input);
    const metadata = readPreparedResourceEngineeringMetadata(input);
    const runtimeFile = fixture.options.config.resourceRuntime, runtimeBytes = readFileSync(runtimeFile);
    const observed: Record<string, Sample[]> = {};
    const ledgers: Record<string, ReturnType<PreparationCandidateSession['measurementLedger']>> = {};
    type BatchTransport = { id: number; status: number | null; signal: string | null; error: string | null;
      stderr: string; stderrBytes: number; inputBytes: number; stdoutBytes: number };
    const healthyBatches: Record<string, BatchTransport[][]> = {};

    for (const [kind, source] of [['baseline', harness.source], ['candidate', candidate]] as const) {
      const before = snapshotPreparationFixture(fixtureRoot);
      let mutated: ReturnType<typeof snapshotPreparationFixture> | undefined;
      const batchTransport: BatchTransport[] = [];
      healthyBatches[kind] = [];
      const nativeRun = harness.run, toolPath = harness.toolPath, privateRoot = harness.root;
      // This sits behind the interceptor's exact tool/request validation. It
      // observes bytes only: no output, status or measurement is rewritten.
      const diagnosticRun: typeof nativeRun = async (argv, options) => {
        const result = await nativeRun(argv, options);
        if (argv.at(-1) !== toolPath || options.input === undefined) return result;
        const input = JSON.parse(options.input) as { request: PreparationMutationRequest };
        if (input.request.api !== 'spawnSync' || input.request.args.at(-2) !== 'cat-file' ||
            input.request.args.at(-1) !== '--batch') return result;
        expect(batchTransport.length).toBeLessThan(16);
        expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256 * 1024);
        const output = JSON.parse(result.stdout) as { status: number | null; signal: string | null; error: { code: string } | null;
          stdoutBase64: string; stderrBase64: string };
        const stderr = Buffer.from(output.stderrBase64, 'base64').toString('utf8')
          .replaceAll(privateRoot, '<fixture>').slice(0, 1024);
        batchTransport.push({ id: input.request.id, status: output.status, signal: output.signal, error: output.error?.code ?? null,
          stderr, stderrBytes: Buffer.from(output.stderrBase64, 'base64').length,
          inputBytes: Buffer.from(input.request.options.inputBase64 ?? '', 'base64').length,
          stdoutBytes: Buffer.from(output.stdoutBase64, 'base64').length });
        return result;
      };
      const interceptor = createPreparationMutationInterceptor({ run: diagnosticRun, toolPath: harness.toolPath, fixtureRoot,
        matches: request => request.file === '/bin/ls' && request.args[0] === '-lde' && request.args.slice(1).includes(join(input.output, 'intent.json')),
        mutate() {
          fixture.save(runtimeFile, { ...fixture.runtime, capacityWaitMs: 1000 });
          mutated = snapshotPreparationFixture(fixtureRoot);
        },
      });
      const child = await harness.session(source, fixtureRoot, interceptor.run);
      try {
        expect(snapshotPreparationFixture(fixtureRoot)).toEqual(before);
        const samples: Sample[] = [];
        for (const [method, options, expected] of [
          ['check', oneOptions, onePlan], ['check', fourOptions, fourPlan], ['metadata', input, metadata],
        ] as const) {
          const batchStart = batchTransport.length;
          const sample = await child.call(method, options);
          healthyBatches[kind]!.push(batchTransport.slice(batchStart));
          expect(sample.error).toBeUndefined(); expect(sample.value).toEqual(expected);
          expect(sample.measurement.processes).toBeGreaterThan(0);
          expect(snapshotPreparationFixture(fixtureRoot)).toEqual(before); samples.push(sample);
        }
        observed[kind] = samples;
        // Same already-successful child: inject after initial capture, before final capture.
        interceptor.arm();
        const changed = await child.call('metadata', input);
        interceptor.assertInjected(); expect(interceptor.injections()).toBe(1);
        expect(changed.error).toBe('candidate-threw'); expect(Object.hasOwn(changed, 'value')).toBe(false);
        expect(mutated).toBeDefined(); expect(mutated).not.toEqual(before);
        expect(snapshotPreparationFixture(fixtureRoot)).toEqual(mutated);
        const ledger = child.measurementLedger(); ledgers[kind] = ledger;
        expect(ledger.requests.map(row => row.method)).toEqual(['check', 'check', 'metadata', 'metadata']);
        expect(ledger.requests.map(row => row.id)).toEqual([1, 2, 3, 4]);
        for (const key of ['processes', 'blobProcesses'] as const) {
          expect(ledger[key]).toBe([...samples, changed].reduce((sum, sample) => sum + sample.measurement[key], 0));
          expect(ledger.requests.reduce((sum, request) => sum + request[key], 0)).toBe(ledger[key]);
        }
      } finally {
        await child.close();
        const finalLedger = child.measurementLedger();
        if (ledgers[kind]) {
          expect(finalLedger.requests.map(row => row.method)).toEqual(['check', 'check', 'metadata', 'metadata', 'close']);
          expect(finalLedger.requests.at(-1)).toEqual({ id: 5, method: 'close', processes: 0, blobProcesses: 0 });
          expect(finalLedger.processes).toBe(ledgers[kind]!.processes);
          expect(finalLedger.blobProcesses).toBe(ledgers[kind]!.blobProcesses);
          ledgers[kind] = finalLedger;
        }
        const afterClose = snapshotPreparationFixture(fixtureRoot);
        writeFileSync(runtimeFile, runtimeBytes);
        expect(afterClose).toEqual(mutated ?? before);
        // Print before the optimization assertions so a failed reduction still
        // retains its actual transport evidence without another native run.
        if (process.env.ASHLR_PREPARATION_BATCH_REPORT === '1') console.info('PREPARATION_BATCH_TRANSPORT',
          JSON.stringify({ kind, batches: batchTransport }));
      }
    }
    const baseline = observed.baseline!, patched = observed.candidate!;
    expect(patched[0]!.measurement).toEqual(baseline[0]!.measurement);
    expect(baseline[0]!.measurement.blobProcesses).toBe(2);
    expect(healthyBatches.baseline!.map(rows => rows.length)).toEqual([0, 0, 0]);
    expect(healthyBatches.candidate![0]).toEqual([]);
    for (const index of [1, 2]) {
      const batches = healthyBatches.candidate![index]!;
      expect(batches).toHaveLength(2);
      for (const batch of batches) {
        expect(batch.error).toBeNull(); expect(batch.signal).toBeNull();
        expect(Number.isSafeInteger(batch.status) && batch.status !== null && batch.status >= 0).toBe(true);
      }
      // A normal warning/nonzero result triggers the candidate's exact original
      // four-blob fallback. Count its attempted batch too, without hiding it.
      const expectedBlobs = batches.reduce((total, batch) => total + (batch.status === 0 && batch.stderrBytes === 0 ? 1 : 5), 0);
      expect([2, 6, 10]).toContain(expectedBlobs);
      expect(baseline[index]!.measurement.blobProcesses).toBe(8);
      expect(patched[index]!.measurement.blobProcesses).toBe(expectedBlobs);
      expect(baseline[index]!.measurement.processes - patched[index]!.measurement.processes).toBe(8 - expectedBlobs);
      expect(patched[index]!.value).toEqual(baseline[index]!.value);
    }
    const improvementAccepted = patched[0]!.measurement.processes === baseline[0]!.measurement.processes &&
      patched[0]!.measurement.blobProcesses === baseline[0]!.measurement.blobProcesses &&
      [1, 2].every(index => baseline[index]!.measurement.blobProcesses === 8 && patched[index]!.measurement.blobProcesses === 2 &&
        baseline[index]!.measurement.processes - patched[index]!.measurement.processes === 6);
    if (process.env.ASHLR_PREPARATION_BATCH_REPORT === '1') console.info('PREPARATION_BATCH_COMPARISON', JSON.stringify({
      baselineBlob: targetBlob, candidateDigest: hash(candidate), patchDigest, gitPin: harness.gitPin, improvementAccepted,
      samples: Object.fromEntries(Object.entries(observed).map(([kind, samples]) => [kind, samples.map(sample => sample.measurement)])),
      healthyBatches, ledgers,
    }));
    if (process.env.ASHLR_REQUIRE_BATCH_IMPROVEMENT === '1') {
      expect(improvementAccepted).toBe(true);
      for (const index of [1, 2]) {
        expect(patched[index]!.measurement.blobProcesses).toBe(2);
        expect(baseline[index]!.measurement.processes - patched[index]!.measurement.processes).toBe(6);
      }
    }
  }, 360000);
});

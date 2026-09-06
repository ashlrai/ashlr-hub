import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, readUniverseOverview, runUniverse, validateUniverseManifest,
  type UniverseManifest } from '../src/core/universe/index.js';
import { canonical } from '../src/core/universe/artifacts.js';
import { appendRecord, manifestRecord, newRun, parseEvaluation, scheduledVariants, selectWinners } from '../src/core/universe/store.js';

const roots: string[] = [];
afterEach(() => {
  // All roots are unique test-owned directories, including readonly archived files.
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

const WORKER = `import {readFileSync,writeFileSync} from 'node:fs';
const value=JSON.parse(readFileSync('value.json','utf8'))+Number(process.argv[2]);
writeFileSync('value.json',JSON.stringify(value));
// Edits to a candidate's evaluator copy must not replace the fixed evaluator.
writeFileSync('evaluate.mjs','console.log(JSON.stringify({passed:true,score:99999}))');
`;
const EVALUATOR = `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const value=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.json'),'utf8'));
console.log(JSON.stringify({passed:Number.isFinite(value)&&value>=0,score:value,metrics:{value}}));
`;

function fixture(options: { worker?: string; evaluator?: string; variants?: number } = {}): { root: string; manifest: UniverseManifest; directory: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-universe-core-')));
  roots.push(root);
  const repo = join(root, 'repository');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'value.json'), '0');
  writeFileSync(join(repo, 'worker.mjs'), options.worker ?? WORKER);
  writeFileSync(join(repo, 'evaluate.mjs'), options.evaluator ?? EVALUATOR);
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Universe Test', '-c', 'user.email=universe@example.invalid', 'commit', '-qm', 'seed']);
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'example', name: 'Measured search', objective: 'Increase fixture score',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) }, metric: { name: 'value', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 8, maxDurationMs: 30_000, trialTimeoutMs: 5_000, maxParallel: 2 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 3_000 },
    variants: Array.from({ length: options.variants ?? 2 }, (_, i) => ({
      id: `increment-${i + 1}`, niche: 'increment', hypothesis: `Add ${i + 1}`, command: [process.execPath, 'worker.mjs', String(i + 1)],
    })),
  };
  return { root, manifest, directory: join(root, 'universes', manifest.id) };
}

describe('Universe manifest and measurement contracts', () => {
  it('rejects nonfinite and malformed measurements rather than inventing a pass', () => {
    for (const output of ['{}', '{"passed":true,"score":"9"}', '{"passed":true,"score":1e999}',
      '{"passed":true,"score":1,"metrics":{"unsafe":null}}', 'log\n{"passed":true,"score":1}']) {
      expect(() => parseEvaluation(output)).toThrow();
    }
    expect(parseEvaluation('{"passed":false,"score":0,"metrics":{"cases":12}}')).toEqual({ passed: false, score: 0, metrics: { cases: 12 } });
  });

  it('validates finite bounds and rotates budgeted variants without starvation', () => {
    const { manifest } = fixture({ variants: 3 });
    expect(() => validateUniverseManifest({ ...manifest, budget: { ...manifest.budget, maxParallel: 0 } })).toThrow();
    expect(() => validateUniverseManifest({ ...manifest, variants: [manifest.variants[0], manifest.variants[0]] })).toThrow();
    manifest.budget.maxTrials = 1;
    expect([1, 2, 3, 4].map((generation) => scheduledVariants(manifest, generation)[0]!.id))
      .toEqual(['increment-1', 'increment-2', 'increment-3', 'increment-1']);
  });

  it('stores an immutable definition and refuses an external evaluator file', () => {
    const { root, manifest } = fixture();
    initUniverse(manifest, { root });
    expect(initUniverse(manifest, { root })).toEqual(manifest);
    expect(() => initUniverse({ ...manifest, objective: 'A different comparator' }, { root })).toThrow(/immutable/);
    const other = fixture();
    other.manifest.evaluation.command = [process.execPath, '/private/tmp/external-evaluator.mjs'];
    expect(() => initUniverse(other.manifest, { root: other.root })).toThrow(/pinned source/);
  });

  it('does not create a missing read-only overview root', () => {
    const { root } = fixture();
    const absent = join(root, 'absent');
    expect(readUniverseOverview({ root: absent }).sourceState).toBe('missing');
    expect(existsSync(absent)).toBe(false);
  });

  it('reports dangling storage symlinks as degraded without creating their target', () => {
    const { root } = fixture();
    const target = join(root, 'never-created');
    const link = join(root, 'dangling-root');
    symlinkSync(target, link, 'dir');
    expect(readUniverseOverview({ root: link }).sourceState).toBe('degraded');
    expect(existsSync(target)).toBe(false);
    symlinkSync(target, join(root, 'universes'), 'dir');
    expect(readUniverseOverview({ root }).sourceState).toBe('degraded');
    expect(existsSync(target)).toBe(false);
  });

  it('rejects an unsupported execution platform before creating run state', async () => {
    const { root } = fixture();
    const absent = join(root, 'unavailable');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      await expect(runUniverse('example', { root: absent })).rejects.toThrow(/requires macOS/);
    } finally { Object.defineProperty(process, 'platform', platform); }
    expect(existsSync(absent)).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin')('Universe confined local execution', () => {
  it('measures immutable artifacts and evolves from the preceding niche elite', async () => {
    const { root, manifest, directory } = fixture();
    initUniverse(manifest, { root });
    const first = await runUniverse(manifest.id, { root });
    expect(first.status, JSON.stringify(first)).toBe('completed');
    expect(first.trials.map((trial) => trial.score)).toEqual([1, 2]);
    const winner = first.trials.find((trial) => trial.selected)!;
    expect(winner.score).toBe(2);
    expect(readFileSync(join(directory, 'seed', 'evaluate.mjs'), 'utf8')).toBe(EVALUATOR);
    const second = await runUniverse(manifest.id, { root });
    expect(second.trials.map((trial) => trial.parentTrialId)).toEqual([winner.id, winner.id]);
    expect(second.trials.map((trial) => trial.score)).toEqual([3, 4]);
    expect(second.trials.find((trial) => trial.selected)?.delta).toBe(2);
    const overview = readUniverseOverview({ root });
    expect(overview.sourceState, JSON.stringify(overview.reasons)).toBe('healthy');
    expect(overview.universes[0]!.elites[0]!.score).toBe(4);
    expect(second.tokensUsed).toBeNull();
    expect(second.costUsd).toBeNull();
    expect(readdirSync(join(directory, 'ledger', 'records'))).toHaveLength(9);
  });

  it('keeps an incumbent on a tie and schedules later variants on the next bounded generation', async () => {
    const { root, manifest } = fixture({ variants: 3 });
    manifest.budget.maxTrials = 1;
    manifest.variants[0]!.command[2] = '0';
    manifest.variants[1]!.command[2] = '0';
    initUniverse(manifest, { root });
    const first = await runUniverse(manifest.id, { root });
    const second = await runUniverse(manifest.id, { root });
    expect(first.trials[0]!.variantId).toBe('increment-1');
    expect(second.trials[0]!.variantId).toBe('increment-2');
    expect(second.trials[0]!.score).toBe(0);
    expect(second.trials[0]!.delta).toBe(0);
    expect(second.trials[0]!.selected).toBe(false);
    expect(readUniverseOverview({ root }).universes[0]!.elites[0]!.trialId).toBe(first.trials[0]!.id);
  });

  it('rejects malformed evaluator output and independently failed candidates', async () => {
    const bad = fixture({ variants: 1, evaluator: 'console.log("not a measurement");' });
    initUniverse(bad.manifest, { root: bad.root });
    const malformed = await runUniverse(bad.manifest.id, { root: bad.root });
    expect(malformed.trials[0]!.status).toBe('failed');
    expect(malformed.trials[0]!.score).toBeNull();
    expect(readUniverseOverview({ root: bad.root }).universes[0]!.elites).toEqual([]);
    const rejected = fixture({ variants: 1 });
    rejected.manifest.variants[0]!.command[2] = '-1';
    initUniverse(rejected.manifest, { root: rejected.root });
    const run = await runUniverse(rejected.manifest.id, { root: rejected.root });
    expect(run.trials[0]).toMatchObject({ status: 'failed', score: -1, selected: false });
  });

  it('cancels active work, prevents concurrent generations, and records interruption', async () => {
    const { root, manifest } = fixture({ variants: 1, worker: 'setTimeout(()=>{},10000);' });
    initUniverse(manifest, { root });
    const controller = new AbortController();
    const pending = runUniverse(manifest.id, { root, signal: controller.signal });
    await expect(runUniverse(manifest.id, { root })).rejects.toThrow(/active run/);
    controller.abort();
    const run = await pending;
    expect(run.status).toBe('interrupted');
    expect(run.trials.every((trial) => !trial.selected)).toBe(true);
    expect(readUniverseOverview({ root }).universes[0]!.activeRun).toBeNull();
  });

  it('records worker timeouts and does not start the evaluator after the trial deadline', async () => {
    const { root, manifest } = fixture({ variants: 1, worker: 'setTimeout(()=>{},10000);' });
    manifest.budget.trialTimeoutMs = 150;
    initUniverse(manifest, { root });
    const run = await runUniverse(manifest.id, { root });
    expect(run.trials[0]!.status).toBe('timed-out');
    expect(run.trials[0]!.artifact).toBeNull();
    expect(run.trials[0]!.selected).toBe(false);
  });

  it('closes abandoned generations as interrupted without inventing success on restart', async () => {
    const { root, manifest, directory } = fixture({ variants: 1 });
    initUniverse(manifest, { root });
    const abandoned = newRun(manifestRecord(directory), 1);
    appendRecord(directory, { id: `${abandoned.id}.start`, kind: 'start', run: abandoned,
      ownerPid: 2_147_000_000, ownerStart: 'a'.repeat(64) });
    expect(readUniverseOverview({ root }).universes[0]!.runs[0]!.status).toBe('interrupted');
    const next = await runUniverse(manifest.id, { root });
    expect(next.generation).toBe(2);
    const runs = readUniverseOverview({ root }).universes[0]!.runs;
    expect(runs).toHaveLength(2);
    expect(runs[0]!.status).toBe('interrupted');
    expect(runs[0]!.trials).toEqual([]);
    expect(runs[1]!.trials[0]!.parentTrialId).toBeNull();
  });

  it('withholds changed comparator and artifact evidence, and rejects forged selection', async () => {
    const { root, manifest, directory } = fixture();
    initUniverse(manifest, { root });
    const run = await runUniverse(manifest.id, { root });
    const finalPath = join(directory, 'ledger', 'records', `${run.id}.final.json`);
    const final = JSON.parse(readFileSync(finalPath, 'utf8'));
    final.run.trials[0].selected = true;
    writeFileSync(finalPath, `${canonical(final)}\n`);
    expect(readUniverseOverview({ root }).sourceState).toBe('degraded');
    await expect(runUniverse(manifest.id, { root })).rejects.toThrow(/selection/);

    const other = fixture({ variants: 1 });
    initUniverse(other.manifest, { root: other.root });
    const healthy = await runUniverse(other.manifest.id, { root: other.root });
    const artifact = join(healthy.trials[0]!.artifact!.path, 'value.json');
    chmodSync(artifact, 0o600);
    writeFileSync(artifact, '999');
    expect(readUniverseOverview({ root: other.root }).universes[0]!.elites).toEqual([]);
    await expect(runUniverse(other.manifest.id, { root: other.root })).rejects.toThrow(/artifact changed/);
    const evaluator = join(other.directory, 'seed', 'evaluate.mjs');
    chmodSync(evaluator, 0o600);
    writeFileSync(evaluator, 'console.log("changed");');
    expect(readUniverseOverview({ root: other.root }).sourceState).toBe('degraded');
    await expect(runUniverse(other.manifest.id, { root: other.root })).rejects.toThrow(/comparator changed/);
  });

  it('rejects an overflowing derived improvement without serializing Infinity', async () => {
    const { root, manifest, directory } = fixture({ variants: 1 });
    initUniverse(manifest, { root });
    const run = await runUniverse(manifest.id, { root });
    const elite = readUniverseOverview({ root }).universes[0]!.elites[0]!;
    run.trials[0]!.score = 1e308;
    expect(() => selectWinners(run, manifestRecord(directory).manifest, [{ ...elite, score: -1e308 }])).toThrow(/finite/);
  });
});

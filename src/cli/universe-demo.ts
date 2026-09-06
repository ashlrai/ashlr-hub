import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureUniverseRoot, initUniverse, runUniverse,
  type UniverseManifest, type UniverseRun, type UniverseRunOptions,
} from '../core/universe/index.js';

// This seed is an executable runtime check, not a claim of model productivity.
// Fixed correctness cases and file-size measurements come from the evaluator,
// not from the candidate or a model judging its own output.
const WORKER = String.raw`import { writeFileSync } from 'node:fs';
const variant = process.argv[2];
const hasParent = Boolean(process.env.ASHLR_UNIVERSE_PARENT_TRIAL);
const compact = 'export default values => [...new Set(values)];\n';
const readable = 'export default function unique(values) {\n  const seen = new Set();\n  const result = [];\n  for (const value of values) {\n    if (!seen.has(value)) { seen.add(value); result.push(value); }\n  }\n  return result;\n}\n';
const baseline = '// Preserve the original order while removing exact duplicates.\n' + readable;
const source = variant === 'broken'
  ? 'export default values => [...new Set(values)].sort();\n'
  : variant === 'compact' ? (hasParent ? compact : baseline)
  : (hasParent ? readable : baseline + '// A conservative, readable first attempt.\n');
writeFileSync('solution.mjs', source);
`;

const CANDIDATE_PROBE = String.raw`import { readFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
const inputs = deserialize(readFileSync(0));
const unique = (await import(pathToFileURL(process.argv[2]).href)).default;
const outputs = inputs.map(values => ({result: unique(values), after: values}));
process.stdout.write(serialize(outputs));
`;

const EVALUATOR = String.raw`import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
const started = performance.now();
const candidate = join(process.env.ASHLR_UNIVERSE_CANDIDATE, 'solution.mjs');
const cases = [[], [3, 1, 3, 2, 1], ['z', 'a', 'z'], [0, false, '', null, 0, false],
  [NaN, 1, NaN, 1], [2, '2', 2, '2'], Array.from({length: 1000}, (_, i) => i % 73)];
// Candidate code runs in a child. It cannot replace this process's assertions
// or print a forged passing verdict into the evaluator's output channel.
const observed = deserialize(execFileSync(process.execPath, ['candidate-probe.mjs', candidate], {
  input: serialize(cases), timeout: 2000, maxBuffer: 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'],
}));
assert.equal(observed.length, cases.length);
let casesPassed = 0;
for (const [index, values] of cases.entries()) {
  const expected = [...new Set(values)];
  assert.deepEqual(observed[index].result, expected);
  assert.deepEqual(observed[index].after, values, 'input must not be mutated');
  casesPassed++;
}
const artifactBytes = readFileSync(candidate).byteLength;
console.log(JSON.stringify({passed: true, score: artifactBytes,
  metrics: {casesPassed, artifactBytes, evaluationMs: performance.now() - started}}));
`;

export interface UniverseDemoResult {
  universeId: string;
  seedRepo: string;
  measurementScope: 'local-experiment';
  runs: UniverseRun[];
  verified: boolean;
  checks: Record<string, boolean>;
}

export async function runUniverseDemo(options: UniverseRunOptions = {}): Promise<UniverseDemoResult> {
  if (options.signal?.aborted) throw new Error('Demo cancelled before initialization');
  const root = ensureUniverseRoot(options.root);
  const seedRepo = mkdtempSync(join(root, 'demo-seeds', 'dedup-'));
  for (const [name, contents] of Object.entries({
    'worker.mjs': WORKER,
    'evaluate.mjs': EVALUATOR,
    'candidate-probe.mjs': CANDIDATE_PROBE,
    'solution.mjs': 'export default values => values;\n',
  })) writeFileSync(join(seedRepo, name), contents, { mode: 0o600, flag: 'wx' });
  // Ignore the operator's signing, templates, hooks, and Git aliases. This commit
  // belongs solely to the generated private demo repository.
  const gitEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: seedRepo,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (argv: string[]): string => execFileSync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...argv,
  ], { cwd: seedRepo, env: gitEnv, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet', '--template=', '--initial-branch=main']);
  git(['add', '--', 'worker.mjs', 'evaluate.mjs', 'candidate-probe.mjs', 'solution.mjs']);
  git(['-c', 'user.name=Ashlr Universe Demo', '-c', 'user.email=demo@localhost',
    'commit', '--quiet', '-m', 'Seed the local Universe experiment']);
  const id = `demo-${seedRepo.split(/[/\\]/).pop()!.toLowerCase()}`;
  const manifest: UniverseManifest = {
    schemaVersion: 1, id, name: 'Stable deduplication experiment',
    objective: 'Produce a smaller correct stable-deduplication module. Synthetic runtime acceptance only.',
    seed: { repo: seedRepo, revision: git(['rev-parse', 'HEAD']) },
    metric: { name: 'artifactBytes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 3, maxDurationMs: 60_000, trialTimeoutMs: 10_000, maxParallel: 2 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 10_000 },
    variants: [
      { id: 'compact', niche: 'compact', hypothesis: 'A Set expression preserves semantics in less code.',
        command: [process.execPath, 'worker.mjs', 'compact'] },
      { id: 'readable', niche: 'readable', hypothesis: 'An explicit loop remains useful as a readable stepping stone.',
        command: [process.execPath, 'worker.mjs', 'readable'] },
      { id: 'broken', niche: 'compact', hypothesis: 'Sorting the output might be simpler; test order preservation.',
        command: [process.execPath, 'worker.mjs', 'broken'] },
    ],
  };
  initUniverse(manifest, { root });
  const runs: UniverseRun[] = [];
  for (let generation = 0; generation < 2 && !options.signal?.aborted; generation++) {
    const run = await runUniverse(id, { root, signal: options.signal });
    runs.push(run);
    if (run.status !== 'completed') break;
  }
  const [first, second] = runs;
  const checks = {
    twoCompletedGenerations: runs.length === 2 && runs.every((run) => run.status === 'completed'),
    brokenVariantRejected: runs.length === 2 && runs.every((run) =>
      run.trials.some((trial) => trial.variantId === 'broken' && trial.status === 'failed' && !trial.selected)),
    bothNichesRetained: runs.length === 2 && runs.every((run) =>
      ['compact', 'readable'].every((niche) => run.trials.some((trial) => trial.niche === niche && trial.selected))),
    priorWinnersReused: Boolean(first && second && second.trials.length === 3 && second.trials.every((trial) =>
      first.trials.some((parent) => parent.selected && parent.niche === trial.niche && parent.id === trial.parentTrialId))),
    measuredImprovement: Boolean(second && second.trials.filter((trial) => trial.selected).length === 2 &&
      second.trials.filter((trial) => trial.selected).every((trial) => trial.delta !== null && trial.delta > 0)),
  };
  return { universeId: id, seedRepo, measurementScope: 'local-experiment', runs,
    verified: Object.values(checks).every(Boolean), checks };
}

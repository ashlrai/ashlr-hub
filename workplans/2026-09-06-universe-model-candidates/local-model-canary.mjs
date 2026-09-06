/**
 * One explicitly configured local-model trial on an isolated real Hub utility.
 * Run from the repository root: node --import tsx workplans/2026-09-06-universe-model-candidates/local-model-canary.mjs
 * Creates a unique private seed and durable default-store experiment; does not
 * change production code, start a provider, download a model, or publish work.
 */
/* global AbortController */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { ensureUniverseRoot, initUniverse, readUniverseOverview, runUniverse } from '../../src/core/universe/index.ts';

const sourcePath = 'src/web-ui/components/charts/format.ts';
const repo = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
if (realpathSync(process.cwd()) !== repo) throw new Error('Run this canary from its repository root');
if (process.platform !== 'darwin') throw new Error('This canary requires the verified macOS Universe runner');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const source = readFileSync(join(repo, sourcePath), 'utf8');
const sourceSha256 = sha256(source);
const sourceParentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repo, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const functionStart = source.indexOf('/** YYYY-MM-DD');
const functionEnd = source.indexOf('/** Epoch ms');
if (functionStart < 0 || functionEnd <= functionStart) throw new Error('Utility boundaries changed; review the canary before running');
const unchangedPrefix = sha256(source.slice(0, functionStart));
const unchangedSuffix = sha256(source.slice(functionEnd));

// The candidate never shares the evaluator's process. Expected values remain
// here; the child sees only exported-function names and invocation arguments.
const probe = String.raw`import { readFileSync } from 'node:fs';
import { deserialize, serialize } from 'node:v8';
import { pathToFileURL } from 'node:url';
const requests = deserialize(readFileSync(0));
const candidate = await import(pathToFileURL(process.argv[1]).href);
const observations = requests.map(({name, args}) => {
  try { return { value: candidate[name](...args) }; }
  catch { return { error: 'Candidate call failed' }; }
});
process.stdout.write(serialize(observations));
`;

const evaluator = String.raw`import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { deserialize, serialize } from 'node:v8';
const started = performance.now();
const candidatePath = join(process.env.ASHLR_UNIVERSE_CANDIDATE, 'format.ts');
const source = readFileSync(candidatePath, 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const functionStart = source.indexOf('/** YYYY-MM-DD');
const functionEnd = source.indexOf('/** Epoch ms');
const sourceChecks = [functionStart >= 0 && sha256(source.slice(0, functionStart)) === PREFIX_SHA256,
  functionEnd > functionStart && sha256(source.slice(functionEnd)) === SUFFIX_SHA256];
const cases = [];
const add = (name, args, expected, category) => cases.push({name, args, expected, category});
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Independent Gregorian calendar arithmetic, not Date's rollover parser.
for (const year of [0, 1, 4, 99, 100, 400, 1900, 2000, 2023, 2024, 2100, 2400, 9999]) {
  const yearText = String(year).padStart(4, '0');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  for (let month = 1; month <= 12; month++) {
    const limit = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
    for (let day = 0; day <= 32; day++) {
      const date = yearText + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      add('formatDayLabel', [date], day >= 1 && day <= limit ? months[month - 1] + ' ' + day : date, 'date');
    }
  }
  for (const month of ['00', '13']) add('formatDayLabel', [yearText + '-' + month + '-01'], yearText + '-' + month + '-01', 'date');
}
for (const value of ['', '2024', '2024-2-01', '2024-02-1', '2024/02/29', '02/29/2024',
  '24-02-29', '02024-02-28', '20240-02-28', '+002024-02-29', '-000001-01-01',
  ' 2024-02-29', '2024-02-29 ', '2024-02-29\n', '2024-02-29T00:00:00Z',
  '2024-02-29Z', '2024-02-29extra', '2024-02-29\0', 'not-a-date', '2024-99-99']) {
  add('formatDayLabel', [value], value, 'date');
}
for (const [args, expected] of [
  [[0], '0'], [[-0], '0'], [[12], '12'], [[1.25], '1.3'], [[-1.25], '-1.3'],
  [[1284], '1,284'], [[10000], '10K'], [[12900], '13K'], [[4200000], '4.2M'], [[12000000], '12M'],
  [[-4200000], '-4.2M'], [[NaN], '—'], [[Infinity], '—'], [[-Infinity], '—'],
]) add('formatCompact', args, expected, 'other');
for (const [args, expected] of [
  [[0], '$0.00'], [[4.2], '$4.20'], [[-4.2], '-$4.20'], [[1200], '$1.2K'],
  [[4200000], '$4.2M'], [[-4200000], '-$4.2M'], [[NaN], '—'], [[Infinity], '—'],
]) add('formatUsd', args, expected, 'other');
for (const [args, expected] of [
  [[0], '0%'], [[0.125], '13%'], [[0.125, 1], '12.5%'], [[-0.5], '-50%'], [[1.25], '125%'], [[NaN], '—'],
]) add('formatPercent', args, expected, 'other');
for (const [args, expected] of [
  [[0], '0'], [[-0], '0'], [[12], '+12'], [[-3], '-3'], [[1200], '+1,200'], [[-4200000], '-4.2M'], [[NaN], '—'],
]) add('formatSignedCompact', args, expected, 'other');
for (const [args, expected] of [
  [[0], 'Jan 1'], [[Date.UTC(2024, 1, 29, 12)], 'Feb 29'], [[Date.UTC(2023, 11, 31, 12)], 'Dec 31'], [[NaN], ''], [[Infinity], ''],
]) add('formatTimeLabel', args, expected, 'other');
let observed = [];
try {
  observed = deserialize(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', PROBE_CODE, candidatePath], {
    input: serialize(cases.map(({name, args}) => ({name, args}))), timeout: 7000, maxBuffer: 1024 * 1024,
    env: { ...process.env, TZ: 'UTC' }, stdio: ['pipe', 'pipe', 'pipe'],
  }));
} catch { /* A missing or crashing export is a failing observation, not a passing score. */ }
const validShape = Array.isArray(observed) && observed.length === cases.length;
let datesPassed = 0;
let otherExportsPassed = 0;
for (const [index, test] of cases.entries()) {
  const observation = validShape ? observed[index] : null;
  const passed = observation && Object.keys(observation).length === 1 && Object.hasOwn(observation, 'value') &&
    isDeepStrictEqual(observation.value, test.expected);
  if (passed && test.category === 'date') datesPassed++;
  if (passed && test.category === 'other') otherExportsPassed++;
}
const datesTotal = cases.filter(test => test.category === 'date').length;
const otherExportsTotal = cases.length - datesTotal;
const sourceInvariantsPassed = sourceChecks.filter(Boolean).length;
const casesPassed = datesPassed + otherExportsPassed + sourceInvariantsPassed;
const casesTotal = cases.length + sourceChecks.length;
console.log(JSON.stringify({passed: casesPassed === casesTotal, score: casesPassed,
  metrics: {casesPassed, casesTotal, datesPassed, datesTotal, otherExportsPassed, otherExportsTotal,
    sourceInvariantsPassed, evaluationMs: performance.now() - started}}));
`.replaceAll('PREFIX_SHA256', JSON.stringify(unchangedPrefix))
  .replaceAll('SUFFIX_SHA256', JSON.stringify(unchangedSuffix))
  .replaceAll('PROBE_CODE', JSON.stringify(probe));

const root = ensureUniverseRoot();
const seedRepo = mkdtempSync(join(root, 'demo-seeds', 'format-date-'));
writeFileSync(join(seedRepo, 'format.ts'), source, { mode: 0o600, flag: 'wx' });
writeFileSync(join(seedRepo, 'evaluator.mjs'), evaluator, { mode: 0o600, flag: 'wx' });
const gitEnv = { PATH: process.env.PATH, HOME: seedRepo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
const git = (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], {
  cwd: seedRepo, env: gitEnv, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
git(['init', '--quiet', '--template=', '--initial-branch=main']);
git(['add', '--', 'format.ts', 'evaluator.mjs']);
git(['-c', 'user.name=Ashlr Universe Canary', '-c', 'user.email=canary@localhost',
  'commit', '--quiet', '-m', 'Pin real date utility and independent canary evaluator']);
const seedRevision = git(['rev-parse', 'HEAD']);
const baseline = JSON.parse(execFileSync(process.execPath, ['evaluator.mjs'], {
  cwd: seedRepo, env: { PATH: process.env.PATH, HOME: seedRepo, ASHLR_UNIVERSE_CANDIDATE: seedRepo, TZ: 'UTC' },
  encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
}));
if (baseline.passed || baseline.metrics.datesPassed >= baseline.metrics.datesTotal ||
    baseline.metrics.otherExportsPassed !== baseline.metrics.otherExportsTotal || baseline.metrics.sourceInvariantsPassed !== 2) {
  throw new Error('Baseline did not isolate the expected date defect; no model request was made');
}
console.log(JSON.stringify({phase: 'baseline', sourceParentHead, sourceSha256, seedRepo, seedRevision, baseline}));

const id = `canary-${seedRepo.split('/').at(-1).toLowerCase()}`;
const manifest = {
  schemaVersion: 1, id, name: 'Real chart date validation canary',
  objective: 'Fix formatDayLabel in the isolated real Hub format.ts utility: accept exactly YYYY-MM-DD and valid Gregorian calendar dates. Return the original string for invalid or malformed dates instead of silently normalizing them. Preserve valid UTC short English month/day labels, including years below 0100. Keep every other export, its behavior, comments, and source text outside formatDayLabel unchanged. This is a correctness experiment, not a minification task or an accepted production change.',
  seed: { repo: seedRepo, revision: seedRevision },
  metric: { name: 'casesPassed', direction: 'maximize', minImprovement: 1 },
  budget: { maxTrials: 1, maxDurationMs: 180_000, trialTimeoutMs: 150_000, maxParallel: 1 },
  evaluation: { command: [process.execPath, 'evaluator.mjs'], timeoutMs: 10_000 },
  variants: [{ id: 'local-calendar-fix', niche: 'correctness',
    hypothesis: 'Exact date-shape and Gregorian calendar validation prevent rollovers without changing the other formatting exports. Return full replacement format.ts in the prescribed edits JSON; preserve all text before the YYYY-MM-DD comment and from the Epoch ms comment onward verbatim.',
    generation: { kind: 'local-chat', endpoint: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b', files: ['format.ts'], maxOutputTokens: 4096 } }],
};
initUniverse(manifest, { root });
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
console.log(JSON.stringify({phase: 'model-trial-starting', universeId: id, endpoint: manifest.variants[0].generation.endpoint,
  model: manifest.variants[0].generation.model, maxTrials: 1, maxOutputTokens: 4096}));
let run;
try { run = await runUniverse(id, { root, signal: controller.signal }); }
finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
const afterSourceSha256 = sha256(readFileSync(join(repo, sourcePath)));
const stored = readUniverseOverview({ root }).universes.find(item => item.manifest.id === id);
const trial = run.trials[0];
const result = {
  phase: 'canary-result', observedAt: new Date().toISOString(), universeId: id,
  source: { repo, path: sourcePath, parentHead: sourceParentHead, sha256: sourceSha256,
    unchanged: afterSourceSha256 === sourceSha256 },
  seed: { repo: seedRepo, revision: seedRevision, evaluatorSha256: sha256(evaluator) }, baseline,
  run: { id: run.id, generation: run.generation, status: run.status, durationMs: run.durationMs,
    tokensUsed: run.tokensUsed, costUsd: run.costUsd, generationUsage: run.generationUsage },
  trial: trial ? { id: trial.id, status: trial.status, score: trial.score, selected: trial.selected,
    metrics: trial.metrics, artifact: trial.artifact, generation: trial.generation, error: trial.error } : null,
  durableSourceState: stored?.sourceState ?? 'missing',
  acceptedProductionChange: false,
};
console.log(JSON.stringify(result, null, 2));
if (!result.source.unchanged || stored?.sourceState !== 'healthy' || run.status !== 'completed' || trial?.status !== 'passed') process.exitCode = 1;

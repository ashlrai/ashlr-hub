#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearTimeout, setTimeout } from 'node:timers';

const CHECKS = ['twoCompletedGenerations', 'brokenVariantRejected', 'bothNichesRetained',
  'priorWinnersReused', 'measuredImprovement'];
const VARIANTS = ['compact', 'readable', 'broken'];
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const fail = () => { throw new Error('Showcase evidence is invalid or incomplete'); };
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some((key) => typeof key !== 'string' ||
      !('value' in Object.getOwnPropertyDescriptor(value, key)))) fail();
  return value;
}
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
function exactArray(value, length) {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length === length &&
    Reflect.ownKeys(value).length === length + 1 && Array.from({ length }, (_, index) => index)
      .every((index) => Object.hasOwn(value, index) && 'value' in Object.getOwnPropertyDescriptor(value, index));
}

/** Closed public projection: no source paths, prompts, raw IDs, output, or auth data. */
export function projectUniverseShowcase(input, { sourceRevision, generatedAt = new Date().toISOString() } = {}) {
  const demo = record(input);
  if (sourceRevision !== undefined && !REVISION.test(sourceRevision)) fail();
  if (typeof generatedAt !== 'string' || !Number.isFinite(Date.parse(generatedAt)) ||
    new Date(generatedAt).toISOString() !== generatedAt) fail();
  if (demo.measurementScope !== 'local-experiment' || demo.verified !== true ||
    !exactArray(demo.runs, 2)) fail();
  const declaredChecks = record(demo.checks);
  if (!CHECKS.every((name) => declaredChecks[name] === true)) fail();
  const ids = new Map();
  const generations = demo.runs.map((rawRun, generationIndex) => {
    const run = record(rawRun);
    if (run.generation !== generationIndex + 1 || run.status !== 'completed' ||
      !exactArray(run.trials, 3)) fail();
    const seenVariants = new Set();
    const trials = run.trials.map((rawTrial, trialIndex) => {
      const trial = record(rawTrial);
      if (typeof trial.id !== 'string' || !trial.id.length || trial.id.length > 256 || ids.has(trial.id) ||
        !VARIANTS.includes(trial.variantId) || seenVariants.has(trial.variantId) ||
        trial.niche !== (trial.variantId === 'readable' ? 'readable' : 'compact')) fail();
      seenVariants.add(trial.variantId);
      const broken = trial.variantId === 'broken';
      if (trial.status !== (broken ? 'failed' : 'passed') || trial.selected !== !broken) fail();
      const metrics = record(trial.metrics);
      if (!broken && (!positiveInteger(metrics.artifactBytes) || metrics.casesPassed !== 7 ||
        trial.score !== metrics.artifactBytes)) fail();
      const id = `g${run.generation}-t${trialIndex + 1}`;
      const parent = ids.get(trial.parentTrialId);
      if (generationIndex === 0 ? trial.parentTrialId !== null :
        !parent || parent.generation !== 1 || !parent.selected || parent.niche !== trial.niche) fail();
      if (!broken && generationIndex === 1 && (!positiveInteger(trial.delta) ||
        parent.artifactBytes - metrics.artifactBytes !== trial.delta)) fail();
      const row = { id, variant: trial.variantId, niche: trial.niche, status: trial.status,
        selected: trial.selected, parentTrialId: parent?.id ?? null,
        artifactBytes: broken ? null : metrics.artifactBytes,
        casesPassed: broken ? null : metrics.casesPassed,
        delta: !broken && generationIndex === 1 ? trial.delta : null };
      ids.set(trial.id, { ...row, generation: run.generation });
      return row;
    });
    return { generation: run.generation, status: 'completed', trials };
  });
  return { schemaVersion: 1, kind: 'universe-offline-demo', measurementScope: 'deterministic-local-experiment',
    generatedAt, ...(sourceRevision === undefined ? {} : { sourceRevision }), verified: true,
    checks: Object.fromEntries(CHECKS.map((name) => [name, true])), generations };
}

export function parseShowcaseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!['--root', '--input', '--output', '--source-revision', '--source-root'].includes(key) ||
      Object.hasOwn(options, key) || typeof value !== 'string' || !value || value.startsWith('--') ||
      value.length > 4096 || [...value].some((character) => character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127)) throw new Error('Invalid showcase arguments');
    options[key] = value;
  }
  if (!options['--output'] || Boolean(options['--root']) === Boolean(options['--input']) ||
    options['--source-root'] !== undefined && (!options['--root'] || !isAbsolute(options['--source-root'])) ||
    options['--source-revision'] !== undefined && !REVISION.test(options['--source-revision'])) {
    throw new Error('Use --root NEW_ABSOLUTE_ROOT or --input PRIVATE_JSON, plus --output NEW_ABSOLUTE_JSON');
  }
  return options;
}

function absentPrivateTarget(path) {
  if (!isAbsolute(path) || resolve(path) !== path || path === sep) throw new Error('Use an absolute normalized target');
  const parent = dirname(path); const stat = lstatSync(parent);
  if (realpathSync(parent) !== parent || !stat.isDirectory() || stat.isSymbolicLink() ||
    typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
    throw new Error('Target parent must be a physical private current-user directory');
  }
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Refusing to overwrite an existing target');
}

export async function generateUniverseShowcase(args) {
  const options = parseShowcaseArguments(args);
  const output = options['--output']; absentPrivateTarget(output);
  let demo;
  if (options['--input']) {
    const input = options['--input'];
    if (!isAbsolute(input)) throw new Error('Input must be an absolute private JSON file');
    const stat = lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) throw new Error('Invalid private input file');
    demo = JSON.parse(readFileSync(input, 'utf8'));
  } else {
    const root = options['--root']; absentPrivateTarget(root);
    const repo = options['--source-root'] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const assertSourceRevision = () => {
      if (!options['--source-revision']) return;
      const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      // Documentation and test edits do not change the executed demo sources.
      if (git(['rev-parse', 'HEAD']) !== options['--source-revision'] ||
        git(['status', '--porcelain=v1', '--untracked-files=all', '--',
          'src', 'package.json', 'package-lock.json', 'tsconfig.json']) !== '') {
        throw new Error('Source revision requires unchanged runtime sources and dependency declarations at the requested commit');
      }
    };
    assertSourceRevision();
    mkdirSync(root, { mode: 0o700 });
    // Import only the trusted source demo, never general Hub setup or providers.
    const { register } = await import('tsx/esm/api'); register();
    const { runUniverseDemo } = await import(pathToFileURL(resolve(repo, 'src/cli/universe-demo.ts')).href);
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), 150_000);
    try { demo = await runUniverseDemo({ root, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    assertSourceRevision();
  }
  const evidence = projectUniverseShowcase(demo, { sourceRevision: options['--source-revision'] });
  absentPrivateTarget(output);
  const fd = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, `${JSON.stringify(evidence, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateUniverseShowcase(process.argv.slice(2)).then(() => {
    console.log('Public showcase evidence written; private demo state was not exported.');
  }).catch(() => {
    console.error('Showcase generation failed; existing files were not overwritten. Check arguments, source identity and demo evidence.');
    process.exitCode = 1;
  });
}

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, runUniverse, type UniverseManifest, type UniverseTrial } from '../src/core/universe/index.js';
import { artifactDigest } from '../src/core/universe/artifacts.js';

const fixtures: string[] = [];
const SENTINEL = 'benign test-owned sentinel\n';
const DENIED = ['EACCES', 'EPERM'];

afterEach(() => {
  const restoreDirectoryWrites = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) restoreDirectoryWrites(join(path, name));
  };
  for (const fixture of fixtures.splice(0)) {
    restoreDirectoryWrites(fixture);
    rmSync(fixture, { recursive: true, force: true });
  }
});

interface FixturePaths { outside: string; storeSibling: string; root: string }
const DEFAULT_EVALUATOR = `import {readFileSync} from 'node:fs';
import {join} from 'node:path';
const report=JSON.parse(readFileSync(join(process.env.ASHLR_UNIVERSE_CANDIDATE,'report.json'),'utf8'));
console.log(JSON.stringify({passed:report.ok===true,score:1}));
`;

function fixture(worker: (paths: FixturePaths) => string, evaluator = DEFAULT_EVALUATOR): {
  paths: FixturePaths; manifest: UniverseManifest;
} {
  // Both sentinels belong to this test. One is outside the store in the user's
  // home; the other is inside the store but outside every worker allowlist.
  const base = realpathSync(mkdtempSync(join(homedir(), '.ashlr-universe-confinement-')));
  fixtures.push(base);
  const root = join(base, 'store');
  const repo = join(base, 'repository');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(repo, { mode: 0o700 });
  const paths = { root, outside: join(base, 'outside.txt'), storeSibling: join(root, 'sibling.txt') };
  for (const path of [paths.outside, paths.storeSibling]) {
    writeFileSync(path, SENTINEL, { mode: 0o600 });
    expect(readFileSync(path, 'utf8')).toBe(SENTINEL);
  }
  writeFileSync(join(repo, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(repo, 'value.txt'), 'original candidate\n');
  writeFileSync(join(repo, 'worker.mjs'), worker(paths));
  writeFileSync(join(repo, 'evaluate.mjs'), evaluator);
  const git = (args: string[]): string => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Universe Test', '-c', 'user.email=universe@example.invalid', 'commit', '-qm', 'confinement fixture']);
  return { paths, manifest: {
    schemaVersion: 1, id: 'confinement', name: 'Test-owned confinement checks', objective: 'Verify declared local filesystem boundaries',
    seed: { repo, revision: git(['rev-parse', 'HEAD']) }, metric: { name: 'checks', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 30_000, trialTimeoutMs: 8_000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'evaluate.mjs'], timeoutMs: 5_000 },
    variants: [{ id: 'fixture', niche: 'confinement', hypothesis: 'Only declared paths are accessible', command: [process.execPath, 'worker.mjs'] }],
  } };
}

async function runFixture(value: ReturnType<typeof fixture>): Promise<UniverseTrial> {
  initUniverse(value.manifest, { root: value.paths.root });
  const run = await runUniverse(value.manifest.id, { root: value.paths.root });
  expect(run.status, JSON.stringify(run)).toBe('completed');
  expect(run.trials).toHaveLength(1);
  const trial = run.trials[0]!;
  expect(trial.status, JSON.stringify(trial)).toBe('passed');
  expect(trial.artifact).not.toBeNull();
  expect(artifactDigest(trial.artifact!.path)).toBe(trial.artifact!.digest);
  return trial;
}

// Direct, benign accesses to temporary files exercise the real macOS profile.
// This is scoped assurance of declared boundaries, not a hostile-code VM audit.
describe.runIf(process.platform === 'darwin')('Universe filesystem confinement', () => {
  it('denies worker reads of home and store sentinels outside its allowed paths', async () => {
    const value = fixture((paths) => `import {readFileSync,writeFileSync} from 'node:fs';
const codes=${JSON.stringify([paths.outside, paths.storeSibling])}.map(path=>{
  try { readFileSync(path,'utf8'); return 'READ_ALLOWED'; } catch(error) { return error.code; }
});
const ownRead=readFileSync('value.txt','utf8')==='original candidate\\n';
writeFileSync('report.json',JSON.stringify({ok:ownRead&&codes.every(code=>['EACCES','EPERM'].includes(code)),codes,ownRead}));
`);
    const trial = await runFixture(value);
    const report = JSON.parse(readFileSync(join(trial.artifact!.path, 'report.json'), 'utf8'));
    expect(report.ownRead).toBe(true);
    expect(report.codes).toHaveLength(2);
    for (const code of report.codes) expect(DENIED).toContain(code);
    for (const path of [value.paths.outside, value.paths.storeSibling]) expect(readFileSync(path, 'utf8')).toBe(SENTINEL);
  });

  it('denies worker writes to siblings while allowing candidate and private scratch writes', async () => {
    const value = fixture((paths) => `import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const codes=${JSON.stringify([paths.outside, paths.storeSibling])}.map(path=>{
  try { writeFileSync(path,'changed by fixture'); return 'WRITE_ALLOWED'; } catch(error) { return error.code; }
});
writeFileSync('value.txt','updated candidate\\n');
const scratch=join(process.env.TMPDIR,'positive-control.txt');
writeFileSync(scratch,'scratch writes work');
const scratchWritable=readFileSync(scratch,'utf8')==='scratch writes work';
writeFileSync('report.json',JSON.stringify({ok:scratchWritable&&codes.every(code=>['EACCES','EPERM'].includes(code)),codes,scratchWritable}));
`);
    const trial = await runFixture(value);
    const report = JSON.parse(readFileSync(join(trial.artifact!.path, 'report.json'), 'utf8'));
    expect(report.scratchWritable).toBe(true);
    expect(report.codes).toHaveLength(2);
    for (const code of report.codes) expect(DENIED).toContain(code);
    expect(readFileSync(join(trial.artifact!.path, 'value.txt'), 'utf8')).toBe('updated candidate\n');
    for (const path of [value.paths.outside, value.paths.storeSibling]) expect(readFileSync(path, 'utf8')).toBe(SENTINEL);
  });

  it('denies evaluator mutation of the frozen candidate while allowing evaluator scratch writes', async () => {
    const evaluator = `import {chmodSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const candidate=join(process.env.ASHLR_UNIVERSE_CANDIDATE,'value.txt');
const before=readFileSync(candidate,'utf8');
const denied=operation=>{try{operation();return false;}catch(error){return ['EACCES','EPERM'].includes(error.code);}};
const writeDenied=denied(()=>writeFileSync(candidate,'changed by evaluator fixture'));
const chmodDenied=denied(()=>chmodSync(candidate,0o600));
const scratch=join(process.env.TMPDIR,'positive-control.txt');
writeFileSync(scratch,'evaluator scratch works');
const scratchWritable=readFileSync(scratch,'utf8')==='evaluator scratch works';
const unchanged=readFileSync(candidate,'utf8')===before;
console.log(JSON.stringify({passed:writeDenied&&chmodDenied&&scratchWritable&&unchanged,score:4,
  metrics:{writeDenied:Number(writeDenied),chmodDenied:Number(chmodDenied),scratchWritable:Number(scratchWritable),unchanged:Number(unchanged)}}));
`;
    const value = fixture(() => `import {writeFileSync} from 'node:fs';
writeFileSync('value.txt','worker candidate\\n');
`, evaluator);
    const trial = await runFixture(value);
    expect(trial.metrics).toEqual({ writeDenied: 1, chmodDenied: 1, scratchWritable: 1, unchanged: 1 });
    expect(readFileSync(join(trial.artifact!.path, 'value.txt'), 'utf8')).toBe('worker candidate\n');
  });
});

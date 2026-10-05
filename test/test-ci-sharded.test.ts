import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectShardConcurrency } from '../scripts/test-ci-sharded.mjs';

const sourceScripts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runFixture(failure: 'none' | 'middle' | 'isolated' | 'stubborn', concurrency = '2') {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-shards-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  for (const file of ['test-ci.mjs', 'test-ci-sharded.mjs']) {
    copyFileSync(join(sourceScripts, file), join(root, 'scripts', file));
  }
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
const shard = process.argv.find((arg) => arg.startsWith('--shard='));
import * as fs from 'node:fs';
const event = (kind) => fs.appendFileSync(${JSON.stringify('EVENT_PATH')}, JSON.stringify({kind, shard, pid:process.pid})+'\\n');
if (shard) event('start');
console.log(JSON.stringify({ shard, file: process.argv.find((arg) => arg.endsWith('.test.ts') && !arg.startsWith('--exclude=')), filter: process.argv.includes('-t') ? process.argv[process.argv.indexOf('-t') + 1] : undefined, excludes: process.argv.filter((arg) => arg.startsWith('--exclude=')), workers: process.argv.find((arg) => arg.startsWith('--maxWorkers=')), parallelism: process.argv.filter((arg) => arg.startsWith('--fileParallelism=')), bail: process.argv.find((arg) => arg.startsWith('--bail=')), home: process.env.HOME, tmp: process.env.TMPDIR, pid:process.pid }));
if (['middle','stubborn'].includes(process.env.ASHLR_FAKE_FAILURE) && shard === '--shard=2/3') {
  setTimeout(() => { event('end'); process.exitCode = 7; }, 300);
} else if (['middle','stubborn'].includes(process.env.ASHLR_FAKE_FAILURE)) {
  if (process.env.ASHLR_FAKE_FAILURE === 'stubborn') process.on('SIGTERM',()=>{});
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'isolated' && process.argv.includes('automatic seed measurement: true')) {
  process.exitCode = 9;
} else if (shard) {
  setTimeout(() => { event('end'); }, 300);
}
`.replace(JSON.stringify('EVENT_PATH'), JSON.stringify(join(root, 'events.jsonl'))), 'utf8');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'test-ci-sharded.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 8_000,
    env: { ...process.env, ASHLR_FAKE_FAILURE: failure,
      ASHLR_TEST_CI_SHARD_CONCURRENCY: concurrency, ASHLR_TEST_CI_SHARD_PEAK_RSS_BYTES: undefined,
      ASHLR_TEST_CI_TIMEOUT_MS: '4000', ASHLR_TEST_CI_IDLE_TIMEOUT_MS: '4000',
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100' },
  });
  const events = result.stdout ? readFileSync(join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as {kind:string; shard:string; pid:number}) : [];
  return { ...result, events };
}

describe('local exhaustive prepublish shards', () => {
  it('requires all three exact CI shards with separate test homes and bounded workers', () => {
    const result = runFixture('none');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      shard?: string; file?: string; filter?: string; excludes: string[]; workers: string; parallelism: string[]; bail: string; home: string; tmp: string;
    });
    expect(rows.filter((row) => row.shard).map((row) => row.shard).sort()).toEqual(['--shard=1/3', '--shard=2/3', '--shard=3/3']);
    // Observe actual coordinator launches, independent of child log ordering.
    // All partitions still run once; the measured longest pair gets both slots.
    expect([...result.stderr.matchAll(/started (\d)\/3/g)].map(match => Number(match[1]))).toEqual([3, 2, 1]);
    expect(rows).toHaveLength(12);
    const isolatedFiles = [
      'test/m342.dispatch-production-ledger.test.ts',
      'test/m395.effect-terminal-retention.test.ts',
      'test/m446.external-skill-git-capture.test.ts',
      'test/resource-engineering-setup-acceptance.test.ts',
      'test/resource-engineering-supervisor-acceptance.test.ts',
      'test/resource-console-engineering-acceptance.test.ts',
      'test/universe-firm-engineering-control.test.ts',
    ];
    expect(rows.filter((row) => row.shard).every((row) => row.excludes.length === 8 &&
      [...isolatedFiles, 'test/universe-hub-marker-campaign.test.ts'].every((file) =>
        row.excludes.includes(`--exclude=${file}`)))).toBe(true);
    expect(rows.filter((row) => !row.shard).map((row) => row.file)).toEqual([
      ...isolatedFiles,
      'test/universe-hub-marker-campaign.test.ts', 'test/universe-hub-marker-campaign.test.ts',
    ]);
    expect(rows.filter((row) => !row.shard).map((row) => row.filter)).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'automatic seed measurement: false', 'automatic seed measurement: true',
    ]);
    expect(rows.every((row) => row.workers === '--maxWorkers=1')).toBe(true);
    expect(rows.every((row) => row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false')).toBe(true);
    expect(rows.every((row) => row.bail === '--bail=1')).toBe(true);
    expect(new Set(rows.map((row) => row.home)).size).toBe(12);
    expect(rows.every((row) => row.tmp === join(row.home, 'tmp'))).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it('fails closed and terminates sibling wrappers when one shard fails', () => {
    const result = runFixture('middle');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
  });

  it('fails closed when the isolated campaign acceptance fails', () => {
    const result = runFixture('isolated');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(9);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 9)');
  });
});


describe('resource-derived local shard startup estimate', () => {
  const resources = { preference: undefined, peakBytes: undefined, cpuCount: 18, availableBytes: 1_000_000 };
  it('imports the chooser without launching work or signal handlers when caller argv cannot resolve', () => {
    const source = pathToFileURL(join(sourceScripts, 'test-ci-sharded.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      process.argv[1] = ${JSON.stringify(join(sourceScripts, 'not-an-existing-caller.mjs'))};
      const before = process.listenerCount('SIGTERM');
      const module = await import(${JSON.stringify(source)});
      if (process.listenerCount('SIGTERM') !== before) throw new Error('import activated scheduler');
      console.log(module.selectShardConcurrency({cpuCount:18}).slots);
    `], {encoding:'utf8', timeout:2000});
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toBe('2\n'); expect(result.stderr).toBe('');
  });
  it('keeps the observed two slots without a measured process-tree peak even on a large host', () => {
    expect(selectShardConcurrency(resources)).toMatchObject({slots:2, mode:'automatic', measuredPeak:null});
    expect(selectShardConcurrency({...resources, cpuCount:1})).toMatchObject({slots:1});
    expect(selectShardConcurrency({...resources, cpuCount:undefined})).toMatchObject({slots:1, cpus:null});
  });
  it('uses available memory and a measured whole-shard envelope rather than total RAM', () => {
    expect(selectShardConcurrency({...resources, peakBytes:'400000'})).toMatchObject({slots:2});
    expect(selectShardConcurrency({...resources, peakBytes:'300000'})).toMatchObject({slots:3});
    expect(selectShardConcurrency({...resources, peakBytes:'300000', cpuCount:1})).toMatchObject({slots:1});
    expect(selectShardConcurrency({...resources, peakBytes:'300000', availableBytes:200000})).toMatchObject({slots:0});
    expect(selectShardConcurrency({...resources, availableBytes:0})).toMatchObject({slots:0, availableBytes:0});
  });
  it.each([undefined, NaN, Infinity, -1, 0.5])('qualifies unknown memory %s without inventing headroom', availableBytes => {
    expect(selectShardConcurrency({...resources, peakBytes:'1', availableBytes})).toMatchObject({slots:2, availableBytes:null});
  });
  it.each(['1','2','3'])('keeps explicit %s a diagnostic preference rather than a resource proof', preference => {
    expect(selectShardConcurrency({...resources, preference, availableBytes:0, cpuCount:1})).toMatchObject({slots:Number(preference),mode:'explicit'});
  });
  it.each(['0','4','NaN','Infinity','9007199254740992','2.5','-1','', ' 3'])('refuses invalid explicit slots %s', preference => {
    expect(() => selectShardConcurrency({...resources, preference})).toThrow('CONCURRENCY');
  });
  it.each(['0','NaN','Infinity','9007199254740992','2.5','-1',''])('refuses invalid calibration %s', peakBytes => {
    expect(() => selectShardConcurrency({...resources, peakBytes})).toThrow('PEAK_RSS_BYTES');
  });
  it.each(['1','2','3'])('runs exactly all partitions with at most %s actual children and then every isolated case', concurrency => {
    const result=runFixture('none',concurrency);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    let active=0; let peak=0;
    for (const event of result.events) { active += event.kind==='start' ? 1 : -1; peak=Math.max(peak,active); expect(active).toBeGreaterThanOrEqual(0); }
    expect(active).toBe(0); expect(peak).toBe(Number(concurrency));
    expect(result.events.filter(event=>event.kind==='start').map(event=>event.shard).sort()).toEqual(['--shard=1/3','--shard=2/3','--shard=3/3']);
    const rows=result.stdout.trim().split('\n').map(line=>JSON.parse(line) as {home:string; workers:string; parallelism:string[]});
    expect(rows).toHaveLength(12); expect(new Set(rows.map(row=>row.home)).size).toBe(12);
    expect(rows.every(row=>row.workers==='--maxWorkers=1' && row.parallelism[0]==='--fileParallelism=false')).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });
  it('terminates both other active wrappers and their children on three-way failure without isolated work', () => {
    const result=runFixture('middle','3');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.events.filter(event=>event.kind==='start')).toHaveLength(3);
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(2);
    expect(result.stdout).not.toContain('"file":');
    for (const event of result.events) expect(() => process.kill(event.pid,0)).toThrow();
  });
  it('retains watchdog SIGKILL settlement for stubborn three-way siblings', () => {
    const result = runFixture('stubborn', '3');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.events.filter(event => event.kind === 'start')).toHaveLength(3);
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(2);
    expect(result.stdout).not.toContain('"file":');
    for (const event of result.events) expect(() => process.kill(event.pid, 0)).toThrow();
  });
  it('refuses invalid slots before starting any test worker', () => {
    const result=runFixture('none','4');
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.events).toEqual([]);
    expect(result.stderr).toContain('CONCURRENCY');
  });
});

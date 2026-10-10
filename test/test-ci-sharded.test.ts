import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceScripts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const isolatedFiles = [
  'test/m342.dispatch-production-ledger.test.ts',
  'test/m395.effect-terminal-retention.test.ts',
  'test/m446.external-skill-git-capture.test.ts',
  'test/resource-engineering-setup-acceptance.test.ts',
  'test/resource-engineering-supervisor-acceptance.test.ts',
  'test/resource-engineering-supervisor-admission-acceptance.test.ts',
  'test/resource-console-engineering-acceptance.test.ts',
  'test/universe-firm-engineering-control.test.ts',
  'test/universe-engineering-handoff-recovery.test.ts',
  'test/universe-campaign-integration.test.ts',
  'test/resource-engineering-successor-acceptance.test.ts',
  'test/universe-supervision-integration.test.ts',
];
const markerFile = 'test/universe-hub-marker-campaign.test.ts';

function runFixture(
  failure: 'none' | 'middle' | 'isolated' | 'successor' | 'supervision' | 'signal',
  phaseEnvironment: Record<string, string> = {},
  args: string[] = [],
  report?: 'private' | 'stale' | 'permissive' | 'sticky' | 'symlink' | 'relative' | 'missing' | 'empty' | 'file' | 'wrong-owner' | 'no-posix-owner',
) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-shards-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  for (const file of ['test-ci.mjs', 'test-ci-sharded.mjs']) {
    copyFileSync(join(sourceScripts, file), join(root, 'scripts', file));
  }
  let reportDirectory: string | undefined;
  if (report !== undefined) {
    reportDirectory = join(realpathSync(root), 'reports');
    if (report === 'file') writeFileSync(reportDirectory, '', { mode: 0o600 });
    else if (report !== 'missing') mkdirSync(reportDirectory, { mode: 0o700 });
    if (report === 'stale') writeFileSync(join(reportDirectory, 'general-2-of-4.json'), '{}');
    if (report === 'permissive') chmodSync(reportDirectory, 0o755);
    if (report === 'sticky') chmodSync(reportDirectory, 0o1700);
    if (report === 'symlink') {
      const alias = join(realpathSync(root), 'report-alias');
      symlinkSync(reportDirectory, alias, 'dir'); reportDirectory = alias;
    }
    if (report === 'relative') reportDirectory = 'reports';
    if (report === 'empty') reportDirectory = '';
    if (report === 'wrong-owner' || report === 'no-posix-owner') {
      // Simulate an unavailable/mismatched ownership witness in this copy only;
      // no privilege change, chown or production probe is involved.
      const path = join(root, 'scripts', 'test-ci-sharded.mjs');
      const prefix = report === 'wrong-owner'
        ? 'const fixtureUid = process.getuid?.() ?? 0; process.getuid = () => fixtureUid + 1;'
        : 'process.getuid = undefined;';
      writeFileSync(path, readFileSync(path, 'utf8').replace('\n', `\n${prefix}\n`));
    }
  }
  // The signal fixture alone tells its fake child the exact owned coordinator.
  if (failure === 'signal') {
    const path = join(root, 'scripts', 'test-ci-sharded.mjs');
    const source = readFileSync(path, 'utf8');
    writeFileSync(path, source.replace('\n', '\nprocess.env.ASHLR_FAKE_COORDINATOR_PID = String(process.pid);\n'));
  }
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
const shard = process.argv.find((arg) => arg.startsWith('--shard='));
console.log(JSON.stringify({ pid: process.pid, wrapperPid: process.ppid, shard, file: process.argv.find((arg) => arg.endsWith('.test.ts') && !arg.startsWith('--exclude=')), filter: process.argv.includes('-t') ? process.argv[process.argv.indexOf('-t') + 1] : undefined, excludes: process.argv.filter((arg) => arg.startsWith('--exclude=')), reporters: process.argv.filter((arg) => arg.startsWith('--reporter=')), outputFiles: process.argv.filter((arg) => arg.startsWith('--outputFile')), reportDirectory: process.env.ASHLR_TEST_CI_REPORT_DIRECTORY, workers: process.argv.find((arg) => arg.startsWith('--maxWorkers=')), parallelism: process.argv.filter((arg) => arg.startsWith('--fileParallelism=')), bail: process.argv.find((arg) => arg.startsWith('--bail=')), home: process.env.HOME, tmp: process.env.TMPDIR, setupTiming: process.env.ASHLR_ENGINEERING_SETUP_PHASE_TIMING, successorTiming: process.env.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING, admissionTiming: process.env.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING, acceptanceTiming: process.env.ASHLR_ACCEPTANCE_PHASE_TIMING, weighted: process.env.ASHLR_TEST_CI_WEIGHTED_PARTITION, weightHints: process.env.ASHLR_TEST_CI_WEIGHTED_HINTS, hardTimeout: process.env.ASHLR_TEST_CI_TIMEOUT_MS, idleTimeout: process.env.ASHLR_TEST_CI_IDLE_TIMEOUT_MS }));
if (process.env.ASHLR_FAKE_FAILURE === 'signal') {
  if (shard === '--shard=3/4') setTimeout(() => {
    process.kill(Number(process.env.ASHLR_FAKE_COORDINATOR_PID), 'SIGTERM');
  }, 100);
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'middle' && shard === '--shard=3/4') {
  setTimeout(() => { process.exitCode = 7; }, 100);
} else if (process.env.ASHLR_FAKE_FAILURE === 'middle') {
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'successor' && process.argv.includes('test/resource-engineering-successor-acceptance.test.ts')) {
  process.exitCode = 11;
} else if (process.env.ASHLR_FAKE_FAILURE === 'supervision' && process.argv.includes('test/universe-supervision-integration.test.ts')) {
  process.exitCode = 12;
} else if (process.env.ASHLR_FAKE_FAILURE === 'isolated' && process.argv.includes('automatic seed measurement: true')) {
  process.exitCode = 9;
}
`, 'utf8');
  // Baseline defaults must be independent of the outer release's timing flags.
  // Clear only this fixture's copied environment, then apply caller overrides.
  const environment = { ...process.env };
  delete environment.ASHLR_ENGINEERING_SETUP_PHASE_TIMING;
  delete environment.ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING;
  delete environment.ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING;
  delete environment.ASHLR_ACCEPTANCE_PHASE_TIMING;
  delete environment.ASHLR_TEST_CI_REPORT_DIRECTORY;
  delete environment.ASHLR_TEST_CI_WEIGHTED_PARTITION;
  delete environment.ASHLR_TEST_CI_WEIGHTED_HINTS;
  if (reportDirectory !== undefined) environment.ASHLR_TEST_CI_REPORT_DIRECTORY = reportDirectory;
  return spawnSync(process.execPath, [join(root, 'scripts', 'test-ci-sharded.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 8_000,
    env: { ...environment, ...phaseEnvironment, ASHLR_FAKE_FAILURE: failure,
      ASHLR_TEST_CI_TIMEOUT_MS: '4000', ASHLR_TEST_CI_IDLE_TIMEOUT_MS: '4000',
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100' },
  });
}

describe('local exhaustive prepublish shards', () => {
  it('requires all four exhaustive local shards with separate test homes and bounded workers', () => {
    const result = runFixture('none');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      shard?: string; file?: string; filter?: string; excludes: string[]; workers: string; parallelism: string[]; bail: string; home: string; tmp: string; setupTiming: string; successorTiming: string; admissionTiming: string; acceptanceTiming: string; hardTimeout: string; idleTimeout: string; outputFiles: string[]; reporters: string[]; reportDirectory?: string;
    });
    expect(rows.filter((row) => row.shard).map((row) => row.shard).sort()).toEqual(['--shard=1/4', '--shard=2/4', '--shard=3/4', '--shard=4/4']);
    // Observe actual coordinator launches, independent of child log ordering.
    // All partitions run once; the same two queue consumers own the slots.
    expect([...result.stderr.matchAll(/started (\d)\/4/g)].map(match => Number(match[1]))).toEqual([4, 3, 2, 1]);
    // Ordered coordinator events prove the ceiling without fake sleeps/files.
    const active = new Set<number>(), started = new Set<number>(), ended = new Set<number>();
    let maximum = 0, isolatedStarts = 0;
    for (const line of result.stderr.split('\n')) {
      const start = /^\[test-ci:sharded\] started (\d)\/4 /.exec(line);
      const finish = /^\[test-ci:sharded\] (\d)\/4 exited 0$/.exec(line);
      if (start) {
        const shard = Number(start[1]); expect(started.has(shard)).toBe(false);
        started.add(shard); active.add(shard); maximum = Math.max(maximum, active.size);
        expect(active.size).toBeLessThanOrEqual(2);
      } else if (finish) {
        const shard = Number(finish[1]); expect(active.delete(shard)).toBe(true);
        expect(ended.has(shard)).toBe(false); ended.add(shard);
      } else if (line.startsWith('[test-ci:sharded] started isolated acceptance ')) {
        expect(active.size).toBe(0); isolatedStarts++;
      }
    }
    expect(maximum).toBe(2); expect(active.size).toBe(0);
    expect([...started].sort()).toEqual([1, 2, 3, 4]); expect(ended).toEqual(started);
    expect(isolatedStarts).toBe(14);
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.setupTiming === '1' && row.successorTiming === '1' && row.admissionTiming === '1')).toBe(true);
    expect(rows.every((row) => row.acceptanceTiming === '1')).toBe(true);
    expect(rows.every((row) => row.hardTimeout === '4000' && row.idleTimeout === '4000')).toBe(true);
    expect(rows.filter((row) => row.shard).every((row) => row.excludes.length === 13 &&
      [...isolatedFiles, 'test/universe-hub-marker-campaign.test.ts'].every((file) =>
        row.excludes.includes(`--exclude=${file}`)))).toBe(true);
    expect(rows.filter((row) => !row.shard).map((row) => row.file)).toEqual([
      ...isolatedFiles,
      'test/universe-hub-marker-campaign.test.ts', 'test/universe-hub-marker-campaign.test.ts',
    ]);
    expect(rows.filter((row) => !row.shard).map((row) => row.filter)).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      'automatic seed measurement: false', 'automatic seed measurement: true',
    ]);
    expect(rows.every((row) => row.workers === '--maxWorkers=1')).toBe(true);
    expect(rows.every((row) => row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false')).toBe(true);
    expect(rows.every((row) => row.bail === '--bail=1')).toBe(true);
    expect(rows.every(row => row.outputFiles.length === 0 && row.reportDirectory === undefined &&
      row.reporters.length === 2 && !row.reporters.includes('--reporter=json'))).toBe(true);
    expect(new Set(rows.map((row) => row.home)).size).toBe(18);
    expect(rows.every((row) => row.tmp === join(row.home, 'tmp'))).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it.each([1, 2, 3, 4])('runs only general shard %i/4 with the full shared exclusion set', (shard) => {
    const result = runFixture('none', {}, [`--general-shard=${shard}/4`]);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      shard?: string; file?: string; excludes: string[]; workers: string; parallelism: string[]; bail: string; home: string;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shard: `--shard=${shard}/4`, workers: '--maxWorkers=1', parallelism: ['--fileParallelism=false'], bail: '--bail=1',
    });
    expect(rows[0]?.file).toBeUndefined();
    expect(rows[0]?.excludes.sort()).toEqual([...isolatedFiles, markerFile].map(file => `--exclude=${file}`).sort());
    expect(result.stderr).toContain(`[test-ci:sharded] PASS (general ${shard}/4)`);
    expect(result.stderr).not.toContain('started isolated acceptance');
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
  });

  it('keeps explicit weighted calibration on general lanes and removes it from every isolated child', () => {
    const calibration = { ASHLR_TEST_CI_WEIGHTED_PARTITION: '1', ASHLR_TEST_CI_WEIGHTED_HINTS: '/private/inert-hints.json' };
    const general = runFixture('none', calibration, ['--general-shard=1/4']);
    expect(general.status).toBe(0);
    expect(JSON.parse(general.stdout.trim())).toMatchObject({ shard: '--shard=1/4', weighted: '1', weightHints: '/private/inert-hints.json' });
    const isolated = runFixture('none', calibration, ['--isolated-only']);
    expect(isolated.status).toBe(0);
    const rows = isolated.stdout.trim().split('\n').map(line => JSON.parse(line) as { weighted?: string; weightHints?: string; shard?: string });
    expect(rows).toHaveLength(14);
    expect(rows.every(row => row.weighted === undefined && row.weightHints === undefined && row.shard === undefined)).toBe(true);
  });

  it('runs the complete isolated lane alone in fourteen separate homes', () => {
    const result = runFixture('none', {}, ['--isolated-only']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      shard?: string; file?: string; filter?: string; excludes: string[]; home: string; workers: string; parallelism: string[]; bail: string;
    });
    expect(rows).toHaveLength(14);
    expect(rows.every(row => row.shard === undefined && row.excludes.length === 0)).toBe(true);
    expect(rows.map(row => row.file)).toEqual([...isolatedFiles, markerFile, markerFile]);
    expect(rows.map(row => row.filter)).toEqual([
      ...isolatedFiles.map(() => undefined), 'automatic seed measurement: false', 'automatic seed measurement: true',
    ]);
    expect(rows.every(row => row.workers === '--maxWorkers=1' && row.bail === '--bail=1' &&
      row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false')).toBe(true);
    expect(new Set(rows.map(row => row.home)).size).toBe(14);
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
    expect(result.stderr).not.toMatch(/started \d\/4/);
    expect(result.stderr).toContain('[test-ci:sharded] PASS (isolated ');
  });

  it.skipIf(process.platform === 'win32').each([
    { args: [], names: [...[1, 2, 3, 4].map(shard => `general-${shard}-of-4.json`),
      ...Array.from({ length: 14 }, (_, index) => `isolated-${String(index + 1).padStart(2, '0')}.json`)] },
    { args: ['--general-shard=2/4'], names: ['general-2-of-4.json'] },
    { args: ['--isolated-only'], names: Array.from({ length: 14 }, (_, index) => `isolated-${String(index + 1).padStart(2, '0')}.json`) },
  ])('assigns fixed JSON report names while retaining console/progress reporters: $args', ({ args, names }) => {
    const result = runFixture('none', {}, args, 'private');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as {
      reporters: string[]; outputFiles: string[]; reportDirectory: string;
    });
    expect(rows).toHaveLength(names.length);
    expect(rows.map(row => {
      expect(row.reporters).toHaveLength(3);
      expect(row.reporters).toContain('--reporter=default');
      expect(row.reporters).toContain('--reporter=json');
      expect(row.reporters.some(value => value.endsWith('vitest-progress-reporter.mjs'))).toBe(true);
      expect(row.outputFiles).toHaveLength(1);
      const output = row.outputFiles[0] ?? '';
      expect(output.startsWith('--outputFile.json=')).toBe(true);
      const file = output.slice('--outputFile.json='.length);
      expect(dirname(file)).toBe(row.reportDirectory);
      return basename(file);
    }).sort()).toEqual([...names].sort());
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it.skipIf(process.platform === 'win32').each([
    'stale', 'permissive', 'sticky', 'symlink', 'relative', 'missing', 'empty', 'file', 'wrong-owner',
  ] as const)('rejects unsafe report directory before any child launch: %s', (report) => {
    const result = runFixture('none', {}, ['--general-shard=2/4'], report);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Report directory must be empty, canonical, owned, and private (0700) on POSIX.');
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('fails report mode closed when POSIX ownership inspection is unavailable', () => {
    const result = runFixture('none', {}, ['--isolated-only'], 'no-posix-owner');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Report directory must be empty, canonical, owned, and private (0700) on POSIX.');
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
  });

  it.each([
    ['--general-shard=0/4'], ['--general-shard=5/4'], ['--general-shard=1/3'], ['--general-shard=01/4'],
    ['--general-shard=1/4', '--isolated-only'], ['--isolated-only', '--isolated-only'],
    ['--general-shard=1/4', '--general-shard=2/4'], ['--isolated-only', '-t', 'arbitrary'],
    ['test/other.test.ts'], ['--shard=1/4'], ['--help'],
  ])('rejects invalid selectors without launching children: %j', (...args) => {
    const result = runFixture('none', {}, args);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage: test-ci-sharded.mjs');
    expect(result.stderr).not.toContain('[test-ci:sharded] started');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('propagates a selected general shard failure without starting any other lane', () => {
    const result = runFixture('middle', {}, ['--general-shard=3/4']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { shard: string; home: string });
    expect(rows).toHaveLength(1); expect(rows[0]?.shard).toBe('--shard=3/4');
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
    expect(result.stderr).not.toContain('started isolated acceptance');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it.each([
    { failure: 'successor' as const, code: 11, launched: 11 },
    { failure: 'supervision' as const, code: 12, launched: 12 },
    { failure: 'isolated' as const, code: 9, launched: 14 },
  ])('fails closed within the selected isolated lane: $failure', ({ failure, code, launched }) => {
    const result = runFixture(failure, {}, ['--isolated-only']);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(code);
    const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { shard?: string; file: string; home: string });
    expect(rows).toHaveLength(launched);
    expect(rows.every(row => row.shard === undefined && !existsSync(row.home))).toBe(true);
    expect(rows.map(row => row.file)).toEqual([...isolatedFiles, markerFile, markerFile].slice(0, launched));
    expect(result.stderr).not.toMatch(/started \d\/4/);
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it.each([
    { setup: '0', successor: '0', admission: '0', acceptance: '0' },
    { setup: '', successor: 'custom', admission: '', acceptance: '' },
    { setup: 'custom', successor: '', admission: 'custom', acceptance: 'custom' },
  ])('preserves explicit phase-output choices $setup/$successor/$admission/$acceptance for every child', ({ setup, successor, admission, acceptance }) => {
    const parentAcceptance = process.env.ASHLR_ACCEPTANCE_PHASE_TIMING;
    const result = runFixture('none', {
      ASHLR_ENGINEERING_SETUP_PHASE_TIMING: setup,
      ASHLR_ENGINEERING_SUCCESSOR_PHASE_TIMING: successor,
      ASHLR_ENGINEERING_ADMISSION_PHASE_TIMING: admission,
      ASHLR_ACCEPTANCE_PHASE_TIMING: acceptance,
    });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      setupTiming: string; successorTiming: string; admissionTiming: string; acceptanceTiming: string; hardTimeout: string; idleTimeout: string;
    });
    expect(rows).toHaveLength(18);
    expect(rows.every((row) => row.setupTiming === setup && row.successorTiming === successor && row.admissionTiming === admission)).toBe(true);
    expect(rows.every((row) => row.acceptanceTiming === acceptance)).toBe(true);
    expect(process.env.ASHLR_ACCEPTANCE_PHASE_TIMING).toBe(parentAcceptance);
    expect(rows.every((row) => row.hardTimeout === '4000' && row.idleTimeout === '4000')).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it.skipIf(process.platform === 'win32')('settles both owned wrappers on SIGTERM without launching pending shards or isolated suites', () => {
    const result = runFixture('signal');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(143);
    const starts = [...result.stderr.matchAll(/started (\d)\/4 \(pid (\d+)\)/g)];
    expect(starts.map(match => Number(match[1]))).toEqual([4, 3]);
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(2);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
    expect(result.stderr).not.toContain('started isolated acceptance');
    const rows = result.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {
      shard?: string; file?: string; home: string; pid: number; wrapperPid: number;
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => ['--shard=3/4', '--shard=4/4'].includes(row.shard ?? '') && !row.file)).toBe(true);
    const pids = new Set([...starts.map(match => Number(match[2])), ...rows.flatMap(row => [row.pid, row.wrapperPid])]);
    for (const pid of pids) {
      // Signal zero observes these fixture-owned PIDs; it never kills them.
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
    }
    expect(rows.every(row => !existsSync(row.home))).toBe(true);
  });

  it('fails closed and terminates sibling wrappers when one shard fails', () => {
    const result = runFixture('middle');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
  });

  it('fails closed before marker cases when the whole isolated successor fixture fails', () => {
    const result = runFixture('successor');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(11);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { file?: string; filter?: string });
    expect(rows).toHaveLength(15); // Four shards and eleven whole files; no marker case starts.
    expect(rows.at(-1)).toMatchObject({ file: 'test/resource-engineering-successor-acceptance.test.ts' });
    expect(rows.at(-1)?.filter).toBeUndefined();
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
    expect(result.stdout).not.toContain('"file":"test/universe-supervision-integration.test.ts"');
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11)');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('fails closed before marker cases when the whole isolated supervision fixture fails', () => {
    const result = runFixture('supervision');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(12);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { file?: string; filter?: string });
    expect(rows).toHaveLength(16); // Four shards and twelve whole files; no marker case starts.
    expect(rows.at(-1)).toMatchObject({ file: 'test/universe-supervision-integration.test.ts' });
    expect(rows.at(-1)?.filter).toBeUndefined();
    expect(result.stdout).not.toContain('"file":"test/universe-hub-marker-campaign.test.ts"');
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 12)');
    expect(result.stderr).not.toContain('[test-ci:sharded] PASS');
  });

  it('fails closed when the isolated campaign acceptance fails', () => {
    const result = runFixture('isolated');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(9);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9)');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceScripts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runFixture(failure: 'none' | 'middle' | 'isolated') {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-shards-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  for (const file of ['test-ci.mjs', 'test-ci-sharded.mjs']) {
    copyFileSync(join(sourceScripts, file), join(root, 'scripts', file));
  }
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
const shard = process.argv.find((arg) => arg.startsWith('--shard='));
console.log(JSON.stringify({ shard, file: process.argv.find((arg) => arg.endsWith('.test.ts') && !arg.startsWith('--exclude=')), filter: process.argv.includes('-t') ? process.argv[process.argv.indexOf('-t') + 1] : undefined, excludes: process.argv.filter((arg) => arg.startsWith('--exclude=')), workers: process.argv.find((arg) => arg.startsWith('--maxWorkers=')), parallelism: process.argv.filter((arg) => arg.startsWith('--fileParallelism=')), bail: process.argv.find((arg) => arg.startsWith('--bail=')), home: process.env.HOME, tmp: process.env.TMPDIR }));
if (process.env.ASHLR_FAKE_FAILURE === 'middle' && shard === '--shard=2/3') {
  setTimeout(() => { process.exitCode = 7; }, 100);
} else if (process.env.ASHLR_FAKE_FAILURE === 'middle') {
  setInterval(() => {}, 1000);
} else if (process.env.ASHLR_FAKE_FAILURE === 'isolated' && process.argv.includes('automatic seed measurement: true')) {
  process.exitCode = 9;
}
`, 'utf8');
  return spawnSync(process.execPath, [join(root, 'scripts', 'test-ci-sharded.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 8_000,
    env: { ...process.env, ASHLR_FAKE_FAILURE: failure,
      ASHLR_TEST_CI_TIMEOUT_MS: '4000', ASHLR_TEST_CI_IDLE_TIMEOUT_MS: '4000',
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100' },
  });
}

describe('local exhaustive prepublish shards', () => {
  it('requires all three exact CI shards with separate test homes and bounded workers', () => {
    const result = runFixture('none');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      shard?: string; file?: string; filter?: string; excludes: string[]; workers: string; parallelism: string[]; bail: string; home: string; tmp: string;
    });
    expect(rows.filter((row) => row.shard).map((row) => row.shard).sort()).toEqual(['--shard=1/3', '--shard=2/3', '--shard=3/3']);
    expect(rows).toHaveLength(11);
    const isolatedFiles = [
      'test/m342.dispatch-production-ledger.test.ts',
      'test/m395.effect-terminal-retention.test.ts',
      'test/m446.external-skill-git-capture.test.ts',
      'test/resource-engineering-setup-acceptance.test.ts',
      'test/resource-engineering-supervisor-acceptance.test.ts',
      'test/universe-firm-engineering-control.test.ts',
    ];
    expect(rows.filter((row) => row.shard).every((row) => row.excludes.length === 7 &&
      [...isolatedFiles, 'test/universe-hub-marker-campaign.test.ts'].every((file) =>
        row.excludes.includes(`--exclude=${file}`)))).toBe(true);
    expect(rows.filter((row) => !row.shard).map((row) => row.file)).toEqual([
      ...isolatedFiles,
      'test/universe-hub-marker-campaign.test.ts', 'test/universe-hub-marker-campaign.test.ts',
    ]);
    expect(rows.filter((row) => !row.shard).map((row) => row.filter)).toEqual([
      undefined, undefined, undefined, undefined, undefined, undefined,
      'automatic seed measurement: false', 'automatic seed measurement: true',
    ]);
    expect(rows.every((row) => row.workers === '--maxWorkers=1')).toBe(true);
    expect(rows.every((row) => row.parallelism.length === 1 && row.parallelism[0] === '--fileParallelism=false')).toBe(true);
    expect(rows.every((row) => row.bail === '--bail=1')).toBe(true);
    expect(new Set(rows.map((row) => row.home)).size).toBe(11);
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
    expect(result.stderr).toContain('[test-ci:sharded] FAIL (0, 0, 0, isolated 0, 0, 0, 0, 0, 0, 0, 9)');
  });
});

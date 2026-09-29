import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceScripts = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function runFixture(failMiddle: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-shards-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true });
  for (const file of ['test-ci.mjs', 'test-ci-sharded.mjs']) {
    copyFileSync(join(sourceScripts, file), join(root, 'scripts', file));
  }
  writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), `
const shard = process.argv.find((arg) => arg.startsWith('--shard='));
console.log(JSON.stringify({ shard, workers: process.argv.find((arg) => arg.startsWith('--maxWorkers=')), bail: process.argv.find((arg) => arg.startsWith('--bail=')), home: process.env.HOME, tmp: process.env.TMPDIR }));
if (process.env.ASHLR_FAKE_FAIL_MIDDLE === '1' && shard === '--shard=2/3') {
  setTimeout(() => { process.exitCode = 7; }, 100);
} else if (process.env.ASHLR_FAKE_FAIL_MIDDLE === '1') {
  setInterval(() => {}, 1000);
}
`, 'utf8');
  return spawnSync(process.execPath, [join(root, 'scripts', 'test-ci-sharded.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 8_000,
    env: { ...process.env, ASHLR_FAKE_FAIL_MIDDLE: failMiddle ? '1' : '0',
      ASHLR_TEST_CI_TIMEOUT_MS: '4000', ASHLR_TEST_CI_IDLE_TIMEOUT_MS: '4000',
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100' },
  });
}

describe('local exhaustive prepublish shards', () => {
  it('requires all three exact CI shards with separate test homes and bounded workers', () => {
    const result = runFixture(false);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as {
      shard: string; workers: string; bail: string; home: string; tmp: string;
    });
    expect(rows.map((row) => row.shard).sort()).toEqual(['--shard=1/3', '--shard=2/3', '--shard=3/3']);
    expect(rows.every((row) => row.workers === '--maxWorkers=1')).toBe(true);
    expect(rows.every((row) => row.bail === '--bail=1')).toBe(true);
    expect(new Set(rows.map((row) => row.home)).size).toBe(3);
    expect(rows.every((row) => row.tmp === join(row.home, 'tmp'))).toBe(true);
    expect(result.stderr).toContain('[test-ci:sharded] PASS');
  });

  it('fails closed and terminates sibling wrappers when one shard fails', () => {
    const result = runFixture(true);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(7);
    expect(result.stderr).toContain('[test-ci:sharded] FAIL');
    expect(result.stderr.match(/received SIGTERM/g)).toHaveLength(2);
  });
});

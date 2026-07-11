import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const wrapper = resolve(here, '..', 'scripts', 'test-ci.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runFixture(
  source: string,
  options: { hardMs?: number; idleMs?: number; args?: string[] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-test-ci-wrapper-'));
  roots.push(root);
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  mkdirSync(dirname(vitest), { recursive: true });
  writeFileSync(vitest, source, 'utf8');

  return spawnSync(process.execPath, [wrapper, ...(options.args ?? [])], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      ...process.env,
      ASHLR_TEST_CI_TIMEOUT_MS: String(options.hardMs ?? 2_000),
      ASHLR_TEST_CI_IDLE_TIMEOUT_MS: String(options.idleMs ?? 1_000),
      ASHLR_TEST_CI_TERMINATION_GRACE_MS: '100',
    },
  });
}

describe('test-ci watchdog', () => {
  it('forwards shard argv and preserves successful exit status', () => {
    const result = runFixture(
      'console.log(JSON.stringify(process.argv.slice(2)));',
      { args: ['--shard=2/3'] },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('["run","--no-file-parallelism","--shard=2/3"]');
  });

  it('keeps an actively producing process alive past the idle window', () => {
    const result = runFixture(
      `let n = 0;
       const timer = setInterval(() => {
         console.log('progress-' + (++n));
         if (n === 5) { clearInterval(timer); process.exit(0); }
       }, 35);`,
      { idleMs: 80, hardMs: 1_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('progress-5');
    expect(result.stderr).not.toContain('idle-timeout');
  });

  it('reports silence as an idle timeout without claiming a leaked handle', () => {
    const result = runFixture('setTimeout(() => {}, 2_000);', {
      idleMs: 80,
      hardMs: 1_000,
    });

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('idle-timeout after 80ms without output');
    expect(result.stderr).toContain('not proven leaked handles');
    expect(result.stderr).not.toContain('hard-runtime-cap reached');
  });

  it('only identifies possible leaked handles after a final Vitest summary', () => {
    const result = runFixture(
      `console.log('Test Files  1 passed (1)');
       setTimeout(() => {}, 2_000);`,
      { idleMs: 80, hardMs: 1_000 },
    );

    expect(result.status).toBe(124);
    expect(result.stderr).toContain('idle-timeout after 80ms without output');
    expect(result.stderr).toContain('final summary; a leaked handle is plausible');
  });

  it('reports active work hitting the absolute cap as a runtime-budget failure', () => {
    const result = runFixture(
      `setInterval(() => console.log('still-running'), 30);`,
      { idleMs: 100, hardMs: 180 },
    );

    expect(result.status).toBe(124);
    expect(result.stdout).toContain('still-running');
    expect(result.stderr).toContain('hard-runtime-cap reached after 180ms');
    expect(result.stderr).toContain('not evidence of a leaked handle');
    expect(result.stderr).not.toContain('idle-timeout');
  });

  it.skipIf(process.platform === 'win32')('kills descendants after the leader exits on SIGTERM', () => {
    const descendant = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
    const result = runFixture(
      `import { spawn } from 'node:child_process';
       spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
       process.on('SIGTERM', () => process.exit(0));
       setInterval(() => {}, 1000);`,
      { idleMs: 80, hardMs: 1_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(124);
    expect(result.stderr).toContain('idle-timeout');
  });
});

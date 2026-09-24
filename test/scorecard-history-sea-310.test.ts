/**
 * Review finding c13 (3.10): inside the Bun single-file binary (the desktop
 * sidecar) the scorecard-history helper has no on-disk script — the binary
 * used to be re-run with `/scripts/scorecard-history-worker.mjs` as an argv,
 * which its CLI rejects as an unknown command (exit 2), so every history
 * read was `io-error` and every append false. The binary now re-enters itself
 * on a fixed, operand-free flag that its entry shim dispatches to the same
 * compiled-in helper. These tests pin the invocation and the shim dispatch
 * together; no binary is built here (verified manually with bun --compile).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSeaShim, SCORECARD_HISTORY_HELPER_FLAG as SHIM_FLAG } from '../scripts/build-sea.mjs';
import { SCORECARD_HISTORY_HELPER_FLAG, scorecardHistoryWorkerArgv } from '../src/core/fleet/scorecard-history.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scorecard history helper invocation (c13)', () => {
  it('inside a single-file binary re-enters the binary on the fixed flag (never a /$bunfs path)', () => {
    expect(scorecardHistoryWorkerArgv('file:///$bunfs/root/ashlr')).toEqual([SCORECARD_HISTORY_HELPER_FLAG]);
    expect(scorecardHistoryWorkerArgv('file:///B:/~BUN/root/ashlr.exe')).toEqual([SCORECARD_HISTORY_HELPER_FLAG]);
  });

  it('on disk (tsx / npm dist) still runs the shipped helper script by path', () => {
    const argv = scorecardHistoryWorkerArgv();
    expect(argv).toHaveLength(1);
    expect(argv[0]).toMatch(/scripts[\\/]scorecard-history-worker\.mjs$/);
    expect(existsSync(argv[0]!)).toBe(true);
  });

  it('the build shim and the module agree on the flag, and the shim matches it only as the ENTIRE argv', () => {
    expect(SHIM_FLAG).toBe(SCORECARD_HISTORY_HELPER_FLAG);
    const shim = createSeaShim({ pkgVersion: '3.10.0', buildIdentityJson: '{}' });
    expect(shim).toContain(`process.argv.length === 3 && process.argv[2] === ${JSON.stringify(SCORECARD_HISTORY_HELPER_FLAG)}`);
    // The helper branch is decided before the CLI (or any env mutation) loads.
    const helperAt = shim.indexOf("await import('../scripts/scorecard-history-worker.mjs');");
    expect(helperAt).toBeGreaterThan(0);
    expect(helperAt).toBeLessThan(shim.indexOf("await import('../dist/cli/index.js');"));
    expect(helperAt).toBeLessThan(shim.indexOf('process.env.ASHLR_WEB_PUBLIC'));
  });

  it('the shim dispatches the flag to the real helper (stdin protocol + pinned-root validation intact)', () => {
    const root = mkdtempSync(join(tmpdir(), 'c13-sea-shim-'));
    roots.push(root);
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(process.cwd(), 'scripts', 'scorecard-history-worker.mjs'), join(root, 'scripts', 'scorecard-history-worker.mjs'));
    const shimPath = join(root, 'bin', '_entry.mjs');
    writeFileSync(shimPath, createSeaShim({ pkgVersion: '3.10.0', buildIdentityJson: '{}' }), 'utf8');

    // A private state root with no history yet: the helper answers `missing`.
    const state = join(root, 'state');
    mkdirSync(state, { mode: 0o700 });
    const st = statSync(state, { bigint: true });
    const request = { operation: 'read', expectedRootDev: String(st.dev), expectedRootIno: String(st.ino), directoryName: 'scorecard-history' };
    const ok = spawnSync(process.execPath, [shimPath, SCORECARD_HISTORY_HELPER_FLAG], { cwd: state, input: JSON.stringify(request), encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ missing: true });

    // No valid stdin ⇒ the helper validates nothing and exits 1.
    const empty = spawnSync(process.execPath, [shimPath, SCORECARD_HISTORY_HELPER_FLAG], { cwd: state, input: '', encoding: 'utf8' });
    expect(empty.status).toBe(1);

    // The flag with an operand is NOT the helper: it falls through to the CLI
    // import (absent in this fixture ⇒ a module-not-found failure, never the helper).
    const operand = spawnSync(process.execPath, [shimPath, SCORECARD_HISTORY_HELPER_FLAG, '/etc/passwd'], { cwd: state, input: JSON.stringify(request), encoding: 'utf8' });
    expect(operand.status).not.toBe(0);
    expect(operand.stdout).not.toContain('missing');
  });
});

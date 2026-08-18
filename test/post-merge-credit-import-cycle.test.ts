/**
 * Regression test for the decisions-ledger.ts <-> post-merge-credit.ts
 * import cycle (with judge-trace.ts's POST_MERGE_CREDIT_RELEASE_LABEL also
 * riding through post-merge-credit.ts).
 *
 * Before the fix, POST_MERGE_CREDIT_RELEASE_LABEL was a `const` declared in
 * post-merge-credit.ts, imported by BOTH decisions-ledger.ts (which
 * post-merge-credit.ts itself imports back, for readDecisions/recordDecision)
 * and judge-trace.ts (for RELEASED_MERGE_OUTCOME_BASIS, read at that module's
 * own top level). Depending on which module a process happened to import
 * FIRST, ESM's live-binding/TDZ semantics could observe that const before
 * post-merge-credit.ts finished evaluating, throwing:
 *
 *   ReferenceError: Cannot access 'POST_MERGE_CREDIT_RELEASE_LABEL' before initialization
 *
 * Live daemon boot order happened to dodge it — pure luck, load-order
 * dependent. This test proves the fix (extracting the constant to the leaf
 * module post-merge-credit-label.ts) by cold-importing each former cycle
 * member FIRST in its own fresh Node process (a real "first import" — no
 * vitest module cache to mask ordering), asserting none of them throw.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const childTimeoutMs = process.platform === 'win32' ? 15_000 : 10_000;

const moduleUrls = {
  selfImprove: new URL('../src/core/fleet/self-improve.ts', import.meta.url).href,
  decisionsLedger: new URL('../src/core/fleet/decisions-ledger.ts', import.meta.url).href,
  postMergeCredit: new URL('../src/core/fleet/post-merge-credit.ts', import.meta.url).href,
  judgeTrace: new URL('../src/core/fleet/judge-trace.ts', import.meta.url).href,
};

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ashlr-pmc-cycle-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Cold-import `moduleUrl` as the very FIRST module loaded in a fresh process. */
function coldImportFirst(moduleUrl: string): { status: number | null; stdout: string; stderr: string } {
  const source =
    `import(${JSON.stringify(moduleUrl)})` +
    `.then(() => { process.stdout.write('OK'); })` +
    `.catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exitCode = 1; });`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr') },
    encoding: 'utf8',
    timeout: childTimeoutMs,
  });
  if (child.error) throw child.error;
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe('post-merge-credit-label import cycle regression', () => {
  it('cold-importing decisions-ledger.ts first does not throw a TDZ ReferenceError', () => {
    const result = coldImportFirst(moduleUrls.decisionsLedger);
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).not.toContain('before initialization');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK');
  });

  it('cold-importing post-merge-credit.ts first does not throw a TDZ ReferenceError', () => {
    const result = coldImportFirst(moduleUrls.postMergeCredit);
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).not.toContain('before initialization');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK');
  });

  it('cold-importing judge-trace.ts first does not throw a TDZ ReferenceError', () => {
    // This was the one member of the (informal) cycle that "happened to
    // work" pre-fix — kept here so a regression that reintroduces the cycle
    // from this side is caught too.
    const result = coldImportFirst(moduleUrls.judgeTrace);
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).not.toContain('before initialization');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK');
  });

  it('cold-importing self-improve.ts first (the actual live-daemon dynamic-import entry point) does not throw', () => {
    // loop.ts's runAncillaryMaintenance reaches this exact module via
    // `await import('../fleet/self-improve.js')` — the real-world trigger
    // forensics traced the live ReferenceError back to.
    const result = coldImportFirst(moduleUrls.selfImprove);
    expect(result.stderr).not.toContain('ReferenceError');
    expect(result.stderr).not.toContain('before initialization');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('OK');
  });
});

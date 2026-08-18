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

describe('post-merge credit import-cycle regression', () => {
  for (const [name, moduleUrl] of Object.entries(moduleUrls)) {
    it(`cold-imports ${name} first without a TDZ failure`, () => {
      const result = coldImportFirst(moduleUrl);
      expect(result.stderr).not.toContain('ReferenceError');
      expect(result.stderr).not.toContain('before initialization');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('OK');
    });
  }
});

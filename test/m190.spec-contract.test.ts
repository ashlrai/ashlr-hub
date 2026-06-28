/**
 * M190 — spec-contract checker (invented idea #4: kills "looks good but does
 * the wrong thing").
 *
 * Verifies:
 *  1. parseAcceptanceCriteria extracts criteria from a spec's `## Verification`
 *     section + the authoring goal, and classifies them
 *     (file-exists / export-present / string-present / test-run / generic).
 *  2. checkSpecContract → satisfied=true when every static criterion is met
 *     (file in diff/repo, export in diff, required string present).
 *  3. unmet criteria are listed (with `why`) when NOT met → satisfied=false.
 *  4. test-requiring criteria are reported `deferred` (NOT failed) — they do
 *     not block satisfaction.
 *  5. Flag OFF (no cfg.foundry.specContract) → vacuous no-op (satisfied=true,
 *     reason='disabled...').
 *  6. Never-throws on malformed / empty / null / undefined spec + diff.
 *
 * Hermetic: a real temp repo dir is created under os.tmpdir() for the
 * file-existence + repo-grep paths; no network, no mocks needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseAcceptanceCriteria,
  checkSpecContract,
  type SpecInput,
} from '../src/core/run/spec-contract.js';
import type { AshlrConfig } from '../src/core/types.js';

// --- cfg helpers ----------------------------------------------------------

const cfgOn = { foundry: { specContract: true } } as unknown as AshlrConfig;
const cfgOff = { foundry: {} } as unknown as AshlrConfig;

// --- a representative spec (mirrors spec-store's authored shape) -----------

const SPEC_BODY = `## Context
Internal team improving the run pipeline.

## North Star
A binding spec contract checker exists.

## Operating Principles
- Local-first
- Never-throws

## Pillars
- Static checks

## Roadmap
### Phase 1
- Build the checker.

## Verification
- The file \`src/core/run/spec-contract.ts\` exists.
- Function \`checkSpecContract\` is exported.
- Output contains the string \`SpecContractResult\`.
- The test suite \`m190\` passes.
- Code follows the project conventions and reads cleanly.
`;

const spec: SpecInput = {
  meta: {
    id: 'build-spec-contract',
    goal: 'Build the spec-contract checker for the run pipeline',
    version: 1,
    project: null,
    path: '/tmp/does-not-exist-v1.md',
    status: 'draft',
    createdAt: '2026-06-28T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
  },
  body: SPEC_BODY,
};

// --- temp repo ------------------------------------------------------------

let repoDir = '';

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm190-'));
  fs.mkdirSync(path.join(repoDir, 'src', 'core', 'run'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'core', 'run', 'spec-contract.ts'),
    'export interface SpecContractResult { satisfied: boolean }\nexport function checkSpecContract() {}\n',
    'utf8',
  );
});

afterAll(() => {
  try {
    fs.rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// A diff that ADDS the file, the export, and the required string.
const goodDiff = `diff --git a/src/core/run/spec-contract.ts b/src/core/run/spec-contract.ts
--- /dev/null
+++ b/src/core/run/spec-contract.ts
@@ -0,0 +1,3 @@
+export interface SpecContractResult { satisfied: boolean }
+export async function checkSpecContract() {}
+// produces a SpecContractResult
`;

// A diff that touches an UNRELATED file — none of the criteria met.
const badDiff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 hello
+world
`;

describe('M190 parseAcceptanceCriteria', () => {
  it('extracts criteria from the Verification section + goal', () => {
    const assertions = parseAcceptanceCriteria(spec);
    expect(assertions.length).toBeGreaterThanOrEqual(5);
    const texts = assertions.map((a) => a.text.toLowerCase());
    expect(texts.some((t) => t.includes('spec-contract.ts'))).toBe(true);
    expect(texts.some((t) => t.includes('checkspeccontract'))).toBe(true);
  });

  it('classifies criteria into the right kinds', () => {
    const assertions = parseAcceptanceCriteria(spec);
    const byKind = (k: string) => assertions.filter((a) => a.kind === k);

    // file existence
    const fileA = assertions.find((a) => a.target?.includes('spec-contract.ts'));
    expect(fileA?.kind).toBe('file-exists');

    // export presence
    const exportA = assertions.find((a) => a.kind === 'export-present');
    expect(exportA).toBeTruthy();
    expect(exportA?.target).toBe('checkSpecContract');

    // string presence
    const strA = assertions.find((a) => a.kind === 'string-present');
    expect(strA?.target).toBe('SpecContractResult');

    // a test-run criterion (the "m190 passes" / "test suite passes" line)
    expect(byKind('test-run').length).toBeGreaterThanOrEqual(1);
  });

  it('returns [] for empty / null specs', () => {
    expect(parseAcceptanceCriteria(null)).toEqual([]);
    expect(parseAcceptanceCriteria(undefined)).toEqual([]);
    expect(parseAcceptanceCriteria('')).toEqual([]);
    expect(parseAcceptanceCriteria({ body: '' })).toEqual([]);
  });
});

describe('M190 checkSpecContract — satisfied path', () => {
  it('satisfied=true when every static criterion is met', async () => {
    const res = await checkSpecContract({ spec, repoDir, diff: goodDiff }, cfgOn);
    expect(res.satisfied).toBe(true);
    expect(res.detail.checkable).toBeGreaterThanOrEqual(3);
    expect(res.met).toBe(res.detail.checkable);
  });

  it('reports test-requiring criteria as deferred (not failed)', async () => {
    const res = await checkSpecContract({ spec, repoDir, diff: goodDiff }, cfgOn);
    expect(res.detail.deferred).toBeGreaterThanOrEqual(1);
    // Deferred items appear in unmet with a "deferred:" why, but do NOT flip satisfied.
    const deferredWhy = res.unmet.filter((u) => /deferred/.test(u.why));
    expect(deferredWhy.length).toBeGreaterThanOrEqual(1);
    expect(res.satisfied).toBe(true);
  });
});

describe('M190 checkSpecContract — unsatisfied path', () => {
  it('lists unmet criteria with why when static checks fail', async () => {
    // Use a repo dir with NO matching file so file-exists also fails.
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'm190-empty-'));
    try {
      const res = await checkSpecContract({ spec, repoDir: emptyRepo, diff: badDiff }, cfgOn);
      expect(res.satisfied).toBe(false);
      // At least the file/export/string checks should be unmet.
      const failures = res.unmet.filter((u) => !/deferred/.test(u.why));
      expect(failures.length).toBeGreaterThanOrEqual(1);
      for (const f of failures) {
        expect(typeof f.criterion).toBe('string');
        expect(f.why.length).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(emptyRepo, { recursive: true, force: true });
    }
  });
});

describe('M190 checkSpecContract — flag off & robustness', () => {
  it('flag off → vacuous no-op (satisfied, reason disabled)', async () => {
    const res = await checkSpecContract({ spec, repoDir, diff: goodDiff }, cfgOff);
    expect(res.satisfied).toBe(true);
    expect(res.total).toBe(0);
    expect(res.met).toBe(0);
    expect(res.detail.reason).toMatch(/disabled/i);
  });

  it('flag off when cfg.foundry is entirely absent', async () => {
    const res = await checkSpecContract({ spec, diff: goodDiff }, {} as unknown as AshlrConfig);
    expect(res.satisfied).toBe(true);
    expect(res.detail.reason).toMatch(/disabled/i);
  });

  it('no criteria parsed → no-op satisfied', async () => {
    const res = await checkSpecContract(
      { spec: { body: '## Context\nnothing checkable here\n' }, repoDir, diff: goodDiff },
      cfgOn,
    );
    expect(res.satisfied).toBe(true);
    expect(res.detail.reason).toMatch(/no acceptance criteria/i);
  });

  it('never-throws on malformed / empty / null inputs', async () => {
    const malformed: Array<{ spec: SpecInput; repoDir?: string; diff?: string | null }> = [
      { spec: null, diff: null },
      { spec: undefined, diff: undefined },
      { spec: '', repoDir: '', diff: '' },
      { spec, repoDir: '/nonexistent/path/xyz', diff: 'not a real diff @@@@' },
      { spec: { meta: null, body: null }, diff: '+++ b/x\n+y' },
    ];
    for (const input of malformed) {
      // @ts-expect-error — exercising untyped/edge inputs on purpose
      const res = await checkSpecContract(input, cfgOn);
      expect(res).toBeTruthy();
      expect(typeof res.satisfied).toBe('boolean');
      expect(Array.isArray(res.unmet)).toBe(true);
    }
    // Even a totally garbage cfg must not throw.
    // @ts-expect-error — garbage cfg
    const r2 = await checkSpecContract({ spec, diff: goodDiff }, null);
    expect(r2.satisfied).toBe(true);
  });
});

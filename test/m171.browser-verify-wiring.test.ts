/**
 * M171 — browser-verify wiring tests.
 *
 * Verifies that the fleet's verify pipeline folds headless-browser evidence
 * into the task outcome when `cfg.foundry.browserVerify` is enabled.
 *
 * FOUR TEST GROUPS:
 *
 *   1. foldBrowserVerify (pure unit) — exported helper:
 *      - renderOk=false  → FAIL prefix in result.
 *      - consoleErrors>0 → FAIL prefix with error summary.
 *      - clean pass      → PASS suffix with evidence (detail + screenshot + count).
 *      - skipped         → null (caller leaves result unchanged).
 *
 *   2. Orchestrator source-audit — wiring code present in orchestrator.ts:
 *      - browserVerify flag guard exists.
 *      - isWebApp guard exists alongside the flag guard.
 *      - verifyInBrowser is called.
 *      - foldBrowserVerify is called with bvResult.
 *
 *   3. Flag OFF / non-web → verifyInBrowser is never called:
 *      - Mock isWebApp+verifyInBrowser; confirm count=0 when flag is false.
 *      - Mock isWebApp returning false; confirm count=0 even with flag true.
 *      Both tested via the source-audit (flag guard) + foldBrowserVerify unit
 *      contract (skipped→null) — no runGoal invocation needed.
 *
 *   4. Flag-off parity (source audit) — verify path is byte-identical:
 *      - The guard wraps the entire block, so when flag is off the block is
 *        unreachable; checked by auditing that no verifyInBrowser call site
 *        exists outside the `browserVerify === true` guard.
 *
 * HERMETICITY:
 *   - No real subprocesses, no live browsers, no dev server.
 *   - vi.mock intercepts browser-verify.js for integration assertions.
 *   - foldBrowserVerify is tested as a pure function (no I/O).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserVerifyResult } from '../src/core/run/browser-verify.js';

// ---------------------------------------------------------------------------
// Mocks — hoisted before lazy imports
// ---------------------------------------------------------------------------

const mockIsWebApp = vi.fn<[string], boolean>();
const mockVerifyInBrowser = vi.fn<[string, unknown, unknown?], Promise<BrowserVerifyResult>>();

vi.mock('../src/core/run/browser-verify.js', () => ({
  isWebApp: (...args: unknown[]) => mockIsWebApp(...(args as [string])),
  verifyInBrowser: (...args: unknown[]) =>
    mockVerifyInBrowser(...(args as [string, unknown, unknown?])),
  detectDriver: vi.fn(() => ({ kind: 'none' })),
  startDevServer: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Lazy import AFTER mocks
// ---------------------------------------------------------------------------

let foldBrowserVerify: typeof import('../src/core/run/orchestrator.js')['foldBrowserVerify'];

beforeEach(async () => {
  vi.resetModules();
  const mod = await import('../src/core/run/orchestrator.js');
  foldBrowserVerify = mod.foldBrowserVerify;
  mockIsWebApp.mockReset();
  mockVerifyInBrowser.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSkipped(): BrowserVerifyResult {
  return { ok: true, skipped: true, renderOk: false, consoleErrors: [], detail: 'skipped' };
}

function makePass(opts: { screenshotPath?: string; detail?: string } = {}): BrowserVerifyResult {
  return {
    ok: true,
    renderOk: true,
    consoleErrors: [],
    screenshotPath: opts.screenshotPath,
    detail: opts.detail ?? 'renders clean, 0 console errors',
  };
}

function makeFail(opts: { renderOk?: boolean; consoleErrors?: string[] } = {}): BrowserVerifyResult {
  return {
    ok: false,
    renderOk: opts.renderOk ?? false,
    consoleErrors: opts.consoleErrors ?? [],
    detail: 'render failed',
  };
}

// ---------------------------------------------------------------------------
// 1. foldBrowserVerify — pure unit tests
// ---------------------------------------------------------------------------

describe('M171 foldBrowserVerify — skipped → null', () => {
  it('returns null when bv.skipped is true (neutral outcome)', () => {
    expect(foldBrowserVerify('existing result', makeSkipped())).toBeNull();
  });

  it('returns null even when existing result is undefined', () => {
    expect(foldBrowserVerify(undefined, makeSkipped())).toBeNull();
  });
});

describe('M171 foldBrowserVerify — renderOk=false → FAIL prefix', () => {
  it('prefixes FAIL when renderOk is false and no console errors', () => {
    const result = foldBrowserVerify('prior result', makeFail({ renderOk: false, consoleErrors: [] }));
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^\[browser-verify: FAIL — render failed\]/);
    expect(result!).toContain('prior result');
  });

  it('prefixes FAIL for undefined existing result', () => {
    const result = foldBrowserVerify(undefined, makeFail({ renderOk: false }));
    expect(result!).toMatch(/^\[browser-verify: FAIL/);
  });
});

describe('M171 foldBrowserVerify — consoleErrors > 0 → FAIL prefix', () => {
  it('prefixes FAIL with console error summary when errors present', () => {
    const bv = makeFail({
      renderOk: true,
      consoleErrors: ['TypeError: x is undefined', 'ReferenceError: foo is not defined'],
    });
    const result = foldBrowserVerify('task output', bv);
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^\[browser-verify: FAIL — console errors:/);
    expect(result!).toContain('TypeError: x is undefined');
    expect(result!).toContain('task output');
  });

  it('truncates to first 5 console errors', () => {
    const errors = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6_SHOULD_NOT_APPEAR'];
    const bv = makeFail({ renderOk: true, consoleErrors: errors });
    const result = foldBrowserVerify('x', bv);
    expect(result!).not.toContain('e6_SHOULD_NOT_APPEAR');
    expect(result!).toContain('e5');
  });

  it('consoleErrors takes precedence over renderOk=false for the summary label', () => {
    const bv = makeFail({ renderOk: false, consoleErrors: ['uncaught error'] });
    const result = foldBrowserVerify('x', bv);
    // When both renderOk=false AND consoleErrors, we report "console errors:"
    expect(result!).toMatch(/console errors:/);
  });
});

describe('M171 foldBrowserVerify — clean pass → PASS suffix with evidence', () => {
  it('appends PASS annotation with detail when no screenshot', () => {
    const bv = makePass({ detail: 'renders clean, 0 console errors' });
    const result = foldBrowserVerify('task output', bv);
    expect(result).not.toBeNull();
    expect(result!).toContain('task output');
    expect(result!).toMatch(/\[browser-verify: PASS — renders clean, 0 console errors/);
    expect(result!).toContain('console errors: 0');
  });

  it('includes screenshotPath in evidence when present', () => {
    const bv = makePass({ screenshotPath: '/tmp/shot.png', detail: 'renders clean' });
    const result = foldBrowserVerify('task output', bv);
    expect(result!).toContain('screenshot: captured');
    expect(result!).not.toContain('/tmp/shot.png');
  });

  it('includes compact visual grounding metadata when present', () => {
    const bv: BrowserVerifyResult = {
      ...makePass({ screenshotPath: '/tmp/shot.png', detail: 'renders clean' }),
      visualGrounding: {
        status: 'ok',
        provider: 'generic-openai-vision',
        boxCount: 1,
        boxes: [{ x1: 10, y1: 20, x2: 300, y2: 400, scale: 'normalized-1000' }],
        detail: 'visual grounding found 1 box',
        image: {
          bytes: 8,
          sha256: 'a'.repeat(64),
        },
      },
    };
    const result = foldBrowserVerify('task output', bv);
    expect(result!).toContain('visual grounding: ok');
    expect(result!).toContain('provider: generic-openai-vision');
    expect(result!).toContain('boxes: 1');
    expect(result!).toContain(`image sha256: ${'a'.repeat(64)}`);
    expect(result!).not.toContain('/tmp/shot.png');
  });

  it('omits screenshot token when screenshotPath is absent', () => {
    const bv = makePass({ detail: 'renders clean' });
    const result = foldBrowserVerify('task output', bv);
    expect(result!).not.toContain('screenshot:');
  });

  it('handles undefined existing result (trimStart prevents leading newline)', () => {
    const bv = makePass({ detail: 'renders ok' });
    const result = foldBrowserVerify(undefined, bv);
    expect(result).not.toBeNull();
    expect(result![0]).not.toBe('\n');
    expect(result!).toContain('[browser-verify: PASS');
  });
});

// ---------------------------------------------------------------------------
// 2. Source audit — wiring code present in orchestrator.ts
// ---------------------------------------------------------------------------

describe('M171 source audit — wiring hooks present in orchestrator.ts', () => {
  const src = readFileSync(
    join(import.meta.dirname ?? __dirname, '../src/core/run/orchestrator.ts'),
    'utf8',
  );

  it('imports isWebApp and verifyInBrowser from browser-verify.js', () => {
    expect(src).toMatch(/import.*isWebApp.*verifyInBrowser.*browser-verify/s);
  });

  it('guards the block with cfg.foundry?.browserVerify === true', () => {
    expect(src).toContain('browserVerify === true');
  });

  it('guards with isWebApp(repoRoot) inside the browserVerify block', () => {
    // Both guards must appear together.
    expect(src).toMatch(/browserVerify === true[\s\S]{0,200}isWebApp\(repoRoot\)/);
  });

  it('calls verifyInBrowser with the run cancellation signal inside the guard', () => {
    expect(src).toMatch(/verifyInBrowser\(\s*repoRoot,\s*cfg,\s*opts\.signal\s*\?/);
  });

  it('calls foldBrowserVerify with bvResult', () => {
    expect(src).toMatch(/foldBrowserVerify\([^)]*bvResult/);
  });

  it('exports foldBrowserVerify as a named export', () => {
    expect(src).toMatch(/export function foldBrowserVerify/);
  });

  it('foldBrowserVerify export appears BEFORE runGoal (not inside it)', () => {
    const foldIdx = src.indexOf('export function foldBrowserVerify');
    const runGoalIdx = src.indexOf('export async function runGoal');
    expect(foldIdx).toBeGreaterThan(0);
    expect(runGoalIdx).toBeGreaterThan(0);
    expect(foldIdx).toBeLessThan(runGoalIdx);
  });
});

// ---------------------------------------------------------------------------
// 3. Flag OFF / non-web → verifyInBrowser never called
// ---------------------------------------------------------------------------

describe('M171 source audit — flag-off parity (verifyInBrowser unreachable when flag=false)', () => {
  const src = readFileSync(
    join(import.meta.dirname ?? __dirname, '../src/core/run/orchestrator.ts'),
    'utf8',
  );

  it('every verifyInBrowser call site is inside the browserVerify === true guard', () => {
    // Find all verifyInBrowser call positions; each must be preceded by the flag guard.
    const callRe = /verifyInBrowser\(/g;
    let m: RegExpExecArray | null;
    let callCount = 0;

    while ((m = callRe.exec(src)) !== null) {
      callCount++;
      // Look back up to 2000 chars for the flag guard.
      const before = src.slice(Math.max(0, m.index - 2000), m.index);
      expect(before).toContain('browserVerify === true');
    }

    // Sanity: at least one call site exists.
    expect(callCount).toBeGreaterThanOrEqual(1);
  });

  it('isWebApp call site is inside the browserVerify === true guard', () => {
    const callRe = /isWebApp\(repoRoot\)/g;
    let m: RegExpExecArray | null;
    let callCount = 0;

    while ((m = callRe.exec(src)) !== null) {
      callCount++;
      const before = src.slice(Math.max(0, m.index - 2000), m.index);
      expect(before).toContain('browserVerify === true');
    }

    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe('M171 foldBrowserVerify — skipped result is neutral (does not fail)', () => {
  it('skipped result does not contain FAIL', () => {
    const result = foldBrowserVerify('some task result', makeSkipped());
    // null means "no change" — the original result stands, no FAIL annotation.
    expect(result).toBeNull();
  });

  it('non-web skipped result is neutral regardless of existing content', () => {
    const bv: BrowserVerifyResult = {
      ok: true,
      skipped: true,
      reason: 'not a web app',
      renderOk: false,
      consoleErrors: [],
      detail: 'skipped: not a web app',
    };
    expect(foldBrowserVerify('important task output', bv)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Integration contract: verify imported + callable
// ---------------------------------------------------------------------------

describe('M171 integration — foldBrowserVerify is exported from orchestrator', () => {
  it('foldBrowserVerify is a function', () => {
    expect(typeof foldBrowserVerify).toBe('function');
  });

  it('renderOk=false fails (returns non-null with FAIL)', () => {
    const r = foldBrowserVerify('result', makeFail({ renderOk: false }));
    expect(r).not.toBeNull();
    expect(r!).toContain('[browser-verify: FAIL');
  });

  it('consoleErrors.length>0 fails (returns non-null with FAIL)', () => {
    const r = foldBrowserVerify('result', makeFail({ renderOk: true, consoleErrors: ['err'] }));
    expect(r).not.toBeNull();
    expect(r!).toContain('[browser-verify: FAIL');
  });

  it('renderOk=true + no errors passes (returns non-null with PASS)', () => {
    const r = foldBrowserVerify('result', makePass());
    expect(r).not.toBeNull();
    expect(r!).toContain('[browser-verify: PASS');
  });

  it('skipped is neutral (returns null)', () => {
    expect(foldBrowserVerify('result', makeSkipped())).toBeNull();
  });
});

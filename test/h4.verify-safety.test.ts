/**
 * test/h4.verify-safety.test.ts — H4: the `ashlr verify-safety` self-check.
 *
 * Drives the NEW READ-ONLY production surface (src/cli/verify-safety.ts) on the
 * REAL build and asserts the HARD contract (CONTRACT-H4.md §Verify-Safety):
 *  - returns 0 on a healthy build, 1 when a check FAILs (proves it actually gates,
 *    not always-green), 2 on bad usage;
 *  - MUTATES NOTHING (snapshot the isolated HOME before+after — byte-identical:
 *    no file written, no sandbox, no enrollment, no kill toggle, no proposal);
 *  - makes NO outward call (fetch stubbed to throw — never invoked);
 *  - --json emits a well-formed { ok, checks: [...] } report.
 *
 * SAFETY (paramount — see CONTRACT-H4.md): isolated tmp HOME per test, real
 * ~/.ashlr never touched, DETERMINISTIC (the checks are pure source reads of the
 * build's own committed source — no live model, no network). The mutates-nothing
 * assertion is load-bearing: verify-safety is the only new production code and
 * must remain side-effect-free + outward-call-free. Every it() has real
 * expect(); beforeEach calls expect.hasAssertions().
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import {
  cmdVerifySafety,
  runSafetyChecks,
  type SafetyReport,
  type CoreSourceReader,
} from '../src/cli/verify-safety.js';

// ---------------------------------------------------------------------------
// stdout/stderr capture + HOME snapshot helpers (local to this suite)
// ---------------------------------------------------------------------------

/** Run `fn` while capturing everything written to stdout + stderr. */
async function captureOut<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  let out = '';
  let err = '';
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any): boolean => {
    out += String(chunk);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any): boolean => {
    err += String(chunk);
    return true;
  };
  try {
    const value = await fn();
    return { value, out, err };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/**
 * Deterministic hash of every regular file under `dir` (path + bytes). Returns a
 * stable digest plus the relative file count so a before/after comparison proves
 * NOTHING under the isolated HOME changed. Symlinks/devices are ignored.
 */
function snapshotTree(dir: string): { digest: string; files: string[] } {
  const files: string[] = [];
  const h = createHash('sha256');
  function walk(d: string): void {
    if (!existsSync(d)) return;
    const items = readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const item of items) {
      const full = join(d, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile()) {
        const rel = relative(dir, full);
        files.push(rel);
        h.update(rel + '\0');
        h.update(readFileSync(full));
        h.update('\0');
      }
    }
  }
  walk(dir);
  return { digest: h.digest('hex'), files: files.sort() };
}

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

// ---------------------------------------------------------------------------

describe('H4 · verify-safety · behavior + exit codes', () => {
  it('returns 0 when all structural checks pass on a healthy build', async () => {
    const { value: code, out } = await captureOut(() => cmdVerifySafety([]));
    expect(code).toBe(0);
    // Every check line is a PASS; the trailing summary says OK.
    expect(out).toContain('[PASS]');
    expect(out).not.toContain('[FAIL]');
    expect(out).toMatch(/\bOK\b/);
    // The healthy build's report itself is ok with all 5 checks passing.
    const report = runSafetyChecks();
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(5);
    expect(report.checks.every((c) => c.pass)).toBe(true);
  });

  it('runSafetyChecks returns 1-mapped FAIL when a check is simulated-violated', async () => {
    // Inject a reader that returns a DELIBERATELY-BROKEN daemon source (it now
    // "imports" the apply primitive). This proves the command actually gates —
    // it is NOT always-green — without weakening any real guard.
    const brokenReader: CoreSourceReader = (rel) => {
      if (rel === 'daemon/loop') {
        return "import { applyProposal } from '../inbox/apply.js';\napplyProposal();\n";
      }
      // Delegate everything else to the real source so only ONE check fails.
      return readRealCore(rel);
    };
    const report = runSafetyChecks({ readSource: brokenReader });
    expect(report.ok).toBe(false);
    const daemonCheck = report.checks.find((c) => c.id === 'daemon-no-primitive');
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck?.pass).toBe(false);
    expect(daemonCheck?.detail).toMatch(/forbidden/i);
    // The other four checks still pass — only the injected one fails.
    const others = report.checks.filter((c) => c.id !== 'daemon-no-primitive');
    expect(others).toHaveLength(4);
    expect(others.every((c) => c.pass)).toBe(true);
  });

  it('returns 2 on bad usage / unknown flag', async () => {
    const { value: code, err } = await captureOut(() => cmdVerifySafety(['--nope']));
    expect(code).toBe(2);
    expect(err).toContain('unknown argument: --nope');
  });

  it('prints help and returns 0 for --help (no checks run)', async () => {
    const { value: code, out } = await captureOut(() => cmdVerifySafety(['--help']));
    expect(code).toBe(0);
    expect(out).toContain('verify-safety');
    expect(out).not.toContain('[PASS]');
  });
});

describe('H4 · verify-safety · read-only + no outward call', () => {
  it('MUTATES NOTHING: isolated HOME byte-identical before vs after a run', async () => {
    const before = snapshotTree(fx.home);
    const { value: code } = await captureOut(() => cmdVerifySafety([]));
    expect(code).toBe(0);
    const after = snapshotTree(fx.home);
    // No file created, modified, or removed anywhere under the isolated HOME.
    expect(after.digest).toBe(before.digest);
    expect(after.files).toEqual(before.files);
    // Specifically: verify-safety created NO ~/.ashlr state.
    expect(existsSync(join(fx.ashlrDir, 'enrollment.json'))).toBe(false);
    expect(existsSync(join(fx.ashlrDir, 'KILL'))).toBe(false);
    // --json run is equally side-effect-free.
    const after2 = snapshotTree(fx.home);
    await captureOut(() => cmdVerifySafety(['--json']));
    const after3 = snapshotTree(fx.home);
    expect(after3.digest).toBe(after2.digest);
  });

  it('makes no network call: a stubbed fetch is never invoked', async () => {
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = (...args: unknown[]): never => {
      fetchCalls++;
      throw new Error(`verify-safety made an outward fetch: ${String(args[0])}`);
    };
    try {
      const { value: code } = await captureOut(() => cmdVerifySafety([]));
      expect(code).toBe(0);
      expect(fetchCalls).toBe(0);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).fetch = realFetch;
    }
  });
});

describe('H4 · verify-safety · checks + output shape', () => {
  it('runs the 5 structural checks with the documented ids', async () => {
    const report = runSafetyChecks();
    const ids = report.checks.map((c) => c.id).sort();
    expect(ids).toEqual(
      [
        'daemon-no-primitive',
        'enrollment-default-empty',
        'kill-switch-precedence',
        'provider-cloud-gate',
        'scrub-patterns-match',
      ].sort(),
    );
    // Each check is well-formed.
    for (const c of report.checks) {
      expect(typeof c.id).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(typeof c.pass).toBe('boolean');
      expect(typeof c.detail).toBe('string');
    }
  });

  it('--json emits a well-formed { ok, checks: [...] } report', async () => {
    const { value: code, out } = await captureOut(() => cmdVerifySafety(['--json']));
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as SafetyReport;
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks).toHaveLength(5);
    for (const c of parsed.checks) {
      expect(c).toHaveProperty('id');
      expect(c).toHaveProperty('label');
      expect(c).toHaveProperty('pass');
      expect(c).toHaveProperty('detail');
    }
  });

  it('--json ok:false when a check is simulated-violated (gating is real)', async () => {
    // Drive cmdVerifySafety via a broken default reader is not exposed; assert
    // the report-level gating through runSafetyChecks + JSON serialization shape.
    const brokenReader: CoreSourceReader = (rel) => {
      if (rel === 'sandbox/policy') {
        // kill check AFTER the enrollment check → precedence violated.
        return [
          'export function assertMayMutate(repo, opts) {',
          '  if (!opts?.allowAnyRepo && !isEnrolled(repo)) throw new Error("nope");',
          '  if (killSwitchOn()) throw new Error("kill");',
          '}',
        ].join('\n');
      }
      return readRealCore(rel);
    };
    const report = runSafetyChecks({ readSource: brokenReader });
    const json = JSON.parse(JSON.stringify(report)) as SafetyReport;
    expect(json.ok).toBe(false);
    const kill = json.checks.find((c) => c.id === 'kill-switch-precedence');
    expect(kill?.pass).toBe(false);
    expect(kill?.detail).toMatch(/precede/i);
  });

  it('scrub-patterns-match FAILs when the index source drops its secret markers', () => {
    // A knowledge/index source that still has a scrubSecrets + SECRET_PATTERNS
    // shell but has dropped the high-entropy AWS/JWT markers must FAIL the scrub
    // check — proving the check is not always-green for a weakened scrub source.
    const brokenReader: CoreSourceReader = (rel) => {
      if (rel === 'knowledge/index') {
        return [
          'export const SECRET_PATTERNS = [];',
          'export function scrubSecrets(t) { return t; }',
          '// no AWS, no JWT markers here',
        ].join('\n');
      }
      return readRealCore(rel);
    };
    const report = runSafetyChecks({ readSource: brokenReader });
    expect(report.ok).toBe(false);
    const scrub = report.checks.find((c) => c.id === 'scrub-patterns-match');
    expect(scrub).toBeDefined();
    expect(scrub?.pass).toBe(false);
    expect(scrub?.detail).toMatch(/AWS\/JWT|pins/i);
    // Only the scrub check fails; the other four still pass.
    const others = report.checks.filter((c) => c.id !== 'scrub-patterns-match');
    expect(others).toHaveLength(4);
    expect(others.every((c) => c.pass)).toBe(true);
  });

  it('provider-cloud-gate FAILs when the gate source omits the !allowCloud throw', () => {
    // A provider-client source that defines CLOUD_PROVIDERS + isCloudProvider but
    // omits the `!opts.allowCloud` throw path must FAIL the cloud-gate check.
    const brokenReader: CoreSourceReader = (rel) => {
      if (rel === 'run/provider-client') {
        return [
          'const CLOUD_PROVIDERS = new Set(["anthropic"]);',
          'function isCloudProvider(id) { return CLOUD_PROVIDERS.has(id); }',
          'export async function getActiveClient(cfg, opts) {',
          '  if (isCloudProvider("anthropic")) { return buildOllamaClient(); }',
          '  return buildOllamaClient();',
          '}',
        ].join('\n');
      }
      return readRealCore(rel);
    };
    const report = runSafetyChecks({ readSource: brokenReader });
    expect(report.ok).toBe(false);
    const gate = report.checks.find((c) => c.id === 'provider-cloud-gate');
    expect(gate).toBeDefined();
    expect(gate?.pass).toBe(false);
    expect(gate?.detail).toMatch(/allowCloud|allow-cloud/i);
    const others = report.checks.filter((c) => c.id !== 'provider-cloud-gate');
    expect(others).toHaveLength(4);
    expect(others.every((c) => c.pass)).toBe(true);
  });

  it('provider-cloud-gate FAILs when the throw is moved BELOW the local client build (bypass)', () => {
    // A present-but-bypassed gate: the !allowCloud throw exists but is ordered
    // AFTER the local client build, so cloud egress could be reached first. The
    // ordering assertion must catch this even though every token is present.
    const brokenReader: CoreSourceReader = (rel) => {
      if (rel === 'run/provider-client') {
        return [
          'const CLOUD_PROVIDERS = new Set(["anthropic"]);',
          'function isCloudProvider(id) { return CLOUD_PROVIDERS.has(id); }',
          'export async function getActiveClient(cfg, opts) {',
          '  const c = buildOllamaClient();', // local client built BEFORE the gate throw
          '  if (isCloudProvider("anthropic")) {',
          '    if (!opts.allowCloud) throw new Error("Pass --allow-cloud");',
          '  }',
          '  return c;',
          '}',
        ].join('\n');
      }
      return readRealCore(rel);
    };
    const report = runSafetyChecks({ readSource: brokenReader });
    expect(report.ok).toBe(false);
    const gate = report.checks.find((c) => c.id === 'provider-cloud-gate');
    expect(gate?.pass).toBe(false);
    expect(gate?.detail).toMatch(/precede|bypass/i);
  });
});

// ---------------------------------------------------------------------------
// Helper: read the REAL committed core source the way the production default
// reader does (so the broken-reader tests fail exactly ONE check and leave the
// rest passing against the real build).
// ---------------------------------------------------------------------------

function readRealCore(relFromCore: string): string {
  // src/core/<rel>.ts relative to this test file (test/ → repo root → src/core).
  // fileURLToPath (not URL.pathname) — on Windows .pathname yields "/C:/…".
  const here = fileURLToPath(new URL('.', import.meta.url)); // test/
  const base = join(here, '..', 'src', 'core', relFromCore);
  for (const ext of ['.ts', '.js']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, 'utf8');
  }
  throw new Error(`readRealCore: source not found for ${relFromCore}`);
}

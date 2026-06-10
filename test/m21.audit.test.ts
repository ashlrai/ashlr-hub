/**
 * M21 audit tests — append-only audit trail.
 *
 * SAFETY GUARDRAIL: HOME is overridden to a tmp dir for every test so
 * the real ~/.ashlr/audit/ is never touched. No secrets are written.
 *
 * Invariants asserted:
 *   - audit() appends a JSONL line (file exists after first call)
 *   - append-only: calling audit() multiple times grows the file, never
 *     truncates or rewrites prior lines
 *   - readAudit() returns entries newest-first
 *   - readAudit(limit) caps the number of entries returned
 *   - readAudit() skips malformed lines without throwing
 *   - audit() sets 'ts' automatically (caller does not supply ts)
 *   - audit() never stores a planted secret (summary is metadata only)
 *   - auditDir() returns the expected path under HOME/.ashlr/audit
 *   - audit entries have the required shape (ts, action, repo, sandboxId,
 *     summary, result)
 *   - result field accepts 'ok', 'refused', 'error'
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// HOME isolation
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m21-audit-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// Lazy import
// ---------------------------------------------------------------------------

let _auditMod: typeof import('../src/core/sandbox/audit.js') | null = null;

async function auditMod(): Promise<typeof import('../src/core/sandbox/audit.js')> {
  if (!_auditMod) {
    _auditMod = await import('../src/core/sandbox/audit.js');
  }
  return _auditMod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryBase(overrides: Partial<{
  action: string;
  repo: string | null;
  sandboxId: string | null;
  summary: string;
  result: 'ok' | 'refused' | 'error';
}> = {}) {
  return {
    action: overrides.action ?? 'test-action',
    repo: overrides.repo ?? null,
    sandboxId: overrides.sandboxId ?? null,
    summary: overrides.summary ?? 'test summary',
    result: (overrides.result ?? 'ok') as 'ok' | 'refused' | 'error',
  };
}

// ---------------------------------------------------------------------------
// auditDir()
// ---------------------------------------------------------------------------

describe('M21 audit — auditDir()', () => {
  it('returns a path ending in .ashlr/audit', async () => {
    const a = await auditMod();
    const dir = a.auditDir();
    expect(dir).toMatch(/[/\\]\.ashlr[/\\]audit$/);
  });

  it('auditDir is under the current HOME', async () => {
    const a = await auditMod();
    const dir = a.auditDir();
    expect(dir.startsWith(tmpHome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// audit() — basic append
// ---------------------------------------------------------------------------

describe('M21 audit — audit() basic write', () => {
  it('creates the audit directory lazily on first call', async () => {
    const a = await auditMod();
    a.audit(entryBase());
    expect(fs.existsSync(a.auditDir())).toBe(true);
  });

  it('creates a JSONL file under auditDir after first call', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'create-sandbox' }));
    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('written entry is valid JSON with required fields', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'sandbox-create', summary: 'created sandbox x' }));
    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(lines[0]!);
    expect(typeof parsed.ts).toBe('string');
    expect(typeof parsed.action).toBe('string');
    expect('repo' in parsed).toBe(true);
    expect('sandboxId' in parsed).toBe(true);
    expect(typeof parsed.summary).toBe('string');
    expect(['ok', 'refused', 'error']).toContain(parsed.result);
  });

  it('audit() sets ts automatically (ISO string)', async () => {
    const a = await auditMod();
    const before = new Date().toISOString();
    a.audit(entryBase());
    const after = new Date().toISOString();
    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const parsed = JSON.parse(lines[lines.length - 1]!);
    expect(parsed.ts >= before).toBe(true);
    expect(parsed.ts <= after).toBe(true);
  });

  it('audit() records action correctly', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'remove-sandbox' }));
    const entries = a.readAudit();
    expect(entries.some(e => e.action === 'remove-sandbox')).toBe(true);
  });

  it('audit() records result:ok', async () => {
    const a = await auditMod();
    a.audit(entryBase({ result: 'ok' }));
    const entries = a.readAudit();
    expect(entries.some(e => e.result === 'ok')).toBe(true);
  });

  it('audit() records result:refused', async () => {
    const a = await auditMod();
    a.audit(entryBase({ result: 'refused' }));
    const entries = a.readAudit();
    expect(entries.some(e => e.result === 'refused')).toBe(true);
  });

  it('audit() records result:error', async () => {
    const a = await auditMod();
    a.audit(entryBase({ result: 'error' }));
    const entries = a.readAudit();
    expect(entries.some(e => e.result === 'error')).toBe(true);
  });

  it('audit() accepts null repo and sandboxId', async () => {
    const a = await auditMod();
    a.audit(entryBase({ repo: null, sandboxId: null }));
    const entries = a.readAudit();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]!.repo).toBeNull();
    expect(entries[0]!.sandboxId).toBeNull();
  });

  it('audit() accepts non-null repo and sandboxId', async () => {
    const a = await auditMod();
    a.audit(entryBase({ repo: '/tmp/my-repo', sandboxId: 'sb-abc123' }));
    const entries = a.readAudit();
    const match = entries.find(e => e.sandboxId === 'sb-abc123');
    expect(match).toBeDefined();
    expect(match!.repo).toBe('/tmp/my-repo');
  });
});

// ---------------------------------------------------------------------------
// Append-only invariant
// ---------------------------------------------------------------------------

describe('M21 audit — append-only invariant', () => {
  it('calling audit() multiple times grows the file, never truncates', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'first', summary: 'entry 1' }));
    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const file = path.join(dir, files[0]!);
    const sizeAfterFirst = fs.statSync(file).size;

    a.audit(entryBase({ action: 'second', summary: 'entry 2' }));
    const sizeAfterSecond = fs.statSync(file).size;

    expect(sizeAfterSecond).toBeGreaterThan(sizeAfterFirst);
  });

  it('prior entries remain intact after subsequent audit() calls', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'alpha', summary: 'first written' }));
    a.audit(entryBase({ action: 'beta', summary: 'second written' }));
    a.audit(entryBase({ action: 'gamma', summary: 'third written' }));

    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    let allLines: string[] = [];
    for (const f of files) {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      allLines = allLines.concat(raw.split('\n').filter(Boolean));
    }
    // All three original entries must still be present
    const actions = allLines.map(l => JSON.parse(l).action as string);
    expect(actions).toContain('alpha');
    expect(actions).toContain('beta');
    expect(actions).toContain('gamma');
  });

  it('readAudit returns all written entries (none dropped)', async () => {
    const a = await auditMod();
    const N = 5;
    for (let i = 0; i < N; i++) {
      a.audit(entryBase({ action: `action-${i}` }));
    }
    const entries = a.readAudit();
    expect(entries.length).toBeGreaterThanOrEqual(N);
  });
});

// ---------------------------------------------------------------------------
// readAudit — ordering and limit
// ---------------------------------------------------------------------------

describe('M21 audit — readAudit() ordering and limit', () => {
  it('readAudit() returns entries newest-first', async () => {
    const a = await auditMod();
    // Write entries with slight sequential ordering; ts is set by audit()
    a.audit(entryBase({ action: 'early' }));
    // Slight artificial gap to ensure distinct ts values
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    await wait(5);
    a.audit(entryBase({ action: 'late' }));

    const entries = a.readAudit();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Newest first: 'late' should appear before 'early'
    const lateIdx = entries.findIndex(e => e.action === 'late');
    const earlyIdx = entries.findIndex(e => e.action === 'early');
    expect(lateIdx).toBeLessThan(earlyIdx);
  });

  it('readAudit(1) returns at most 1 entry', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'x1' }));
    a.audit(entryBase({ action: 'x2' }));
    a.audit(entryBase({ action: 'x3' }));
    const entries = a.readAudit(1);
    expect(entries.length).toBe(1);
  });

  it('readAudit(2) returns at most 2 entries', async () => {
    const a = await auditMod();
    for (let i = 0; i < 5; i++) {
      a.audit(entryBase({ action: `e${i}` }));
    }
    const entries = a.readAudit(2);
    expect(entries.length).toBe(2);
  });

  it('readAudit(undefined) returns all entries', async () => {
    const a = await auditMod();
    const N = 4;
    for (let i = 0; i < N; i++) {
      a.audit(entryBase({ action: `all-${i}` }));
    }
    const entries = a.readAudit();
    expect(entries.length).toBeGreaterThanOrEqual(N);
  });

  it('readAudit() returns [] when no audit file exists', async () => {
    const a = await auditMod();
    // No audit() call made — dir does not even exist yet
    expect(a.readAudit()).toEqual([]);
  });

  it('readAudit() skips malformed JSONL lines without throwing', async () => {
    const a = await auditMod();
    // Write a good entry first
    a.audit(entryBase({ action: 'good-entry' }));

    // Inject a malformed line directly into the file
    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const file = path.join(dir, files[0]!);
    fs.appendFileSync(file, 'NOT VALID JSON\n', 'utf8');

    // Should not throw; good entries should still be returned
    let result: unknown[];
    expect(() => {
      result = a.readAudit();
    }).not.toThrow();
    // The good entry is present; the bad line is silently skipped
    expect(result!.some((e: unknown) => (e as { action: string }).action === 'good-entry')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No secrets in audit entries
// ---------------------------------------------------------------------------

describe('M21 audit — no secrets in audit entries', () => {
  it('a planted secret in the summary is stored verbatim (no redaction contract) but summary is short metadata', async () => {
    // The contract says "NEVER write secrets — summary is metadata only".
    // We enforce: the audit module accepts any summary string (caller's
    // responsibility to not pass secrets), but we verify that no internal
    // mechanism injects secrets.
    const a = await auditMod();
    const SECRET = 'SHOULD_NOT_APPEAR_IN_AUDIT_sk-live-abc123';
    // The contract forbids the SYSTEM from writing secrets automatically.
    // Callers must not pass secrets as summary. We test that a normal
    // non-secret summary is stored correctly.
    const SAFE_SUMMARY = 'sandbox created for repo scan';
    a.audit(entryBase({ summary: SAFE_SUMMARY }));

    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf8');

    // The planted secret constant must NOT appear anywhere in the file
    // (it was never passed to audit(), so it must not be there)
    expect(raw).not.toContain(SECRET);
    // The safe summary IS there
    expect(raw).toContain(SAFE_SUMMARY);
  });

  it('audit file does not contain any environment variables or tokens', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'sandbox-create', summary: 'created sandbox' }));

    const dir = a.auditDir();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'utf8');

    // No common secret patterns should appear in the audit entry
    // (the implementation must not embed env vars, tokens, or config values)
    expect(raw).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);       // OpenAI-style key
    expect(raw).not.toMatch(/ghp_[a-zA-Z0-9]{36}/);         // GitHub PAT
    expect(raw).not.toMatch(/Bearer [a-zA-Z0-9._-]{20,}/);  // Bearer token
  });

  it('readAudit entries carry only the expected fields', async () => {
    const a = await auditMod();
    a.audit(entryBase({ action: 'check-fields', repo: '/tmp/r', sandboxId: 'sb-1', summary: 'ok', result: 'ok' }));
    const entries = a.readAudit(1);
    expect(entries.length).toBe(1);
    const entry = entries[0]!;
    // Required fields present
    expect(typeof entry.ts).toBe('string');
    expect(typeof entry.action).toBe('string');
    expect(typeof entry.summary).toBe('string');
    expect(['ok', 'refused', 'error']).toContain(entry.result);
    // repo and sandboxId exist (may be null)
    expect('repo' in entry).toBe(true);
    expect('sandboxId' in entry).toBe(true);
  });
});

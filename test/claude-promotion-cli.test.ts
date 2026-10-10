import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdResources } from '../src/cli/resources.js';
import { CLAUDE_API_GRANT_LEDGER_FILE, CLAUDE_API_GRANT_OBSERVATIONS_FILE, createClaudeApiGrantAdmission, readClaudeApiGrantObservations, readClaudeApiGrantViews } from '../src/core/resources/claude-api-grant.js';
import { acquireLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

const f = vi.hoisted(() => ({ snapshot: vi.fn(), config: vi.fn() }));
vi.mock('../src/core/fabric/resource-monitor.js', () => ({ getResourceSnapshot: f.snapshot }));
vi.mock('../src/core/config.js', () => ({ loadConfig: f.config }));
const NOW = Date.parse('2026-10-10T00:00:00.000Z');
let parent: string; let root: string; let input: string; let out: string[]; let errors: string[];
function history() {
  return { v: 1, kind: 'claude-api-promotion-history', observationId: 'fixture-history', binding: null, cycleId: null,
    capturedAt: '2026-10-09T20:00:00.000Z', evidenceDigest: createHash('sha256').update('fictional billing capture').digest('hex'),
    remainingUsdMicros: '200000000', totalUsdMicros: '200000000', expiry: { precision: 'date', date: '2026-10-24', timezone: 'UTC', instant: null } };
}
function args() { return ['claude-promotion', 'record', '--observation', input, '--accounts-root', root, '--json']; }
function write(value: unknown) { writeFileSync(input, JSON.stringify(value), { mode: 0o600 }); }
beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'phm-promotion-cli-'))); root = join(parent, 'accounts');
  mkdirSync(root, { mode: 0o700 }); input = join(parent, 'capture.json'); write(history()); out = []; errors = [];
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  f.snapshot.mockClear(); f.config.mockClear();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(parent, { recursive: true, force: true }); });

describe('Claude promotion history CLI', () => {
  it('dispatches without provider/config reads and preserves original unbound evidence and Held projection', async () => {
    expect(await cmdResources(args())).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ recorded: true, automaticAdmission: 'held' });
    const disk = JSON.parse(readFileSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE), 'utf8'));
    expect(disk.observations).toEqual([history()]);
    if (process.platform !== 'win32') {
      expect(await readClaudeApiGrantObservations(root, NOW)).toEqual({ ok: true, value: [history()] });
      expect(await readClaudeApiGrantViews(root, NOW)).toMatchObject({ state: 'healthy', rows: [{ capturedAt: history().capturedAt, expiryDate: '2026-10-24', cutoffPolicy: 'expiry-day-start/v1', automaticAdmission: 'held' }] });
      expect(statSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE)).mode & 0o777).toBe(0o600);
    }
    expect(createClaudeApiGrantAdmission({ nowMs: NOW, expectedBinding: { organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), credentialDigest: 'c'.repeat(64), generation: 'fixture' } })).toEqual({ ok: false, reason: 'proof-missing' });
    expect(JSON.parse(readFileSync(join(root, CLAUDE_API_GRANT_LEDGER_FILE), 'utf8'))).toEqual({ v: 1, rows: [], ceilings: [] });
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });
  it('uses the configured accounts root without starting the resource monitor', async () => {
    f.config.mockReturnValue({ verse: { accountsRoot: root } });
    expect(await cmdResources(['claude-promotion', 'record', '--observation', input, '--json'])).toBe(0);
    expect(JSON.parse(readFileSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE), 'utf8')).observations).toEqual([history()]);
    expect(f.config).toHaveBeenCalledOnce(); expect(f.snapshot).not.toHaveBeenCalled();
  });
  it('keeps identical history idempotent and rejects a conflicting capture without rewriting evidence', async () => {
    expect(await cmdResources(args())).toBe(0); const path = join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE); const original = readFileSync(path);
    expect(await cmdResources(args())).toBe(0); expect(JSON.parse(readFileSync(path, 'utf8')).observations).toHaveLength(1);
    write({ ...history(), remainingUsdMicros: '1' }); expect(await cmdResources(args())).toBe(2);
    expect(readFileSync(path)).toEqual(original);
  });
  it('rejects financial observations, invented bindings and future capture times before creating store files', async () => {
    for (const value of [
      { ...history(), kind: 'claude-api-promotion', binding: { organizationDigest: 'a'.repeat(64), workspaceDigest: 'b'.repeat(64), credentialDigest: 'c'.repeat(64), generation: 'fixture' }, cycleId: 'cycle' },
      { ...history(), cycleId: 'invented' }, { ...history(), capturedAt: '2026-10-11T00:00:00.000Z' },
    ]) { write(value); expect(await cmdResources(args())).toBe(2); }
    expect(existsSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE))).toBe(false);
    expect(existsSync(join(root, CLAUDE_API_GRANT_LEDGER_FILE))).toBe(false);
    expect(out.join('')).not.toMatch(/organizationDigest|credentialDigest|capture\.json/);
  });
  it('retains unknown balances and expiry rather than guessing current availability', async () => {
    const row = { ...history(), remainingUsdMicros: null, totalUsdMicros: null, expiry: { precision: 'unknown', date: null, timezone: null, instant: null } };
    write(row); expect(await cmdResources(args())).toBe(0);
    expect(JSON.parse(readFileSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE), 'utf8')).observations).toEqual([row]);
  });
  it('inherits the private store lock and keeps a busy store untouched', async () => {
    const lock = acquireLocalStoreLock(join(root, '.claude-api-grants.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(lock).not.toBeNull();
    try { expect(await cmdResources(args())).toBe(1); expect(JSON.parse(out.join(''))).toMatchObject({ recorded: false, reason: 'store-busy' }); }
    finally { if (lock) releaseLocalStoreLock(lock); }
    expect(existsSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('refuses a linked input without creating stored evidence', async () => {
    const link = join(parent, 'linked.json'); symlinkSync(input, link);
    expect(await cmdResources(args().map(arg => arg === input ? link : arg))).toBe(2);
    expect(existsSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE))).toBe(false);
  });
  it('refuses a corrupt existing store without replacing it', async () => {
    const path = join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE); writeFileSync(path, '{', { mode: 0o600 });
    expect(await cmdResources(args())).toBe(1); expect(readFileSync(path, 'utf8')).toBe('{');
  });
  it('explains history-only import and refuses repeated paths without any capture or default monitor', async () => {
    expect(await cmdResources(['claude-promotion', '--help'])).toBe(0); expect(out.join('')).toContain('Automatic use remains Held');
    expect(await cmdResources(['claude-promotion', 'record', '--observation', input, '--observation', input])).toBe(2);
    expect(existsSync(join(root, CLAUDE_API_GRANT_OBSERVATIONS_FILE))).toBe(false);
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.config).not.toHaveBeenCalled();
  });
});

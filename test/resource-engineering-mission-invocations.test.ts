/** Real private observation records, with no console, worker, evaluator or account calls. */
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginEngineeringMissionInvocation, readEngineeringMissionInvocations } from '../src/core/resources/engineering-mission-invocations.js';
import { missionHash, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import * as immutable from '../src/core/util/immutable-private-record-store.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-invocations-'))); roots.push(root);
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'mission', root, maxScopes: 2, pollIntervalMs: 100,
    deadlineAt: '2026-09-12T20:00:00.000Z', initial: { expectedPlanDigest: 'a'.repeat(64), setup: {
      recipe: {}, policy: {}, output: '/fixture/output', resourceRuntime: '/fixture/runtime.json', workspace: '/fixture/project', projectsFile: '/fixture/projects.json' } } };
  let owned = true, bound = true;
  const host = { isOwned: vi.fn(() => owned), isBound: vi.fn(() => bound) };
  const file = (kind: string, index = 1) => join(root, 'mission-invocations/records', `${String(index).padStart(4, '0')}-${kind}.json`);
  const read = (kind: string, index = 1) => JSON.parse(readFileSync(file(kind, index), 'utf8')) as Record<string, unknown>;
  const alter = (kind: string, change: (row: Record<string, unknown>) => unknown, index = 1) => {
    const path = file(kind, index), row = read(kind, index); chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(change(row)) + '\n'); chmodSync(path, 0o600);
  };
  return { root, config, host, file, read, alter, release: () => { owned = false; }, unbind: () => { bound = false; } };
}
const completed = { state: 'completed' as const, reason: 'scope-limit', scopesReserved: 2 };
describe('mission invocation observations', () => {
  it('reads missing history without creating it or inspecting execution configuration', () => {
    const f = fixture(); expect(readEngineeringMissionInvocations(f.config)).toEqual({ scope: 'recorded-mission-invocations-only',
      count: 0, unfinishedCount: 0, latest: null, ownerState: 'not-observed', executionAuthorized: false });
    expect(readdirSync(f.root)).toEqual([]);
  });
  it('records an unknown outcome rather than asserting liveness when finish is missing', () => {
    const f = fixture(); beginEngineeringMissionInvocation(f.config, f.host);
    expect(readEngineeringMissionInvocations(f.config)).toMatchObject({ count: 1, unfinishedCount: 1,
      latest: { index: 1, outcome: null, elapsedMs: null, timings: [] }, ownerState: 'not-observed' });
    expect(readdirSync(f.root)).toEqual(['mission-invocations']);
  });
  it('finishes after lease release, aggregates monotonic durations and coalesces repeated phases', () => {
    const f = fixture(); let mono = 100; vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const invocation = beginEngineeringMissionInvocation(f.config, f.host);
    mono = 110; invocation.observe(1, 'executing'); mono = 115; invocation.observe(1, 'executing');
    mono = 130; invocation.observe(1, 'draining'); mono = 150; invocation.observe(1, 'executing'); mono = 170;
    f.release(); const calls = f.host.isOwned.mock.calls.length; invocation.finish(completed);
    expect(f.host.isOwned.mock.calls).toHaveLength(calls);
    expect(readEngineeringMissionInvocations(f.config)).toMatchObject({ unfinishedCount: 0, latest: {
      outcome: completed, elapsedMs: 70, timings: [{ scope: 0, phase: 'startup', durationMs: 10 },
        { scope: 1, phase: 'executing', durationMs: 40 }, { scope: 1, phase: 'draining', durationMs: 20 }] } });
    const bytes = readFileSync(f.file('finished')); invocation.finish(completed); expect(readFileSync(f.file('finished'))).toEqual(bytes);
    expect(() => invocation.finish({ ...completed, state: 'held' })).toThrow(); expect(() => invocation.observe(2, 'executing')).toThrow();
  });
  it('keeps later invocation ordering when an older owner finishes late', () => {
    const f = fixture(), first = beginEngineeringMissionInvocation(f.config, f.host);
    const second = beginEngineeringMissionInvocation(f.config, f.host); second.finish({ state: 'held', reason: 'proposing-held', scopesReserved: 1 });
    first.finish(completed);
    expect(readEngineeringMissionInvocations(f.config)).toMatchObject({ count: 2, unfinishedCount: 0, latest: { index: 2, outcome: { state: 'held' } } });
  });
  it('does not replace a conflicting immutable finish', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host); invocation.finish(completed);
    f.alter('finished', row => ({ ...row, outcome: { ...completed, state: 'held', reason: 'shutdown-unresolved' } }));
    const bytes = readFileSync(f.file('finished'));
    expect(() => invocation.finish(completed)).toThrow(); expect(readFileSync(f.file('finished'))).toEqual(bytes);
  });
  it('clamps the finish timestamp on wall-clock rollback without renewing monotonic duration', () => {
    const f = fixture(); let mono = 100; vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const invocation = beginEngineeringMissionInvocation(f.config, f.host), started = f.read('started').startedAt;
    vi.spyOn(Date, 'now').mockReturnValue(0); mono = 120; invocation.finish(completed);
    expect(readEngineeringMissionInvocations(f.config).latest).toMatchObject({ startedAt: started, finishedAt: started, elapsedMs: 20 });
  });
  it('redacts arbitrary reason text and preserves closed shutdown diagnostics', () => {
    const f = fixture(), first = beginEngineeringMissionInvocation(f.config, f.host);
    first.finish({ state: 'held', reason: 'private-token-in-error https://secret/path', scopesReserved: 0 });
    expect(readEngineeringMissionInvocations(f.config).latest?.outcome?.reason).toBe('unclassified-outcome');
    expect(readFileSync(f.file('finished'), 'utf8')).not.toContain('secret');
    beginEngineeringMissionInvocation(f.config, f.host).finish({ state: 'held', reason: 'shutdown-unresolved', scopesReserved: 1 });
    expect(readEngineeringMissionInvocations(f.config).latest?.outcome?.reason).toBe('shutdown-unresolved');
    expect(JSON.stringify(readEngineeringMissionInvocations(f.config))).not.toContain(f.root);
  });
  it.each(['ownership', 'binding'])('requires %s at start before writes', kind => {
    const f = fixture(); if (kind === 'ownership') f.release(); else f.unbind();
    expect(() => beginEngineeringMissionInvocation(f.config, f.host)).toThrow(); expect(readdirSync(f.root)).toEqual([]);
  });
  it('refuses observations after ownership loss and completion after binding loss', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host);
    f.release(); expect(() => invocation.observe(1, 'executing')).toThrow(); f.unbind(); expect(() => invocation.finish(completed)).toThrow();
    expect(readEngineeringMissionInvocations(f.config).unfinishedCount).toBe(1);
  });
  it('rechecks ownership at publication and leaves refusal unfinished', () => {
    const f = fixture(); f.host.isOwned.mockImplementationOnce(() => true).mockImplementationOnce(() => true).mockReturnValue(false);
    expect(() => beginEngineeringMissionInvocation(f.config, f.host)).toThrow();
    expect(readEngineeringMissionInvocations(f.config).count).toBe(0);
  });
  it('refuses root replacement even with a stale host binding callback', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host);
    renameSync(f.root, f.root + '-old'); roots.push(f.root + '-old');
    symlinkSync(f.root + '-old', f.root); expect(() => invocation.finish(completed)).toThrow();
  });
  it.each(['live', 'dangling'])('refuses a %s journal symlink', kind => {
    const f = fixture(); symlinkSync(kind === 'live' ? f.root : join(f.root, 'absent'), join(f.root, 'mission-invocations'));
    expect(() => readEngineeringMissionInvocations(f.config)).toThrow();
  });
  it('refuses a changed original start and a changed configuration', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host);
    expect(() => readEngineeringMissionInvocations({ ...f.config, deadlineAt: '2026-09-13T20:00:00.000Z' })).toThrow();
    f.alter('started', row => ({ ...row, startedAt: '2025-01-01T00:00:00.000Z' }));
    expect(() => invocation.finish(completed)).toThrow();
  });
  it('rechecks the exact start identity inside final publication serialization', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host);
    const actual = immutable.writeImmutablePrivateRecord;
    vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((config, row, options) => {
      f.alter('started', value => value);
      return actual(config, row, options);
    });
    expect(() => invocation.finish(completed)).toThrow(); expect(readEngineeringMissionInvocations(f.config).unfinishedCount).toBe(1);
  });
  it.each([[-1, 'executing'], [3, 'executing'], [1, 'https://secret'], [NaN, 'startup'], [Infinity, 'startup']])('refuses invalid phase/scope %s %s', (scope, value) => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host);
    expect(() => invocation.observe(scope as number, value as string)).toThrow(); expect(readEngineeringMissionInvocations(f.config).unfinishedCount).toBe(1);
  });
  it('refuses backwards scope or monotonic time and non-finite duration', () => {
    const f = fixture(); let mono = 100; vi.spyOn(performance, 'now').mockImplementation(() => mono);
    const invocation = beginEngineeringMissionInvocation(f.config, f.host); invocation.observe(2, 'executing');
    expect(() => invocation.observe(1, 'executing')).toThrow(); mono = 99; expect(() => invocation.finish(completed)).toThrow();
    mono = Infinity; expect(() => invocation.finish(completed)).toThrow();
  });
  it('does not invoke getters in outcome input', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host), getter = vi.fn(() => 'secret');
    expect(() => invocation.finish(Object.defineProperty({ ...completed }, 'reason', { get: getter }))).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('refuses excessive input before serializing a receipt', () => {
    const f = fixture(), invocation = beginEngineeringMissionInvocation(f.config, f.host);
    expect(() => invocation.finish({ ...completed, reason: 'x'.repeat(600_000) })).toThrow();
    expect(readEngineeringMissionInvocations(f.config).unfinishedCount).toBe(1);
  });
  it.each([
    (row: Record<string, unknown>) => ({ ...row, kind: ['finished'] }),
    (row: Record<string, unknown>) => ({ ...row, outcome: { ...completed, state: ['held'] } }),
    (row: Record<string, unknown>) => ({ ...row, elapsedMs: -1 }),
    (row: Record<string, unknown>) => ({ ...row, elapsedMs: null }),
    (row: Record<string, unknown>) => ({ ...row, startDigest: '0'.repeat(64) }),
    (row: Record<string, unknown>) => ({ ...row, finishedAt: '2000-01-01T00:00:00.000Z' }),
    (row: Record<string, unknown>) => ({ ...row, timings: [] }),
    (row: Record<string, unknown>) => ({ ...row, timings: [{ scope: 0, phase: 'startup', durationMs: 0 }, { scope: 0, phase: 'startup', durationMs: 0 }] }),
    (row: Record<string, unknown>) => ({ ...row, outcome: { ...completed, reason: 'private-message' } }),
  ])('refuses hostile finished records %#', change => {
    const f = fixture(); beginEngineeringMissionInvocation(f.config, f.host).finish(completed);
    f.alter('finished', change); expect(() => readEngineeringMissionInvocations(f.config)).toThrow();
  });
  it('refuses orphan finishes and nonsequential starts', () => {
    const f = fixture(); beginEngineeringMissionInvocation(f.config, f.host).finish(completed);
    rmSync(f.file('started')); expect(() => readEngineeringMissionInvocations(f.config)).toThrow();
    rmSync(f.file('finished')); writeFileSync(f.file('started', 2), JSON.stringify({ id: '0002-started', kind: 'started', index: 2,
      configDigest: missionHash(f.config), startedAt: new Date().toISOString() }), { mode: 0o600 });
    expect(() => readEngineeringMissionInvocations(f.config)).toThrow();
  });
  it('compares canonical extended-year timestamps numerically', () => {
    const f = fixture(); beginEngineeringMissionInvocation(f.config, f.host).finish(completed);
    f.alter('started', row => ({ ...row, startedAt: '+030000-01-01T00:00:00.000Z' }));
    f.alter('finished', row => ({ ...row, startDigest: missionHash(f.read('started')) }));
    expect(() => readEngineeringMissionInvocations(f.config)).toThrow();
  });
  it('refuses incomplete staging without recovering it', () => {
    const f = fixture(); beginEngineeringMissionInvocation(f.config, f.host);
    const path = join(f.root, 'mission-invocations/staging/unknown'); writeFileSync(path, '{}', { mode: 0o600 });
    expect(() => readEngineeringMissionInvocations(f.config)).toThrow(); expect(readFileSync(path, 'utf8')).toBe('{}');
  });
  it('bounds invocations at 4096 without writing a new start (mocked census only)', () => {
    const f = fixture(); const rows = Array.from({ length: 4096 }, (_, i) => ({ id: `${String(i + 1).padStart(4, '0')}-started`,
      kind: 'started', index: i + 1, configDigest: missionHash(f.config), startedAt: new Date().toISOString() }));
    vi.spyOn(immutable, 'readImmutablePrivateRecords').mockReturnValue({ sourceState: 'healthy', sourcePresent: true, complete: true,
      records: rows, stopReasons: [], filesRead: rows.length, bytesRead: 100, invalidFiles: 0, limitExceeded: false });
    expect(() => beginEngineeringMissionInvocation(f.config, f.host)).toThrow(); expect(readdirSync(f.root)).toEqual([]);
  });
  it('uses private single-link immutable files', () => {
    const f = fixture(); beginEngineeringMissionInvocation(f.config, f.host).finish(completed);
    expect(lstatSync(f.file('started')).nlink).toBe(1); expect(lstatSync(f.file('finished')).mode & 0o777).toBe(0o600);
  });
});

/** Real private state reads and owner restart; inert callbacks, no dispatch/provider. */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { createResourceConsoleEngineeringSupervisor } from '../src/core/resources/console-engineering-supervisor.js';
import { readResourceConsoleEngineeringSupervisionState, validateResourceConsoleEngineeringSupervisionState,
  type ResourceConsoleEngineeringSupervisionState as State } from '../src/core/resources/console-engineering-supervision-state.js';
import type { ResourceConsoleEngineeringOwner } from '../src/core/resources/console-engineering.js';
import type { ResourceConsoleEngineeringSupervisionConfig } from '../src/core/resources/console-engineering-supervisor-types.js';
import * as resourceFiles from '../src/core/resources/pool-runtime.js';

const hash = 'a'.repeat(64);
const config: ResourceConsoleEngineeringSupervisionConfig = { schemaVersion: 1, id: 'queue', maxDurationMs: 60_000,
  pollIntervalMs: 100, maxConcurrent: 1, maxAttemptsPerEnrollment: 3, maxEnrollments: 2, autoAdmitPrepared: true,
  enrollments: [{ enrollmentId: 'first', expectedEnrollmentDigest: hash }] };
const catalog = [{ id: 'first', enrollmentDigest: hash }, { id: 'second', enrollmentDigest: 'b'.repeat(64) }];
const scope = { config, catalog };
const state = (): State => ({ schemaVersion: 1, configDigest: digest(canonical(config)),
  createdAt: '2025-01-01T00:00:00.000Z', writtenAt: '2025-01-01T00:00:01.000Z', deadlineAt: '2025-01-01T00:01:00.000Z',
  paused: true, revision: 2, entries: [{ enrollmentId: 'first', enrollmentDigest: hash, attempts: 1,
    lastEvidenceDigest: 'c'.repeat(64), lastOutcome: 'settled' }] });
let root: string;
const owners: Array<ReturnType<typeof createResourceConsoleEngineeringSupervisor>> = [];
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-supervision-state-'))); });
afterEach(async () => {
  for (const owner of owners.splice(0).reverse()) await owner.close().catch(() => {});
  vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
});
const directory = () => join(root, 'engineering-supervision', config.id);
const file = () => join(directory(), 'state.json');
function save(value: unknown) {
  mkdirSync(directory(), { recursive: true, mode: 0o700 });
  writeFileSync(file(), canonical(value) + '\n', { mode: 0o600 });
}
function tree(path: string): unknown {
  const stat = lstatSync(path, { bigint: true });
  return { ino: stat.ino, mode: stat.mode, mtime: stat.mtimeNs, ctime: stat.ctimeNs,
    data: stat.isFile() ? readFileSync(path).toString('base64') : stat.isDirectory()
      ? readdirSync(path).sort().map(name => [name, tree(join(path, name))]) : null };
}
function inertOwner() {
  const callbacks = { catalog: vi.fn(() => structuredClone(catalog)), snapshot: vi.fn(), readiness: vi.fn(),
    evidenceFingerprint: vi.fn(), launch: vi.fn(), awaitSettlement: vi.fn(async () => {}) };
  return { callbacks, owner: callbacks as unknown as ResourceConsoleEngineeringOwner };
}

describe('read-only durable engineering supervision state', () => {
  it('reads historical original deadline, exact digest and outcomes without effects or renewal', () => {
    save(state()); const before = tree(root);
    const report = readResourceConsoleEngineeringSupervisionState({ root, ...scope });
    expect(report).toEqual({ state: state(), stateDigest: digest(canonical(state())) });
    report.state.entries[0]!.attempts = 3;
    expect(readResourceConsoleEngineeringSupervisionState({ root, ...scope }).state).toEqual(state());
    expect(tree(root)).toEqual(before);
  });

  it('reads actual constructor state after close and preserves bytes across owner restart', async () => {
    const { owner, callbacks } = inertOwner();
    const first = createResourceConsoleEngineeringSupervisor({ root, config, owner }); owners.push(first);
    const beforeClose = readResourceConsoleEngineeringSupervisionState({ root, ...scope });
    await first.close(); const closedTree = tree(root); const bytes = readFileSync(file());
    expect(readResourceConsoleEngineeringSupervisionState({ root, ...scope })).toEqual(beforeClose);
    expect(tree(root)).toEqual(closedTree);
    const second = createResourceConsoleEngineeringSupervisor({ root, config, owner }); owners.push(second);
    expect(second.snapshot().deadlineAt).toBe(beforeClose.state.deadlineAt);
    await second.close();
    expect(readFileSync(file())).toEqual(bytes);
    expect(readResourceConsoleEngineeringSupervisionState({ root, ...scope })).toEqual(beforeClose);
    expect(callbacks.launch).not.toHaveBeenCalled(); expect(callbacks.awaitSettlement).not.toHaveBeenCalled();
  });

  it('shares exact persisted-state refusal with actual owner restart and releases failed startup ownership', () => {
    save({ ...state(), deadlineAt: '2025-01-01T00:02:00.000Z' });
    const { owner, callbacks } = inertOwner();
    expect(() => readResourceConsoleEngineeringSupervisionState({ root, ...scope })).toThrow();
    expect(() => createResourceConsoleEngineeringSupervisor({ root, config, owner })).toThrow('configuration or state changed');
    expect(existsSync(join(directory(), '.execution.lock'))).toBe(false);
    expect(callbacks.launch).not.toHaveBeenCalled();
  });

  it('accepts exact appended enrollment and each recorded outcome without promoting it to completion', () => {
    for (const lastOutcome of ['attempting', 'settled', 'unavailable'] as const) {
      const value = state(); value.entries.push({ enrollmentId: 'second', enrollmentDigest: catalog[1]!.enrollmentDigest,
        attempts: 2, lastEvidenceDigest: 'd'.repeat(64), lastOutcome });
      expect(validateResourceConsoleEngineeringSupervisionState(value, scope)).toEqual(value);
    }
  });

  it.each([
    { schemaVersion: 2 }, { configDigest: 'b'.repeat(64) }, { createdAt: 'invalid' }, { deadlineAt: '2025-01-01T00:02:00.000Z' },
    { writtenAt: '2024-12-31T00:00:00.000Z' }, { paused: 'false' }, { revision: -1 }, { entries: [] }, { entries: [null] },
    { entries: [state().entries[0], state().entries[0]] }, { extra: true },
  ])('rejects malformed or foreign state %#', change => {
    expect(() => validateResourceConsoleEngineeringSupervisionState({ ...state(), ...change }, scope)).toThrow();
  });

  it.each([
    { enrollmentId: 'second' }, { enrollmentDigest: 'b'.repeat(64) }, { attempts: 4 }, { attempts: 0 },
    { lastEvidenceDigest: null }, { lastEvidenceDigest: 'bad' }, { lastOutcome: null }, { lastOutcome: ['settled'] }, { extra: true },
  ])('rejects invalid entry or initial-prefix change %#', change => {
    expect(() => validateResourceConsoleEngineeringSupervisionState({ ...state(), entries: [{ ...state().entries[0], ...change }] }, scope)).toThrow();
  });

  it('requires every appended identity in the explicit catalog and preserves fixed queue cardinality', () => {
    const value = state(); value.entries.push({ ...value.entries[0]!, enrollmentId: 'second', enrollmentDigest: catalog[1]!.enrollmentDigest });
    expect(() => validateResourceConsoleEngineeringSupervisionState(value, { config, catalog: catalog.slice(0, 1) })).toThrow();
    const { maxEnrollments: _max, autoAdmitPrepared: _auto, ...fixed } = config;
    expect(() => validateResourceConsoleEngineeringSupervisionState({ ...value, configDigest: digest(canonical(fixed)) }, { config: fixed, catalog })).toThrow();
  });

  it('does not create missing storage or evaluate getters in arguments/state', () => {
    const before = tree(root); const getter = vi.fn(() => root);
    expect(() => readResourceConsoleEngineeringSupervisionState({ root, ...scope })).toThrow();
    expect(() => readResourceConsoleEngineeringSupervisionState(Object.defineProperty({ ...scope }, 'root', { enumerable: true, get: getter }) as { root: string } & typeof scope)).toThrow();
    expect(() => validateResourceConsoleEngineeringSupervisionState(Object.defineProperty(state(), 'entries', { enumerable: true, get: getter }), scope)).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(tree(root)).toEqual(before);
  });

  it('refuses a replaced containing directory even when the returned state bytes are identical', () => {
    save(state()); const original = resourceFiles.readResourceJson; let mutated: unknown;
    vi.spyOn(resourceFiles, 'readResourceJson').mockImplementation((path, maxBytes) => {
      const value = original(path, maxBytes);
      renameSync(directory(), directory() + '-retained'); save(state()); mutated = tree(root);
      return value;
    });
    expect(() => readResourceConsoleEngineeringSupervisionState({ root, ...scope })).toThrow('state unavailable');
    expect(tree(root)).toEqual(mutated);
  });

  it.each(['../escape', '/absolute', 'UPPER'])('rejects invalid configuration path %s before reading', id => {
    const before = tree(root);
    expect(() => readResourceConsoleEngineeringSupervisionState({ root, config: { ...config, id }, catalog })).toThrow();
    expect(tree(root)).toEqual(before);
  });

  it.each(['state-link', 'directory-link', 'public-state', 'oversized', 'malformed'])('refuses unsafe storage %s without writes', mode => {
    save(state());
    if (mode === 'state-link') { rmSync(file()); symlinkSync(join(root, 'missing'), file()); }
    if (mode === 'directory-link') { rmSync(directory(), { recursive: true }); symlinkSync(join(root, 'missing'), directory()); }
    if (mode === 'public-state') chmodSync(file(), 0o644);
    if (mode === 'oversized') writeFileSync(file(), ' '.repeat(128 * 1024 + 1));
    if (mode === 'malformed') writeFileSync(file(), '{');
    const before = tree(root);
    expect(() => readResourceConsoleEngineeringSupervisionState({ root, ...scope })).toThrow();
    expect(tree(root)).toEqual(before);
  });
});

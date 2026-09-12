/** Private immutable records, with no worker, evaluator, account or console startup. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineeringMissionRecordStore, missionHash, missionRecord, readEngineeringMissionRecords, type MissionRecordKind,
  validateResourceEngineeringMissionConfig, type ResourceEngineeringMissionConfig } from '../src/core/resources/engineering-mission-store.js';
import { writeImmutablePrivateRecord } from '../src/core/util/immutable-private-record-store.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mission-records-'))); roots.push(root);
  const config: ResourceEngineeringMissionConfig = { schemaVersion: 1, id: 'mission', root, maxScopes: 2, pollIntervalMs: 100,
    deadlineAt: '2026-09-12T20:00:00.000Z', initial: { expectedPlanDigest: 'a'.repeat(64), setup: {
      recipe: {}, policy: {}, output: join(root, 'initial'), resourceRuntime: '/fixture/runtime.json', workspace: '/fixture/project', projectsFile: '/fixture/projects.json' } } };
  const payloads: Record<MissionRecordKind, unknown> = {
    definition: { configDigest: missionHash(config) }, reserved: { setup: config.initial.setup }, prepared: { planDigest: 'b'.repeat(64) },
    running: { deadlineAt: config.deadlineAt }, finished: { reason: 'stop-requested' },
    proposal: { poolDigest: 'c'.repeat(64), task: { schemaVersion: 1, id: 'proposal', allowedWorkerIds: ['local'], prompt: 'Propose.',
      cwd: '/fixture/project', timeoutMs: 1000, maxOutputTokens: 100, mode: 'read-only' } },
    result: { output: '{"action":"stop"}', receiptDigest: 'd'.repeat(64) },
    settled: { schemaVersion: 1, scope: 'predecessor-completion-evidence-only', status: 'verified', reasons: [], sampledAt: config.deadlineAt,
      executionAuthorized: false, effectsExecuted: false, providerContacted: false, evidenceDigest: 'e'.repeat(64),
      tip: { enrollmentId: 'enrollment', enrollmentDigest: 'f'.repeat(64), projectId: 'default', commit: 'a'.repeat(40) }, continuation: 'eligible' },
  };
  const write = (kind: Parameters<typeof missionRecord>[0], index: number, payload: unknown = payloads[kind]) =>
    writeImmutablePrivateRecord(engineeringMissionRecordStore(root), missionRecord(kind, index, payload));
  return { config, write, payloads };
}
describe('mission configuration and immutable sequencing', () => {
  it('detaches configuration and refuses unknown authority fields and accessors', () => {
    const { config } = fixture(); const checked = validateResourceEngineeringMissionConfig(config);
    expect(checked).toEqual(config); expect(checked).not.toBe(config);
    expect(() => validateResourceEngineeringMissionConfig({ ...config, execute: true })).toThrow();
    const getter = vi.fn(() => config.initial);
    expect(() => validateResourceEngineeringMissionConfig(Object.defineProperty({ ...config }, 'initial', { enumerable: true, get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([{ maxScopes: 0 }, { maxScopes: 65 }, { maxScopes: 1.5 }, { pollIntervalMs: 0 }, { deadlineAt: '2026-09-12' }, { root: '/' }])('rejects invalid mission limit/path %j', patch => {
    const { config } = fixture(); expect(() => validateResourceEngineeringMissionConfig({ ...config, ...patch })).toThrow();
  });
  it('requires the original configuration after restart and never renews its deadline', () => {
    const { config, write } = fixture(); expect(readEngineeringMissionRecords(config, true)).toEqual([]);
    expect(write('definition', 0, { configDigest: missionHash(config) })).toBe('recorded');
    expect(write('reserved', 1, { setup: config.initial.setup })).toBe('recorded');
    const rows = readEngineeringMissionRecords(config);
    expect(write('definition', 0, { configDigest: missionHash(config) })).toBe('replayed');
    expect(readEngineeringMissionRecords(config)).toEqual(rows);
    expect(() => readEngineeringMissionRecords({ ...config, deadlineAt: '2026-09-12T21:00:00.000Z' })).toThrow('Mission definition changed');
    expect(() => readEngineeringMissionRecords({ ...config, maxScopes: 3 })).toThrow('Mission definition changed');
  });
  it.each(['prepared', 'running', 'settled', 'proposal', 'result', 'finished'] as const)('refuses orphan %s records', kind => {
    const { config, write } = fixture(); write('definition', 0, { configDigest: missionHash(config) }); write(kind, 1);
    expect(() => readEngineeringMissionRecords(config)).toThrow('Unreserved mission work');
  });
  it('requires completed predecessor and a result before reserving another scope', () => {
    const { config, write } = fixture(); write('definition', 0, { configDigest: missionHash(config) });
    write('reserved', 1); write('reserved', 2); expect(() => readEngineeringMissionRecords(config)).toThrow('Mission history is incomplete');
  });
  it.each(['definition', 'reserved', 'prepared', 'running', 'settled', 'proposal', 'result', 'finished'] as const)('refuses malformed %s payloads before publication', kind => {
    const { config, write, payloads } = fixture(); const index = kind === 'definition' ? 0 : 1;
    for (const payload of [null, {}, [], { ...(payloads[kind] as object), execute: true }]) expect(write(kind, index, payload)).toBe('invalid');
    expect(readEngineeringMissionRecords(config, true)).toEqual([]);
  });
  it.each([
    ['prepared', { planDigest: 'not-a-digest' }], ['running', { deadlineAt: 'tomorrow' }],
    ['result', { receiptDigest: 'a'.repeat(64), output: '{"action":"execute"}' }], ['finished', { reason: 'unknown' }],
  ] as const)('refuses semantically invalid %s payloads', (kind, payload) => {
    expect(fixture().write(kind, 1, payload)).toBe('invalid');
  });
  it('refuses unverified completion and writable proposal records', () => {
    const { write, payloads } = fixture();
    expect(write('settled', 1, { ...(payloads.settled as object), status: 'held' })).toBe('invalid');
    const proposal = payloads.proposal as { task: object; poolDigest: string };
    expect(write('proposal', 1, { ...proposal, task: { ...proposal.task, mode: 'workspace-write' } })).toBe('invalid');
  });
});

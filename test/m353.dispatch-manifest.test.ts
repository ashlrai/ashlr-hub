/**
 * m353.dispatch-manifest.test.ts - forensic concurrent dispatch manifest tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkItem, WorkSource } from '../src/core/types.js';
import type { BackendAvailability, BackendResourceState, ResourceSnapshot } from '../src/core/fabric/resource-monitor.js';
import { planConcurrentDispatch, type ConcurrentDispatchCfg } from '../src/core/fabric/concurrent-dispatch.js';
import {
  buildDispatchManifestEvent,
  dispatchManifestDir,
  readDispatchManifestEvents,
  readDispatchManifestEventsDetailed,
  readDispatchManifestLatestObservationDetailed,
  recordDispatchManifest,
  sanitizeDispatchManifestEvent,
  type DispatchManifestEvent,
} from '../src/core/fleet/dispatch-manifest.js';

let tmpDir: string;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m353-'));
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.ASHLR_HOME = path.join(tmpDir, '.ashlr');
});

afterEach(() => {
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function defaultRepoPath(): string {
  return path.join(fs.realpathSync.native(os.tmpdir()), 'repo');
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const id = `item-${++seq}`;
  return {
    id,
    title: `Task ${id}`,
    repo: defaultRepoPath(),
    effort: 2,
    source: 'backlog' as WorkSource,
    tags: [],
    createdAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function makeSnapshot(
  backends: Array<{
    backend: string;
    availability: BackendAvailability;
    usedPct?: number | null;
    cap?: number | null;
    capUnit?: BackendResourceState['capUnit'];
  }>,
): ResourceSnapshot {
  return {
    generatedAt: '2026-07-10T00:00:00.000Z',
    backends: backends.map(({ backend, availability, usedPct, cap, capUnit }) => ({
      backend: backend as import('../src/core/types.js').EngineId,
      availability,
      usedPct: usedPct ?? null,
      cap: cap ?? null,
      capUnit: capUnit ?? null,
      capWindow: null,
      resetsAt: null,
      costPerMTokenOut: 0,
      p50LatencyMs: null,
      snapshotAt: '2026-07-10T00:00:00.000Z',
      reason: `test: ${availability}`,
      backoffUntilMs: null,
    })),
  };
}

function makeEvent(ts: string, id = `manifest-item-${++seq}`): DispatchManifestEvent {
  const snapshot = makeSnapshot([{ backend: 'codex', availability: 'open' }]);
  const plan = planConcurrentDispatch(
    [makeItem({ id })],
    snapshot,
    { maxSlotsPerBackend: 1 },
    () => 'codex',
  );
  return buildDispatchManifestEvent({ ts, plan, resourceSnapshotAt: snapshot.generatedAt });
}

function writeRows(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

describe('dispatch manifest ledger', () => {
  it('records a bounded, scrubbed concurrent dispatch plan', () => {
    const secret = 'sk-1234567890abcdef';
    const items = [
      makeItem({
        id: `item-${secret}`,
        title: `Investigate token=${secret}`,
        repo: defaultRepoPath(),
      }),
      makeItem({ id: 'item-two', title: 'Second task' }),
    ];
    const snapshot = makeSnapshot([{ backend: 'codex', availability: 'open' }]);
    const cfg: ConcurrentDispatchCfg = { maxSlotsPerBackend: 1 };
    const plan = planConcurrentDispatch(items, snapshot, cfg, () => 'codex');
    const routeReasons = new Map<string, string>([
      [items[0]!.id, `Authorization ${secret}`],
    ]);
    const routeModels = new Map<string, string | null>([
      [items[0]!.id, `model-${secret}`],
    ]);

    const event = buildDispatchManifestEvent({
      ts: '2026-07-10T00:01:00.000Z',
      machineId: `machine-${secret}`,
      plan,
      routeReasons,
      routeModels,
      resourceSnapshotAt: snapshot.generatedAt,
    });
    const summary = recordDispatchManifest(event);
    const readback = readDispatchManifestEvents({ limit: 10 });
    const raw = fs.readFileSync(path.join(dispatchManifestDir(), '2026-07-10.jsonl'), 'utf8');

    expect(summary).toMatchObject({
      schemaVersion: 1,
      recorded: true,
      mode: 'concurrent',
      claimed: 2,
      assigned: 2,
      unassigned: 0,
      backends: { codex: 1, builtin: 1 },
      resourceSnapshotAt: '2026-07-10T00:00:00.000Z',
    });
    expect(readback).toHaveLength(1);
    expect(readback[0]?.assignments).toHaveLength(2);
    expect(readback[0]?.claimedItemIds).toHaveLength(2);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('Authorization sk-');
    expect(raw).not.toContain('api_key=sk-');
  });

  it('idempotently rejects relative and secret-shaped repo identities without unknown or cwd rows', () => {
    const valid = makeEvent('2026-07-10T00:02:00.000Z', 'invalid-repo-seed');
    const secret = 'github_pat_1234567890abcdefghijklmnop';
    const invalidRepos = ['relative/repo', path.join(tmpDir, `token=${secret}`)];

    for (const repo of invalidRepos) {
      const invalid: DispatchManifestEvent = {
        ...valid,
        assignments: valid.assignments.map((assignment) => ({ ...assignment, repo })),
      };
      expect(() => sanitizeDispatchManifestEvent(invalid)).toThrow(/repository identity/);
      expect(() => sanitizeDispatchManifestEvent(invalid)).toThrow(/repository identity/);
      expect(recordDispatchManifest(invalid)).toMatchObject({ recorded: false });
      expect(recordDispatchManifest(invalid)).toMatchObject({ recorded: false });
    }

    expect(fs.existsSync(path.join(dispatchManifestDir(), '2026-07-10.jsonl'))).toBe(false);
  });

  it('persists physical assignment repo identity and rejects legacy alias authority', () => {
    const physicalRepo = path.join(tmpDir, 'physical-repo');
    const nested = path.join(physicalRepo, 'identity-probe');
    const linkedAlias = path.join(tmpDir, 'repo-alias');
    fs.mkdirSync(nested, { recursive: true });
    const canonicalRepo = fs.realpathSync.native(physicalRepo);
    const lexicalAlias = path.join(nested, '..');
    fs.symlinkSync(canonicalRepo, linkedAlias, process.platform === 'win32' ? 'junction' : 'dir');

    const snapshot = makeSnapshot([{ backend: 'codex', availability: 'open' }]);
    const plan = planConcurrentDispatch(
      [makeItem({ id: 'lexical-alias', repo: lexicalAlias }), makeItem({ id: 'linked-alias', repo: linkedAlias })],
      snapshot,
      { maxSlotsPerBackend: 2 },
      () => 'codex',
    );
    const event = buildDispatchManifestEvent({ ts: '2026-07-10T00:03:00.000Z', plan });
    expect(event.assignments.map((assignment) => assignment.repo)).toEqual([canonicalRepo, canonicalRepo]);

    event.assignments[0]!.repo = lexicalAlias;
    event.assignments[1]!.repo = linkedAlias;
    expect(recordDispatchManifest(event)).toMatchObject({ recorded: true });

    const ledgerPath = path.join(dispatchManifestDir(), '2026-07-10.jsonl');
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const persisted = JSON.parse(raw) as DispatchManifestEvent;
    expect(persisted.assignments.map((assignment) => assignment.repo)).toEqual([canonicalRepo, canonicalRepo]);
    expect(readDispatchManifestEvents()[0]?.assignments.map((assignment) => assignment.repo))
      .toEqual([canonicalRepo, canonicalRepo]);

    const legacy = {
      ...persisted,
      manifestId: `${persisted.manifestId}-legacy`,
      assignments: persisted.assignments.map((assignment, index) =>
        index === 0 ? { ...assignment, repo: linkedAlias } : assignment),
    };
    fs.writeFileSync(ledgerPath, `${raw}${JSON.stringify(legacy)}\n`, 'utf8');
    const detailed = readDispatchManifestEventsDetailed();
    expect(detailed.events).toHaveLength(1);
    expect(detailed).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    const rawAfter = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as DispatchManifestEvent);
    expect(rawAfter.at(-1)?.assignments[0]?.repo).toBe(linkedAlias);
  });

  it('bounds assignment and claim samples while preserving full counts', () => {
    const items = Array.from({ length: 30 }, (_, idx) => makeItem({ id: `item-${idx}` }));
    const snapshot = makeSnapshot([{ backend: 'codex', availability: 'open' }]);
    const plan = planConcurrentDispatch(items, snapshot, { maxSlotsPerBackend: 30 }, () => 'codex');

    const event = buildDispatchManifestEvent({
      ts: '2026-07-10T00:02:00.000Z',
      machineId: 'machine-A',
      plan,
      resourceSnapshotAt: snapshot.generatedAt,
    });

    expect(event.assignments).toHaveLength(24);
    expect(event.claimedItemIds).toHaveLength(24);
    expect(event.backendCounts).toEqual({ codex: 30 });
    expect(event.counts).toEqual({ claimed: 30, assigned: 30, unassigned: 0 });
  });

  it('fails soft when the manifest directory is unwritable', () => {
    const blockedHome = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(blockedHome, '');
    process.env.ASHLR_HOME = blockedHome;

    const snapshot = makeSnapshot([{ backend: 'codex', availability: 'open' }]);
    const plan = planConcurrentDispatch([makeItem()], snapshot, { maxSlotsPerBackend: 1 }, () => 'codex');
    const event = buildDispatchManifestEvent({
      ts: '2026-07-10T00:03:00.000Z',
      plan,
      resourceSnapshotAt: snapshot.generatedAt,
    });

    expect(() => recordDispatchManifest(event)).not.toThrow();
    expect(recordDispatchManifest(event)).toMatchObject({ recorded: false, assigned: 1 });
    expect(readDispatchManifestEvents()).toEqual([]);
  });

  it('reports missing, healthy, and malformed sources without making quality enumerable', () => {
    const missing = readDispatchManifestEventsDetailed();
    expect(missing).toMatchObject({ sourceState: 'missing', sourcePresent: false, complete: true });

    const event = makeEvent('2026-07-11T10:00:00.000Z', 'healthy');
    expect(recordDispatchManifest(event)).toMatchObject({ recorded: true });
    const healthy = readDispatchManifestEvents();
    expect(healthy).toHaveLength(1);
    expect(Object.keys(healthy)).toEqual(['0']);
    expect((healthy as typeof healthy & { sourceQuality: unknown }).sourceQuality).toMatchObject({
      sourceState: 'healthy', complete: true,
    });

    fs.appendFileSync(path.join(dispatchManifestDir(), '2026-07-11.jsonl'), '{"torn":true\n', 'utf8');
    const degraded = readDispatchManifestEventsDetailed();
    expect(degraded).toMatchObject({ sourceState: 'degraded', complete: false, invalidRows: 1 });
    expect(degraded.events).toHaveLength(1);
    expect(readDispatchManifestEvents({ requireComplete: true })).toEqual([]);
  });

  it('rejects malformed schema, non-canonical timestamps, and timestamp-partition mismatches', () => {
    const valid = makeEvent('2026-07-11T10:00:00.000Z', 'valid');
    writeRows(path.join(dispatchManifestDir(), '2026-07-11.jsonl'), [
      valid,
      { ...valid, schemaVersion: 2 },
      { ...valid, ts: 'July 11 2026 10:00 UTC' },
      { ...valid, ts: '2026-07-10T10:00:00.000Z' },
      { ...valid, unexpected: true },
      { ...valid, assignments: [{ ...valid.assignments[0], source: 'unknown-source' }] },
      { ...valid, backendCounts: { unknownBackend: 1 } },
      { ...valid, counts: { claimed: 2, assigned: 1, unassigned: 0 } },
      { ...valid, backendCounts: { codex: 0 } },
      'not-json',
    ]);

    const detailed = readDispatchManifestEventsDetailed();
    expect(detailed.events.map((event) => event.claimedItemIds[0])).toEqual(['valid']);
    expect(detailed).toMatchObject({ sourceState: 'degraded', complete: false, rowsScanned: 10, invalidRows: 9 });
  });

  it('rejects impossible and loosely named dated partitions', () => {
    writeRows(path.join(dispatchManifestDir(), '2026-02-30.jsonl'), []);
    expect(readDispatchManifestEventsDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
    });

    fs.rmSync(dispatchManifestDir(), { recursive: true });
    writeRows(path.join(dispatchManifestDir(), 'latest.jsonl'), []);
    expect(readDispatchManifestEventsDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['io-error'], unreadableFiles: 1,
    });
  });

  it('distinguishes logical event limits from exact-cap complete reads', () => {
    const older = makeEvent('2026-07-11T09:00:00.000Z', 'older');
    const newer = makeEvent('2026-07-11T10:00:00.000Z', 'newer');
    writeRows(path.join(dispatchManifestDir(), '2026-07-11.jsonl'), [older, newer]);

    expect(readDispatchManifestEventsDetailed({ limit: 1, stopAfterLimit: true })).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['event-limit'], events: [{ claimedItemIds: ['newer'] }],
    });

    writeRows(path.join(dispatchManifestDir(), '2026-07-11.jsonl'), [newer]);
    expect(readDispatchManifestEventsDetailed({ limit: 1, stopAfterLimit: true, maxRows: 1 })).toMatchObject({
      sourceState: 'healthy', complete: true, stopReasons: [], rowsScanned: 1,
    });
  });

  it('preserves the compatibility reader default cap with explicit partial quality', () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...makeEvent(`2026-07-11T10:${String(index % 60).padStart(2, '0')}:00.000Z`, `row-${index}`),
      manifestId: `dm-default-${index}`,
    }));
    writeRows(path.join(dispatchManifestDir(), '2026-07-11.jsonl'), rows);

    const events = readDispatchManifestEvents() as ReturnType<typeof readDispatchManifestEvents> & {
      sourceQuality: { sourceState: string; complete: boolean; stopReasons: string[] };
    };
    expect(events).toHaveLength(100);
    expect(events.sourceQuality).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['event-limit'],
    });
  });

  it('reads the latest observation from complete history without applying a display window', () => {
    const older = makeEvent('2020-01-01T09:00:00.000Z', 'old-history');
    const newer = makeEvent('2020-01-01T10:00:00.000Z', 'newer-history');
    writeRows(path.join(dispatchManifestDir(), '2020-01-01.jsonl'), [older, newer]);

    expect(readDispatchManifestLatestObservationDetailed()).toMatchObject({
      latestAt: '2020-01-01T10:00:00.000Z',
      sourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true },
    });
  });

  it('reports an empty readable manifest ledger as healthy without a latest observation', () => {
    fs.mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });

    expect(readDispatchManifestLatestObservationDetailed()).toEqual({
      sourceQuality: expect.objectContaining({ sourceState: 'healthy', sourcePresent: true, complete: true }),
    });
  });

  it('withholds the latest observation when bounded manifest history is degraded', () => {
    const event = makeEvent('2026-07-11T10:00:00.000Z', 'partial-history');
    writeRows(path.join(dispatchManifestDir(), '2026-07-11.jsonl'), [event, '{"torn":true']);

    expect(readDispatchManifestLatestObservationDetailed()).toEqual({
      sourceQuality: expect.objectContaining({ sourceState: 'degraded', sourcePresent: true, complete: false, invalidRows: 1 }),
    });
  });

  it('reports file, byte, and row physical caps while accepting an exact byte cap', () => {
    const old = makeEvent('2026-07-10T10:00:00.000Z', 'old');
    const recent = makeEvent('2026-07-11T10:00:00.000Z', 'recent');
    writeRows(path.join(dispatchManifestDir(), '2026-07-10.jsonl'), [old]);
    const recentFile = path.join(dispatchManifestDir(), '2026-07-11.jsonl');
    writeRows(recentFile, [recent]);

    expect(readDispatchManifestEventsDetailed({ maxFiles: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['file-limit'], filesRead: 1,
    });
    expect(readDispatchManifestEventsDetailed({ maxBytes: fs.statSync(recentFile).size - 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['byte-limit'], filesRead: 1,
    });

    fs.rmSync(path.join(dispatchManifestDir(), '2026-07-10.jsonl'));
    const exactBytes = fs.statSync(recentFile).size;
    expect(readDispatchManifestEventsDetailed({ maxBytes: exactBytes, maxRows: 1 })).toMatchObject({
      sourceState: 'healthy', complete: true, stopReasons: [], bytesRead: exactBytes, rowsScanned: 1,
    });

    writeRows(recentFile, [recent, { ...recent, manifestId: 'second' }]);
    expect(readDispatchManifestEventsDetailed({ maxRows: 1 })).toMatchObject({
      sourceState: 'degraded', complete: false, stopReasons: ['row-limit'], rowsScanned: 1,
    });
  });

  it.runIf(process.platform !== 'win32')('refuses symlinked, hard-linked, and public ledger files', () => {
    const event = makeEvent('2026-07-11T10:00:00.000Z', 'unsafe');
    const outside = path.join(tmpDir, 'outside.jsonl');
    writeRows(outside, [event]);
    fs.mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });
    const ledger = path.join(dispatchManifestDir(), '2026-07-11.jsonl');

    fs.symlinkSync(outside, ledger);
    expect(readDispatchManifestEventsDetailed()).toMatchObject({ sourceState: 'degraded', stopReasons: ['io-error'], unreadableFiles: 1 });
    expect(recordDispatchManifest(event)).toMatchObject({ recorded: false });
    fs.rmSync(ledger);

    fs.linkSync(outside, ledger);
    expect(readDispatchManifestEventsDetailed()).toMatchObject({ sourceState: 'degraded', stopReasons: ['io-error'], unreadableFiles: 1 });
    fs.rmSync(ledger);

    writeRows(ledger, [event]);
    fs.chmodSync(ledger, 0o666);
    expect(readDispatchManifestEventsDetailed()).toMatchObject({ sourceState: 'degraded', stopReasons: ['io-error'], unreadableFiles: 1 });
  });

  it.runIf(process.platform !== 'win32')('creates private storage and isolates a torn tail before appending', () => {
    const first = makeEvent('2026-07-11T09:00:00.000Z', 'before-torn');
    const second = makeEvent('2026-07-11T10:00:00.000Z', 'after-torn');
    const file = path.join(dispatchManifestDir(), '2026-07-11.jsonl');
    writeRows(file, [first]);
    fs.appendFileSync(file, '{"torn":true', 'utf8');

    expect(recordDispatchManifest(second)).toMatchObject({ recorded: true });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('{"torn":true\n{');
    expect(fs.statSync(dispatchManifestDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readDispatchManifestEventsDetailed()).toMatchObject({
      sourceState: 'degraded', complete: false, invalidRows: 1,
    });
    expect(readDispatchManifestEventsDetailed().events.map((event) => event.claimedItemIds[0])).toEqual(['after-torn', 'before-torn']);
  });

  it.runIf(process.platform !== 'win32')('migrates an owner-readable legacy ledger and rejects multi-event writes atomically', () => {
    const event = makeEvent('2026-07-11T10:00:00.000Z', 'legacy');
    const file = path.join(dispatchManifestDir(), '2026-07-11.jsonl');
    writeRows(file, [event]);
    fs.chmodSync(file, 0o644);

    expect(readDispatchManifestEventsDetailed()).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const before = fs.readFileSync(file, 'utf8');
    expect(recordDispatchManifest([event, { ...event, manifestId: 'second' }])).toMatchObject({ recorded: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it.runIf(process.platform !== 'win32')('rejects unsafe storage roots and full partitions', () => {
    const event = makeEvent('2026-07-11T10:00:00.000Z', 'bounded');
    fs.mkdirSync(process.env.ASHLR_HOME!, { recursive: true, mode: 0o700 });
    fs.chmodSync(process.env.ASHLR_HOME!, 0o777);
    expect(recordDispatchManifest(event)).toMatchObject({ recorded: false });

    fs.chmodSync(process.env.ASHLR_HOME!, 0o700);
    fs.mkdirSync(dispatchManifestDir(), { recursive: true, mode: 0o700 });
    const file = path.join(dispatchManifestDir(), '2026-07-11.jsonl');
    fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024), { mode: 0o600 });
    const before = fs.statSync(file).size;
    expect(recordDispatchManifest(event)).toMatchObject({ recorded: false });
    expect(fs.statSync(file).size).toBe(before);
  });

  it('falls back to the absolute default home when ASHLR_HOME is relative', () => {
    process.env.ASHLR_HOME = 'relative-home';
    expect(dispatchManifestDir()).toBe(path.join(os.homedir(), '.ashlr', 'dispatch-manifests'));
    expect(path.isAbsolute(dispatchManifestDir())).toBe(true);
  });
});

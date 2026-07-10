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
  recordDispatchManifest,
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
function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const id = `item-${++seq}`;
  return {
    id,
    title: `Task ${id}`,
    repo: '/tmp/repo',
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

describe('dispatch manifest ledger', () => {
  it('records a bounded, scrubbed concurrent dispatch plan', () => {
    const secret = 'sk-1234567890abcdef';
    const items = [
      makeItem({
        id: `item-${secret}`,
        title: `Investigate token=${secret}`,
        repo: `/tmp/repo?api_key=${secret}`,
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
});

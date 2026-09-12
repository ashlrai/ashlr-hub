/** Real private ownership records; graph projections are explicit inert test doubles. */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const graphRead = vi.hoisted(() => vi.fn());
vi.mock('../src/core/universe/control-graph.js', async original => ({
  ...await original<typeof import('../src/core/universe/control-graph.js')>(), readControlGraph: graphRead,
}));
import { readResourceConsoleEngineeringGraphCompletion as read,
  type ResourceConsoleEngineeringPreparedEnrollment } from '../src/core/resources/console-engineering.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { validateControlGraph, type ControlGraphReport } from '../src/core/universe/control-graph.js';

let root: string;
beforeEach(() => { vi.resetAllMocks(); root = realpathSync(mkdtempSync(join(tmpdir(), 'engineering-completion-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const enrollmentDigest = 'a'.repeat(64);
  const definition = validateControlGraph({ schemaVersion: 1, id: 'graph', hostEnrollmentDigest: enrollmentDigest,
    maxConcurrent: 1, maxDurationMs: 60_000, nodes: [{ id: 'inspect', kind: 'explore', requires: [], input: {} }] });
  const definitionDigest = digest(canonical(definition));
  // Only the inert identity fields are consumed; no handler/owner is instantiated.
  const prepared = { row: { id: 'objective', graphId: 'graph', graphRoot: root },
    summary: { id: 'objective', graphId: 'graph', enrollmentDigest }, definition, definitionDigest } as ResourceConsoleEngineeringPreparedEnrollment;
  const launchedAt = '2026-09-12T00:00:00.000Z';
  const launch = { schemaVersion: 1, kind: 'launch', enrollmentDigest, definitionDigest, at: launchedAt };
  const graph: ControlGraphReport = { schemaVersion: 1, sourceState: 'healthy', status: 'completed', graphId: 'graph', definitionDigest,
    deadlineAt: '2026-09-12T00:01:00.000Z', nodes: [{ id: 'inspect', kind: 'explore', state: 'completed', artifactDigest: 'b'.repeat(64) }],
    edges: [], traces: [], reasons: [] };
  const store = join(root, 'console-engineering'); const records = join(store, 'records');
  const save = (name: string, value: unknown) => writeFileSync(join(records, name), canonical(value) + '\n', { mode: 0o600 });
  const publish = () => { for (const directory of [store, records, join(store, 'staging')]) mkdirSync(directory, { mode: 0o700 }); save('launch.json', launch); };
  graphRead.mockImplementation(() => structuredClone(graph));
  return { prepared, graph, launch, publish, save, store, records };
}
function files(directory: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [name, content] of Object.entries(files(join(directory, entry.name)))) values[`${entry.name}/${name}`] = content;
    else values[entry.name] = readFileSync(join(directory, entry.name), 'utf8');
  }
  return values;
}
describe('host-only completed graph observation', () => {
  it('joins stable completed graph and matching launch without writing, renewal or execution', () => {
    const f = fixture(); f.publish(); const before = files(root);
    expect(read(f.prepared)).toEqual({ enrollmentId: 'objective', enrollmentDigest: f.launch.enrollmentDigest, graphId: 'graph',
      definitionDigest: f.launch.definitionDigest, graphDigest: digest(canonical(f.graph)), ownershipDigest: digest(canonical(f.launch)),
      launchedAt: f.launch.at, deadlineAt: f.graph.deadlineAt });
    expect(graphRead).toHaveBeenCalledTimes(2); expect(files(root)).toEqual(before);
  });
  it('refuses an absent launch even with a completed graph and creates nothing', () => {
    const f = fixture(); expect(read(f.prepared)).toBeNull(); expect(readdirSync(root)).toEqual([]);
  });
  it.each(['cancel', 'foreign-launch', 'cancel-before-launch', 'malformed', 'staging'])('refuses %s ownership evidence', kind => {
    const f = fixture(); f.publish();
    if (kind === 'cancel' || kind === 'cancel-before-launch') f.save('cancel.json', { ...f.launch, kind: 'cancel',
      at: kind === 'cancel' ? f.launch.at : '2026-09-11T00:00:00.000Z' });
    else if (kind === 'foreign-launch') f.save('launch.json', { ...f.launch, enrollmentDigest: 'c'.repeat(64) });
    else if (kind === 'malformed') f.save('launch.json', { ...f.launch, extra: true });
    else writeFileSync(join(f.store, 'staging', 'incomplete'), 'held', { mode: 0o600 });
    const before = files(root); expect(read(f.prepared)).toBeNull(); expect(files(root)).toEqual(before);
  });
  it.each(['missing', 'degraded', 'incomplete', 'foreign-definition', 'foreign-graph', 'pending-node', 'missing-node'])('refuses %s graph', kind => {
    const f = fixture(); f.publish();
    if (kind === 'missing' || kind === 'degraded') f.graph.sourceState = kind;
    else if (kind === 'incomplete') f.graph.status = 'incomplete';
    else if (kind === 'foreign-definition') f.graph.definitionDigest = 'c'.repeat(64);
    else if (kind === 'foreign-graph') f.graph.graphId = 'other';
    else if (kind === 'pending-node') f.graph.nodes[0]!.state = 'pending';
    else f.graph.nodes = [];
    expect(read(f.prepared)).toBeNull();
  });
  it('refuses a graph changing between reads', () => {
    const f = fixture(); f.publish();
    graphRead.mockReturnValueOnce(f.graph).mockReturnValueOnce({ ...f.graph, deadlineAt: '2026-09-12T00:02:00.000Z' });
    expect(read(f.prepared)).toBeNull(); expect(graphRead).toHaveBeenCalledTimes(2);
  });
  it('refuses cancellation published between graph and ownership reads', () => {
    const f = fixture(); f.publish();
    graphRead.mockImplementationOnce(() => { f.save('cancel.json', { ...f.launch, kind: 'cancel' }); return structuredClone(f.graph); });
    expect(read(f.prepared)).toBeNull(); expect(readdirSync(f.records).sort()).toEqual(['cancel.json', 'launch.json']);
  });
  it('refuses unsafe ownership links without following or replacing them', () => {
    const f = fixture(); const absent = join(root, 'absent'); symlinkSync(absent, f.store);
    expect(read(f.prepared)).toBeNull(); expect(readdirSync(root)).toEqual(['console-engineering']);
  });
  it('rejects prepared identity drift and accessors without invoking them or reading graphs', () => {
    const f = fixture(); f.publish(); const getter = vi.fn(() => f.prepared.row);
    expect(read({ ...f.prepared, definitionDigest: 'c'.repeat(64) })).toBeNull();
    expect(read(Object.defineProperty({ ...f.prepared }, 'row', { get: getter }))).toBeNull();
    expect(read({ ...f.prepared, summary: { ...f.prepared.summary, enrollmentDigest: 'c'.repeat(64) } })).toBeNull();
    expect(getter).not.toHaveBeenCalled(); expect(graphRead).not.toHaveBeenCalled();
  });
});

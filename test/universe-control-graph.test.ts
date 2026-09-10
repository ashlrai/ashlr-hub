import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readControlGraph, runControlGraph, validateControlGraph, type ControlGraphDefinition, type ControlGraphHandler } from '../src/core/universe/control-graph.js';
import { verifyDecisionTraceV1 } from '../src/core/universe/decision-trace.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';

let root: string;
const traceKeys = { testKey: randomBytes(32) };
const pass = { id: 'cold-worker', verdict: 'pass' as const, independent: true };
function graph(): ControlGraphDefinition {
  return { schemaVersion: 1, id: 'fixture', maxConcurrent: 2, maxDurationMs: 5000, nodes: [
    { id: 'plan', kind: 'plan', requires: [], input: { alternatives: 2 } },
    { id: 'build', kind: 'implement', requires: ['plan'], input: {} },
    { id: 'check', kind: 'verify', requires: ['build'], input: {} },
  ] };
}
const emit: ControlGraphHandler = async ({ node }) => ({ artifact: { node: node.id }, verifier: pass });
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-graph-test-'))); chmodSync(root, 0o700); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('artifact-bearing durable control graph', () => {
  it('runs a signed plan/build/check path and does not replay completed nodes', async () => {
    const handler = vi.fn(emit);
    const options = { root, traceKeys, handlers: { plan: handler, implement: handler, verify: handler } };
    const first = await runControlGraph(graph(), options);
    expect(first.status).toBe('completed');
    expect(first.edges.map(({ from, to }) => [from, to])).toEqual([['plan', 'build'], ['build', 'check']]);
    expect(first.edges.every((edge) => /^[a-f0-9]{64}$/.test(edge.artifactDigest))).toBe(true);
    expect(first.traces).toHaveLength(7);
    expect(first.traces.every((trace) => verifyDecisionTraceV1(trace, traceKeys))).toBe(true);
    const second = await runControlGraph(graph(), options);
    expect(second).toEqual(first);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[1]![0].artifacts[0]!.nodeId).toBe('plan');
  });

  it.each(['fail', 'unavailable'] as const)('rejects %s verifier and withholds descendants', async (verdict) => {
    const definition = graph();
    definition.nodes.push({ id: 'after', kind: 'talk', requires: ['check'], input: {} });
    const after = vi.fn(emit);
    const report = await runControlGraph(definition, { root, traceKeys, handlers: { plan: emit, implement: emit,
      verify: async () => ({ artifact: 'builder claimed success', verifier: { ...pass, verdict } }), talk: after } });
    expect(report.nodes.map((row) => row.state)).toEqual(['completed', 'completed', 'rejected', 'pending']);
    expect(after).not.toHaveBeenCalled();
    expect(report.edges).toHaveLength(2);
  });

  it('requires independent verdict rather than builder self-report', async () => {
    const result = await runControlGraph(graph(), { root, traceKeys, handlers: { plan: emit, implement: emit,
      verify: async () => ({ artifact: 'pass', verifier: { ...pass, independent: false } }) } });
    expect(result.nodes[2]!.state).toBe('rejected');
  });

  it('preserves a failed dispatch intent without replay and continues independent work', async () => {
    const definition = graph();
    definition.nodes.push({ id: 'independent', kind: 'explore', requires: [], input: {} });
    const broken = vi.fn(async () => { throw new Error('sensitive worker failure'); });
    const options = { root, traceKeys, handlers: { plan: broken, explore: emit } };
    const first = await runControlGraph(definition, options);
    expect(first.nodes.map((row) => row.state)).toEqual(['unresolved', 'pending', 'pending', 'completed']);
    expect(JSON.stringify(first)).not.toContain('sensitive');
    await runControlGraph(definition, options);
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it('withholds effectful kinds even if a handler is supplied', async () => {
    const definition = graph();
    definition.nodes = ['integrate', 'deliver', 'mutate-harness', 'sweep'].map((kind) => ({ id: kind, kind: kind as 'integrate', requires: [], input: {} }));
    const handler = vi.fn(emit);
    const report = await runControlGraph(definition, { root, traceKeys, handlers: { integrate: handler, deliver: handler, 'mutate-harness': handler, sweep: handler } });
    expect(handler).not.toHaveBeenCalled();
    expect(report.edges).toEqual([]);
    expect(report.nodes.every((row) => row.state === 'pending')).toBe(true);
  });

  it('stops before enrollment when killed', async () => {
    writeFileSync(join(root, 'KILL'), 'stop', { mode: 0o600 });
    const handler = vi.fn(emit);
    const report = await runControlGraph(graph(), { root, traceKeys, handlers: { plan: handler } });
    expect(report.status).toBe('stopped'); expect(report.traces).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('drains a cancelled active handler but never dispatches its dependent', async () => {
    const controller = new AbortController();
    const child = vi.fn(emit);
    const report = await runControlGraph(graph(), { root, traceKeys, signal: controller.signal, handlers: {
      plan: async () => { controller.abort(); return { artifact: 'settled during cancellation' }; }, implement: child } });
    expect(report.status).toBe('stopped'); expect(child).not.toHaveBeenCalled();
    expect(report.nodes[0]!.state).toBe('completed');
  });

  it('stops on a kill file while active and drains the handler', async () => {
    const after = vi.fn(emit);
    const report = await runControlGraph(graph(), { root, traceKeys, handlers: { plan: async ({ signal }) => {
      writeFileSync(join(root, 'KILL'), 'stop', { mode: 0o600 });
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { artifact: 'drained' };
    }, implement: after } });
    expect(report.status).toBe('stopped'); expect(after).not.toHaveBeenCalled();
  });

  it('does not renew persisted deadline across reinvocation', async () => {
    const definition = graph(); definition.maxDurationMs = 1000;
    const first = await runControlGraph(definition, { root, traceKeys, handlers: {} });
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(first.deadlineAt!) + 1);
    const handler = vi.fn(emit);
    const second = await runControlGraph(definition, { root, traceKeys, handlers: { plan: handler } });
    expect(second.status).toBe('stopped'); expect(second.deadlineAt).toBe(first.deadlineAt);
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses conflicting owner without dispatch', async () => {
    const owner = acquireLocalStoreLockWithOutcome(join(root, '.control-execution.lock'), 0, { anchorPath: root, exactPrivateStorage: true });
    expect(owner.state).toBe('acquired');
    try {
      const report = await runControlGraph(graph(), { root, traceKeys, handlers: { plan: emit } });
      expect(report.reasons).toEqual(['graph-owner-unavailable']);
    } finally { if (owner.state === 'acquired') releaseLocalStoreLock(owner.lock); }
  });

  it('refuses graph drift and forged disk evidence', async () => {
    await runControlGraph(graph(), { root, traceKeys, handlers: { plan: emit } });
    const changed = graph(); changed.maxConcurrent = 1;
    expect((await runControlGraph(changed, { root, traceKeys, handlers: {} })).status).toBe('unavailable');
    const directory = join(root, 'control-graph', 'records');
    const file = join(directory, readdirSync(directory)[0]!);
    const value = JSON.parse(readFileSync(file, 'utf8'));
    value.trace.provenanceSig = 'f'.repeat(64); writeFileSync(file, JSON.stringify(value));
    expect(readControlGraph(root, traceKeys).sourceState).toBe('degraded');
  });

  it('accepts graph and node with identical IDs using namespaced entities', async () => {
    const definition = graph(); definition.id = 'plan';
    const result = await runControlGraph(definition, { root, traceKeys, handlers: { plan: emit, implement: emit, verify: emit } });
    expect(result.status).toBe('completed');
  });

  it('enrolls definitions larger than 128KiB and delivers large fan-in artifacts', async () => {
    const definition = graph();
    definition.maxDurationMs = 60_000;
    definition.nodes = Array.from({ length: 18 }, (_, i) => ({ id: `source${i}`, kind: 'plan', requires: [], input: i < 5 ? 'a'.repeat(30_000) : '' }));
    definition.nodes.push({ id: 'fan', kind: 'implement', requires: definition.nodes.map((row) => row.id), input: {} });
    const fan = vi.fn(emit);
    const result = await runControlGraph(definition, { root, traceKeys, handlers: { plan: async () => ({ artifact: 'a'.repeat(60_000) }), implement: fan } });
    expect(result.status).toBe('completed');
    expect(fan.mock.calls[0]![0].artifacts).toHaveLength(18);
  });

  it('reserves structural envelope depth before creating an intent', () => {
    const definition = graph();
    let nested: unknown = null;
    for (let i = 0; i < 29; i++) nested = { value: nested };
    definition.nodes[0]!.input = nested;
    expect(() => validateControlGraph(definition)).toThrow();
    expect(readdirSync(root)).toEqual([]);
  });

  it('respects the concurrent handler ceiling', async () => {
    const definition = graph(); definition.nodes = Array.from({ length: 6 }, (_, i) => ({ id: `node${i}`, kind: 'plan', requires: [], input: {} }));
    let active = 0; let peak = 0;
    const result = await runControlGraph(definition, { root, traceKeys, handlers: { plan: async () => {
      active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--;
      return { artifact: 'done' };
    } } });
    expect(result.status).toBe('completed'); expect(peak).toBe(2);
  });

  it.each(['cycle', 'unknown', 'duplicates', 'extra', 'fraction'])('rejects invalid graph %s', (mode) => {
    const definition = graph();
    if (mode === 'cycle') definition.nodes[0]!.requires = ['check'];
    if (mode === 'unknown') definition.nodes[0]!.requires = ['absent'];
    if (mode === 'duplicates') definition.nodes.push(definition.nodes[0]!);
    if (mode === 'extra') Object.assign(definition, { command: 'never execute this' });
    if (mode === 'fraction') definition.maxConcurrent = 1.5;
    expect(() => validateControlGraph(definition)).toThrow();
  });
});

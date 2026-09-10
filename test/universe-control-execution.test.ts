import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as privateRecords from '../src/core/util/immutable-private-record-store.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { signDecisionTraceV1, verifyDecisionTraceV1 } from '../src/core/universe/decision-trace.js';
import { readControlGraph, runControlGraph, type ControlGraphDefinition, type ControlHandlerResult,
  type ControlGraphHandler, type ControlGraphHandlerRegistration } from '../src/core/universe/control-graph.js';

let root: string;
const traceKeys = { testKey: Buffer.alloc(32, 19) };
const metadata = { effectClass: 'resource-completion' as const, constitutionVersion: 'fixture-policy', policyEpoch: 2, bindingDigest: 'a'.repeat(64) };
const graph: ControlGraphDefinition = { schemaVersion: 1, id: 'resource-graph', maxConcurrent: 1, maxDurationMs: 60_000,
  nodes: [{ id: 'generate', kind: 'explore', requires: [], input: {} }, { id: 'consume', kind: 'plan', requires: ['generate'], input: {} }] };
beforeEach(() => { root = realpathSync(mkdtempSync(join(homedir(), 'control-execution-'))); });
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
function descriptor(run: ControlGraphHandler = async () => ({ artifact: { content: 'fixture' }, outcome: 'completed' })) {
  return { ...metadata, run };
}
function run(handler: ControlGraphHandlerRegistration, consume = vi.fn(async () => ({ artifact: 'used' }))) {
  return runControlGraph(graph, { root, traceKeys, handlers: { explore: handler, plan: consume } });
}

describe('trusted graph execution declarations', () => {
  it('signs resource intent and settlement with bound policy and measured partial spend', async () => {
    const result = await run(descriptor(async () => ({ artifact: 'response', outcome: 'completed', spend: { tokens: 17, unknown: true } })));
    expect(result.status).toBe('completed');
    const rows = result.traces.filter((trace) => trace.entities.includes('node:generate'));
    expect(rows).toHaveLength(2);
    for (const trace of rows) {
      expect(verifyDecisionTraceV1(trace, traceKeys)).toBe(true);
      expect(trace).toMatchObject({ constitutionVersion: metadata.constitutionVersion, policyEpoch: 2,
        authority: { effectClass: 'resource-completion' } });
    }
    expect(rows[0]!.spend).toEqual({ unknown: true });
    expect(rows[1]!.spend).toEqual({ tokens: 17, unknown: true });
    expect(result.edges).toHaveLength(1);
  });

  it('a rejected outcome overrides a passing verifier and withholds descendants', async () => {
    const consume = vi.fn(async () => ({ artifact: 'must-not-run' }));
    const result = await run(descriptor(async () => ({ artifact: 'withheld', outcome: 'rejected',
      verifier: { id: 'fixture', verdict: 'pass', independent: true } })), consume);
    expect(result.nodes.map((node) => node.state)).toEqual(['rejected', 'pending']);
    expect(consume).not.toHaveBeenCalled(); expect(result.edges).toEqual([]);
  });

  it.each([undefined, 'success', null])('keeps missing/invalid outcome %j unresolved and never retries', async (outcome) => {
    const callback = vi.fn(async () => ({ artifact: 'not-established', ...(outcome === undefined ? {} : { outcome }) } as ControlHandlerResult));
    const handler = descriptor(callback);
    expect((await run(handler)).nodes[0]!.state).toBe('unresolved');
    expect((await run(handler)).nodes[0]!.state).toBe('unresolved'); expect(callback).toHaveBeenCalledOnce();
  });

  it('captures metadata and callback before the asynchronous admission yield', async () => {
    const original = vi.fn(async (): Promise<ControlHandlerResult> => ({ artifact: 'original', outcome: 'completed' }));
    const changed = vi.fn(async (): Promise<ControlHandlerResult> => ({ artifact: 'changed', outcome: 'completed' }));
    const handler = descriptor(original); const pending = run(handler);
    handler.run = changed; handler.policyEpoch = 99; handler.bindingDigest = 'b'.repeat(64);
    const result = await pending;
    expect(original).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
    expect(result.traces.filter((trace) => trace.entities.includes('node:generate')).every((trace) => trace.policyEpoch === 2)).toBe(true);
  });

  it.each(['caller', 'kill'])('settles a late completion as rejected after %s stop', async (kind) => {
    const controller = new AbortController();
    const handler = descriptor(async () => {
      if (kind === 'caller') controller.abort(); else writeFileSync(join(root, 'KILL'), 'fixture', { mode: 0o600 });
      return { artifact: 'late response', outcome: 'completed', spend: { tokens: 4, unknown: true } };
    });
    const result = await runControlGraph(graph, { root, traceKeys, signal: controller.signal, handlers: { explore: handler } });
    expect(result.status).toBe('stopped'); expect(readControlGraph(root, traceKeys).nodes[0]!.state).toBe('rejected');
    expect(result.traces.at(-1)!.spend).toEqual({ tokens: 4, unknown: true });
  });

  it('does not invoke a queued worker after an internal admission failure aborts the graph', async () => {
    const write = privateRecords.writeImmutablePrivateRecord;
    vi.spyOn(privateRecords, 'writeImmutablePrivateRecord').mockImplementation((config, record, options) => {
      if ((record as { nodeId?: string }).nodeId === 'fail-admission') throw new Error('fixture admission failure');
      return write(config, record, options);
    });
    const callback = vi.fn(async (): Promise<ControlHandlerResult> => ({ artifact: 'must-not-run', outcome: 'completed' }));
    const result = await runControlGraph({ ...graph, maxConcurrent: 2, nodes: [graph.nodes[0]!,
      { id: 'fail-admission', kind: 'explore', requires: [], input: {} }] }, { root, traceKeys, handlers: { explore: descriptor(callback) } });
    expect(result.status).toBe('unavailable');
    expect(result.nodes.map((node) => node.state)).toEqual(['unresolved', 'pending']);
    expect(callback).not.toHaveBeenCalled();
  });

  it('retains a late response as rejected when an internal failure aborts an active worker', async () => {
    const write = privateRecords.writeImmutablePrivateRecord;
    vi.spyOn(privateRecords, 'writeImmutablePrivateRecord').mockImplementation((config, record, options) => {
      if ((record as { nodeId?: string }).nodeId === 'fail-admission') throw new Error('fixture admission failure');
      return write(config, record, options);
    });
    const result = await runControlGraph({ ...graph, maxConcurrent: 2, nodes: [graph.nodes[0]!,
      { id: 'quick', kind: 'plan', requires: [], input: {} },
      { id: 'fail-admission', kind: 'plan', requires: [], input: {} }] }, { root, traceKeys, handlers: {
      explore: descriptor(async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { artifact: 'late response', outcome: 'completed', spend: { tokens: 5, unknown: true } };
      }),
      plan: async () => ({ artifact: 'quick' }),
    } });
    expect(result.status).toBe('unavailable');
    expect(result.nodes.map((node) => node.state)).toEqual(['rejected', 'completed', 'pending']);
    expect(result.traces.at(-1)!.spend).toEqual({ tokens: 5, unknown: true });
  });

  it.each(['binding', 'policy', 'effect'])('refuses signed-but-inconsistent %s settlement metadata', async (field) => {
    await run(descriptor());
    const paths = readdirSync(join(root, 'control-graph', 'records')).sort().map((name) => join(root, 'control-graph', 'records', name));
    const rows = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
    if (field === 'binding') rows[2].data.execution.bindingDigest = 'b'.repeat(64);
    if (field === 'policy') rows[2].trace.policyEpoch = 3;
    if (field === 'effect') rows[2].trace.authority.effectClass = 'simulate';
    // Re-sign the whole suffix so rejection proves semantic continuity, not
    // merely a broken HMAC or previous-record link.
    for (let index = 2; index < rows.length; index++) {
      rows[index].previousDigest = digest(canonical(rows[index - 1]));
      const { trace, ...body } = rows[index]; const { provenanceSig: _signature, ...unsigned } = trace;
      rows[index].trace = signDecisionTraceV1({ ...unsigned, inputsDigest: digest(canonical(body)) }, traceKeys);
      expect(verifyDecisionTraceV1(rows[index].trace, traceKeys)).toBe(true);
      writeFileSync(paths[index]!, `${canonical(rows[index])}\n`, { mode: 0o600 });
    }
    expect(readControlGraph(root, traceKeys)).toMatchObject({ sourceState: 'degraded', traces: [], nodes: [] });
  });

  it.each(['integrate', 'deliver', 'sweep', 'mutate-harness'] as const)('does not turn a descriptor into %s authority', async (kind) => {
    const callback = vi.fn(async (): Promise<ControlHandlerResult> => ({ artifact: 'forbidden', outcome: 'completed' }));
    const result = await runControlGraph({ ...graph, nodes: [{ ...graph.nodes[0]!, kind }] },
      { root, traceKeys, handlers: { [kind]: descriptor(callback) } });
    expect(result.nodes[0]!.state).toBe('pending'); expect(callback).not.toHaveBeenCalled();
  });

  it('refuses malformed registration before graph evidence is created', async () => {
    await expect(run({ ...descriptor(), bindingDigest: 'invalid' })).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
  });
});

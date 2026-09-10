/** Kernel authority only: signed private graph records, inert registry-injected callbacks; no provider/evaluator proof. */
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as engineering from '../src/core/universe/firm-engineering-control-handler.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import * as immutable from '../src/core/util/immutable-private-record-store.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { readControlGraph, readGraphContinuationAuthority, runControlGraph,
  type ControlGraphDefinition, type ControlHandlerContext, type ControlHandlerResult } from '../src/core/universe/control-graph.js';

const roots: string[] = [];
const HASH = 'a'.repeat(64);
const completed = (): ControlHandlerResult => ({ artifact: { fixture: 'inert-completion' }, outcome: 'completed',
  verifier: { id: 'kernel-fixture-only', verdict: 'pass', independent: true } });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-continuation-'))); roots.push(root);
  const definition: ControlGraphDefinition = { schemaVersion: 1, id: 'continuation-fixture', maxConcurrent: 1, maxDurationMs: 60_000,
    nodes: [{ id: 'deliver', kind: 'deliver', requires: [], input: { bindingDigest: HASH, requestDigest: HASH } }] };
  const run = vi.fn(async (context: ControlHandlerContext): Promise<ControlHandlerResult> => {
    expect(readGraphContinuationAuthority(context, HASH)).toBeNull(); throw new Error('inert unsettled invocation');
  });
  const recover = vi.fn((context: ControlHandlerContext): ControlHandlerResult | null => {
    expect(readGraphContinuationAuthority(context, HASH)).toBeNull(); return null;
  });
  const continuation = vi.fn(async (_context: ControlHandlerContext): Promise<ControlHandlerResult | null> => null);
  const handler = { effectClass: 'engineering-portfolio-local-delivery' as const, constitutionVersion: 'fixture', policyEpoch: 1, bindingDigest: HASH, run };
  let enabled = true;
  vi.spyOn(engineering, 'isFirmEngineeringControlHandler').mockImplementation(value => value === handler);
  vi.spyOn(engineering, 'firmEngineeringControlRecovery').mockImplementation(value => value === handler ? recover : undefined);
  vi.spyOn(engineering, 'firmEngineeringControlContinuation').mockImplementation(value => value === handler && enabled ? continuation : undefined);
  const controller = new AbortController(); let stopped = false;
  const options = { root, handlers: { deliver: handler }, traceKeys: { testKey: Buffer.alloc(32, 91) },
    signal: controller.signal, isExecutionStopped: () => stopped };
  const first = await runControlGraph(definition, options);
  expect(first.nodes[0]?.state).toBe('unresolved'); expect(continuation).not.toHaveBeenCalled();
  const records = () => readdirSync(join(root, 'control-graph', 'records')).sort().map(name => readFileSync(join(root, 'control-graph', 'records', name), 'utf8'));
  return { root, definition, handler, run, recover, continuation, options, controller, first, records,
    stop: () => { stopped = true; }, disable: () => { enabled = false; } };
}

describe('private graph continuation authority', () => {
  it('exists only for the exact active callback context and binding, then revokes both lookup and captured guards', async () => {
    const f = await fixture(); const before = f.records();
    let captured: ReturnType<typeof readGraphContinuationAuthority> = null; let context: ControlHandlerContext | undefined;
    f.continuation.mockImplementation(async current => {
      context = current; const authority = readGraphContinuationAuthority(current, HASH); captured = authority;
      expect(authority).not.toBeNull(); expect(authority!.isExecutionStopped()).toBe(false);
      expect(Object.isFrozen(authority)).toBe(true); expect(Object.isFrozen(authority!.graphDispatch)).toBe(true);
      expect(authority!.graphDispatch).toEqual({ schemaVersion: 1, graphRootDigest: digest(canonical(f.root)),
        graphId: f.definition.id, definitionDigest: digest(canonical(f.definition)), nodeId: 'deliver',
        intentDigest: digest(canonical(JSON.parse(before[1]!))) });
      expect(authority!.signal).toBe(current.signal); expect(authority!.deadlineMonotonicMs).toBe(current.deadlineMonotonicMs);
      for (const copied of [{ ...current }, {}, null, undefined, 'context']) expect(readGraphContinuationAuthority(copied, HASH)).toBeNull();
      expect(readGraphContinuationAuthority(current, 'b'.repeat(64))).toBeNull();
      await Promise.resolve(); expect(authority!.isExecutionStopped()).toBe(false); return null;
    });
    await runControlGraph(f.definition, f.options);
    expect(readGraphContinuationAuthority(context, HASH)).toBeNull();
    expect((captured as ReturnType<typeof readGraphContinuationAuthority>)!.isExecutionStopped()).toBe(true);
    expect(f.records()).toEqual(before); expect(f.run).toHaveBeenCalledOnce(); expect(f.continuation).toHaveBeenCalledOnce();
  });

  it.each(['null', 'throw'] as const)('tries continuation once per invocation after %s without creating another intent', async mode => {
    const f = await fixture(); const before = f.records(); const guards: Array<() => boolean> = [];
    f.continuation.mockImplementation(async context => {
      guards.push(readGraphContinuationAuthority(context, HASH)!.isExecutionStopped);
      if (mode === 'throw') throw new Error('inert continuation failure'); return null;
    });
    for (let i = 1; i <= 2; i++) {
      expect((await runControlGraph(f.definition, f.options)).nodes[0]?.state).toBe('unresolved');
      expect(f.continuation).toHaveBeenCalledTimes(i); expect(guards.every(guard => guard())).toBe(true);
      expect(f.records()).toEqual(before);
    }
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('uses receipt-only success without invoking continuation', async () => {
    const f = await fixture(); f.recover.mockReturnValue(completed());
    expect((await runControlGraph(f.definition, f.options)).nodes[0]?.state).toBe('completed');
    expect(f.continuation).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledOnce();
  });

  it.each(['default', 'copy', 'binding'] as const)('does not mint authority for %s registration', async kind => {
    const f = await fixture(); const before = f.records();
    if (kind === 'default') f.disable();
    const selected = kind === 'copy' ? { ...f.handler } : f.handler;
    if (kind === 'binding') f.handler.bindingDigest = 'b'.repeat(64);
    expect((await runControlGraph(f.definition, { ...f.options, handlers: { deliver: selected } })).nodes[0]?.state).toBe('unresolved');
    expect(f.continuation).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledOnce(); expect(f.records()).toEqual(before);
  });

  it.each(['kill', 'caller', 'parent', 'expiry', 'ownership'] as const)('revokes the active effect guard and withholds completion after %s', async kind => {
    const f = await fixture(); const before = f.records(); let stopped = false;
    const owns = locks.ownsLocalStoreLock;
    if (kind === 'ownership') vi.spyOn(locks, 'ownsLocalStoreLock').mockImplementation(lock =>
      lock?.path === join(f.root, '.control-execution.lock') && stopped ? false : owns(lock));
    f.continuation.mockImplementation(async context => {
      const authority = readGraphContinuationAuthority(context, HASH)!; expect(authority.isExecutionStopped()).toBe(false);
      if (kind === 'kill') writeFileSync(join(f.root, 'KILL'), 'fixture stop\n', { mode: 0o600 });
      else if (kind === 'caller') f.controller.abort();
      else if (kind === 'parent') f.stop();
      else if (kind === 'expiry') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(f.first.deadlineAt!) + 1); }
      else stopped = true;
      expect(authority.isExecutionStopped()).toBe(true);
      return completed(); // A late completion cannot restore lost authority.
    });
    const result = await runControlGraph(f.definition, f.options);
    expect(result.nodes[0]?.state).toBe('unresolved'); expect(result.status).toBe('stopped'); expect(f.records()).toEqual(before);
  });

  it('rechecks stop after receipt collection before invoking an effectful callback', async () => {
    const f = await fixture(); const before = f.records();
    f.recover.mockImplementation(() => { f.stop(); return null; });
    expect((await runControlGraph(f.definition, f.options)).status).toBe('stopped');
    expect(f.continuation).not.toHaveBeenCalled(); expect(f.records()).toEqual(before);
  });

  it('vetoes settlement at the real immutable publication boundary after a successful callback', async () => {
    const f = await fixture(); const before = f.records(); f.continuation.mockResolvedValue(completed());
    const write = immutable.writeImmutablePrivateRecord; let vetoes = 0;
    vi.spyOn(immutable, 'writeImmutablePrivateRecord').mockImplementation((config, record, options) => {
      if ((record as { kind?: string }).kind !== 'settled') return write(config, record, options);
      return write(config, record, { ...options, prepublish: () => {
        if (readdirSync(join(f.root, 'control-graph', 'staging')).length > 0) { vetoes++; f.stop(); }
        return options!.prepublish!();
      } });
    });
    expect((await runControlGraph(f.definition, f.options)).nodes[0]?.state).toBe('unresolved');
    expect(vetoes).toBeGreaterThan(0); expect(f.records()).toEqual(before);
  });

  it('never continues completed or rejected terminal nodes', async () => {
    const f = await fixture(); f.continuation.mockResolvedValue(completed());
    expect((await runControlGraph(f.definition, f.options)).nodes[0]?.state).toBe('completed');
    const before = f.records(); await runControlGraph(f.definition, f.options); expect(f.records()).toEqual(before);
    expect(f.continuation).toHaveBeenCalledOnce();
    // A separate real graph records an ordinary handler rejection, not a forged receipt.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'control-terminal-'))); roots.push(root);
    f.run.mockResolvedValue({ ...completed(), outcome: 'rejected' });
    const options = { ...f.options, root };
    expect((await runControlGraph(f.definition, options)).nodes[0]?.state).toBe('rejected');
    await runControlGraph(f.definition, options); expect(f.continuation).toHaveBeenCalledOnce();
    expect(readControlGraph(root, options.traceKeys).nodes[0]?.state).toBe('rejected');
  });
});

/** Protocol/lifetime tests; Worker is a double, no proof or provider executes. */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ workers: [] as Array<{ emit(name: string, value?: unknown): boolean; terminate: ReturnType<typeof vi.fn> }>,
  termination: undefined as (() => Promise<number>) | undefined }));
vi.mock('node:worker_threads', async original => ({
  ...await original<typeof import('node:worker_threads')>(),
  Worker: class extends EventEmitter {
    terminate = vi.fn(() => state.termination?.() ?? Promise.resolve(1));
    constructor() { super(); state.workers.push(this); }
  },
}));
import { readEngineeringMissionProof } from '../src/core/resources/engineering-mission-proof.js';
import { createWorkerWorkspaceProofContext, matchesWorkspaceProofState, type ResourceWorkspaceProofSample } from '../src/core/resources/workspace-proof-context.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import type { ResourceEngineeringAutonomousSetupOptions } from '../src/core/resources/engineering-autonomous-setup-types.js';
const request = { kind: 'setup' as const, input: {} as ResourceEngineeringAutonomousSetupOptions };
const lifetime = () => ({ deadlineAt: new Date(Date.now() + 60_000).toISOString() });
const result = { schemaVersion: 1, status: 'planned', scope: 'local-autonomous-setup-only', planDigest: 'a'.repeat(64),
  executionStarted: false, providerContacted: false };
beforeEach(() => { state.workers.length = 0; state.termination = undefined; });
afterEach(() => vi.restoreAllMocks());

describe('mission read-only proof lifecycle', () => {
  it('waits for confirmed worker termination before returning evidence', async () => {
    let exit!: (code: number) => void;
    state.termination = () => new Promise(resolve => { exit = resolve; });
    let settled = false;
    const run = readEngineeringMissionProof(request, { lifetime: lifetime() }).then(value => { settled = true; return value; });
    const worker = state.workers[0]!;
    worker.emit('message', { type: 'mission-proof-result', ok: true, value: result });
    await Promise.resolve(); expect(settled).toBe(false); expect(worker.terminate).toHaveBeenCalledOnce();
    exit(1); expect(await run).toEqual(result);
  });
  it.each(['abort', 'deadline', 'veto'])('terminates an outstanding read on %s and ignores late success', async mode => {
    const controller = new AbortController(); let stop = false;
    const run = readEngineeringMissionProof(request, { lifetime: { ...lifetime(), signal: controller.signal,
      ...(mode === 'deadline' ? { deadlineAt: new Date(Date.now() + 30).toISOString() } : {}), isExecutionStopped: () => stop } });
    const rejection = expect(run).rejects.toThrow('Mission proof');
    if (mode === 'abort') controller.abort(); if (mode === 'veto') stop = true;
    await rejection;
    expect(state.workers[0]!.terminate).toHaveBeenCalledOnce();
    state.workers[0]!.emit('message', { type: 'mission-proof-result', ok: true, value: result });
    expect(state.workers).toHaveLength(1);
  });
  it('rechecks stop after the result but before terminal cleanup completes', async () => {
    let exit!: (code: number) => void; let stop = false;
    state.termination = () => new Promise(resolve => { exit = resolve; });
    const run = readEngineeringMissionProof(request, { lifetime: { ...lifetime(), isExecutionStopped: () => stop } });
    const rejection = expect(run).rejects.toThrow('Mission proof');
    state.workers[0]!.emit('message', { type: 'mission-proof-result', ok: true, value: result });
    stop = true; exit(1); await rejection;
  });
  it.each(['failure', 'malformed', 'exit', 'error', 'termination'])('withholds %s without restarting the worker', async mode => {
    if (mode === 'termination') state.termination = () => Promise.reject(Error('private termination detail'));
    const run = readEngineeringMissionProof(request, { lifetime: lifetime() });
    const rejection = expect(run).rejects.toThrow('Mission proof');
    const worker = state.workers[0]!;
    if (mode === 'exit') worker.emit('exit', 1);
    else if (mode === 'error') worker.emit('error', Error('private worker detail'));
    else worker.emit('message', mode === 'failure' ? { type: 'mission-proof-result', ok: false } :
      mode === 'malformed' ? { type: 'unexpected', ok: true, value: result } : { type: 'mission-proof-result', ok: true, value: result });
    await rejection; expect(worker.terminate).toHaveBeenCalledOnce(); expect(state.workers).toHaveLength(1);
  });
  it('requires the original deadline and non-executable host fields before spawning', async () => {
    await expect(readEngineeringMissionProof(request, { lifetime: {} })).rejects.toThrow();
    const getter = vi.fn(() => undefined);
    await expect(readEngineeringMissionProof(request, { lifetime: lifetime(), get custody() { return getter(); } })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(state.workers).toHaveLength(0);
  });
  it.each(['proof-refused', 'workspace-state-changed', 'rpc-invalid-data', 'rpc-unavailable'])(
    'retains the fixed diagnostic %s without accepting arbitrary worker text', async reason => {
      const run = readEngineeringMissionProof(request, { lifetime: lifetime() });
      const rejection = expect(run).rejects.toThrow(`Mission proof ${reason}`);
      state.workers[0]!.emit('message', { type: 'mission-proof-result', ok: false, reason }); await rejection;
    });
  it('does not expose an unrecognized diagnostic string', async () => {
    const run = readEngineeringMissionProof(request, { lifetime: lifetime() });
    const rejection = expect(run).rejects.toThrow('Mission proof unavailable or stopped');
    state.workers[0]!.emit('message', { type: 'mission-proof-result', ok: false, reason: 'PRIVATE_CREDENTIAL_DETAIL' }); await rejection;
  });
  it('limits worker failure locations to a source basename and line', async () => {
    const run = readEngineeringMissionProof(request, { lifetime: lifetime() });
    const rejection = expect(run).rejects.toThrow('proof-refused (engineering-preparation.ts:10)');
    state.workers[0]!.emit('message', { type: 'mission-proof-result', ok: false, reason: 'proof-refused', location: 'engineering-preparation.ts:10' }); await rejection;
    const invalid = readEngineeringMissionProof(request, { lifetime: lifetime() });
    const denied = expect(invalid).rejects.toThrow('Mission proof unavailable or stopped');
    state.workers[1]!.emit('message', { type: 'mission-proof-result', ok: false, reason: 'proof-refused', location: '/private/customer/file.ts:10' }); await denied;
  });
  it('omits only job rows from an explicitly issued read-only scope projection', () => {
    const original = { schemaVersion: 7, originPoolDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), paused: false, projects: [], jobs: [] };
    const sample: ResourceWorkspaceProofSample = { root: '/fixture', workspace: '/project', poolDigest: 'c'.repeat(64),
      stateDigest: digest(canonical(original)), lockPaths: [], metadataPending: false, ownsReceipt: () => false };
    const changed = { ...original, jobs: [{ id: 'human-new' }] };
    expect(matchesWorkspaceProofState(sample, changed)).toBe(false);
    sample.consoleScopeDigest = digest(canonical(original));
    expect(matchesWorkspaceProofState(sample, changed)).toBe(true);
    for (const mutation of [{ paused: true }, { schemaVersion: 6 }, { originPoolDigest: 'd'.repeat(64) }, { scopeDigest: 'e'.repeat(64) }, { projects: [{ id: 'different' }] }]) {
      expect(matchesWorkspaceProofState(sample, { ...changed, ...mutation })).toBe(false);
    }
  });
  it('does not manufacture a worker proof context on the host', () => {
    expect(() => createWorkerWorkspaceProofContext({ call: () => { throw Error('must not be called'); }, isClosed: () => false })).toThrow('worker-only');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import * as locks from '../src/core/fleet/local-store-lock.js';
import { appendPortfolioControllerEvent, foldPortfolioController, readPortfolioControllerEvents,
  refreshPortfolioControllerEvents, requestUniversePortfolioControllerControl, withPortfolioControllerTransaction,
  PortfolioControllerDrainError, PortfolioControllerTransactionBusyError } from '../src/core/universe/portfolio-controller-store.js';
import type { PortfolioControllerEnrollment, PortfolioControllerEvent } from '../src/core/universe/portfolio-controller-types.js';

const roots: string[] = [];
const HASH = 'a'.repeat(64);
afterEach(() => {
  vi.restoreAllMocks();
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});

type Input<T = PortfolioControllerEvent> = T extends PortfolioControllerEvent ? Omit<T, 'id' | 'sequence'> : never;
const stamp = (input: Input, sequence: number): PortfolioControllerEvent =>
  ({ ...input, sequence, id: String(sequence).padStart(8, '0') }) as PortfolioControllerEvent;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-controls-'))); roots.push(root);
  mkdirSync(join(root, 'portfolios'), { mode: 0o700 });
  const directory = join(root, 'portfolios', 'controller'); mkdirSync(directory, { mode: 0o700 });
  const at = new Date(Date.now() - 1_000).toISOString();
  const definition = { schemaVersion: 1 as const, id: 'controller', tasks: [{ campaignId: 'a', dependsOn: [] }],
    maxParallel: 1, maxDurationMs: 60_000 };
  const enrollment: PortfolioControllerEnrollment = { definition, definitionDigest: digest(canonical(definition)),
    deliveryPlan: null, deadlineAt: new Date(Date.parse(at) + 60_000).toISOString(), pins: [{ campaignId: 'a', universeId: 'universe-a',
      definitionDigest: HASH, manifestDigest: HASH, comparatorDigest: HASH, campaignDigest: HASH, recordsDigest: HASH,
      initialState: 'pending', dispatch: 'campaign', reasonCode: 'never-dispatched' }] };
  const created = appendPortfolioControllerEvent(directory, { kind: 'created', at, enrollment });
  const options = { root };
  const read = () => readPortfolioControllerEvents(directory);
  const request = (action: 'drain' | 'resume', expectedDrainSequence?: number) =>
    requestUniversePortfolioControllerControl('controller', action, { ...options, ...(expectedDrainSequence === undefined ? {} : { expectedDrainSequence }) });
  const append = (input: Input, expectedRecords?: PortfolioControllerEvent[]) =>
    appendPortfolioControllerEvent(directory, input, expectedRecords ? { expectedRecords } : {});
  const settle = (): Input => ({ kind: 'settled', at: new Date().toISOString(), recordsDigest: HASH,
    outcome: { campaignId: 'a', state: 'completed', attempted: true, reasonCode: 'campaign-completed', campaignDigest: HASH, deliveryDigest: null } });
  return { root, directory, options, at, created, read, request, append, settle };
}

describe('Controller durable control ordering and transactions', () => {
  it('checks intent evidence synchronously under the acquired short lock before publishing', () => {
    const f = fixture();
    const beforeIntent = vi.fn((records: readonly PortfolioControllerEvent[]) => {
      expect(records).toEqual(f.created);
      expect(existsSync(join(f.directory, '.control.lock'))).toBe(true);
      expect(f.read()).toEqual(f.created);
    });
    const next = appendPortfolioControllerEvent(f.directory, { kind: 'intent', campaignId: 'a', at: new Date().toISOString() },
      { expectedRecords: f.created, beforeIntent });
    expect(beforeIntent).toHaveBeenCalledOnce();
    expect(next.at(-1)?.kind).toBe('intent');
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(false);
  });

  it.each(['throw', 'async', 'value'] as const)('rejects a %s intent guard without history or lock leakage', async (kind) => {
    const f = fixture();
    const beforeIntent = () => {
      if (kind === 'throw') throw new Error('Fixture admission refused');
      if (kind === 'async') return Promise.reject(new Error('Fixture asynchronous refusal'));
      return true;
    };
    expect(() => appendPortfolioControllerEvent(f.directory,
      { kind: 'intent', campaignId: 'a', at: new Date().toISOString() }, { expectedRecords: f.created, beforeIntent })).toThrow();
    await Promise.resolve();
    expect(f.read()).toEqual(f.created);
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(false);
  });

  it('rejects non-intent guard use and preserves drain precedence before invoking a guard', () => {
    const f = fixture(); const beforeIntent = vi.fn();
    expect(() => appendPortfolioControllerEvent(f.directory, { kind: 'observed', at: new Date().toISOString() },
      { beforeIntent })).toThrow('intent check is invalid');
    expect(beforeIntent).not.toHaveBeenCalled();
    expect(f.read()).toEqual(f.created);
    f.request('drain'); const drained = f.read();
    expect(() => appendPortfolioControllerEvent(f.directory, { kind: 'intent', campaignId: 'a', at: new Date().toISOString() },
      { expectedRecords: f.created, beforeIntent })).toThrow(PortfolioControllerDrainError);
    expect(beforeIntent).not.toHaveBeenCalled();
    expect(f.read()).toEqual(drained);
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(false);
  });

  it('keeps legacy histories open with no invented control metadata', () => {
    const f = fixture();
    expect(foldPortfolioController(f.created).control).toBeUndefined();
    expect(f.append({ kind: 'intent', campaignId: 'a', at: new Date().toISOString() }).at(-1)?.kind).toBe('intent');
  });

  it('orders drain before intent and preserves the pristine campaign slot', () => {
    const f = fixture(); const request = f.request('drain'); const before = f.read();
    expect(request).toMatchObject({ changed: true, action: 'drain', sequence: 1 });
    expect(() => f.append({ kind: 'intent', campaignId: 'a', at: new Date().toISOString() }, f.created)).toThrow(PortfolioControllerDrainError);
    expect(f.read()).toEqual(before);
    expect(foldPortfolioController(before).states.get('a')).toMatchObject({ state: 'pending', attempted: false });
  });

  it('allows earlier intents to settle but never acknowledges an unresolved attempt', () => {
    const f = fixture(); f.append({ kind: 'intent', campaignId: 'a', at: new Date().toISOString() });
    const requested = f.request('drain'); const pending = f.read();
    expect(() => f.append({ kind: 'drained', drainSequence: requested.sequence, at: new Date().toISOString() })).toThrow('acknowledgement');
    expect(f.read()).toEqual(pending);
    f.append(f.settle());
    const drained = f.append({ kind: 'drained', drainSequence: requested.sequence, at: new Date().toISOString() });
    expect(foldPortfolioController(drained).control).toMatchObject({ mode: 'drain', sequence: requested.sequence, acknowledgedAt: expect.any(String) });
  });

  it('makes repeated owner requests idempotent and requires the exact acknowledged drain to resume', () => {
    const f = fixture(); const requested = f.request('drain'); const afterRequest = f.read();
    expect(f.request('drain')).toEqual({ ...requested, changed: false });
    expect(f.read()).toEqual(afterRequest);
    expect(() => f.request('resume', requested.sequence)).toThrow('acknowledged drain');
    f.append({ kind: 'drained', drainSequence: requested.sequence, at: new Date().toISOString() });
    const beforeResume = f.read();
    expect(() => f.request('resume', requested.sequence + 1)).toThrow('acknowledged drain');
    expect(f.read()).toEqual(beforeResume);
    const resumed = f.request('resume', requested.sequence); const afterResume = f.read();
    expect(resumed).toMatchObject({ changed: true, action: 'resume', sequence: 3 });
    expect(refreshPortfolioControllerEvents(f.directory, beforeResume)).toEqual(afterResume);
    expect(f.request('resume', requested.sequence)).toEqual({ ...resumed, changed: false });
    expect(f.read()).toEqual(afterResume);
    expect(foldPortfolioController(afterResume)).toMatchObject({ control: { mode: 'open', sequence: resumed.sequence },
      first: { enrollment: f.created[0]!.kind === 'created' ? f.created[0]!.enrollment : undefined } });
    const second = f.request('drain');
    expect(second.sequence).toBeGreaterThan(resumed.sequence);
    expect(() => f.request('resume', requested.sequence)).toThrow('acknowledged drain');
  });

  it.each([
    { kind: 'control', action: 'drain', drainSequence: 0 },
    { kind: 'control', action: 'resume' },
    { kind: 'control', action: 'resume', drainSequence: -1 },
    { kind: 'control', action: 'resume', drainSequence: 1.5 },
    { kind: 'control', action: 'resume', drainSequence: 512 },
    { kind: 'control', action: 'resume', drainSequence: '1' },
    { kind: 'control', action: 'pause' },
    { kind: 'drained', drainSequence: 0, action: 'drain' },
  ])('rejects malformed control record %#', (input) => {
    const f = fixture();
    const event = stamp({ ...input, at: f.at } as Input, 1);
    expect(() => foldPortfolioController([...f.created, event])).toThrow();
  });

  it('rejects duplicate stored requests, stale acknowledgements and duplicate acknowledgements', () => {
    const f = fixture(); const requested = f.request('drain');
    expect(() => f.append({ kind: 'control', action: 'drain', at: new Date().toISOString() })).toThrow('already requested');
    expect(() => f.append({ kind: 'drained', drainSequence: 0, at: new Date().toISOString() })).toThrow('acknowledgement');
    f.append({ kind: 'drained', drainSequence: requested.sequence, at: new Date().toISOString() });
    expect(() => f.append({ kind: 'drained', drainSequence: requested.sequence, at: new Date().toISOString() })).toThrow('acknowledgement');
  });

  it('treats an already-recorded post-drain intent as invalid evidence rather than a new admission refusal', () => {
    const f = fixture(); f.request('drain'); const records = f.read();
    let error: unknown;
    try { foldPortfolioController([...records, stamp({ kind: 'intent', campaignId: 'a', at: new Date().toISOString() }, records.length)]); }
    catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PortfolioControllerDrainError);
  });

  it('accepts only valid appended owner controls when refreshing or appending against a checkpoint', () => {
    const f = fixture(); f.request('drain');
    const current = refreshPortfolioControllerEvents(f.directory, f.created);
    expect(current).toEqual(f.read());
    const next = f.append({ kind: 'observed', at: new Date().toISOString() }, f.created);
    expect(next.at(-1)?.kind).toBe('observed');
    expect(() => refreshPortfolioControllerEvents(f.directory, f.created)).toThrow('outside owner control');
    const changed = structuredClone(next); changed[0]!.at = new Date(0).toISOString();
    expect(() => refreshPortfolioControllerEvents(f.directory, changed)).toThrow('outside owner control');
    expect(() => f.append({ kind: 'observed', at: new Date().toISOString() }, changed)).toThrow('outside owner control');
    expect(f.read()).toEqual(next);
  });

  it('does not refresh an owner acknowledgement as an external control', () => {
    const f = fixture(); const request = f.request('drain'); const expected = f.read();
    f.append({ kind: 'drained', drainSequence: request.sequence, at: new Date().toISOString() });
    expect(() => refreshPortfolioControllerEvents(f.directory, expected)).toThrow('outside owner control');
  });

  it('never initializes a nonexistent target through drain or resume', () => {
    const f = fixture(); const target = join(f.root, 'portfolios', 'missing');
    expect(() => requestUniversePortfolioControllerControl('missing', 'drain', f.options)).toThrow();
    expect(existsSync(target)).toBe(false);
    mkdirSync(target, { mode: 0o700 });
    expect(() => requestUniversePortfolioControllerControl('missing', 'resume', { ...f.options, expectedDrainSequence: 1 })).toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it.each([undefined, -1, 1.5, 512, Number.NaN])('rejects invalid resume sequence %s before control writes', (expectedDrainSequence) => {
    const f = fixture();
    expect(() => requestUniversePortfolioControllerControl('controller', 'resume', { ...f.options, expectedDrainSequence })).toThrow();
    expect(f.read()).toEqual(f.created);
  });

  it('refuses a resume with no prior drain and an unexpected drain token', () => {
    const f = fixture();
    expect(() => f.request('resume', 1)).toThrow();
    expect(() => f.request('drain', 1)).toThrow();
    expect(f.read()).toEqual(f.created);
  });

  it('keeps the short transaction separate from a live lifetime execution lease', () => {
    const f = fixture();
    const execution = acquireLocalStoreLockWithOutcome(join(f.directory, '.execution.lock'), 0, { anchorPath: f.directory, exactPrivateStorage: true });
    if (execution.state !== 'acquired') throw new Error('Fixture execution unavailable');
    try { expect(f.request('drain').changed).toBe(true); expect(ownsLocalStoreLock(execution.lock)).toBe(true); }
    finally { releaseLocalStoreLock(execution.lock); }
  });

  it('classifies only verified live contention as transaction busy and never changes its lock', () => {
    const f = fixture(); const path = join(f.directory, '.control.lock');
    const lock = acquireLocalStoreLockWithOutcome(path, 0, { anchorPath: f.directory, exactPrivateStorage: true });
    if (lock.state !== 'acquired') throw new Error('Fixture control lock unavailable');
    const bytes = readFileSync(path);
    try { expect(() => f.request('drain')).toThrow(PortfolioControllerTransactionBusyError); expect(readFileSync(path)).toEqual(bytes); }
    finally { releaseLocalStoreLock(lock.lock); }
    writeFileSync(path, 'unknown private owner', { mode: 0o600, flag: 'wx' });
    try { f.request('drain'); throw new Error('Unexpected success'); }
    catch (error) { expect(error).not.toBeInstanceOf(PortfolioControllerTransactionBusyError); }
    expect(readFileSync(path, 'utf8')).toBe('unknown private owner');
    expect(f.read()).toEqual(f.created);
  });

  it('reuses a proven-dead short transaction owner without touching record history', () => {
    const f = fixture();
    const source = `const {acquireLocalStoreLockWithOutcome}=await import('./src/core/fleet/local-store-lock.ts');
const result=acquireLocalStoreLockWithOutcome(${JSON.stringify(join(f.directory, '.control.lock'))},0,{anchorPath:${JSON.stringify(f.directory)},exactPrivateStorage:true});
if(result.state!=='acquired')throw new Error('fixture lock unavailable');`;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { cwd: process.cwd(), timeout: 15_000,
      env: { PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(true);
    expect(refreshPortfolioControllerEvents(f.directory, f.created)).toEqual(f.created);
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(false);
  });

  it('rejects asynchronous and nested callbacks and releases its short lock after exceptions', () => {
    const f = fixture(); const path = join(f.directory, '.control.lock');
    expect(() => withPortfolioControllerTransaction(f.directory, () => Promise.resolve())).toThrow('synchronous');
    expect(existsSync(path)).toBe(false);
    expect(() => withPortfolioControllerTransaction(f.directory, () => f.request('drain'))).toThrow('must not nest');
    expect(existsSync(path)).toBe(false);
    expect(() => withPortfolioControllerTransaction(f.directory, () => { throw new Error('fixture failure'); })).toThrow('fixture failure');
    expect(existsSync(path)).toBe(false);
    expect(f.read()).toEqual(f.created);
  });

  it('leaves staged records untouched and does not mistake incomplete history for registration', () => {
    const f = fixture(); const stage = join(f.directory, 'ledger', 'staging', '.incomplete.tmp');
    writeFileSync(stage, 'retained private evidence', { mode: 0o600 });
    expect(() => f.request('drain')).toThrow();
    expect(readFileSync(stage, 'utf8')).toBe('retained private evidence');
    expect(existsSync(join(f.directory, '.control.lock'))).toBe(false);
  });

  it('retains a committed control after unconfirmed transaction release and deduplicates its retry', () => {
    const f = fixture(); const original = locks.releaseLocalStoreLock;
    const release = vi.spyOn(locks, 'releaseLocalStoreLock').mockImplementation((lock) => {
      const result = original(lock);
      return lock?.path === join(f.directory, '.control.lock') ? false : result;
    });
    expect(() => f.request('drain')).toThrow('release failed');
    release.mockRestore();
    const saved = f.read();
    expect(saved.at(-1)).toMatchObject({ kind: 'control', action: 'drain' });
    expect(f.request('drain')).toMatchObject({ changed: false, sequence: 1 });
    expect(f.read()).toEqual(saved);
  });

  it('reserves final drain and acknowledgement slots without allowing a capacity-exhausted resume', () => {
    const f = fixture(); const records = join(f.directory, 'ledger', 'records');
    // Populate valid immutable fixture observations cheaply; production writes
    // below exercise the real reserved-capacity boundary and strict reader.
    for (let index = 1; index < 508; index++) writeFileSync(join(records, `${String(index).padStart(8, '0')}.json`),
      `${canonical(stamp({ kind: 'observed', at: f.at }, index))}\n`, { mode: 0o600, flag: 'wx' });
    expect(() => f.append({ kind: 'observed', at: new Date().toISOString() })).toThrow('capacity exhausted');
    const request = f.request('drain');
    expect(request.sequence).toBe(508);
    f.append({ kind: 'drained', drainSequence: request.sequence, at: new Date().toISOString() });
    const before = f.read();
    expect(() => f.request('resume', request.sequence)).toThrow('capacity exhausted');
    expect(f.read()).toEqual(before);
    expect(foldPortfolioController(before).control?.acknowledgedAt).not.toBeNull();
  });

  it('reserves settlement and acknowledgement capacity for an admitted attempt during drain', () => {
    const f = fixture(); const records = join(f.directory, 'ledger', 'records');
    f.append({ kind: 'intent', campaignId: 'a', at: f.at });
    for (let index = 2; index < 509; index++) writeFileSync(join(records, `${String(index).padStart(8, '0')}.json`),
      `${canonical(stamp({ kind: 'observed', at: f.at }, index))}\n`, { mode: 0o600, flag: 'wx' });
    const request = f.request('drain');
    f.append(f.settle());
    const final = f.append({ kind: 'drained', drainSequence: request.sequence, at: new Date().toISOString() });
    expect(final).toHaveLength(512);
    expect(foldPortfolioController(final)).toMatchObject({ control: { mode: 'drain', acknowledgedAt: expect.any(String) } });
    expect(f.request('drain')).toMatchObject({ changed: false, sequence: request.sequence });
  });

  it('preserves the final reserved settlement of a valid legacy history without admitting fresh work', () => {
    const f = fixture(); const records = join(f.directory, 'ledger', 'records');
    f.append({ kind: 'intent', campaignId: 'a', at: f.at });
    for (let index = 2; index < 511; index++) writeFileSync(join(records, `${String(index).padStart(8, '0')}.json`),
      `${canonical(stamp({ kind: 'observed', at: f.at }, index))}\n`, { mode: 0o600, flag: 'wx' });
    expect(() => f.request('drain')).toThrow('capacity exhausted');
    expect(() => f.append({ kind: 'observed', at: new Date().toISOString() })).toThrow('capacity exhausted');
    const final = f.append(f.settle());
    expect(final).toHaveLength(512);
    expect(foldPortfolioController(final).states.get('a')?.state).toBe('completed');
    expect(foldPortfolioController(final).control).toBeUndefined();
    expect(() => f.request('drain')).toThrow();
  });
});

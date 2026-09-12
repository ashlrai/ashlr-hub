/** Historical observations only: neither missing outcomes nor completed observations authorize work. */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { canonical, inspectPrivateDirectory } from '../universe/artifacts.js';
import { readImmutablePrivateRecords, writeImmutablePrivateRecord, type ImmutablePrivateRecordStoreConfig } from '../util/immutable-private-record-store.js';
import { missionData, missionExact, missionHash, validateResourceEngineeringMissionConfig, type ResourceEngineeringMissionConfig } from './engineering-mission-store.js';

const PHASES = ['startup', 'preparing', 'executing', 'draining', 'verifying', 'reconciling', 'proposing'] as const;
type Phase = typeof PHASES[number];
type Outcome = { state: 'completed' | 'stopped' | 'held'; reason: string; scopesReserved: number };
type Timing = { scope: number; phase: Phase; durationMs: number };
type Start = { id: string; kind: 'started'; index: number; configDigest: string; startedAt: string };
type Finish = { id: string; kind: 'finished'; index: number; configDigest: string; startDigest: string;
  finishedAt: string; outcome: Outcome; elapsedMs: number; timings: Timing[] };
type Record = Start | Finish;
const MAX_INVOCATIONS = 4096;
const MAX_TIMINGS = 65 * PHASES.length;
const REASONS = new Set(['stop-requested', 'scope-limit', 'shutdown-unresolved', 'ownership-release-unresolved',
  'invocation-record-unavailable', 'unclassified-outcome', 'mission-unavailable',
  ...['initial setup changed', 'mission project unavailable', 'mission records overlap execution controls',
    'mission already owned or unavailable', 'mission execution stopped', 'mission ownership changed',
    'mission record publication unavailable', 'mission console unavailable', 'mission console request refused',
    'mission console response exceeds bound', 'mission console contains stopped or unrelated work', 'mission scope missing',
    'mission predecessor missing', 'mission predecessor requested stop', 'mission proposal unavailable',
    'reserved mission scope changed', 'initial mission plan changed', 'mission predecessor changed',
    'mission prepared setup changed', 'mission queue unavailable', 'mission queue deadline changed',
    'mission successor scope changed', 'mission scope did not settle', 'mission completion proof unavailable',
    'recorded mission completion changed', 'mission proposal identity changed', 'mission proposal receipt mismatch',
    'mission feedback unavailable', 'mission feedback exceeds bound',
    'mission proposal console unavailable', 'mission proposal unresolved', 'mission proposal did not complete',
    'mission proposal output unavailable', 'mission proposal result changed', 'mission scope limit unavailable']
    .map(reason => reason.replaceAll(' ', '-')),
  ...PHASES.flatMap(phase => [`${phase}-held`, `${phase}-stopped`])]);
const fail = (): never => { throw new Error('Mission invocation observations unavailable'); };
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const phase = (value: unknown): value is Phase => typeof value === 'string' && (PHASES as readonly string[]).includes(value);
const id = (index: number, kind: Record['kind']) => `${String(index).padStart(4, '0')}-${kind}`;
function decode(input: unknown): Record | null {
  try {
    const row = missionData<Record>(input);
    if (!row || !integer(row.index, MAX_INVOCATIONS) || row.index < 1 || !hash(row.configDigest)) return null;
    if (row.kind === 'started') return missionExact(row, ['id', 'kind', 'index', 'configDigest', 'startedAt']) &&
      row.id === id(row.index, row.kind) && date(row.startedAt) ? row : null;
    if (row.kind !== 'finished' || !missionExact(row, ['id', 'kind', 'index', 'configDigest', 'startDigest', 'finishedAt', 'outcome', 'elapsedMs', 'timings']) ||
      row.id !== id(row.index, row.kind) || !hash(row.startDigest) || !date(row.finishedAt) || !integer(row.elapsedMs) ||
      !missionExact(row.outcome, ['state', 'reason', 'scopesReserved']) || typeof row.outcome.state !== 'string' ||
      !['completed', 'stopped', 'held'].includes(row.outcome.state) || !REASONS.has(row.outcome.reason) || !integer(row.outcome.scopesReserved, 64) ||
      !Array.isArray(row.timings) || row.timings.length < 1 || row.timings.length > MAX_TIMINGS) return null;
    const seen = new Set<string>(); let total = 0, previousScope = 0;
    for (const timing of row.timings) {
      if (!missionExact(timing, ['scope', 'phase', 'durationMs']) || !integer(timing.scope, 64) || timing.scope < previousScope ||
        !phase(timing.phase) || !integer(timing.durationMs) || seen.has(`${timing.scope}:${timing.phase}`)) return null;
      seen.add(`${timing.scope}:${timing.phase}`); previousScope = timing.scope; total += timing.durationMs;
    }
    if (!integer(total) || total !== row.elapsedMs || row.timings[0]!.scope !== 0 || row.timings[0]!.phase !== 'startup') return null;
    return row;
  } catch { return null; }
}
function store(root: string): ImmutablePrivateRecordStoreConfig<Record> {
  const codec = { parse: decode, serialize: (row: Record) => canonical(row) + '\n', recordId: (row: Record) => row.id,
    recordFileName: (row: Record) => row.id + '.json', isRecordFileName: (name: string) => /^\d{4}-(started|finished)\.json$/.test(name),
    stageToken: missionHash, equivalent: (a: Record, b: Record) => canonical(a) === canonical(b) };
  return { label: 'Mission invocation observations', anchorPath: root, rootPath: join(root, 'mission-invocations'), lockFileName: '.records.lock',
    maxRecordBytes: 64 * 1024, defaultMaxFiles: 8192, hardMaxFiles: 8192, defaultMaxBytes: 128 * 1024 * 1024, hardMaxBytes: 128 * 1024 * 1024,
    codecForRead: () => codec, codecForWrite: () => codec };
}
function rootPin(root: string) {
  inspectPrivateDirectory(root); const before = lstatSync(root, { bigint: true });
  return () => { inspectPrivateDirectory(root); const after = lstatSync(root, { bigint: true });
    if (['dev', 'ino', 'uid', 'mode'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) fail(); };
}
function records(config: ResourceEngineeringMissionConfig): Record[] {
  const bound = rootPin(config.root), definition = missionHash(config);
  try { if (lstatSync(store(config.root).rootPath).isSymbolicLink()) fail(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const read = readImmutablePrivateRecords(store(config.root), { requireComplete: true }); bound();
  if (read.sourceState === 'missing') return [];
  if (read.sourceState !== 'healthy' || !read.complete) return fail();
  const starts = read.records.filter((row): row is Start => row.kind === 'started').sort((a, b) => a.index - b.index);
  if (starts.some((row, index) => row.index !== index + 1)) return fail();
  for (const row of read.records) {
    if (row.configDigest !== definition) return fail();
    if (row.kind === 'finished') {
      const start = starts[row.index - 1];
      if (!start || row.startDigest !== missionHash(start) || Date.parse(row.finishedAt) < Date.parse(start.startedAt) || row.outcome.scopesReserved > config.maxScopes ||
        row.timings.some(timing => timing.scope > config.maxScopes)) return fail();
    }
  }
  return read.records;
}

export function readEngineeringMissionInvocations(input: ResourceEngineeringMissionConfig) {
  const config = validateResourceEngineeringMissionConfig(input), rows = records(config);
  const starts = rows.filter((row): row is Start => row.kind === 'started').sort((a, b) => a.index - b.index);
  const start = starts.at(-1), finish = rows.find((row): row is Finish => row.kind === 'finished' && row.index === start?.index);
  return { scope: 'recorded-mission-invocations-only' as const, count: starts.length,
    unfinishedCount: starts.filter(row => !rows.some(other => other.kind === 'finished' && other.index === row.index)).length,
    latest: start ? { index: start.index, startedAt: start.startedAt, finishedAt: finish?.finishedAt ?? null,
      outcome: finish?.outcome ?? null, elapsedMs: finish?.elapsedMs ?? null, timings: finish?.timings ?? [] } : null,
    ownerState: 'not-observed' as const, executionAuthorized: false as const };
}

export function beginEngineeringMissionInvocation(input: ResourceEngineeringMissionConfig,
  host: { isOwned: () => boolean; isBound: () => boolean }) {
  const config = validateResourceEngineeringMissionConfig(input), bound = rootPin(config.root);
  const guard = (owned: boolean) => { bound(); if (host.isBound() !== true || owned && host.isOwned() !== true) fail(); bound(); };
  guard(true);
  const index = records(config).filter(row => row.kind === 'started').length + 1;
  if (index > MAX_INVOCATIONS) return fail();
  const startedAt = new Date().toISOString(), startedMono = performance.now();
  if (!Number.isFinite(startedMono)) return fail();
  const start: Start = { id: id(index, 'started'), kind: 'started', index, configDigest: missionHash(config), startedAt };
  const publish = (row: Record, owned: boolean, check = () => {}) => {
    guard(owned); check();
    const result = writeImmutablePrivateRecord(store(config.root), row, { lockWaitMs: 0,
      prepublish: () => { guard(owned); check(); return true; } });
    if (result !== 'recorded' && result !== 'replayed') fail();
    guard(owned);
  };
  publish(start, true);
  const startFile = join(store(config.root).rootPath, 'records', start.id + '.json');
  const startIdentity = lstatSync(startFile, { bigint: true });
  const exactStart = () => { const current = lstatSync(startFile, { bigint: true });
    if (['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].some(key =>
      startIdentity[key as keyof typeof current] !== current[key as keyof typeof current])) fail(); };
  let currentScope = 0, currentPhase: Phase = 'startup', elapsed = 0, finished: Finish | undefined;
  const timings: Timing[] = [{ scope: 0, phase: 'startup', durationMs: 0 }];
  const accrue = () => {
    const next = Math.floor(performance.now() - startedMono);
    if (!integer(next) || next < elapsed) fail();
    const timing = timings.find(row => row.scope === currentScope && row.phase === currentPhase)!;
    timing.durationMs += next - elapsed; elapsed = next;
  };
  return {
    observe(scope: number, value: string): void {
      if (finished || !integer(scope, config.maxScopes) || scope < currentScope) fail();
      const checkedPhase = phase(value) ? value : fail();
      guard(true); accrue(); currentScope = scope; currentPhase = checkedPhase;
      if (!timings.some(row => row.scope === scope && row.phase === checkedPhase)) timings.push({ scope, phase: checkedPhase, durationMs: 0 });
    },
    finish(inputOutcome: Outcome): void {
      const outcome = missionData<Outcome>(inputOutcome);
      if (!missionExact(outcome, ['state', 'reason', 'scopesReserved']) || !['completed', 'stopped', 'held'].includes(outcome.state) ||
        typeof outcome.reason !== 'string' || !integer(outcome.scopesReserved, config.maxScopes)) fail();
      outcome.reason = REASONS.has(outcome.reason) ? outcome.reason : 'unclassified-outcome';
      guard(false);
      if (finished && canonical(finished.outcome) !== canonical(outcome)) fail();
      const rows = records(config);
      if (canonical(rows.find(row => row.kind === 'started' && row.index === index)) !== canonical(start)) fail();
      exactStart();
      if (!finished) {
        accrue();
        finished = { id: id(index, 'finished'), kind: 'finished', index, configDigest: start.configDigest, startDigest: missionHash(start),
          finishedAt: new Date(Math.max(Date.parse(startedAt), Date.now())).toISOString(), outcome, elapsedMs: elapsed, timings: missionData(timings) };
      }
      publish(finished, false, exactStart);
    },
  };
}

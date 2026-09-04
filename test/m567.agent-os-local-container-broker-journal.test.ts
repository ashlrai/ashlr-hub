import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AgentOsLocalContainerBrokerJournalV1,
  agentOsLocalContainerBrokerRequestNonceDigestV1,
  agentOsLocalContainerBrokerRunIdV1,
  type AgentOsLocalContainerBrokerJournalRecordV1,
  type AgentOsLocalContainerBrokerJournalStateV1,
} from '../src/core/daemon/agent-os-local-container-broker-journal.js';

const raw = (label: string): string => createHash('sha256').update(`m567-journal\0${label}`).digest('hex');
const prefixed = (label: string): string => `sha256:${raw(label)}`;
const NONCE = Buffer.alloc(32, 0x67).toString('base64url');
const NOW = Date.parse('2026-09-04T19:00:00.000Z');

interface Fixture {
  anchor: string;
  root: string;
  now: { value: number };
  journal: AgentOsLocalContainerBrokerJournalV1;
}

const fixtures: Fixture[] = [];

function fixture(enabled = true, maxRecords?: number): Fixture {
  const anchor = mkdtempSync(join(tmpdir(), 'ashlr-m567-journal-'));
  chmodSync(anchor, 0o700);
  const root = join(anchor, 'journal');
  const now = { value: NOW };
  const journal = new AgentOsLocalContainerBrokerJournalV1({
    anchorPath: anchor,
    rootPath: root,
    enabled,
    clock: () => new Date(now.value),
    lockWaitMs: 0,
    maxRecords,
  });
  const result = { anchor, root, now, journal };
  fixtures.push(result);
  return result;
}

function state(overrides: Partial<AgentOsLocalContainerBrokerJournalStateV1> = {}):
AgentOsLocalContainerBrokerJournalStateV1 {
  return {
    runId: agentOsLocalContainerBrokerRunIdV1(NONCE)!,
    requestNonceDigest: agentOsLocalContainerBrokerRequestNonceDigestV1(NONCE)!,
    requestDigest: raw('request'),
    permitDigest: raw('permit'),
    brokerDigest: raw('broker'),
    engineDigest: raw('engine'),
    imageDigest: raw('image'),
    producerDigest: raw('producer'),
    seccompDigest: raw('seccomp'),
    createConfigDigest: raw('create-config'),
    executionIdentityDigest: prefixed('execution-identity'),
    capacityEvidenceDigest: prefixed('capacity-evidence'),
    allocationDigest: prefixed('allocation'),
    leaseEpoch: 1,
    leaseExpiresAt: new Date(NOW + 300_000).toISOString(),
    containerName: `ashlr-agent-os-${raw('name').slice(0, 32)}`,
    containerId: null,
    engineCreateRequestDigest: null,
    prestartInspectionDigest: null,
    finalInspectionDigest: null,
    prepareAttestationDigest: null,
    finalAttestationDigest: null,
    removalEvidenceDigest: null,
    outcome: null,
    ...overrides,
  };
}

afterEach(() => {
  for (const value of fixtures.splice(0)) rmSync(value.anchor, { recursive: true, force: true });
});

describe('M567 local-container broker journal', () => {
  it('is default-off, values-free, and creates no storage', () => {
    const value = fixture(false);
    expect(value.journal.acquireLifecycleLock()).toEqual({ state: 'disabled', lock: null });
    expect(value.journal.inspect()).toEqual({
      enabled: false,
      sourceState: 'disabled',
      complete: true,
      activeRuns: [],
      terminalRunCount: 0,
      recordCount: 0,
      stopReasons: ['disabled'],
      sameUserTamperResistant: false,
      commissioningAuthority: false,
      activationAuthority: false,
    });
    expect(() => readdirSync(value.root)).toThrow();
  });

  it('records an immutable ordered lifecycle and exposes no container values publicly', () => {
    const value = fixture();
    const acquired = value.journal.acquireLifecycleLock();
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') return;
    let current = value.journal.begin(state(), acquired.lock);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const advance = (
      stage: Parameters<typeof value.journal.advance>[2],
      updates: Parameters<typeof value.journal.advance>[3] = {},
    ): AgentOsLocalContainerBrokerJournalRecordV1 => {
      value.now.value += 100;
      const next = value.journal.advance(state().runId, current.record.recordDigest, stage, updates, acquired.lock);
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(next.reason);
      current = next;
      return next.record;
    };
    advance('created', { containerId: raw('container'), engineCreateRequestDigest: raw('engine-create') });
    advance('prepared', {
      prestartInspectionDigest: raw('prestart-inspect'),
      prepareAttestationDigest: raw('prepare'),
    });
    advance('started');
    advance('stopped', { finalInspectionDigest: raw('final-inspect') });
    advance('removed', { removalEvidenceDigest: raw('removal') });
    advance('finalized', { finalAttestationDigest: raw('finalize') });
    const terminal = advance('settled', { outcome: 'succeeded', leaseEpoch: 2 });
    expect(terminal).toMatchObject({ sequence: 8, stage: 'settled', outcome: 'succeeded' });
    expect(value.journal.readActive(acquired.lock)).toEqual([]);
    expect(value.journal.releaseLifecycleLock(acquired.lock)).toBe(true);
    const inspectionText = JSON.stringify(value.journal.inspect());
    expect(value.journal.inspect()).toMatchObject({
      sourceState: 'healthy', complete: true, activeRuns: [], terminalRunCount: 1, recordCount: 8,
      sameUserTamperResistant: false,
    });
    expect(inspectionText).not.toContain(raw('container'));
    expect(inspectionText).not.toContain(state().containerName);
    const files = readdirSync(join(value.root, 'records'));
    expect(files).toHaveLength(8);
    expect(files.every((file) => /^[a-f0-9]{64}\.[0-9]{4}\.json$/u.test(file))).toBe(true);
  });

  it('enforces the lifecycle lock, transition order, predecessor digest, and terminal fence', () => {
    const value = fixture();
    const first = value.journal.acquireLifecycleLock();
    expect(first.state).toBe('acquired');
    if (first.state !== 'acquired') return;
    expect(value.journal.acquireLifecycleLock()).toEqual({ state: 'contended', lock: null });
    const begun = value.journal.begin(state(), first.lock);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(value.journal.advance(state().runId, raw('wrong-predecessor'), 'created', {}, first.lock))
      .toMatchObject({ ok: false, reason: 'stage-conflict' });
    expect(value.journal.advance(state().runId, begun.record.recordDigest, 'created', {}, first.lock))
      .toMatchObject({ ok: false, reason: 'invalid-state' });
    expect(value.journal.advance(state().runId, begun.record.recordDigest, 'started', {}, first.lock))
      .toMatchObject({ ok: false, reason: 'stage-conflict' });
    const abandoned = value.journal.advance(
      state().runId, begun.record.recordDigest, 'abandoned', { outcome: 'recovered-after-crash' }, first.lock,
    );
    expect(abandoned).toMatchObject({ ok: true, record: { stage: 'abandoned' } });
    if (!abandoned.ok) return;
    expect(value.journal.advance(
      state().runId, abandoned.record.recordDigest, 'settled', { outcome: 'succeeded' }, first.lock,
    )).toMatchObject({ ok: false, reason: 'stage-conflict' });
    expect(value.journal.releaseLifecycleLock(first.lock)).toBe(true);
  });

  it('rejects proxy and accessor inputs without executing their traps', () => {
    const value = fixture();
    const acquired = value.journal.acquireLifecycleLock();
    if (acquired.state !== 'acquired') throw new Error('fixture lock failed');
    const proxied = new Proxy(state(), {});
    expect(value.journal.begin(proxied, acquired.lock)).toMatchObject({ ok: false, reason: 'invalid-state' });
    const getter = vi.fn(() => raw('attacker'));
    const hostile = { ...state() };
    Object.defineProperty(hostile, 'requestDigest', { enumerable: true, get: getter });
    expect(value.journal.begin(hostile, acquired.lock)).toMatchObject({ ok: false, reason: 'invalid-state' });
    expect(getter).not.toHaveBeenCalled();
    expect(value.journal.releaseLifecycleLock(acquired.lock)).toBe(true);
  });

  it('fails closed on record corruption, hardlinks, and unsafe modes', () => {
    const value = fixture();
    const acquired = value.journal.acquireLifecycleLock();
    if (acquired.state !== 'acquired') throw new Error('fixture lock failed');
    expect(value.journal.begin(state(), acquired.lock).ok).toBe(true);
    expect(value.journal.releaseLifecycleLock(acquired.lock)).toBe(true);
    const recordsPath = join(value.root, 'records');
    const recordPath = join(recordsPath, readdirSync(recordsPath)[0]!);
    const original = readFileSync(recordPath);
    writeFileSync(recordPath, Buffer.from(original.toString('utf8').replace(raw('request'), raw('tampered'))));
    expect(value.journal.inspect()).toMatchObject({ sourceState: 'degraded', complete: false, activeRuns: [] });

    const linked = fixture();
    const linkedLock = linked.journal.acquireLifecycleLock();
    if (linkedLock.state !== 'acquired') throw new Error('fixture lock failed');
    expect(linked.journal.begin(state(), linkedLock.lock).ok).toBe(true);
    expect(linked.journal.releaseLifecycleLock(linkedLock.lock)).toBe(true);
    const linkedRecords = join(linked.root, 'records');
    const source = join(linkedRecords, readdirSync(linkedRecords)[0]!);
    linkSync(source, join(linked.anchor, 'stolen-record'));
    expect(linked.journal.inspect()).toMatchObject({ sourceState: 'degraded', complete: false });

    const unsafe = fixture();
    const unsafeLock = unsafe.journal.acquireLifecycleLock();
    if (unsafeLock.state !== 'acquired') throw new Error('fixture lock failed');
    expect(unsafe.journal.releaseLifecycleLock(unsafeLock.lock)).toBe(true);
    chmodSync(unsafe.root, 0o755);
    expect(unsafe.journal.acquireLifecycleLock()).toEqual({ state: 'unavailable', lock: null });
  });

  it('reserves a complete lifecycle at the cap and compacts terminal chains behind anchored summaries', () => {
    const value = fixture(true, 16);
    const acquired = value.journal.acquireLifecycleLock();
    if (acquired.state !== 'acquired') throw new Error('fixture lock failed');
    const terminal = (label: string): void => {
      const selected = state({
        runId: raw(`run-${label}`),
        requestNonceDigest: raw(`nonce-${label}`),
        containerName: `ashlr-agent-os-${raw(`name-${label}`).slice(0, 32)}`,
      });
      const begun = value.journal.begin(selected, acquired.lock);
      expect(begun.ok).toBe(true);
      if (!begun.ok) return;
      value.now.value += 1;
      expect(value.journal.advance(selected.runId, begun.record.recordDigest, 'settled', {
        outcome: 'request-withheld', leaseEpoch: 2,
      }, acquired.lock).ok).toBe(true);
    };
    for (let index = 0; index < 5; index += 1) terminal(String(index));

    const selected = state({
      runId: raw('near-cap-run'), requestNonceDigest: raw('near-cap-nonce'),
      containerName: `ashlr-agent-os-${raw('near-cap-name').slice(0, 32)}`,
    });
    let current = value.journal.begin(selected, acquired.lock);
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const advance = (stage: Parameters<typeof value.journal.advance>[2], updates = {}): void => {
      value.now.value += 1;
      const next = value.journal.advance(selected.runId, current.record.recordDigest, stage, updates, acquired.lock);
      expect(next.ok).toBe(true);
      if (next.ok) current = next;
    };
    advance('created', { containerId: raw('near-cap-container'), engineCreateRequestDigest: raw('near-cap-create') });
    advance('prepared', { prestartInspectionDigest: raw('near-cap-inspect'),
      prepareAttestationDigest: raw('near-cap-prepare') });
    advance('started');
    advance('stopped', { finalInspectionDigest: raw('near-cap-final-inspect') });
    advance('removed', { removalEvidenceDigest: raw('near-cap-removal') });
    advance('finalized', { finalAttestationDigest: raw('near-cap-finalize') });
    advance('settled', { outcome: 'succeeded', leaseEpoch: 2 });
    expect(value.journal.inspect()).toMatchObject({ complete: true, recordCount: 16, terminalRunCount: 6 });

    const before = new Map(readdirSync(join(value.root, 'records')).map((file) =>
      [file, readFileSync(join(value.root, 'records', file))]));
    terminal('after-cap');
    const files = readdirSync(join(value.root, 'records'));
    const summary = files.find((file) => file.endsWith('.summary.json') && !before.has(file));
    expect(summary).toBeDefined();
    const summarizedRun = summary!.slice(0, 64);
    const summaryRecord = JSON.parse(readFileSync(join(value.root, 'records', summary!), 'utf8')) as
      AgentOsLocalContainerBrokerJournalRecordV1;
    const priorDigests = [...before].filter(([file]) => file.startsWith(`${summarizedRun}.`))
      .map(([, bytes]) => (JSON.parse(bytes.toString('utf8')) as AgentOsLocalContainerBrokerJournalRecordV1)
        .recordDigest);
    expect(priorDigests).toContain(summaryRecord.previousRecordDigest);
    const removedOriginal = [...before].find(([file]) => file.startsWith(`${summarizedRun}.`) &&
      !file.endsWith('.summary.json'));
    if (removedOriginal && !files.includes(removedOriginal[0])) {
      const restored = join(value.root, 'records', removedOriginal[0]);
      writeFileSync(restored, removedOriginal[1], { mode: 0o600 });
      chmodSync(restored, 0o600);
      expect(value.journal.inspect()).toMatchObject({ sourceState: 'healthy', complete: true });
      expect(value.journal.recoverStore(acquired.lock)).toBe(true);
      expect(readdirSync(join(value.root, 'records'))).not.toContain(removedOriginal[0]);
    }
    expect(value.journal.releaseLifecycleLock(acquired.lock)).toBe(true);
  });
});

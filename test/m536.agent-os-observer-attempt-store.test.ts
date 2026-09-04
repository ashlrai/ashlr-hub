import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENT_OS_OBSERVER_ATTEMPT_MAX_RECORDS,
  beginAgentOsObserverAttemptV1,
  completeAgentOsObserverAttemptV1,
  defaultAgentOsObserverAttemptStoreDependenciesV1,
  readAgentOsObserverAttemptReceiptsV1,
  verifyAgentOsObserverAttemptReceiptV1,
  type AgentOsObserverAttemptReceiptV1,
  type AgentOsObserverAttemptStartInputV1,
  type AgentOsObserverAttemptStoreDependenciesV1,
  type AgentOsObserverAttemptTerminalInputV1,
  type AgentOsObserverTerminalOutcomeV1,
} from '../src/core/vision/agent-os-observer-attempt-store.js';
import {
  agentOsObserverAttemptIdForTickV1,
  readAgentOsObserverAttemptLedgerDecisionV1,
} from '../src/core/daemon/agent-os-observer-scheduler.js';
import { AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE } from '../src/core/vision/agent-os-source-bundle.js';
import type { AgentOsSnapshotReadResultV1 } from '../src/core/vision/agent-os-snapshot-store.js';

const TICK_AT = '2026-09-03T14:00:00.000Z';
const STARTED_AT = '2026-09-03T14:00:01.000Z';
const DEADLINE_AT = '2026-09-03T14:00:06.000Z';
const COMPLETED_AT = '2026-09-03T14:00:02.000Z';
const TICK_DIGEST = '1'.repeat(64);
const BUNDLE_DIGEST = '2'.repeat(64);
const SNAPSHOT_DIGEST = `sha256:${'3'.repeat(64)}`;
const ENVELOPE_DIGEST = '4'.repeat(64);
const TEST_KEY = Buffer.alloc(32, 0x53);

let temporary = '';
let dependencies: AgentOsObserverAttemptStoreDependenciesV1;

function startInput(attemptId = randomUUID()): AgentOsObserverAttemptStartInputV1 {
  return {
    attemptId,
    initiatingTickDigest: TICK_DIGEST,
    initiatingTickAt: TICK_AT,
    bundleDigest: BUNDLE_DIGEST,
    startedAt: STARTED_AT,
    deadlineAt: DEADLINE_AT,
  };
}

function terminalInput(
  start: AgentOsObserverAttemptStartInputV1,
  outcome: AgentOsObserverTerminalOutcomeV1 = 'completed',
): AgentOsObserverAttemptTerminalInputV1 {
  const appendFailure = outcome === 'append-failed' || outcome === 'ambiguous-after-commit';
  const success = outcome === 'completed' || outcome === 'replayed';
  return {
    ...start,
    outcome,
    bundleDigest: start.bundleDigest,
    snapshotDigest: success || appendFailure ? SNAPSHOT_DIGEST : null,
    snapshotEnvelopeDigest: success ? ENVELOPE_DIGEST : null,
    snapshotEnvelopeSequence: success ? 1 : null,
    completedAt: outcome === 'deadline-before-commit' ? DEADLINE_AT : COMPLETED_AT,
  };
}

function coherentSnapshots(start: AgentOsObserverAttemptStartInputV1): AgentOsSnapshotReadResultV1 {
  return {
    sourceState: 'healthy',
    availability: 'available',
    sourcePresent: true,
    complete: true,
    envelopes: [{
      producerAttemptId: start.attemptId,
      sourceDigest: start.bundleDigest,
      payload: { snapshotDigest: SNAPSHOT_DIGEST },
      envelopeDigest: ENVELOPE_DIGEST,
      sequence: 1,
    } as never],
    current: null,
    stopReasons: [],
    filesRead: 1,
    bytesRead: 1,
    invalidFiles: 0,
    limitExceeded: false,
    authority: 'observation-only',
    sameUserTamperResistant: false,
    rollbackProtected: false,
    historicalAuthority: false,
    executionAuthority: false,
    proposalAuthority: false,
    mergeAuthority: false,
    deployAuthority: false,
    publicationAuthority: false,
    externalMutationAuthority: false,
  };
}

function recordsDirectory(): string {
  return join(dependencies.rootPath, 'records');
}

function receiptFiles(): string[] {
  return readdirSync(recordsDirectory()).sort();
}

function readReceipt(file: string): AgentOsObserverAttemptReceiptV1 {
  return JSON.parse(readFileSync(join(recordsDirectory(), file), 'utf8')) as AgentOsObserverAttemptReceiptV1;
}

function reseal(
  receipt: AgentOsObserverAttemptReceiptV1,
  changes: Partial<AgentOsObserverAttemptReceiptV1>,
): AgentOsObserverAttemptReceiptV1 {
  const next = { ...receipt, ...changes } as Record<string, unknown>;
  delete next['receiptDigest'];
  delete next['attestation'];
  const receiptDigest = createHash('sha256')
    .update(JSON.stringify(['ashlr:agent-os-observer-attempt:receipt:v1', next]), 'utf8')
    .digest('hex');
  const attestation = createHmac('sha256', TEST_KEY)
    .update(JSON.stringify([
      'ashlr:agent-os-observer-attempt:attestation:v1',
      [receiptDigest, next['attemptId'], next['transitionOrdinal']],
    ]), 'utf8')
    .digest('hex');
  return { ...next, receiptDigest, attestation } as unknown as AgentOsObserverAttemptReceiptV1;
}

function writeReceipt(receipt: AgentOsObserverAttemptReceiptV1): string {
  const file = `${receipt.attemptId}.${receipt.transitionOrdinal}.${receipt.receiptDigest}.json`;
  writeFileSync(join(recordsDirectory(), file), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
  return file;
}

beforeEach(() => {
  temporary = resolve(mkdtempSync(join(tmpdir(), 'ashlr-agent-os-attempt-')));
  const anchorPath = join(temporary, '.ashlr');
  mkdirSync(anchorPath, { mode: 0o700 });
  dependencies = {
    anchorPath,
    rootPath: join(anchorPath, 'attempts'),
    key: Buffer.from(TEST_KEY),
  };
});

afterEach(() => {
  try { chmodSync(dependencies.rootPath, 0o700); } catch { /* absent */ }
  rmSync(temporary, { recursive: true, force: true });
});

describe('M536 Agent OS observer attempt ledger', () => {
  it('records an exact authenticated start-to-terminal chain with no authority', () => {
    const start = startInput();
    const began = beginAgentOsObserverAttemptV1(start, dependencies);
    expect(began).toMatchObject({ disposition: 'recorded', receipt: { phase: 'started' } });
    const completed = completeAgentOsObserverAttemptV1(terminalInput(start), dependencies);
    expect(completed).toMatchObject({
      disposition: 'recorded',
      receipt: {
        phase: 'terminal',
        terminalOutcome: 'completed',
        previousReceiptDigest: began.receipt?.receiptDigest,
        authority: 'observation-only',
        effectAuthority: 'none',
        executionAuthority: false,
        proposalAuthority: false,
        mergeAuthority: false,
        deployAuthority: false,
        publicationAuthority: false,
        externalMutationAuthority: false,
        policyEligible: false,
        sameUserTamperResistant: false,
        rollbackProtected: false,
        historicalAuthority: false,
      },
    });

    const read = readAgentOsObserverAttemptReceiptsV1(dependencies, { requireComplete: true });
    expect(read).toMatchObject({
      sourceState: 'healthy',
      complete: true,
      stopReasons: [],
      authority: 'observation-only',
      effectAuthority: 'none',
    });
    expect(read.records.map((receipt) => receipt.transitionOrdinal)).toEqual([1, 2]);
    expect(verifyAgentOsObserverAttemptReceiptV1(completed.receipt, dependencies))
      .toEqual(completed.receipt);
    if (process.platform !== 'win32') {
      expect(statSync(dependencies.rootPath).mode & 0o777).toBe(0o700);
      for (const file of receiptFiles()) {
        expect(statSync(join(recordsDirectory(), file)).mode & 0o777).toBe(0o600);
      }
    }
  });

  it('returns exact idempotent replay and rejects a conflicting terminal fork', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('replayed');
    const completed = terminalInput(start);
    expect(completeAgentOsObserverAttemptV1(completed, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(completed, dependencies).disposition).toBe('replayed');
    expect(completeAgentOsObserverAttemptV1({ ...completed, outcome: 'replayed' }, dependencies))
      .toEqual({ disposition: 'conflicted', receipt: null });
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies).records).toHaveLength(2);
  });

  it.each<AgentOsObserverTerminalOutcomeV1>([
    'completed',
    'replayed',
    'source-incomplete',
    'source-invalid',
    'cancelled-before-commit',
    'deadline-before-commit',
    'append-failed',
    'ambiguous-after-commit',
  ])('accepts the bounded %s terminal contract', (outcome) => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(start, outcome), dependencies))
      .toMatchObject({ disposition: 'recorded', receipt: { terminalOutcome: outcome } });
  });

  it.each<AgentOsObserverTerminalOutcomeV1>([
    'source-incomplete',
    'source-invalid',
  ])('durably closes %s when the rejected source has no valid claimed digest', (outcome) => {
    const start = { ...startInput(), bundleDigest: null };
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1({
      ...terminalInput(start, outcome),
      bundleDigest: null,
    }, dependencies)).toMatchObject({
      disposition: 'recorded',
      receipt: { terminalOutcome: outcome, bundleDigest: null },
    });
  });

  it('rejects noncanonical identities, nonmonotonic times, and incoherent outcome bindings', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1({
      ...start,
      note: 'operator prose is not part of this private receipt protocol',
    } as unknown as AgentOsObserverAttemptStartInputV1, dependencies))
      .toEqual({ disposition: 'invalid', receipt: null });
    expect(beginAgentOsObserverAttemptV1({ ...start, attemptId: start.attemptId.toUpperCase() }, dependencies))
      .toEqual({ disposition: 'invalid', receipt: null });
    expect(beginAgentOsObserverAttemptV1({ ...start, startedAt: DEADLINE_AT }, dependencies))
      .toEqual({ disposition: 'invalid', receipt: null });
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1({
      ...terminalInput(start),
      completedAt: TICK_AT,
    }, dependencies)).toEqual({ disposition: 'invalid', receipt: null });
    expect(completeAgentOsObserverAttemptV1({
      ...terminalInput(start),
      snapshotEnvelopeDigest: null,
      snapshotEnvelopeSequence: 1,
    }, dependencies)).toEqual({ disposition: 'invalid', receipt: null });
    expect(completeAgentOsObserverAttemptV1({
      ...terminalInput(start, 'append-failed'),
      snapshotEnvelopeDigest: ENVELOPE_DIGEST,
      snapshotEnvelopeSequence: 1,
    }, dependencies)).toEqual({ disposition: 'invalid', receipt: null });
  });

  it('requires the terminal transition to bind the exact initiating start', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1({
      ...terminalInput(start),
      initiatingTickDigest: '9'.repeat(64),
    }, dependencies)).toEqual({ disposition: 'invalid-transition', receipt: null });
    expect(completeAgentOsObserverAttemptV1(terminalInput(startInput()), dependencies))
      .toEqual({ disposition: 'invalid-transition', receipt: null });
  });

  it('fails the complete read closed after authenticated bytes are tampered', () => {
    const start = startInput();
    const began = beginAgentOsObserverAttemptV1(start, dependencies);
    expect(began.disposition).toBe('recorded');
    const file = receiptFiles()[0]!;
    const receipt = readReceipt(file);
    writeFileSync(join(recordsDirectory(), file), `${JSON.stringify({
      ...receipt,
      initiatingTickDigest: '8'.repeat(64),
    })}\n`, { mode: 0o600 });

    expect(verifyAgentOsObserverAttemptReceiptV1({
      ...began.receipt,
      initiatingTickDigest: '8'.repeat(64),
    }, dependencies)).toBeNull();
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies, { requireComplete: true }))
      .toMatchObject({
        sourceState: 'degraded',
        complete: false,
        records: [],
        stopReasons: expect.arrayContaining(['invalid-file']),
      });
  });

  it('detects a missing predecessor and an authenticated terminal fork', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(start), dependencies).disposition).toBe('recorded');
    const files = receiptFiles();
    const startFile = files.find((file) => file.includes('.1.'))!;
    unlinkSync(join(recordsDirectory(), startFile));
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies))
      .toMatchObject({ sourceState: 'degraded', stopReasons: expect.arrayContaining(['transition-gap']) });

    rmSync(dependencies.rootPath, { recursive: true, force: true });
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(start), dependencies).disposition).toBe('recorded');
    const terminalFile = receiptFiles().find((file) => file.includes('.2.'))!;
    const terminal = readReceipt(terminalFile);
    writeReceipt(reseal(terminal, { terminalOutcome: 'replayed' }));
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies))
      .toMatchObject({ sourceState: 'degraded', stopReasons: expect.arrayContaining(['transition-fork']) });
  });

  it('detects an authenticated terminal whose immutable start binding is wrong', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(start), dependencies).disposition).toBe('recorded');
    const terminalFile = receiptFiles().find((file) => file.includes('.2.'))!;
    const terminal = readReceipt(terminalFile);
    unlinkSync(join(recordsDirectory(), terminalFile));
    writeReceipt(reseal(terminal, { initiatingTickDigest: 'a'.repeat(64) }));
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies))
      .toMatchObject({ sourceState: 'degraded', stopReasons: expect.arrayContaining(['invalid-transition']) });
  });

  it('fails closed for a missing key and does not create key or store on default read', () => {
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies)).toMatchObject({
      sourceState: 'missing', sourcePresent: false, complete: false, records: [], stopReasons: [],
    });

    const noKey = { ...dependencies, key: null };
    expect(readAgentOsObserverAttemptReceiptsV1(noKey)).toMatchObject({
      sourceState: 'degraded', sourcePresent: false, complete: false, records: [],
      stopReasons: expect.arrayContaining(['key-unavailable']),
    });
    expect(beginAgentOsObserverAttemptV1(startInput(), noKey))
      .toEqual({ disposition: 'key-unavailable', receipt: null });

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const emptyHome = join(temporary, 'empty-home');
    mkdirSync(emptyHome, { mode: 0o700 });
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = emptyHome;
    try {
      const defaults = defaultAgentOsObserverAttemptStoreDependenciesV1('read');
      expect(defaults?.key).toBeNull();
      expect(readAgentOsObserverAttemptReceiptsV1(defaults)).toMatchObject({
        sourceState: 'degraded', stopReasons: ['key-unavailable'],
      });
      expect(existsSync(join(emptyHome, '.ashlr'))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
    }

    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(readAgentOsObserverAttemptReceiptsV1(noKey, { requireComplete: true }))
      .toMatchObject({ sourceState: 'degraded', complete: false, records: [], stopReasons: ['key-unavailable'] });
  });

  it('enforces a bounded ledger capacity without overwriting prior receipts', () => {
    dependencies = { ...dependencies, maxRecords: 2 };
    const first = startInput();
    expect(beginAgentOsObserverAttemptV1(first, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(first), dependencies).disposition).toBe('recorded');
    const before = receiptFiles().map((file) => readFileSync(join(recordsDirectory(), file), 'utf8'));
    expect(beginAgentOsObserverAttemptV1(startInput(), dependencies))
      .toEqual({ disposition: 'capacity-exhausted', receipt: null });
    expect(receiptFiles().map((file) => readFileSync(join(recordsDirectory(), file), 'utf8'))).toEqual(before);
  });

  it('deduplicates an authenticated successful source and fits the full source protocol ceiling exactly', () => {
    const first = startInput();
    expect(beginAgentOsObserverAttemptV1(first, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(first), dependencies).disposition).toBe('recorded');
    const nextTickDigest = '8'.repeat(64);
    const decision = readAgentOsObserverAttemptLedgerDecisionV1(
      agentOsObserverAttemptIdForTickV1(nextTickDigest)!,
      nextTickDigest,
      '2026-09-03T14:05:00.000Z',
      BUNDLE_DIGEST,
      Date.parse('2026-09-03T14:05:01.000Z'),
      dependencies,
      () => coherentSnapshots(first),
    );
    expect(decision).toEqual({ state: 'source-observed' });
    expect(receiptFiles()).toHaveLength(2);
    expect(AGENT_OS_SOURCE_BUNDLE_MAX_SEQUENCE * 2).toBe(AGENT_OS_OBSERVER_ATTEMPT_MAX_RECORDS);
  });

  it('requires an exact authenticated snapshot join before suppressing a successful source', () => {
    const first = startInput();
    expect(beginAgentOsObserverAttemptV1(first, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(first), dependencies).disposition).toBe('recorded');
    const args = [
      randomUUID(), '8'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse('2026-09-03T14:05:01.000Z'), dependencies,
    ] as const;
    expect(readAgentOsObserverAttemptLedgerDecisionV1(...args, () => ({
      ...coherentSnapshots(first),
      sourceState: 'missing',
      sourcePresent: false,
      complete: false,
      availability: 'unavailable',
      envelopes: [],
    }))).toEqual({ state: 'snapshot-repair-required' });
    expect(readAgentOsObserverAttemptLedgerDecisionV1(...args, () => ({
      ...coherentSnapshots(first),
      envelopes: [{
        ...coherentSnapshots(first).envelopes[0]!,
        envelopeDigest: '9'.repeat(64),
      }],
    }))).toEqual({ state: 'snapshot-store-degraded' });
  });

  it('bounds missing-snapshot regeneration by later failures and ledger capacity', () => {
    const success = startInput();
    expect(beginAgentOsObserverAttemptV1(success, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(success), dependencies).disposition).toBe('recorded');
    for (let index = 0; index < 3; index++) {
      const failed = startInput(randomUUID());
      expect(beginAgentOsObserverAttemptV1(failed, dependencies).disposition).toBe('recorded');
      expect(completeAgentOsObserverAttemptV1(terminalInput(failed, 'append-failed'), dependencies).disposition)
        .toBe('recorded');
    }
    const missingSnapshots = () => ({
      ...coherentSnapshots(success),
      sourceState: 'missing' as const,
      sourcePresent: false,
      complete: false,
      availability: 'unavailable' as const,
      envelopes: [],
    });
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '8'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse('2026-09-03T14:05:01.000Z'), dependencies, missingSnapshots,
    )).toEqual({ state: 'retry-exhausted' });

    dependencies = { ...dependencies, rootPath: join(dependencies.anchorPath, 'repair-capacity'), maxRecords: 2 };
    const capacitySuccess = startInput();
    expect(beginAgentOsObserverAttemptV1(capacitySuccess, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(capacitySuccess), dependencies).disposition).toBe('recorded');
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '9'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse('2026-09-03T14:05:01.000Z'), dependencies, missingSnapshots,
    )).toEqual({ state: 'capacity-exhausted' });
  });

  it('returns exact persisted bindings for a recoverable started attempt', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(),
      '8'.repeat(64),
      '2026-09-03T14:05:00.000Z',
      '7'.repeat(64),
      Date.parse('2026-09-03T14:05:01.000Z'),
      dependencies,
      undefined,
      () => true,
    )).toEqual({
      state: 'resume-started',
      attemptId: start.attemptId,
      tickDigest: start.initiatingTickDigest,
      tickAt: start.initiatingTickAt,
      deadlineAt: start.deadlineAt,
      bundleDigest: start.bundleDigest,
    });
  });

  it('degrades an open attempt whose initiating tick is no longer durable', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(),
      '8'.repeat(64),
      '2026-09-03T14:05:00.000Z',
      '7'.repeat(64),
      Date.parse('2026-09-03T14:05:01.000Z'),
      dependencies,
      undefined,
      () => false,
    )).toEqual({ state: 'degraded' });
  });

  it('degrades rather than reusing one closed durable tick for a different source', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(start), dependencies).disposition).toBe('recorded');

    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      start.attemptId,
      start.initiatingTickDigest,
      start.initiatingTickAt,
      '7'.repeat(64),
      Date.parse('2026-09-03T14:05:01.000Z'),
      dependencies,
    )).toEqual({ state: 'degraded' });
  });

  it('bounds failed-source retries and exposes durable-derived capacity exhaustion', () => {
    for (let index = 0; index < 3; index++) {
      const start = startInput(randomUUID());
      expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
      expect(completeAgentOsObserverAttemptV1(terminalInput(start, 'append-failed'), dependencies).disposition)
        .toBe('recorded');
    }
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '8'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse('2026-09-03T14:05:01.000Z'), dependencies,
    )).toEqual({ state: 'retry-exhausted' });

    dependencies = { ...dependencies, rootPath: join(dependencies.anchorPath, 'capacity-attempts'), maxRecords: 2 };
    const full = startInput();
    expect(beginAgentOsObserverAttemptV1(full, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(full), dependencies).disposition).toBe('recorded');
    const read = readAgentOsObserverAttemptReceiptsV1(dependencies, { requireComplete: true });
    expect(read.capacityExhausted).toBe(true);
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '9'.repeat(64), '2026-09-03T14:05:00.000Z', '7'.repeat(64),
      Date.parse('2026-09-03T14:05:01.000Z'), dependencies,
    )).toEqual({ state: 'capacity-exhausted' });
  });

  it('does not charge administrative cancellation against the failed-source retry budget', () => {
    for (let index = 0; index < 3; index++) {
      const start = startInput(randomUUID());
      expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
      expect(completeAgentOsObserverAttemptV1(
        terminalInput(start, 'cancelled-before-commit'), dependencies,
      ).disposition).toBe('recorded');
    }
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '8'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse('2026-09-03T14:05:01.000Z'), dependencies,
    )).toEqual({ state: 'missing' });
  });

  it('rejects a successful terminal recorded at or after its deadline', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1({
      ...terminalInput(start),
      completedAt: DEADLINE_AT,
    }, dependencies)).toEqual({ disposition: 'invalid', receipt: null });
  });

  it('backs off a failed source before admitting another immutable attempt', () => {
    const failed = startInput();
    expect(beginAgentOsObserverAttemptV1(failed, dependencies).disposition).toBe('recorded');
    expect(completeAgentOsObserverAttemptV1(terminalInput(failed, 'append-failed'), dependencies).disposition)
      .toBe('recorded');
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '8'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse(COMPLETED_AT) + 30_000, dependencies,
    )).toEqual({ state: 'retry-backoff' });
    expect(readAgentOsObserverAttemptLedgerDecisionV1(
      randomUUID(), '9'.repeat(64), '2026-09-03T14:05:00.000Z', BUNDLE_DIGEST,
      Date.parse(COMPLETED_AT) + 60_000, dependencies,
    )).toEqual({ state: 'missing' });
  });

  it.skipIf(process.platform === 'win32')('degrades rather than following an aliased record file', () => {
    const start = startInput();
    expect(beginAgentOsObserverAttemptV1(start, dependencies).disposition).toBe('recorded');
    const file = receiptFiles()[0]!;
    const original = join(recordsDirectory(), file);
    const moved = join(temporary, 'outside.json');
    renameSync(original, moved);
    // A symlink occupying a canonical immutable slot must never be followed.
    symlinkSync(moved, original);
    expect(readAgentOsObserverAttemptReceiptsV1(dependencies, { requireComplete: true }))
      .toMatchObject({ sourceState: 'degraded', records: [], stopReasons: expect.arrayContaining(['invalid-file']) });
  });
});

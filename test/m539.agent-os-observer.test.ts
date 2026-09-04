import { describe, expect, it, beforeEach, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  verify: vi.fn(),
  build: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  append: vi.fn(),
}));

vi.mock('../src/core/vision/agent-os-source-bundle.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/vision/agent-os-source-bundle.js')>(),
  verifyAgentOsSourceBundleV1: controls.verify,
}));

vi.mock('../src/core/vision/agent-os-read-model.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/vision/agent-os-read-model.js')>(),
  buildAgentOsReadModelV1: controls.build,
}));

vi.mock('../src/core/vision/agent-os-observer-attempt-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/vision/agent-os-observer-attempt-store.js')>(),
  beginAgentOsObserverAttemptV1: controls.begin,
  completeAgentOsObserverAttemptV1: controls.complete,
}));

vi.mock('../src/core/vision/agent-os-snapshot-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/vision/agent-os-snapshot-store.js')>(),
  appendAgentOsSnapshotV1: controls.append,
}));

import {
  observeAgentOsSourceBundleV1,
  type AgentOsObserverDependenciesV1,
  type AgentOsObserverInputV1,
} from '../src/core/vision/agent-os-observer.js';
import type {
  AgentOsObserverAttemptReceiptV1,
} from '../src/core/vision/agent-os-observer-attempt-store.js';
import type {
  AgentOsSnapshotAppendResultV1,
  AgentOsSnapshotEnvelopeV1,
} from '../src/core/vision/agent-os-snapshot-store.js';
import type {
  AgentOsReadModelInputV1,
  AgentOsReadModelVerifierV1,
} from '../src/core/vision/agent-os-read-model.js';
import type { AgentOsSourceTrustPolicyV1 } from '../src/core/vision/agent-os-source-bundle.js';

const ATTEMPT_ID = '018f3f6a-7c21-4f2a-9b5c-0123456789ab';
const OTHER_ATTEMPT_ID = '118f3f6a-7c21-4f2a-9b5c-0123456789ab';
const TICK_DIGEST = '1'.repeat(64);
const BUNDLE_DIGEST = '2'.repeat(64);
const SNAPSHOT_DIGEST = `sha256:${'3'.repeat(64)}`;
const ENVELOPE_DIGEST = '4'.repeat(64);
const TICK_AT = '2026-09-03T15:00:00.000Z';
const NOW = '2026-09-03T15:00:01.000Z';
const DEADLINE_AT = '2026-09-03T15:00:10.000Z';

const sourceBundle = Object.freeze({ bundleDigest: BUNDLE_DIGEST, signed: true });
const readModelInput = Object.freeze({ schemaVersion: 1 }) as unknown as AgentOsReadModelInputV1;
const readModelVerifier = Object.freeze({
  verifySourceBundle: vi.fn(),
  outcomeEvidenceVerifier: { verifyOutcomeEvidence: vi.fn() },
}) as unknown as AgentOsReadModelVerifierV1;
const trustPolicy = Object.freeze({
  schemaVersion: 1,
  protocol: 'agent-os-source-trust-policy-v1',
  generation: 1,
  keys: Object.freeze([]),
}) as unknown as AgentOsSourceTrustPolicyV1;

function input(): AgentOsObserverInputV1 {
  return {
    attemptId: ATTEMPT_ID,
    initiatingTickDigest: TICK_DIGEST,
    initiatingTickAt: TICK_AT,
    deadlineAt: DEADLINE_AT,
    sourceBundle,
  };
}

function receipt(
  phase: 'started' | 'terminal',
  receiptDigest = phase === 'started' ? '5'.repeat(64) : '6'.repeat(64),
): AgentOsObserverAttemptReceiptV1 {
  return {
    phase,
    receiptDigest,
  } as unknown as AgentOsObserverAttemptReceiptV1;
}

function envelope(attemptId = ATTEMPT_ID): AgentOsSnapshotEnvelopeV1 {
  return {
    producerAttemptId: attemptId,
    sourceDigest: BUNDLE_DIGEST,
    payload: { snapshotDigest: SNAPSHOT_DIGEST },
    envelopeDigest: ENVELOPE_DIGEST,
    sequence: 7,
  } as unknown as AgentOsSnapshotEnvelopeV1;
}

function appendResult(
  disposition: AgentOsSnapshotAppendResultV1['disposition'],
  value: AgentOsSnapshotEnvelopeV1 | null,
): AgentOsSnapshotAppendResultV1 {
  return {
    disposition,
    reason: disposition === 'recorded' ? 'recorded' :
      disposition === 'replayed' ? 'snapshot-replay' :
        disposition === 'rejected' ? 'invalid-input' : 'publication-failed',
    envelope: disposition === 'replayed' ? null : value,
    current: disposition === 'replayed' ? value : null,
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

function dependencies(overrides: Partial<AgentOsObserverDependenciesV1> = {}): AgentOsObserverDependenciesV1 {
  return {
    sourceTrustPolicy: trustPolicy,
    attemptStore: {
      anchorPath: '/tmp/ashlr-observer-test',
      rootPath: '/tmp/ashlr-observer-test/attempts',
      key: Buffer.alloc(32, 1),
    },
    snapshotStore: {
      anchorPath: '/tmp/ashlr-observer-test',
      rootPath: '/tmp/ashlr-observer-test/snapshots',
      signer: null,
      verifier: null,
      readModelVerifier: null,
      clock: () => new Date(NOW),
    },
    clock: () => new Date(NOW),
    killCheck: () => false,
    ...overrides,
  };
}

beforeEach(() => {
  controls.verify.mockReset().mockReturnValue({
    ok: true,
    bundleDigest: BUNDLE_DIGEST,
    readModelInput,
    verifier: readModelVerifier,
    issues: [],
  });
  controls.build.mockReset().mockReturnValue({
    ok: true,
    snapshot: Object.freeze({}),
    snapshotDigest: SNAPSHOT_DIGEST,
    issues: [],
  });
  controls.begin.mockReset().mockReturnValue({ disposition: 'recorded', receipt: receipt('started') });
  controls.complete.mockReset().mockReturnValue({ disposition: 'recorded', receipt: receipt('terminal') });
  controls.append.mockReset().mockReturnValue(appendResult('recorded', envelope()));
});

describe('M539 Agent OS bounded observer transaction', () => {
  it('authenticates one bundle, injects only its closed verifier, and commits exact lineage', () => {
    const value = input();
    const deps = dependencies();
    const observed = observeAgentOsSourceBundleV1(value, deps);

    expect(observed).toMatchObject({
      disposition: 'completed',
      attemptId: ATTEMPT_ID,
      attemptStartDisposition: 'recorded',
      terminalDisposition: 'recorded',
      terminalPersisted: true,
      snapshotDisposition: 'recorded',
      snapshotCommit: 'recorded',
      bundleDigest: BUNDLE_DIGEST,
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshotEnvelopeDigest: ENVELOPE_DIGEST,
      snapshotEnvelopeSequence: 7,
      authority: 'observation-only',
      effectAuthority: 'none',
      executionAuthority: false,
      externalMutationAuthority: false,
    });
    expect(controls.begin).toHaveBeenCalledBefore(controls.verify);
    expect(controls.verify).toHaveBeenCalledWith(sourceBundle, trustPolicy, new Date(NOW));
    expect(controls.append).toHaveBeenCalledWith(
      { readModelInput, producerAttemptId: ATTEMPT_ID },
      expect.objectContaining({
        readModelVerifier: { bundleDigest: BUNDLE_DIGEST, verifier: readModelVerifier },
      }),
    );
    const injected = controls.append.mock.calls[0]?.[1].readModelVerifier as Record<string, unknown>;
    expect(Object.keys(injected).sort()).toEqual(['bundleDigest', 'verifier']);
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: ATTEMPT_ID,
      initiatingTickDigest: TICK_DIGEST,
      initiatingTickAt: TICK_AT,
      startedAt: TICK_AT,
      deadlineAt: DEADLINE_AT,
      outcome: 'completed',
      bundleDigest: BUNDLE_DIGEST,
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshotEnvelopeDigest: ENVELOPE_DIGEST,
      snapshotEnvelopeSequence: 7,
    }), deps.attemptStore);
  });

  it('preserves exact attempt and snapshot replay semantics', () => {
    controls.begin.mockReturnValue({ disposition: 'replayed', receipt: receipt('started') });
    controls.append.mockReturnValue(appendResult('replayed', envelope()));
    controls.complete.mockReturnValue({ disposition: 'replayed', receipt: receipt('terminal') });

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'replayed',
      attemptStartDisposition: 'replayed',
      terminalDisposition: 'replayed',
      terminalPersisted: true,
      snapshotCommit: 'replayed',
      snapshotEnvelopeDigest: ENVELOPE_DIGEST,
    });
  });

  it.each([
    ['trust-root-unprovisioned', 'source-incomplete'],
    ['bundle-signature-invalid', 'source-invalid'],
  ] as const)('records %s verification failure as %s without appending', (issue, outcome) => {
    controls.verify.mockReturnValue({
      ok: false,
      bundleDigest: null,
      readModelInput: null,
      verifier: null,
      issues: [issue],
    });

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: outcome,
      terminalPersisted: true,
      bundleDigest: BUNDLE_DIGEST,
      snapshotDigest: null,
      snapshotCommit: 'none',
    });
    expect(controls.append).not.toHaveBeenCalled();
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome,
      bundleDigest: BUNDLE_DIGEST,
      snapshotDigest: null,
    }), expect.anything());
  });

  it('closes an invalid-source attempt even when the source has no claimed digest', () => {
    controls.verify.mockReturnValue({
      ok: false,
      bundleDigest: null,
      readModelInput: null,
      verifier: null,
      issues: ['invalid-input'],
    });
    const value = { ...input(), sourceBundle: { malformed: true } };

    expect(observeAgentOsSourceBundleV1(value, dependencies())).toMatchObject({
      disposition: 'source-invalid',
      terminalPersisted: true,
      bundleDigest: null,
      snapshotCommit: 'none',
    });
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'source-invalid',
      bundleDigest: null,
    }), expect.anything());
  });

  it('records a kill observed immediately before verification', () => {
    let killed = false;
    const deps = dependencies({
      killCheck: () => killed,
      phaseHook: (phase) => { if (phase === 'before-verification') killed = true; },
    });

    expect(observeAgentOsSourceBundleV1(input(), deps)).toMatchObject({
      disposition: 'cancelled-before-commit', terminalPersisted: true, snapshotCommit: 'none',
    });
    expect(controls.verify).not.toHaveBeenCalled();
    expect(controls.append).not.toHaveBeenCalled();
  });

  it('records an abort race immediately before append', () => {
    const controller = new AbortController();
    const deps = dependencies({
      signal: controller.signal,
      phaseHook: (phase) => { if (phase === 'before-append') controller.abort(); },
    });

    expect(observeAgentOsSourceBundleV1(input(), deps)).toMatchObject({
      disposition: 'cancelled-before-commit', terminalPersisted: true, snapshotCommit: 'none',
    });
    expect(controls.verify).toHaveBeenCalledOnce();
    expect(controls.append).not.toHaveBeenCalled();
  });

  it('records a deadline race immediately before append', () => {
    let now = NOW;
    const deps = dependencies({
      clock: () => new Date(now),
      phaseHook: (phase) => { if (phase === 'before-append') now = DEADLINE_AT; },
    });

    expect(observeAgentOsSourceBundleV1(input(), deps)).toMatchObject({
      disposition: 'deadline-before-commit', terminalPersisted: true, snapshotCommit: 'none',
    });
    expect(controls.append).not.toHaveBeenCalled();
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'deadline-before-commit', completedAt: DEADLINE_AT,
    }), expect.anything());
  });

  it('maps the snapshot store final commit fence to a cancellation terminal', () => {
    let checks = 0;
    controls.append.mockImplementation((_value, snapshotDependencies) => {
      const reason = snapshotDependencies.commitGuard?.();
      return { ...appendResult('rejected', null), reason };
    });
    const result = observeAgentOsSourceBundleV1(input(), dependencies({
      killCheck: () => ++checks >= 3,
    }));
    expect(result).toMatchObject({
      disposition: 'cancelled-before-commit',
      terminalPersisted: true,
      snapshotDisposition: 'rejected',
      snapshotCommit: 'none',
    });
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'cancelled-before-commit',
      snapshotDigest: null,
    }), expect.anything());
  });

  it('records a rejected append as append-failed with the precomputed snapshot digest', () => {
    controls.append.mockReturnValue(appendResult('rejected', null));

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'append-failed',
      terminalPersisted: true,
      snapshotDisposition: 'rejected',
      snapshotCommit: 'none',
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshotEnvelopeDigest: null,
    });
  });

  it('reports explicit post-commit ambiguity without fabricating terminal persistence', () => {
    controls.complete.mockReturnValue({ disposition: 'persistence-failed', receipt: null });

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'ambiguous-after-commit',
      terminalDisposition: 'persistence-failed',
      terminalReceiptDigest: null,
      terminalPersisted: false,
      snapshotDisposition: 'recorded',
      snapshotCommit: 'recorded',
      snapshotEnvelopeDigest: ENVELOPE_DIGEST,
    });
  });

  it('records a potentially committed failed publication as ambiguous', () => {
    controls.append.mockReturnValue(appendResult('failed', envelope()));

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'ambiguous-after-commit',
      terminalPersisted: true,
      snapshotDisposition: 'failed',
      snapshotCommit: 'ambiguous',
      snapshotEnvelopeDigest: null,
      snapshotEnvelopeSequence: null,
    });
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'ambiguous-after-commit',
      snapshotDigest: SNAPSHOT_DIGEST,
      snapshotEnvelopeDigest: null,
      snapshotEnvelopeSequence: null,
    }), expect.anything());
  });

  it('refuses a replay that belongs to a different producer attempt', () => {
    controls.append.mockReturnValue(appendResult('replayed', envelope(OTHER_ATTEMPT_ID)));

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'append-failed',
      terminalPersisted: true,
      snapshotDisposition: 'replayed',
      snapshotCommit: 'none',
      snapshotEnvelopeDigest: null,
    });
    expect(controls.complete).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: ATTEMPT_ID,
      outcome: 'append-failed',
      snapshotEnvelopeDigest: null,
    }), expect.anything());
  });

  it('treats a recorded envelope with the wrong attempt binding as post-commit ambiguity', () => {
    controls.append.mockReturnValue(appendResult('recorded', envelope(OTHER_ATTEMPT_ID)));

    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'ambiguous-after-commit',
      terminalPersisted: true,
      snapshotDisposition: 'recorded',
      snapshotCommit: 'ambiguous',
      snapshotEnvelopeDigest: null,
    });
  });

  it('rejects noncanonical or expanded transaction inputs before durable work', () => {
    expect(observeAgentOsSourceBundleV1({
      ...input(),
      attemptId: ATTEMPT_ID.toUpperCase(),
    }, dependencies())).toMatchObject({ disposition: 'invalid-input', attemptId: null });
    expect(observeAgentOsSourceBundleV1({
      ...input(),
      note: 'not part of the bounded protocol',
    } as unknown as AgentOsObserverInputV1, dependencies()))
      .toMatchObject({ disposition: 'invalid-input', attemptId: null });
    expect(controls.begin).not.toHaveBeenCalled();
  });

  it('stops when the durable attempt cannot begin', () => {
    controls.begin.mockReturnValue({ disposition: 'key-unavailable', receipt: null });
    expect(observeAgentOsSourceBundleV1(input(), dependencies())).toMatchObject({
      disposition: 'attempt-unavailable',
      attemptId: ATTEMPT_ID,
      attemptStartDisposition: 'key-unavailable',
      terminalPersisted: false,
      snapshotCommit: 'none',
    });
    expect(controls.verify).not.toHaveBeenCalled();
  });
});

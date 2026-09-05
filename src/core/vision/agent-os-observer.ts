/**
 * Bounded, synchronous Agent OS observation transaction.
 *
 * The observer authenticates one caller-supplied source bundle and may append
 * one inert snapshot. It imports no execution surface and grants no authority.
 */

import { buildAgentOsReadModelV1 } from './agent-os-read-model.js';
import {
  beginAgentOsObserverAttemptV1,
  completeAgentOsObserverAttemptV1,
  type AgentOsObserverAttemptReceiptV1,
  type AgentOsObserverAttemptStoreDependenciesV1,
  type AgentOsObserverAttemptWriteDispositionV1,
  type AgentOsObserverTerminalOutcomeV1,
} from './agent-os-observer-attempt-store.js';
import {
  appendAgentOsSnapshotV1,
  type AgentOsSnapshotAppendResultV1,
  type AgentOsSnapshotEnvelopeV1,
  type AgentOsSnapshotStoreDependenciesV1,
} from './agent-os-snapshot-store.js';
import {
  verifyAgentOsSourceBundleV1,
  type AgentOsSourceTrustPolicyV1,
} from './agent-os-source-bundle.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAIN_SHA256_RE = /^[a-f0-9]{64}$/;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/;
const INPUT_KEYS = new Set([
  'attemptId',
  'initiatingTickDigest',
  'initiatingTickAt',
  'deadlineAt',
  'sourceBundle',
]);

export type AgentOsObserverPhaseV1 =
  | 'after-attempt-begin'
  | 'before-verification'
  | 'after-verification'
  | 'before-append'
  | 'after-append'
  | 'before-terminal-receipt';

export interface AgentOsObserverInputV1 {
  attemptId: string;
  initiatingTickDigest: string;
  initiatingTickAt: string;
  deadlineAt: string;
  sourceBundle: unknown;
}

export interface AgentOsObserverDependenciesV1 {
  sourceTrustPolicy: AgentOsSourceTrustPolicyV1;
  attemptStore: AgentOsObserverAttemptStoreDependenciesV1;
  snapshotStore: AgentOsSnapshotStoreDependenciesV1;
  clock: () => Date;
  killCheck: () => boolean;
  signal?: AbortSignal;
  /** Test/telemetry seam only. Exceptions are ignored and grant no authority. */
  phaseHook?: (phase: AgentOsObserverPhaseV1) => void;
}

export type AgentOsObserverDispositionV1 =
  | 'invalid-input'
  | 'attempt-unavailable'
  | AgentOsObserverTerminalOutcomeV1;

export type AgentOsObserverSnapshotCommitV1 =
  | 'none'
  | 'recorded'
  | 'replayed'
  | 'ambiguous';

export interface AgentOsObserverResultV1 {
  disposition: AgentOsObserverDispositionV1;
  attemptId: string | null;
  attemptStartDisposition: AgentOsObserverAttemptWriteDispositionV1 | null;
  attemptStartReceiptDigest: string | null;
  terminalDisposition: AgentOsObserverAttemptWriteDispositionV1 | null;
  terminalReceiptDigest: string | null;
  terminalPersisted: boolean;
  snapshotDisposition: AgentOsSnapshotAppendResultV1['disposition'] | null;
  snapshotCommit: AgentOsObserverSnapshotCommitV1;
  bundleDigest: string | null;
  snapshotDigest: string | null;
  snapshotEnvelopeDigest: string | null;
  snapshotEnvelopeSequence: number | null;
  authority: 'observation-only';
  effectAuthority: 'none';
  executionAuthority: false;
  proposalAuthority: false;
  mergeAuthority: false;
  releaseAuthority: false;
  deployAuthority: false;
  publicationAuthority: false;
  externalMutationAuthority: false;
}

const AUTHORITY = Object.freeze({
  authority: 'observation-only' as const,
  effectAuthority: 'none' as const,
  executionAuthority: false as const,
  proposalAuthority: false as const,
  mergeAuthority: false as const,
  releaseAuthority: false as const,
  deployAuthority: false as const,
  publicationAuthority: false as const,
  externalMutationAuthority: false as const,
});

interface ResultState {
  disposition: AgentOsObserverDispositionV1;
  attemptId?: string | null;
  startDisposition?: AgentOsObserverAttemptWriteDispositionV1 | null;
  startReceipt?: AgentOsObserverAttemptReceiptV1 | null;
  terminalDisposition?: AgentOsObserverAttemptWriteDispositionV1 | null;
  terminalReceipt?: AgentOsObserverAttemptReceiptV1 | null;
  snapshotDisposition?: AgentOsSnapshotAppendResultV1['disposition'] | null;
  snapshotCommit?: AgentOsObserverSnapshotCommitV1;
  bundleDigest?: string | null;
  snapshotDigest?: string | null;
  snapshotEnvelopeDigest?: string | null;
  snapshotEnvelopeSequence?: number | null;
}

interface GateResult {
  stop: 'cancelled-before-commit' | 'deadline-before-commit' | null;
  now: Date;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (keys.some((key) => {
      const descriptor = descriptors[String(key)];
      return !descriptor?.enumerable || !('value' in descriptor);
    })) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function exactKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_RE.test(value);
}

function sameDigest(left: unknown, right: unknown): boolean {
  return digest(left) && digest(right) &&
    left.replace(/^sha256:/u, '') === right.replace(/^sha256:/u, '');
}

function validInput(value: unknown): value is AgentOsObserverInputV1 {
  const row = recordOf(value);
  if (!row || !exactKeys(row, INPUT_KEYS)) return false;
  const input = value as AgentOsObserverInputV1;
  return UUID_V4_RE.test(input.attemptId) && PLAIN_SHA256_RE.test(input.initiatingTickDigest) &&
    canonicalTimestamp(input.initiatingTickAt) && canonicalTimestamp(input.deadlineAt) &&
    Date.parse(input.initiatingTickAt) < Date.parse(input.deadlineAt);
}

function validDependencies(value: unknown): value is AgentOsObserverDependenciesV1 {
  const dependencies = recordOf(value);
  if (!dependencies || !recordOf(dependencies['sourceTrustPolicy']) ||
    !recordOf(dependencies['attemptStore']) || !recordOf(dependencies['snapshotStore']) ||
    typeof dependencies['clock'] !== 'function' || typeof dependencies['killCheck'] !== 'function' ||
    (dependencies['phaseHook'] !== undefined && typeof dependencies['phaseHook'] !== 'function')) return false;
  const snapshotStore = dependencies['snapshotStore'] as unknown as AgentOsSnapshotStoreDependenciesV1;
  return snapshotStore.readModelVerifier === null;
}

function result(state: ResultState): AgentOsObserverResultV1 {
  const terminalPersisted = Boolean(
    state.terminalReceipt &&
    (state.terminalDisposition === 'recorded' || state.terminalDisposition === 'replayed'),
  );
  return {
    disposition: state.disposition,
    attemptId: state.attemptId ?? null,
    attemptStartDisposition: state.startDisposition ?? null,
    attemptStartReceiptDigest: state.startReceipt?.receiptDigest ?? null,
    terminalDisposition: state.terminalDisposition ?? null,
    terminalReceiptDigest: terminalPersisted ? state.terminalReceipt!.receiptDigest : null,
    terminalPersisted,
    snapshotDisposition: state.snapshotDisposition ?? null,
    snapshotCommit: state.snapshotCommit ?? 'none',
    bundleDigest: state.bundleDigest ?? null,
    snapshotDigest: state.snapshotDigest ?? null,
    snapshotEnvelopeDigest: state.snapshotEnvelopeDigest ?? null,
    snapshotEnvelopeSequence: state.snapshotEnvelopeSequence ?? null,
    ...AUTHORITY,
  };
}

function invokeHook(dependencies: AgentOsObserverDependenciesV1, phase: AgentOsObserverPhaseV1): void {
  try { dependencies.phaseHook?.(phase); } catch { /* observation hook has no control authority */ }
}

function logicalNow(dependencies: AgentOsObserverDependenciesV1, floor: string): Date | null {
  try {
    const value = dependencies.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
    return new Date(Math.max(value.getTime(), Date.parse(floor)));
  } catch {
    return null;
  }
}

function gate(
  input: AgentOsObserverInputV1,
  dependencies: AgentOsObserverDependenciesV1,
): GateResult {
  let cancelled = dependencies.signal?.aborted === true;
  try { cancelled ||= dependencies.killCheck(); } catch { cancelled = true; }
  const now = logicalNow(dependencies, input.initiatingTickAt);
  if (!now) return { stop: 'cancelled-before-commit', now: new Date(input.initiatingTickAt) };
  if (cancelled) return { stop: 'cancelled-before-commit', now };
  return now.getTime() >= Date.parse(input.deadlineAt)
    ? { stop: 'deadline-before-commit', now }
    : { stop: null, now };
}

function claimedBundleDigest(sourceBundle: unknown): string | null {
  const bundle = recordOf(sourceBundle);
  return bundle && digest(bundle['bundleDigest']) ? bundle['bundleDigest'] : null;
}

function boundEnvelope(
  envelope: AgentOsSnapshotEnvelopeV1 | null,
  input: AgentOsObserverInputV1,
  bundleDigest: string,
  snapshotDigest: string,
): AgentOsSnapshotEnvelopeV1 | null {
  return envelope && envelope.producerAttemptId === input.attemptId &&
    sameDigest(envelope.sourceDigest, bundleDigest) &&
    sameDigest(envelope.payload.snapshotDigest, snapshotDigest) &&
    PLAIN_SHA256_RE.test(envelope.envelopeDigest) && Number.isSafeInteger(envelope.sequence) && envelope.sequence >= 1
    ? envelope
    : null;
}

function persistTerminal(
  input: AgentOsObserverInputV1,
  dependencies: AgentOsObserverDependenciesV1,
  startReceipt: AgentOsObserverAttemptReceiptV1,
  startDisposition: 'recorded' | 'replayed',
  outcome: AgentOsObserverTerminalOutcomeV1,
  bundleDigest: string | null,
  snapshotDigest: string | null,
  envelope: AgentOsSnapshotEnvelopeV1 | null,
  completedAt: Date,
  snapshotDisposition: AgentOsSnapshotAppendResultV1['disposition'] | null,
  snapshotCommit: AgentOsObserverSnapshotCommitV1,
): AgentOsObserverResultV1 {
  invokeHook(dependencies, 'before-terminal-receipt');
  let terminal: ReturnType<typeof completeAgentOsObserverAttemptV1>;
  try {
    terminal = completeAgentOsObserverAttemptV1({
      attemptId: input.attemptId,
      initiatingTickDigest: input.initiatingTickDigest,
      initiatingTickAt: input.initiatingTickAt,
      startedAt: input.initiatingTickAt,
      deadlineAt: input.deadlineAt,
      outcome,
      bundleDigest,
      snapshotDigest,
      snapshotEnvelopeDigest: envelope?.envelopeDigest ?? null,
      snapshotEnvelopeSequence: envelope?.sequence ?? null,
      completedAt: completedAt.toISOString(),
    }, dependencies.attemptStore);
  } catch {
    terminal = { disposition: 'persistence-failed', receipt: null };
  }
  const terminalPersisted = Boolean(
    terminal.receipt && (terminal.disposition === 'recorded' || terminal.disposition === 'replayed'),
  );
  const committed = snapshotCommit !== 'none';
  return result({
    disposition: committed && !terminalPersisted ? 'ambiguous-after-commit' : outcome,
    attemptId: input.attemptId,
    startDisposition,
    startReceipt,
    terminalDisposition: terminal.disposition,
    terminalReceipt: terminal.receipt,
    snapshotDisposition,
    snapshotCommit,
    bundleDigest,
    snapshotDigest,
    snapshotEnvelopeDigest: envelope?.envelopeDigest ?? null,
    snapshotEnvelopeSequence: envelope?.sequence ?? null,
  });
}

/** Observe one signed source bundle without invoking models, tools, providers, or effects. */
export function observeAgentOsSourceBundleV1(
  input: AgentOsObserverInputV1,
  dependencies: AgentOsObserverDependenciesV1,
): AgentOsObserverResultV1 {
  if (!validInput(input) || !validDependencies(dependencies)) {
    return result({ disposition: 'invalid-input' });
  }

  let began: ReturnType<typeof beginAgentOsObserverAttemptV1>;
  try {
    began = beginAgentOsObserverAttemptV1({
      attemptId: input.attemptId,
      initiatingTickDigest: input.initiatingTickDigest,
      initiatingTickAt: input.initiatingTickAt,
      bundleDigest: claimedBundleDigest(input.sourceBundle),
      startedAt: input.initiatingTickAt,
      deadlineAt: input.deadlineAt,
    }, dependencies.attemptStore);
  } catch {
    began = { disposition: 'persistence-failed', receipt: null };
  }
  if (!began.receipt || (began.disposition !== 'recorded' && began.disposition !== 'replayed')) {
    return result({
      disposition: 'attempt-unavailable',
      attemptId: input.attemptId,
      startDisposition: began.disposition,
    });
  }
  const startReceipt = began.receipt;
  const startDisposition = began.disposition;

  invokeHook(dependencies, 'after-attempt-begin');
  invokeHook(dependencies, 'before-verification');
  const beforeVerification = gate(input, dependencies);
  if (beforeVerification.stop) {
    return persistTerminal(
      input, dependencies, startReceipt, startDisposition, beforeVerification.stop,
      claimedBundleDigest(input.sourceBundle),
      null, null, beforeVerification.now, null, 'none',
    );
  }

  let verification: ReturnType<typeof verifyAgentOsSourceBundleV1>;
  try {
    verification = verifyAgentOsSourceBundleV1(
      input.sourceBundle,
      dependencies.sourceTrustPolicy,
      beforeVerification.now,
    );
  } catch {
    verification = {
      ok: false,
      bundleDigest: null,
      readModelInput: null,
      verifier: null,
      issues: ['invalid-input'],
    };
  }
  invokeHook(dependencies, 'after-verification');
  if (!verification.ok) {
    const outcome = verification.issues[0] === 'trust-root-unprovisioned'
      ? 'source-incomplete'
      : 'source-invalid';
    return persistTerminal(
      input, dependencies, startReceipt, startDisposition, outcome,
      claimedBundleDigest(input.sourceBundle), null, null,
      logicalNow(dependencies, input.initiatingTickAt) ?? beforeVerification.now, null, 'none',
    );
  }

  const readModel = buildAgentOsReadModelV1(verification.readModelInput, verification.verifier);
  if (!readModel.ok) {
    return persistTerminal(
      input, dependencies, startReceipt, startDisposition, 'source-invalid',
      verification.bundleDigest, null, null,
      logicalNow(dependencies, input.initiatingTickAt) ?? beforeVerification.now, null, 'none',
    );
  }

  invokeHook(dependencies, 'before-append');
  const beforeAppend = gate(input, dependencies);
  if (beforeAppend.stop) {
    return persistTerminal(
      input, dependencies, startReceipt, startDisposition, beforeAppend.stop,
      verification.bundleDigest, null, null,
      beforeAppend.now, null, 'none',
    );
  }

  let append: AgentOsSnapshotAppendResultV1;
  try {
    append = appendAgentOsSnapshotV1({
      readModelInput: verification.readModelInput,
      producerAttemptId: input.attemptId,
    }, {
      ...dependencies.snapshotStore,
      readModelVerifier: {
        bundleDigest: verification.bundleDigest,
        verifier: verification.verifier,
      },
      commitGuard: () => gate(input, dependencies).stop ?? 'allow',
    });
  } catch {
    append = {
      disposition: 'failed',
      reason: 'publication-failed',
      envelope: null,
      current: null,
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
  invokeHook(dependencies, 'after-append');

  const returnedEnvelope = append.disposition === 'replayed' ? append.current : append.envelope;
  const envelope = boundEnvelope(
    returnedEnvelope,
    input,
    verification.bundleDigest,
    readModel.snapshotDigest,
  );
  const terminalAt = logicalNow(dependencies, input.initiatingTickAt) ?? beforeAppend.now;

  if (append.disposition === 'recorded' && envelope) {
    return persistTerminal(
      input, dependencies, startReceipt, startDisposition, 'completed', verification.bundleDigest,
      readModel.snapshotDigest, envelope, terminalAt, append.disposition, 'recorded',
    );
  }
  if (append.disposition === 'replayed' && envelope) {
    return persistTerminal(
      input, dependencies, startReceipt, startDisposition, 'replayed', verification.bundleDigest,
      readModel.snapshotDigest, envelope, terminalAt, append.disposition, 'replayed',
    );
  }

  if (append.reason === 'cancelled-before-commit' || append.reason === 'deadline-before-commit') {
    return persistTerminal(
      input,
      dependencies,
      startReceipt,
      startDisposition,
      append.reason,
      verification.bundleDigest,
      null,
      null,
      terminalAt,
      append.disposition,
      'none',
    );
  }

  const commitAmbiguous = append.disposition === 'recorded' ||
    (append.disposition === 'failed' && append.envelope !== null);
  return persistTerminal(
    input,
    dependencies,
    startReceipt,
    startDisposition,
    commitAmbiguous ? 'ambiguous-after-commit' : 'append-failed',
    verification.bundleDigest,
    readModel.snapshotDigest,
    null,
    terminalAt,
    append.disposition,
    commitAmbiguous ? 'ambiguous' : 'none',
  );
}

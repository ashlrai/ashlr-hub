import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { AshlrConfig } from '../types.js';
import { resolveGitHubOriginAuthorityDetails, type GitHubOriginAuthority } from '../git.js';
import { audit } from '../sandbox/audit.js';
import {
  inspectCommittedAutoMergeCanaryPatch,
  type AutoMergeCanaryCommittedClassification,
} from './automerge-canary.js';
import {
  appendShadowObservation,
  readAutomergeCanaryStore,
  type AutoMergeCanaryCas,
  type AutoMergeCanaryReadResult,
  type AutoMergeCanaryShadowObservationInput,
  type AutoMergeCanaryShadowOutcome,
  type AutoMergeCanaryStateV1,
  type AutoMergeCanaryWriteResult,
} from './automerge-canary-store.js';

const HASH_DOMAINS = {
  repository: 'ashlr:automerge-canary-observer:repository:v1',
  fetchDestination: 'ashlr:automerge-canary-observer:fetch-destination:v1',
  pushDestination: 'ashlr:automerge-canary-observer:push-destination:v1',
  baseRef: 'ashlr:automerge-canary-observer:base-ref:v1',
  policy: 'ashlr:automerge-canary-observer:policy:v1',
  config: 'ashlr:automerge-canary-observer:config:v1',
  classifier: 'ashlr:automerge-canary-observer:classifier:v1',
  path: 'ashlr:automerge-canary-observer:path:v1',
  reason: 'ashlr:automerge-canary-observer:reason:v1',
  observation: 'ashlr:automerge-canary-observer:observation:v1',
} as const;

const POLICY_FACTS = {
  authority: 'observation-only',
  enforceSupported: false,
  patchClass: 'docs-only',
  mode: 'shadow',
} as const;

const CLASSIFIER_FACTS = {
  algorithm: 'committed-docs-only',
  immutableCommitPair: true,
  version: 1,
} as const;

const ASYNC_OBSERVER_MAX_INPUT_BYTES = 256 * 1024;
const ASYNC_OBSERVER_MAX_OUTPUT_BYTES = 16 * 1024;
const ASYNC_OBSERVER_TIMEOUT_MS = 20_000;

const ASYNC_OBSERVER_CHILD_SOURCE = String.raw`
const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > ${ASYNC_OBSERVER_MAX_INPUT_BYTES}) process.exit(64);
  chunks.push(chunk);
}
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const observer = await import(payload.moduleUrl);
const result = observer.observeAutoMergeCanaryShadow(payload.input);
process.stdout.write(JSON.stringify(result));
`;

export type AutoMergeCanaryBindingField =
  | 'repositoryId'
  | 'fetchDestinationDigest'
  | 'pushDestinationDigest'
  | 'baseRefDigest'
  | 'baseOid'
  | 'headOid'
  | 'policyDigest'
  | 'configDigest'
  | 'classifierDigest'
  | 'pathDigest';

export interface AutoMergeCanaryCandidateBindings {
  repositoryId: string;
  fetchDestinationDigest: string;
  pushDestinationDigest: string;
  baseRefDigest: string;
  baseOid: string;
  headOid: string;
  policyDigest: string;
  configDigest: string;
  classifierDigest: string;
  pathDigest: string;
}

interface AutoMergeCanaryObservedBindings {
  repositoryId: string;
  fetchDestinationDigest: string;
  pushDestinationDigest: string;
  baseRefDigest: string;
  baseOid: string | null;
  headOid: string | null;
  policyDigest: string;
  configDigest: string;
  classifierDigest: string;
  pathDigest: string | null;
}

export interface AutoMergeCanaryShadowObserverInput {
  repo: string;
  baseRef: string;
  baseOid: string;
  headOid: string;
  cfg: AshlrConfig;
}

type AutoMergeCanaryObserverFailureStage = 'read' | 'derive' | 'inspect' | 'append' | 'retry';

export type AutoMergeCanaryShadowObserverResult =
  | { status: 'inactive' }
  | {
      status: 'observed';
      outcome: AutoMergeCanaryShadowOutcome;
      mismatchFields: AutoMergeCanaryBindingField[];
      observationDigest: string;
      casRetries: 0 | 1;
    }
  | { status: 'failed'; stage: AutoMergeCanaryObserverFailureStage };

interface ObserverDependencies {
  readStore: () => AutoMergeCanaryReadResult;
  appendObservation: (
    expected: AutoMergeCanaryCas,
    input: AutoMergeCanaryShadowObservationInput,
  ) => AutoMergeCanaryWriteResult;
  inspectCommitted: typeof inspectCommittedAutoMergeCanaryPatch;
  resolveOrigin: (repo: string) => GitHubOriginAuthority | null;
  now: () => Date;
  auditEvent: typeof audit;
}

export interface AutoMergeCanaryShadowObserverOptions {
  /** Test seams only; production callers use the fixed bounded dependencies. */
  deps?: Partial<ObserverDependencies>;
}

function isObserverResult(value: unknown): value is AutoMergeCanaryShadowObserverResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.status === 'inactive') return true;
  if (candidate.status === 'failed') {
    return candidate.stage === 'read' || candidate.stage === 'derive' || candidate.stage === 'inspect' ||
      candidate.stage === 'append' || candidate.stage === 'retry';
  }
  return candidate.status === 'observed' &&
    (candidate.outcome === 'eligible' || candidate.outcome === 'rejected' ||
      candidate.outcome === 'binding-mismatch' || candidate.outcome === 'inspection-error') &&
    Array.isArray(candidate.mismatchFields) &&
    typeof candidate.observationDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.observationDigest) &&
    (candidate.casRetries === 0 || candidate.casRetries === 1);
}

const DEFAULT_DEPS: ObserverDependencies = {
  readStore: readAutomergeCanaryStore,
  appendObservation: appendShadowObservation,
  inspectCommitted: inspectCommittedAutoMergeCanaryPatch,
  resolveOrigin: resolveGitHubOriginAuthorityDetails,
  now: () => new Date(),
  auditEvent: audit,
};

function stableHash(domain: string, value: unknown): string {
  return createHash('sha256').update(JSON.stringify([domain, value]), 'utf8').digest('hex');
}

function normalizedAutoMergeConfig(cfg: AshlrConfig): Record<string, unknown> {
  const value = cfg.foundry?.autoMerge;
  const checks = value?.protectedRemote?.requiredChecks ?? [];
  return {
    allowSelfMerge: value?.allowSelfMerge === true,
    allowWithoutVerification: value?.allowWithoutVerification === true,
    enabled: value?.enabled === true,
    managerGate: value?.managerGate === true,
    maxAutomergeFiles: value?.maxAutomergeFiles ?? 4,
    maxAutomergeLines: value?.maxAutomergeLines ?? 150,
    maxRisk: value?.maxRisk ?? 'low',
    midToBranch: value?.midToBranch === true,
    protectedRemote: value?.protectedRemote
      ? {
          branchProtection: value.protectedRemote.branchProtection === true,
          requiredChecks: checks.map((check) => typeof check === 'string'
            ? check
            : { context: check.context, appId: String(check.appId) }).sort((left, right) => {
              const leftJson = JSON.stringify(left);
              const rightJson = JSON.stringify(right);
              return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
            }),
        }
      : null,
    pushToRemote: value?.pushToRemote === true,
    trustBasis: value?.trustBasis ?? 'tier',
    verifyBeforeJudgePerPass: value?.verifyBeforeJudgePerPass ?? null,
  };
}

function canonicalBaseRef(baseRef: string): string | null {
  if (!baseRef || baseRef.length > 255 || baseRef.includes('\0') || baseRef.startsWith('-')) return null;
  const ref = baseRef.startsWith('refs/heads/') ? baseRef : `refs/heads/${baseRef}`;
  return /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/') && !ref.endsWith('.')
    ? ref
    : null;
}

function deriveStaticBindings(
  input: AutoMergeCanaryShadowObserverInput,
  origin: GitHubOriginAuthority,
): Omit<AutoMergeCanaryCandidateBindings, 'baseOid' | 'headOid' | 'pathDigest'> | null {
  const baseRef = canonicalBaseRef(input.baseRef);
  if (!baseRef) return null;
  const repositoryPath = realpathSync(input.repo);
  const nameWithOwner = origin.nameWithOwner.toLowerCase();
  return {
    repositoryId: stableHash(HASH_DOMAINS.repository, { nameWithOwner, repositoryPath }),
    fetchDestinationDigest: stableHash(HASH_DOMAINS.fetchDestination, {
      nameWithOwner,
      urls: [...origin.fetchUrls].sort(),
    }),
    pushDestinationDigest: stableHash(HASH_DOMAINS.pushDestination, {
      nameWithOwner,
      urls: [...origin.pushUrls].sort(),
    }),
    baseRefDigest: stableHash(HASH_DOMAINS.baseRef, baseRef),
    policyDigest: stableHash(HASH_DOMAINS.policy, POLICY_FACTS),
    configDigest: stableHash(HASH_DOMAINS.config, normalizedAutoMergeConfig(input.cfg)),
    classifierDigest: stableHash(HASH_DOMAINS.classifier, CLASSIFIER_FACTS),
  };
}

function deriveBindings(
  input: AutoMergeCanaryShadowObserverInput,
  origin: GitHubOriginAuthority,
  inspection: AutoMergeCanaryCommittedClassification,
): AutoMergeCanaryCandidateBindings | null {
  const fixed = deriveStaticBindings(input, origin);
  if (!fixed || !inspection.baseCommitOid || !inspection.headCommitOid || !inspection.pathDigest) return null;
  return {
    ...fixed,
    baseOid: inspection.baseCommitOid,
    headOid: inspection.headCommitOid,
    pathDigest: stableHash(HASH_DOMAINS.path, inspection.pathDigest),
  };
}

/** Derive activation-compatible bindings without consulting active canary state. */
export function deriveAutoMergeCanaryCandidateBindings(
  input: AutoMergeCanaryShadowObserverInput,
  options: AutoMergeCanaryShadowObserverOptions = {},
): AutoMergeCanaryCandidateBindings | null {
  const deps = { ...DEFAULT_DEPS, ...options.deps };
  try {
    const origin = deps.resolveOrigin(input.repo);
    if (!origin) return null;
    const inspection = deps.inspectCommitted(input.repo, input.baseOid, input.headOid);
    return deriveBindings(input, origin, inspection);
  } catch {
    return null;
  }
}

function cas(state: AutoMergeCanaryStateV1): AutoMergeCanaryCas {
  return { epochId: state.epochId, revision: state.revision, attestation: state.attestation };
}

function activeShadow(read: AutoMergeCanaryReadResult, now: Date): AutoMergeCanaryStateV1 | null {
  const state = read.sourceState === 'healthy' && read.active && read.state?.state === 'shadow'
    ? read.state
    : null;
  const deadlineMs = state?.observation.deadlineAt === null || state?.observation.deadlineAt === undefined
    ? Number.NaN
    : Date.parse(state.observation.deadlineAt);
  if (!state || !Number.isFinite(now.getTime()) || !Number.isFinite(deadlineMs) ||
    now.getTime() >= deadlineMs) return null;
  return state;
}

function bindingMismatches(
  expected: AutoMergeCanaryStateV1,
  actual: AutoMergeCanaryObservedBindings,
): AutoMergeCanaryBindingField[] {
  const expectedBindings: AutoMergeCanaryCandidateBindings = {
    ...expected.repository,
    policyDigest: expected.policyDigest,
    configDigest: expected.configDigest,
    classifierDigest: expected.classifierDigest,
    pathDigest: expected.pathDigest,
  };
  const order: AutoMergeCanaryBindingField[] = [
    'repositoryId', 'fetchDestinationDigest', 'pushDestinationDigest', 'baseRefDigest',
    'baseOid', 'headOid', 'policyDigest', 'configDigest', 'classifierDigest', 'pathDigest',
  ];
  return order.filter((field) => actual[field] !== null && expectedBindings[field] !== actual[field]);
}

function wallObservedAt(now: Date): string {
  return now.toISOString();
}

function auditFailure(
  deps: ObserverDependencies,
  input: AutoMergeCanaryShadowObserverInput,
  stage: AutoMergeCanaryObserverFailureStage,
  code: string,
): void {
  try {
    deps.auditEvent({
      action: 'inbox:auto-merge-canary-shadow',
      repo: input.repo,
      sandboxId: null,
      summary: `shadow observer ${stage} failed (${code.slice(0, 48)})`.slice(0, 160),
      result: 'error',
    });
  } catch { /* observer failures cannot escape through auditing */ }
}

function appendResultCode(result: AutoMergeCanaryWriteResult): string {
  return result.ok ? 'ok' : result.reason;
}

/**
 * Observe one exact staging commit. This function never throws and grants no
 * merge authority; callers must discard its return value.
 */
export function observeAutoMergeCanaryShadow(
  input: AutoMergeCanaryShadowObserverInput,
  options: AutoMergeCanaryShadowObserverOptions = {},
): AutoMergeCanaryShadowObserverResult {
  const deps = { ...DEFAULT_DEPS, ...options.deps };
  let initialRead: AutoMergeCanaryReadResult;
  try {
    initialRead = deps.readStore();
  } catch {
    auditFailure(deps, input, 'read', 'exception');
    return { status: 'failed', stage: 'read' };
  }
  if (initialRead.sourceState === 'degraded') {
    auditFailure(deps, input, 'read', 'degraded');
    return { status: 'failed', stage: 'read' };
  }
  let initialNow: Date;
  try {
    initialNow = deps.now();
  } catch {
    auditFailure(deps, input, 'read', 'clock-exception');
    return { status: 'failed', stage: 'read' };
  }
  const initial = activeShadow(initialRead, initialNow);
  if (!initial) return { status: 'inactive' };

  let inspection: AutoMergeCanaryCommittedClassification;
  let origin: GitHubOriginAuthority | null;
  try {
    origin = deps.resolveOrigin(input.repo);
    inspection = deps.inspectCommitted(input.repo, input.baseOid, input.headOid);
  } catch {
    auditFailure(deps, input, 'inspect', 'exception');
    return { status: 'failed', stage: 'inspect' };
  }
  if (!origin) {
    auditFailure(deps, input, 'derive', 'origin-unavailable');
    return { status: 'failed', stage: 'derive' };
  }

  let actual: AutoMergeCanaryObservedBindings;
  let observedAt: string;
  try {
    const fixed = deriveStaticBindings(input, origin);
    if (!fixed) throw new Error('invalid fixed bindings');
    const inspected = deriveBindings(input, origin, inspection);
    if (inspection.outcome !== 'inspection-failed' && !inspected) {
      throw new Error('invalid inspected bindings');
    }
    actual = inspection.outcome === 'inspection-failed'
      ? { ...fixed, baseOid: null, headOid: null, pathDigest: null }
      : inspected!;
    const observationNow = deps.now();
    if (!activeShadow(initialRead, observationNow)) return { status: 'inactive' };
    observedAt = wallObservedAt(observationNow);
  } catch {
    auditFailure(deps, input, 'derive', 'exception');
    return { status: 'failed', stage: 'derive' };
  }
  const mismatchFields = bindingMismatches(initial, actual);
  const outcome: AutoMergeCanaryShadowOutcome = inspection.outcome === 'inspection-failed'
    ? 'inspection-error'
    : mismatchFields.length > 0
      ? 'binding-mismatch'
      : inspection.eligible
        ? 'eligible'
        : 'rejected';
  const reasonDigest = stableHash(HASH_DOMAINS.reason, {
    mismatchFields,
    outcome,
    reason: inspection.reason,
  });
  const evidenceWithoutDigest = {
    observedAt,
    outcome,
    mismatchFields,
    ...actual,
    treeOid: inspection.headTreeOid,
    fileCount: inspection.fileCount,
    lineCount: inspection.lineCount,
    reasonDigest,
  };
  const observationDigest = stableHash(HASH_DOMAINS.observation, {
    epochId: initial.epochId,
    bindings: actual,
    evidence: evidenceWithoutDigest,
  });
  const evidence: AutoMergeCanaryShadowObservationInput = {
    observationDigest,
    ...evidenceWithoutDigest,
    casRetries: 0,
  };

  let appended: AutoMergeCanaryWriteResult;
  try {
    appended = deps.appendObservation(cas(initial), evidence);
  } catch {
    auditFailure(deps, input, 'append', 'exception');
    return { status: 'failed', stage: 'append' };
  }
  if (appended.ok) {
    if (appended.clockRollbackDetected) {
      auditFailure(deps, input, 'append', 'clock-rollback');
      return { status: 'failed', stage: 'append' };
    }
    return { status: 'observed', outcome, mismatchFields, observationDigest, casRetries: 0 };
  }
  if (appended.reason !== 'conflict') {
    auditFailure(deps, input, 'append', appendResultCode(appended));
    return { status: 'failed', stage: 'append' };
  }

  let retryRead: AutoMergeCanaryReadResult;
  try {
    retryRead = deps.readStore();
  } catch {
    auditFailure(deps, input, 'retry', 'read-exception');
    return { status: 'failed', stage: 'retry' };
  }
  let retryNow: Date;
  try {
    retryNow = deps.now();
  } catch {
    auditFailure(deps, input, 'retry', 'clock-exception');
    return { status: 'failed', stage: 'retry' };
  }
  const retryState = activeShadow(retryRead, retryNow);
  if (!retryState || retryState.epochId !== initial.epochId) {
    auditFailure(deps, input, 'retry', 'state-changed');
    return { status: 'failed', stage: 'retry' };
  }
  const duplicateAlreadyPresent = retryState.lastShadowEvidence?.observationDigest === observationDigest;
  let retryEvidence: AutoMergeCanaryShadowObservationInput;
  let retryObservationDigest = observationDigest;
  try {
    const retryObservedAt = duplicateAlreadyPresent ? evidence.observedAt : wallObservedAt(retryNow);
    if (!duplicateAlreadyPresent) {
      const { observationDigest: _digest, casRetries: _casRetries, ...retryEvidenceWithoutDigest } = evidence;
      retryObservationDigest = stableHash(HASH_DOMAINS.observation, {
        epochId: initial.epochId,
        bindings: actual,
        evidence: { ...retryEvidenceWithoutDigest, observedAt: retryObservedAt },
      });
    }
    retryEvidence = {
      ...evidence,
      observationDigest: retryObservationDigest,
      observedAt: retryObservedAt,
      casRetries: 1,
    };
  } catch {
    auditFailure(deps, input, 'retry', 'clock-exception');
    return { status: 'failed', stage: 'retry' };
  }
  try {
    appended = deps.appendObservation(cas(retryState), retryEvidence);
  } catch {
    auditFailure(deps, input, 'retry', 'append-exception');
    return { status: 'failed', stage: 'retry' };
  }
  if (!appended.ok) {
    auditFailure(deps, input, 'retry', appendResultCode(appended));
    return { status: 'failed', stage: 'retry' };
  }
  if (appended.clockRollbackDetected) {
    auditFailure(deps, input, 'retry', 'clock-rollback');
    return { status: 'failed', stage: 'retry' };
  }
  return {
    status: 'observed',
    outcome,
    mismatchFields,
    observationDigest: retryObservationDigest,
    casRetries: 1,
  };
}

/**
 * Run the synchronous, bounded Git inspector outside the caller's event loop.
 * The returned promise is a completion boundary for short-lived CLI callers;
 * the child receives no mutation authority and this function never throws.
 */
export async function observeAutoMergeCanaryShadowAsync(
  input: AutoMergeCanaryShadowObserverInput,
): Promise<AutoMergeCanaryShadowObserverResult> {
  // Even malformed inputs cross an asynchronous boundary, keeping this API
  // predictably nonblocking for daemon callers.
  await new Promise<void>((resolve) => setImmediate(resolve));
  let payload: string;
  try {
    payload = JSON.stringify({ moduleUrl: import.meta.url, input });
  } catch {
    auditFailure(DEFAULT_DEPS, input, 'inspect', 'input-serialization');
    return { status: 'failed', stage: 'inspect' };
  }
  if (Buffer.byteLength(payload, 'utf8') > ASYNC_OBSERVER_MAX_INPUT_BYTES) {
    auditFailure(DEFAULT_DEPS, input, 'inspect', 'input-limit');
    return { status: 'failed', stage: 'inspect' };
  }

  const args: string[] = [];
  if (import.meta.url.endsWith('.ts')) {
    try {
      args.push('--import', createRequire(import.meta.url).resolve('tsx'));
    } catch {
      auditFailure(DEFAULT_DEPS, input, 'inspect', 'loader-unavailable');
      return { status: 'failed', stage: 'inspect' };
    }
  }
  args.push('--input-type=module', '--eval', ASYNC_OBSERVER_CHILD_SOURCE);

  return await new Promise<AutoMergeCanaryShadowObserverResult>((resolve) => {
    let settled = false;
    const timerRef: { value?: NodeJS.Timeout } = {};
    let outputBytes = 0;
    const output: Buffer[] = [];
    const finish = (result: AutoMergeCanaryShadowObserverResult): void => {
      if (settled) return;
      settled = true;
      if (timerRef.value) clearTimeout(timerRef.value);
      resolve(result);
    };
    const fail = (code: string): void => {
      auditFailure(DEFAULT_DEPS, input, 'inspect', code);
      finish({ status: 'failed', stage: 'inspect' });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, args, {
        env: process.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      fail('spawn-exception');
      return;
    }
    timerRef.value = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
      fail('timeout');
    }, ASYNC_OBSERVER_TIMEOUT_MS);

    child.stdout!.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > ASYNC_OBSERVER_MAX_OUTPUT_BYTES) {
        try { child.kill('SIGKILL'); } catch { /* process may already be gone */ }
        fail('output-limit');
        return;
      }
      output.push(chunk);
    });
    child.once('error', () => fail('spawn-error'));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail('child-error');
        return;
      }
      try {
        const result: unknown = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (!isObserverResult(result)) {
          fail('invalid-result');
          return;
        }
        finish(result);
      } catch {
        fail('invalid-output');
      }
    });
    child.stdin!.once('error', () => fail('stdin-error'));
    child.stdin!.end(payload, 'utf8');
  });
}

import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';

import {
  EXECUTION_CAPACITY_LEASE_MAX_TTL_MS_V1,
  type ExecutionCapacityEvidenceEnvelopeV1,
  type ExecutionCapacityLeaseStoreV1,
} from '../fabric/execution-capacity-lease.js';
import {
  createAgentOsObservationIsolationFinalizeAttestationV2,
  createAgentOsObservationIsolationPrepareAttestationV2,
  verifyAgentOsObservationIsolationFinalizeAttestationV2,
  verifyAgentOsObservationIsolationPrepareAttestationV2,
  type AgentOsObservationIsolationBindingsV2,
  type AgentOsObservationIsolationFinalizeAttestationV2,
  type AgentOsObservationIsolationPostRunEvidenceV2,
  type AgentOsObservationIsolationPrepareAttestationV2,
  type AgentOsObservationIsolationSignerV2,
  type AgentOsObservationIsolationVerifierV2,
} from '../vision/agent-os-observation-isolation-v2.js';
import {
  inspectAgentOsLocalContainerCreatePolicyV1,
  type AgentOsLocalContainerCreatePolicyV1,
} from '../vision/agent-os-local-container-policy.js';
import {
  verifyAgentOsLocalContainerDispatchPermitV1,
  type AgentOsLocalContainerDispatchPermitEnvelopeV1,
  type AgentOsLocalContainerDispatchPermitVerifierV1,
} from '../vision/agent-os-local-container-dispatch-permit.js';
import {
  canonicalAgentOsObservationSandboxRequestFrameBytesV1,
  verifyAgentOsObservationSandboxRequestV1,
  verifyAgentOsObservationSandboxResponseV1,
  type AgentOsObservationSandboxFrameVerifierV1,
  type AgentOsObservationSandboxRequestV1,
} from '../vision/agent-os-observation-sandbox.js';
import {
  agentOsDockerContainerNameV1,
  AGENT_OS_DOCKER_ENGINE_CONTROL_TIMEOUT_MS_V1,
  agentOsDockerEngineCreateRequestDigestV1,
  agentOsDockerOutputEvidenceDigestV1,
  agentOsDockerResponseFrameLimitV1,
  type AgentOsDockerAttachmentV1,
  type AgentOsDockerEngineClientV1,
  type AgentOsDockerEngineIdentityV1,
} from './agent-os-docker-engine-client.js';
import {
  agentOsLocalContainerBrokerRequestNonceDigestV1,
  agentOsLocalContainerBrokerRunIdV1,
  type AgentOsLocalContainerBrokerJournalOutcomeV1,
  type AgentOsLocalContainerBrokerJournalRecordV1,
  type AgentOsLocalContainerBrokerJournalStateV1,
  type AgentOsLocalContainerBrokerJournalV1,
} from './agent-os-local-container-broker-journal.js';

export const AGENT_OS_LOCAL_CONTAINER_BROKER_V1 = 'ashlr-agent-os-local-container-broker-v1' as const;
export const AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_RUN_MS_V1 = 240_000;
export const AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1 = 5_000;
export const AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_SETTLEMENT_MS_V1 = 10_000;

const RAW_DIGEST_RE = /^[a-f0-9]{64}$/u;
const MAX_FRAME_WAIT_MS = 5_000;

export const AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1 = Object.freeze({
  authority: 'observation-only' as const,
  executionAuthority: false as const,
  effectAuthority: false as const,
  externalMutationAuthority: false as const,
  providerContactAuthority: false as const,
  credentialAuthority: false as const,
  commissioningAuthority: false as const,
  activationAuthority: false as const,
  productionAuthorized: false as const,
  brokerTruthIndependentlyVerified: false as const,
  dockerEnforcementVerified: false as const,
});

export interface AgentOsLocalContainerBrokerInputV1 {
  request: AgentOsObservationSandboxRequestV1;
  permit: AgentOsLocalContainerDispatchPermitEnvelopeV1;
  capacityEvidence: ExecutionCapacityEvidenceEnvelopeV1;
}

export type AgentOsLocalContainerBrokerReasonV1 =
  | 'succeeded'
  | 'disabled'
  | 'invalid-dependencies'
  | 'invalid-input'
  | 'request-unauthenticated'
  | 'request-binding-mismatch'
  | 'permit-withheld'
  | 'engine-unavailable'
  | 'engine-mismatch'
  | 'journal-unavailable'
  | 'recovery-required'
  | 'capacity-withheld'
  | 'capacity-window-insufficient'
  | 'container-create-failed'
  | 'container-policy-mismatch'
  | 'prepare-attestation-failed'
  | 'attach-failed'
  | 'container-start-failed'
  | 'request-write-failed'
  | 'deadline-exceeded'
  | 'output-limit-exceeded'
  | 'producer-failed'
  | 'cleanup-failed'
  | 'finalize-attestation-failed'
  | 'capacity-release-failed'
  | 'lifecycle-lock-release-failed';

export interface AgentOsLocalContainerBrokerResultV1
  extends Readonly<typeof AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1> {
  state: 'completed' | 'withheld' | 'unavailable';
  reason: AgentOsLocalContainerBrokerReasonV1;
  requestDigest: string | null;
  permitDigest: string | null;
  allocationDigest: string | null;
  prepareAttestation: Readonly<AgentOsObservationIsolationPrepareAttestationV2> | null;
  finalizeAttestation: Readonly<AgentOsObservationIsolationFinalizeAttestationV2> | null;
  output: Uint8Array | null;
  replayAdmissionConsumed: boolean;
  containerRemovalConfirmed: boolean;
  capacityReleased: boolean;
}

export interface AgentOsLocalContainerBrokerRecoveryResultV1
  extends Readonly<typeof AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1> {
  state: 'recovered' | 'clean' | 'withheld' | 'unavailable';
  recoveredRuns: number;
  unreconciledRuns: number;
  stopReasons: string[];
}

export type AgentOsLocalContainerBrokerEngineV1 = Pick<AgentOsDockerEngineClientV1,
'inspectEngine' | 'createContainer' | 'inspectContainer' | 'resolveContainerIdByName' |
'openAttachment' | 'startContainer' | 'waitContainer' | 'killContainer' | 'removeContainer' |
'confirmContainerAbsent'>;

export interface AgentOsLocalContainerBrokerDependenciesV1 {
  enabled?: boolean;
  brokerDigest: string;
  expectedEngineDigest: string;
  policy: AgentOsLocalContainerCreatePolicyV1;
  seccompProfile: Uint8Array;
  permitVerifier: AgentOsLocalContainerDispatchPermitVerifierV1;
  requestVerifier: AgentOsObservationSandboxFrameVerifierV1;
  responseVerifier: AgentOsObservationSandboxFrameVerifierV1;
  isolationSigner: AgentOsObservationIsolationSignerV2;
  isolationVerifier: AgentOsObservationIsolationVerifierV2;
  capacityStore: ExecutionCapacityLeaseStoreV1;
  journal: AgentOsLocalContainerBrokerJournalV1;
  engine: AgentOsLocalContainerBrokerEngineV1;
  clock?: () => Date;
}

interface BrokerPorts {
  permitVerifier: AgentOsLocalContainerDispatchPermitVerifierV1;
  requestVerifier: AgentOsObservationSandboxFrameVerifierV1;
  responseVerifier: AgentOsObservationSandboxFrameVerifierV1;
  isolationSigner: AgentOsObservationIsolationSignerV2;
  isolationVerifier: AgentOsObservationIsolationVerifierV2;
  capacity: Pick<ExecutionCapacityLeaseStoreV1, 'acquire' | 'release'>;
  journal: Pick<AgentOsLocalContainerBrokerJournalV1,
  'acquireLifecycleLock' | 'releaseLifecycleLock' | 'recoverStore' | 'readActive' | 'begin' | 'advance'>;
  engine: AgentOsLocalContainerBrokerEngineV1;
}

interface ExecutionOutcome {
  reason: AgentOsLocalContainerBrokerReasonV1;
  timedOut: boolean;
  outputExceeded: boolean;
  killIssuedAt: string | null;
  waitEvidenceDigest: string | null;
  waitStatusCode: number | null;
  attachment: Awaited<AgentOsDockerAttachmentV1['completion']> | null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`;
}

function digest(domain: string, value: unknown): string {
  return createHash('sha256').update(domain, 'utf8').update('\0', 'utf8')
    .update(canonicalJson(value), 'utf8').digest('hex');
}

function plainData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'object' || isProxy(value) || depth > 16 || seen.size >= 256 || seen.has(value)) return false;
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || value.length > 128) return false;
    } else if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
      Object.hasOwn(descriptor, 'value') && plainData(descriptor.value, seen, depth + 1));
  } catch {
    return false;
  }
}

function immutable<T>(value: T, seen = new WeakSet<object>()): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const nested of Object.values(value as Record<string, unknown>)) immutable(nested, seen);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): T | null {
  try {
    if (!plainData(value)) return null;
    const owned = structuredClone(value);
    return plainData(owned) ? immutable(owned) : null;
  } catch {
    return null;
  }
}

function dataProperty<T>(value: unknown, key: string, validate: (candidate: unknown) => candidate is T): T | null {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') && validate(descriptor.value)
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function method(value: unknown, key: string): ((...args: never[]) => unknown) | null {
  if (value === null || typeof value !== 'object' || isProxy(value)) return null;
  try {
    let current: object | null = value;
    while (current && current !== Object.prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        ? descriptor.value.bind(value) as (...args: never[]) => unknown
        : null;
      current = Object.getPrototypeOf(current);
    }
  } catch { /* unavailable */ }
  return null;
}

function keyedVerifier<T extends { readonly keyId: string }>(value: T, methodName: string): T | null {
  const keyId = dataProperty(value, 'keyId', (candidate): candidate is string =>
    typeof candidate === 'string' && RAW_DIGEST_RE.test(candidate));
  const callback = method(value, methodName);
  return keyId && callback ? Object.freeze({ keyId, [methodName]: callback }) as T : null;
}

function capturePorts(dependencies: AgentOsLocalContainerBrokerDependenciesV1): BrokerPorts | null {
  if (isProxy(dependencies)) return null;
  const permitVerifier = keyedVerifier(ownValue(dependencies, 'permitVerifier') as
    AgentOsLocalContainerDispatchPermitVerifierV1, 'verify');
  const requestVerifier = keyedVerifier(ownValue(dependencies, 'requestVerifier') as
    AgentOsObservationSandboxFrameVerifierV1, 'verify');
  const responseVerifier = keyedVerifier(ownValue(dependencies, 'responseVerifier') as
    AgentOsObservationSandboxFrameVerifierV1, 'verify');
  const isolationSigner = keyedVerifier(ownValue(dependencies, 'isolationSigner') as
    AgentOsObservationIsolationSignerV2, 'sign');
  const isolationVerifier = keyedVerifier(ownValue(dependencies, 'isolationVerifier') as
    AgentOsObservationIsolationVerifierV2, 'verify');
  if (!permitVerifier || !requestVerifier || !responseVerifier || !isolationSigner || !isolationVerifier ||
    isolationSigner.keyId !== isolationVerifier.keyId ||
    new Set([permitVerifier.keyId, requestVerifier.keyId, responseVerifier.keyId, isolationSigner.keyId]).size !== 4) {
    return null;
  }
  const capacityStore = ownValue(dependencies, 'capacityStore');
  const journalStore = ownValue(dependencies, 'journal');
  const enginePort = ownValue(dependencies, 'engine');
  const capacityAcquire = method(capacityStore, 'acquire');
  const capacityRelease = method(capacityStore, 'release');
  const journalAcquire = method(journalStore, 'acquireLifecycleLock');
  const journalRelease = method(journalStore, 'releaseLifecycleLock');
  const journalRecover = method(journalStore, 'recoverStore');
  const journalRead = method(journalStore, 'readActive');
  const journalBegin = method(journalStore, 'begin');
  const journalAdvance = method(journalStore, 'advance');
  const engineMethods = ['inspectEngine', 'createContainer', 'inspectContainer', 'resolveContainerIdByName',
    'openAttachment', 'startContainer', 'waitContainer', 'killContainer', 'removeContainer',
    'confirmContainerAbsent'] as const;
  const engine = Object.fromEntries(engineMethods.map((name) => [name, method(enginePort, name)]));
  if (!capacityAcquire || !capacityRelease || !journalAcquire || !journalRelease || !journalRecover ||
    !journalRead || !journalBegin || !journalAdvance || Object.values(engine).some((entry) => !entry)) return null;
  return Object.freeze({
    permitVerifier,
    requestVerifier,
    responseVerifier,
    isolationSigner,
    isolationVerifier,
    capacity: { acquire: capacityAcquire, release: capacityRelease } as unknown as BrokerPorts['capacity'],
    journal: {
      acquireLifecycleLock: journalAcquire, releaseLifecycleLock: journalRelease,
      recoverStore: journalRecover, readActive: journalRead, begin: journalBegin, advance: journalAdvance,
    } as unknown as BrokerPorts['journal'],
    engine: engine as unknown as AgentOsLocalContainerBrokerEngineV1,
  });
}

function result(
  state: AgentOsLocalContainerBrokerResultV1['state'],
  reason: AgentOsLocalContainerBrokerReasonV1,
  values: Partial<Pick<AgentOsLocalContainerBrokerResultV1,
  'requestDigest' | 'permitDigest' | 'allocationDigest' | 'prepareAttestation' |
  'finalizeAttestation' | 'output' | 'replayAdmissionConsumed' | 'containerRemovalConfirmed' |
  'capacityReleased'>> = {},
): AgentOsLocalContainerBrokerResultV1 {
  return immutable({
    state,
    reason,
    requestDigest: values.requestDigest ?? null,
    permitDigest: values.permitDigest ?? null,
    allocationDigest: values.allocationDigest ?? null,
    prepareAttestation: values.prepareAttestation ?? null,
    finalizeAttestation: values.finalizeAttestation ?? null,
    output: values.output ? Buffer.from(values.output) : null,
    replayAdmissionConsumed: values.replayAdmissionConsumed ?? false,
    containerRemovalConfirmed: values.containerRemovalConfirmed ?? false,
    capacityReleased: values.capacityReleased ?? false,
    ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1,
  });
}

function outcomeFor(reason: AgentOsLocalContainerBrokerReasonV1): AgentOsLocalContainerBrokerJournalOutcomeV1 {
  if (reason === 'succeeded') return 'succeeded';
  if (reason === 'container-create-failed') return 'container-create-failed';
  if (reason === 'container-policy-mismatch') return 'container-policy-mismatch';
  if (reason === 'deadline-exceeded') return 'deadline-exceeded';
  if (reason === 'output-limit-exceeded') return 'output-limit-exceeded';
  if (reason === 'producer-failed') return 'producer-failed';
  if (reason === 'cleanup-failed') return 'cleanup-failed';
  if (reason === 'capacity-release-failed') return 'capacity-release-failed';
  return 'request-withheld';
}

function delay(ms: number): Promise<'timeout'> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(() => resolveDelay('timeout'), Math.max(1, ms));
    timer.unref();
  });
}

function responseFrame(value: Uint8Array): unknown {
  try {
    const bytes = Buffer.from(value);
    if (bytes.byteLength < 3 || bytes[bytes.byteLength - 1] !== 0x0a ||
      bytes.subarray(0, -1).includes(0x0a) || bytes.subarray(0, -1).includes(0x0d)) return null;
    const parsed = JSON.parse(bytes.subarray(0, -1).toString('utf8'));
    return `${canonicalJson(parsed)}\n` === bytes.toString('utf8') ? parsed : null;
  } catch {
    return null;
  }
}

export class AgentOsLocalContainerBrokerV1 {
  readonly #enabled: boolean;
  readonly #brokerDigest: string;
  readonly #expectedEngineDigest: string;
  readonly #policy: AgentOsLocalContainerCreatePolicyV1 | null;
  readonly #createConfigDigest: string | null;
  readonly #seccompProfile: Uint8Array;
  readonly #ports: BrokerPorts | null;
  readonly #clock: () => Date;
  readonly #configurationValid: boolean;

  constructor(dependencies: AgentOsLocalContainerBrokerDependenciesV1) {
    const enabled = ownValue(dependencies, 'enabled');
    const brokerDigest = ownValue(dependencies, 'brokerDigest');
    const engineDigest = ownValue(dependencies, 'expectedEngineDigest');
    const selectedPolicy = ownValue(dependencies, 'policy');
    const seccompProfile = ownValue(dependencies, 'seccompProfile');
    const clock = ownValue(dependencies, 'clock');
    this.#enabled = enabled === true;
    this.#brokerDigest = typeof brokerDigest === 'string' ? brokerDigest : '';
    this.#expectedEngineDigest = typeof engineDigest === 'string' ? engineDigest : '';
    const inspected = inspectAgentOsLocalContainerCreatePolicyV1(selectedPolicy);
    this.#policy = inspected.policy && inspected.policy.limits.maxDurationMs <=
      AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_RUN_MS_V1 ? snapshot(inspected.policy) : null;
    this.#createConfigDigest = this.#policy ? inspected.createConfigDigest : null;
    this.#seccompProfile = seccompProfile instanceof Uint8Array && !isProxy(seccompProfile)
      ? Buffer.from(seccompProfile)
      : Buffer.alloc(0);
    this.#ports = capturePorts(dependencies);
    this.#clock = typeof clock === 'function' ? clock.bind(dependencies) as () => Date : () => new Date();
    this.#configurationValid = (enabled === undefined || typeof enabled === 'boolean') &&
      (clock === undefined || typeof clock === 'function');
  }

  #ready(): boolean {
    return Boolean(this.#configurationValid && this.#ports && this.#policy && this.#createConfigDigest &&
      RAW_DIGEST_RE.test(this.#brokerDigest) && RAW_DIGEST_RE.test(this.#expectedEngineDigest) &&
      agentOsDockerEngineCreateRequestDigestV1(this.#policy!, this.#seccompProfile));
  }

  #dispatchWindowOpen(request: AgentOsObservationSandboxRequestV1,
    permit: AgentOsLocalContainerDispatchPermitEnvelopeV1): boolean {
    try {
      const now = this.#clock().getTime();
      return Number.isSafeInteger(now) && now >= 0 &&
        now < Date.parse(request.deadlineAt) && now < Date.parse(permit.expiresAt);
    } catch {
      return false;
    }
  }

  async run(input: AgentOsLocalContainerBrokerInputV1): Promise<AgentOsLocalContainerBrokerResultV1> {
    if (!this.#enabled) return result('withheld', 'disabled');
    if (!this.#ready()) return result('unavailable', 'invalid-dependencies');
    const owned = snapshot(input);
    if (!owned) return result('withheld', 'invalid-input');
    const ports = this.#ports!;
    const policy = this.#policy!;
    let now: number;
    try {
      const clockValue = this.#clock();
      now = clockValue instanceof Date ? clockValue.getTime() : Number.NaN;
    } catch {
      now = Number.NaN;
    }
    if (!Number.isSafeInteger(now) || now < 0) return result('unavailable', 'invalid-dependencies');
    const request = verifyAgentOsObservationSandboxRequestV1(owned.request, ports.requestVerifier);
    if (!request) return result('withheld', 'request-unauthenticated');
    const frame = canonicalAgentOsObservationSandboxRequestFrameBytesV1(request);
    const runId = agentOsLocalContainerBrokerRunIdV1(request.requestNonce);
    const nonceDigest = agentOsLocalContainerBrokerRequestNonceDigestV1(request.requestNonce);
    const containerName = agentOsDockerContainerNameV1(request.requestNonce);
    const imageDigest = policy.image.slice(policy.image.indexOf('@sha256:') + '@sha256:'.length);
    if (!frame || !runId || !nonceDigest || !containerName ||
      request.backendIdentityDigest !== this.#brokerDigest || request.policyDigest !== this.#createConfigDigest ||
      request.maxOutputBytes !== policy.limits.maxOutputBytes ||
      Date.parse(request.deadlineAt) <= now ||
      Date.parse(request.deadlineAt) - now > AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_RUN_MS_V1 ||
      owned.capacityEvidence.executionIdentityDigest !== owned.permit.bindings.executionIdentityDigest ||
      owned.capacityEvidence.evidenceDigest !== owned.permit.bindings.capacityEvidenceDigest) {
      return result('withheld', 'request-binding-mismatch', { requestDigest: request.requestDigest });
    }
    const expectedBindings = {
      requestNonce: request.requestNonce,
      requestDigest: request.requestDigest,
      deadlineAt: request.deadlineAt,
      brokerDigest: this.#brokerDigest,
      engineDigest: this.#expectedEngineDigest,
      imageDigest,
      producerDigest: policy.producer.digest,
      seccompDigest: policy.seccompProfileDigest,
      createConfigDigest: this.#createConfigDigest!,
      executionIdentityDigest: owned.capacityEvidence.executionIdentityDigest,
      capacityEvidenceDigest: owned.capacityEvidence.evidenceDigest,
      slots: 1 as const,
    };
    const permitInspection = verifyAgentOsLocalContainerDispatchPermitV1(
      owned.permit, expectedBindings, ports.permitVerifier, now,
    );
    if (permitInspection.state !== 'verified' || !permitInspection.permitDigest) {
      return result('withheld', 'permit-withheld', { requestDigest: request.requestDigest });
    }
    const locked = ports.journal.acquireLifecycleLock();
    if (locked.state !== 'acquired') return result(
      locked.state === 'contended' ? 'withheld' : 'unavailable', 'journal-unavailable',
      { requestDigest: request.requestDigest, permitDigest: permitInspection.permitDigest },
    );
    let finalResult = result('unavailable', 'journal-unavailable', {
      requestDigest: request.requestDigest, permitDigest: permitInspection.permitDigest,
    });
    try {
      if (ports.journal.recoverStore(locked.lock)) {
        const active = ports.journal.readActive(locked.lock);
        if (active && active.length > 0) {
          finalResult = result('withheld', 'recovery-required', {
            requestDigest: request.requestDigest, permitDigest: permitInspection.permitDigest,
          });
        } else if (active) {
          const engine = await ports.engine.inspectEngine(this.#expectedEngineDigest);
          if (!engine.ok) {
            finalResult = result('unavailable', engine.reason === 'engine-mismatch'
              ? 'engine-mismatch' : 'engine-unavailable', {
              requestDigest: request.requestDigest, permitDigest: permitInspection.permitDigest,
            });
          } else {
            finalResult = await this.#runLocked(
              owned, request, frame, permitInspection.permitDigest, runId, nonceDigest, containerName,
              engine.value, locked.lock,
            );
          }
        }
      }
    } catch {
      // Any effect after the durable lease/journal boundary is reconciled by
      // recover(); never guess that an unobserved external effect did not occur.
      const active = ports.journal.readActive(locked.lock);
      const recorded = active?.find((entry) => entry.requestDigest === request.requestDigest);
      finalResult = result('unavailable', 'recovery-required', {
        requestDigest: request.requestDigest,
        permitDigest: permitInspection.permitDigest,
        allocationDigest: recorded?.allocationDigest ?? finalResult.allocationDigest,
        replayAdmissionConsumed: Boolean(recorded) || finalResult.replayAdmissionConsumed,
        containerRemovalConfirmed: finalResult.containerRemovalConfirmed,
        capacityReleased: finalResult.capacityReleased,
      });
    } finally {
      if (!ports.journal.releaseLifecycleLock(locked.lock)) {
        finalResult = result('unavailable', 'lifecycle-lock-release-failed', {
          requestDigest: finalResult.requestDigest,
          permitDigest: finalResult.permitDigest,
          allocationDigest: finalResult.allocationDigest,
          replayAdmissionConsumed: finalResult.replayAdmissionConsumed,
          containerRemovalConfirmed: finalResult.containerRemovalConfirmed,
          capacityReleased: finalResult.capacityReleased,
        });
      }
    }
    return finalResult;
  }

  async #runLocked(
    input: AgentOsLocalContainerBrokerInputV1,
    request: AgentOsObservationSandboxRequestV1,
    requestFrame: Buffer,
    permitDigest: string,
    runId: string,
    nonceDigest: string,
    containerName: string,
    engineIdentity: AgentOsDockerEngineIdentityV1,
    lock: Parameters<AgentOsLocalContainerBrokerJournalV1['begin']>[1],
  ): Promise<AgentOsLocalContainerBrokerResultV1> {
    const ports = this.#ports!;
    const policy = this.#policy!;
    const allocationId = `agent-os-observation:${request.requestNonce}`;
    const lease = ports.capacity.acquire({
      allocationId,
      leaseTtlMs: EXECUTION_CAPACITY_LEASE_MAX_TTL_MS_V1,
      items: [{
        executionIdentityDigest: input.capacityEvidence.executionIdentityDigest,
        slots: 1,
        expectedEvidenceDigest: input.capacityEvidence.evidenceDigest,
        evidenceEnvelope: input.capacityEvidence,
      }],
    });
    if (lease.disposition !== 'recorded' || lease.reason !== 'recorded' || !lease.durable ||
      lease.committedWithoutReceipt || lease.leaseEpoch !== 1 || !lease.ownerCapability ||
      !lease.allocationDigest || !lease.expiresAt) {
      return result('withheld', 'capacity-withheld', {
        requestDigest: request.requestDigest, permitDigest, allocationDigest: lease.allocationDigest,
      });
    }
    const base = {
      requestDigest: request.requestDigest,
      permitDigest,
      allocationDigest: lease.allocationDigest,
      replayAdmissionConsumed: true,
    };
    const cleanupHorizon = Date.parse(request.deadlineAt) + 2 *
      AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1 +
      4 * AGENT_OS_DOCKER_ENGINE_CONTROL_TIMEOUT_MS_V1 + policy.limits.cleanupStartGraceMs +
      MAX_FRAME_WAIT_MS + AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_SETTLEMENT_MS_V1;
    if (Date.parse(lease.expiresAt) < cleanupHorizon) {
      const released = ports.capacity.release({
        allocationId, ownerCapability: lease.ownerCapability, expectedLeaseEpoch: 1,
      });
      return result('withheld', 'capacity-window-insufficient', {
        ...base, capacityReleased: released.reason === 'released' && released.durable,
      });
    }
    const journalState: AgentOsLocalContainerBrokerJournalStateV1 = {
      runId,
      requestNonceDigest: nonceDigest,
      requestDigest: request.requestDigest,
      permitDigest,
      brokerDigest: this.#brokerDigest,
      engineDigest: engineIdentity.engineDigest,
      imageDigest: policy.image.slice(policy.image.indexOf('@sha256:') + '@sha256:'.length),
      producerDigest: policy.producer.digest,
      seccompDigest: policy.seccompProfileDigest,
      createConfigDigest: this.#createConfigDigest!,
      executionIdentityDigest: input.capacityEvidence.executionIdentityDigest,
      capacityEvidenceDigest: input.capacityEvidence.evidenceDigest,
      allocationDigest: lease.allocationDigest,
      leaseEpoch: 1,
      containerName,
      containerId: null,
      engineCreateRequestDigest: null,
      prestartInspectionDigest: null,
      finalInspectionDigest: null,
      prepareAttestationDigest: null,
      finalAttestationDigest: null,
      removalEvidenceDigest: null,
      outcome: null,
    };
    let journal = ports.journal.begin(journalState, lock);
    if (!journal.ok) {
      ports.capacity.release({ allocationId, ownerCapability: lease.ownerCapability, expectedLeaseEpoch: 1 });
      return result('unavailable', 'journal-unavailable', base);
    }
    if (!this.#dispatchWindowOpen(request, input.permit)) {
      return this.#settleWithoutContainer(
        'deadline-exceeded', journal.record, lock, allocationId, lease.ownerCapability, base,
      );
    }
    const created = await ports.engine.createContainer(containerName, policy, this.#seccompProfile);
    if (!created.ok) return this.#reconcileAmbiguousCreate(
      journal.record, lock, allocationId, lease.ownerCapability, containerName, base,
    );
    journal = ports.journal.advance(runId, journal.record.recordDigest, 'created', {
      containerId: created.value.containerId,
      engineCreateRequestDigest: created.value.engineCreateRequestDigest,
    }, lock);
    if (!journal.ok) return this.#emergencyCleanup(
      created.value.containerId, allocationId, lease.ownerCapability, base, false,
    );
    const expectedInspect = {
      containerId: created.value.containerId, containerName, policy, seccompProfile: this.#seccompProfile,
    };
    const prestart = await ports.engine.inspectContainer(expectedInspect);
    if (!prestart.ok) return this.#cleanupAfterCreate(
      prestart.reason === 'container-policy-mismatch' ? 'container-policy-mismatch' : 'engine-unavailable',
      null, request, allocationId, lease.ownerCapability,
      created.value.containerId, containerName, null, null, journal.record, lock, base,
    );
    const bindings: AgentOsObservationIsolationBindingsV2 = {
      requestNonce: request.requestNonce,
      requestDigest: request.requestDigest,
      deadlineAt: request.deadlineAt,
      containerId: created.value.containerId,
      brokerDigest: this.#brokerDigest,
      engineDigest: engineIdentity.engineDigest,
      imageDigest: journalState.imageDigest,
      producerDigest: policy.producer.digest,
      seccompDigest: policy.seccompProfileDigest,
      createConfigDigest: this.#createConfigDigest!,
      // The V2 verifier rejects aliased caller graphs. Keep bindings independent
      // from the pinned policy even though both values are immutable here.
      limits: { ...policy.limits },
    };
    const prepareNow = this.#clock().getTime();
    const prepare = createAgentOsObservationIsolationPrepareAttestationV2({
      ...bindings,
      issuedAt: new Date(prepareNow).toISOString(),
      expiresAt: lease.expiresAt,
    }, ports.isolationSigner);
    if (!prepare || verifyAgentOsObservationIsolationPrepareAttestationV2(
      prepare, bindings, policy, ports.isolationVerifier, prepareNow,
    ).state !== 'verified') return this.#cleanupAfterCreate(
      'prepare-attestation-failed', null, request, allocationId, lease.ownerCapability,
      created.value.containerId, containerName, null, null, journal.record, lock, base,
    );
    journal = ports.journal.advance(runId, journal.record.recordDigest, 'prepared', {
      prestartInspectionDigest: prestart.value.inspectionDigest,
      prepareAttestationDigest: prepare.attestationDigest,
    }, lock);
    if (!journal.ok) return this.#emergencyCleanup(
      created.value.containerId, allocationId, lease.ownerCapability, base, false,
    );
    const frameLimit = agentOsDockerResponseFrameLimitV1(policy.limits.maxOutputBytes)!;
    const attached = await ports.engine.openAttachment(created.value.containerId, frameLimit);
    if (!attached.ok) return this.#cleanupAfterCreate(
      'attach-failed', prepare, request, allocationId, lease.ownerCapability,
      created.value.containerId, containerName, null, null, journal.record, lock, base,
    );
    if (!this.#dispatchWindowOpen(request, input.permit)) {
      attached.value.abort();
      return this.#cleanupAfterCreate(
        'deadline-exceeded', prepare, request, allocationId, lease.ownerCapability,
        created.value.containerId, containerName, null, bindings, journal.record, lock, base,
      );
    }
    const started = await ports.engine.startContainer(created.value.containerId);
    if (!started.ok) {
      attached.value.abort();
      return this.#cleanupAfterCreate(
        'container-start-failed', prepare, request, allocationId, lease.ownerCapability,
        created.value.containerId, containerName, null, null, journal.record, lock, base,
      );
    }
    journal = ports.journal.advance(runId, journal.record.recordDigest, 'started', {}, lock);
    if (!journal.ok || !attached.value.writeAndClose(requestFrame)) {
      attached.value.abort();
      if (!journal.ok) return this.#emergencyCleanup(
        created.value.containerId, allocationId, lease.ownerCapability, base, true,
      );
      return this.#cleanupAfterCreate(
        'request-write-failed', prepare, request,
        allocationId, lease.ownerCapability, created.value.containerId, containerName, null, null,
        journal.record, lock, base, true,
      );
    }
    const execution = await this.#awaitExecution(created.value.containerId, attached.value, request.deadlineAt);
    return this.#cleanupAfterCreate(
      execution.reason, prepare, request, allocationId, lease.ownerCapability,
      created.value.containerId, containerName, execution, bindings, journal.record, lock, base,
      false,
    );
  }

  async #awaitExecution(
    containerId: string,
    attachment: AgentOsDockerAttachmentV1,
    deadlineAt: string,
  ): Promise<ExecutionOutcome> {
    const ports = this.#ports!;
    const remaining = Math.max(1, Date.parse(deadlineAt) - this.#clock().getTime());
    let captured: Awaited<AgentOsDockerAttachmentV1['completion']> | null = null;
    const attachMonitor = attachment.completion.then((value) => {
      captured = value;
      return value.ok ? new Promise<never>(() => {}) : { kind: 'attach' as const, value };
    });
    const wait = ports.engine.waitContainer(
      containerId, remaining + AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1,
    ).then((value) => ({ kind: 'wait' as const, value }));
    const first = await Promise.race([wait, attachMonitor, delay(remaining).then(() => ({ kind: 'deadline' as const }))]);
    const timedOut = first.kind === 'deadline';
    let outputExceeded = first.kind === 'attach' && first.value.reason === 'attach-truncated';
    let killIssuedAt: string | null = null;
    let waitResult = first.kind === 'wait' ? first.value : null;
    if (timedOut || first.kind === 'attach') {
      killIssuedAt = this.#clock().toISOString();
      await ports.engine.killContainer(containerId);
      waitResult = await ports.engine.waitContainer(containerId, AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1);
    }
    if (!captured) {
      const completed = await Promise.race([
        attachment.completion,
        delay(MAX_FRAME_WAIT_MS).then(() => null),
      ]);
      if (!completed) attachment.abort(); else captured = completed;
    }
    if (!waitResult?.ok) return {
      reason: timedOut ? 'deadline-exceeded' : outputExceeded ? 'output-limit-exceeded' : 'producer-failed',
      timedOut, outputExceeded, killIssuedAt, waitEvidenceDigest: null, waitStatusCode: null,
      attachment: captured,
    };
    if (!captured?.ok) {
      outputExceeded ||= captured?.reason === 'attach-truncated';
      return {
        reason: outputExceeded ? 'output-limit-exceeded' : 'producer-failed', timedOut, outputExceeded,
        killIssuedAt, waitEvidenceDigest: waitResult.value.waitEvidenceDigest,
        waitStatusCode: waitResult.value.statusCode, attachment: captured,
      };
    }
    return {
      reason: timedOut ? 'deadline-exceeded' : 'succeeded', timedOut, outputExceeded,
      killIssuedAt, waitEvidenceDigest: waitResult.value.waitEvidenceDigest,
      waitStatusCode: waitResult.value.statusCode, attachment: captured,
    };
  }

  async #settleWithoutContainer(
    reason: AgentOsLocalContainerBrokerReasonV1,
    journal: AgentOsLocalContainerBrokerJournalRecordV1,
    lock: Parameters<AgentOsLocalContainerBrokerJournalV1['begin']>[1],
    allocationId: string,
    ownerCapability: string,
    base: Parameters<typeof result>[2],
  ): Promise<AgentOsLocalContainerBrokerResultV1> {
    const ports = this.#ports!;
    const released = ports.capacity.release({ allocationId, ownerCapability, expectedLeaseEpoch: 1 });
    const capacityReleased = released.reason === 'released' && released.durable;
    const settled = ports.journal.advance(journal.runId, journal.recordDigest,
      reason === 'cleanup-failed' ? 'unreconciled' : 'settled', {
        outcome: reason === 'cleanup-failed' ? 'cleanup-failed'
          : capacityReleased ? outcomeFor(reason) : 'capacity-release-failed',
        leaseEpoch: released.leaseEpoch ?? 1,
      }, lock);
    const finalReason = !settled.ok ? 'journal-unavailable'
      : !capacityReleased ? 'capacity-release-failed'
        : reason;
    return result(['cleanup-failed', 'journal-unavailable', 'capacity-release-failed'].includes(finalReason)
      ? 'unavailable' : 'withheld', finalReason, {
      ...base, capacityReleased,
    });
  }

  async #reconcileAmbiguousCreate(
    journal: AgentOsLocalContainerBrokerJournalRecordV1,
    lock: Parameters<AgentOsLocalContainerBrokerJournalV1['begin']>[1],
    allocationId: string,
    ownerCapability: string,
    containerName: string,
    base: Parameters<typeof result>[2],
  ): Promise<AgentOsLocalContainerBrokerResultV1> {
    const ports = this.#ports!;
    const resolved = await ports.engine.resolveContainerIdByName(containerName);
    if (!resolved.ok && resolved.reason === 'container-not-found') {
      // A negative lookup cannot prove that an already-sent create request will
      // not become visible later. Keep the durable lease-held record and
      // reservation active so a later cleanup-only recovery can reconcile it.
      return result('unavailable', 'recovery-required', base);
    }
    if (!resolved.ok) return result('unavailable', 'recovery-required', base);
    const engineCreateRequestDigest = agentOsDockerEngineCreateRequestDigestV1(
      this.#policy!, this.#seccompProfile,
    );
    const recorded = ports.journal.advance(journal.runId, journal.recordDigest, 'created', {
      containerId: resolved.value,
      engineCreateRequestDigest,
    }, lock);
    if (!recorded.ok) return result('unavailable', 'recovery-required', base);
    const inspected = await ports.engine.inspectContainer({
      containerId: resolved.value,
      containerName,
      policy: this.#policy!,
      seccompProfile: this.#seccompProfile,
    });
    if (!inspected.ok) {
      ports.journal.advance(recorded.record.runId, recorded.record.recordDigest, 'unreconciled', {
        outcome: 'cleanup-failed',
      }, lock);
      return result('unavailable', 'cleanup-failed', base);
    }
    return this.#cleanupAfterCreate(
      'container-create-failed', null, null,
      allocationId, ownerCapability, resolved.value, containerName, null, null,
      recorded.record, lock, base, inspected.value.running,
    );
  }

  async #emergencyCleanup(
    containerId: string,
    allocationId: string,
    ownerCapability: string,
    base: Parameters<typeof result>[2],
    killFirst: boolean,
  ): Promise<AgentOsLocalContainerBrokerResultV1> {
    const ports = this.#ports!;
    if (killFirst) {
      await ports.engine.killContainer(containerId);
      await ports.engine.waitContainer(containerId, AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1);
    }
    const removed = await ports.engine.removeContainer(containerId);
    const absent = removed.ok ? await ports.engine.confirmContainerAbsent(containerId) : removed;
    const released = absent.ok
      ? ports.capacity.release({ allocationId, ownerCapability, expectedLeaseEpoch: 1 })
      : null;
    return result('unavailable', absent.ok ? 'journal-unavailable' : 'cleanup-failed', {
      ...base,
      containerRemovalConfirmed: absent.ok,
      capacityReleased: released?.reason === 'released' && released.durable,
    });
  }

  async #cleanupAfterCreate(
    reason: AgentOsLocalContainerBrokerReasonV1,
    prepare: AgentOsObservationIsolationPrepareAttestationV2 | null,
    request: AgentOsObservationSandboxRequestV1 | null,
    allocationId: string,
    ownerCapability: string,
    containerId: string,
    containerName: string,
    execution: ExecutionOutcome | null,
    bindings: AgentOsObservationIsolationBindingsV2 | null,
    initialJournal: AgentOsLocalContainerBrokerJournalRecordV1,
    lock: Parameters<AgentOsLocalContainerBrokerJournalV1['begin']>[1],
    base: Parameters<typeof result>[2],
    killFirst = false,
  ): Promise<AgentOsLocalContainerBrokerResultV1> {
    const ports = this.#ports!;
    const policy = this.#policy!;
    let journal = initialJournal;
    if (killFirst) {
      await ports.engine.killContainer(containerId);
      await ports.engine.waitContainer(containerId, AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1);
    }
    const inspected = await ports.engine.inspectContainer({
      containerId, containerName, policy, seccompProfile: this.#seccompProfile,
    });
    const finishedAt = this.#clock().toISOString();
    if (inspected.ok && journal.stage === 'started') {
      const stopped = ports.journal.advance(journal.runId, journal.recordDigest, 'stopped', {
        finalInspectionDigest: inspected.value.inspectionDigest,
      }, lock);
      if (stopped.ok) journal = stopped.record;
    }
    const cleanupStartedAt = this.#clock().toISOString();
    const removed = await ports.engine.removeContainer(containerId);
    const absent = removed.ok ? await ports.engine.confirmContainerAbsent(containerId) : removed;
    if (!removed.ok || !absent.ok) {
      ports.journal.advance(journal.runId, journal.recordDigest, 'unreconciled', {
        outcome: 'cleanup-failed',
      }, lock);
      return result('unavailable', 'cleanup-failed', { ...base });
    }
    const removedAt = this.#clock().toISOString();
    const removalEvidenceDigest = digest('ashlr.agent-os.container-removal-evidence.v1', {
      containerId, cleanupStartedAt, removedAt, absent: true,
    });
    const removedRecord = ports.journal.advance(journal.runId, journal.recordDigest, 'removed', {
      removalEvidenceDigest,
    }, lock);
    if (!removedRecord.ok) {
      const released = ports.capacity.release({ allocationId, ownerCapability, expectedLeaseEpoch: 1 });
      return result('unavailable', 'journal-unavailable', {
        ...base, containerRemovalConfirmed: true,
        capacityReleased: released.reason === 'released' && released.durable,
      });
    }
    journal = removedRecord.record;
    let finalized: AgentOsObservationIsolationFinalizeAttestationV2 | null = null;
    let output: Uint8Array | null = null;
    let finalReason = reason;
    if (prepare && request && bindings && execution?.waitEvidenceDigest && execution.waitStatusCode !== null &&
      inspected.ok && !inspected.value.running && inspected.value.exitCode === execution.waitStatusCode) {
      const captured = execution.attachment?.ok ? execution.attachment.value : null;
      const parsedFrame = captured ? responseFrame(captured.stdout) : null;
      const verifiedResponse = parsedFrame ? verifyAgentOsObservationSandboxResponseV1(
        parsedFrame, request, ports.responseVerifier,
      ) : null;
      if (finalReason === 'succeeded' && (!verifiedResponse ||
        verifiedResponse.response.process.executableDigest !== policy.producer.digest ||
        verifiedResponse.response.outcome !== 'succeeded' || execution.waitStatusCode !== 0 ||
        inspected.value.oomKilled)) finalReason = 'producer-failed';
      if (verifiedResponse?.response.outcome === 'output-limit-exceeded') finalReason = 'output-limit-exceeded';
      const outputExceeded = execution.outputExceeded || finalReason === 'output-limit-exceeded';
      const responseDigest = verifiedResponse?.response.responseDigest ??
        digest('ashlr.agent-os.invalid-producer-response.v1', captured ? [...captured.stdout] : []);
      const outputEvidenceDigest = verifiedResponse
        ? agentOsDockerOutputEvidenceDigestV1(verifiedResponse.output)
        : digest('ashlr.agent-os.missing-producer-output.v1', { responseDigest });
      const postRun: AgentOsObservationIsolationPostRunEvidenceV2 = {
        requestDigest: request.requestDigest,
        responseDigest,
        inspectDigest: inspected.value.inspectionDigest,
        outputEvidenceDigest,
        exitEvidenceDigest: execution.waitEvidenceDigest,
        deadlineKillEvidenceDigest: digest('ashlr.agent-os.deadline-kill-evidence.v1', {
          timedOut: execution.timedOut, killIssuedAt: execution.killIssuedAt,
        }),
        removalEvidenceDigest,
        outputBytes: outputExceeded ? policy.limits.maxOutputBytes : verifiedResponse?.response.outputBytes ?? 0,
        outputTruncated: outputExceeded,
        outputLimitExceeded: outputExceeded,
        exitCode: inspected.value.exitCode ?? 255,
        oomKilled: inspected.value.oomKilled,
        timedOut: execution.timedOut,
        deadlineAt: request.deadlineAt,
        deadlineKillObserved: execution.timedOut,
        killIssuedAt: execution.timedOut ? execution.killIssuedAt : null,
        finishedAt,
        cleanupStartedAt,
        removalConfirmed: true,
        containerAbsentAfterRemoval: true,
        removedAt,
      };
      const finalizeNow = this.#clock().getTime();
      finalized = createAgentOsObservationIsolationFinalizeAttestationV2({
        ...bindings,
        prepareAttestationDigest: prepare.attestationDigest,
        issuedAt: new Date(finalizeNow).toISOString(),
        expiresAt: new Date(finalizeNow + 120_000).toISOString(),
        postRun,
      }, ports.isolationSigner);
      if (!finalized || verifyAgentOsObservationIsolationFinalizeAttestationV2(
        finalized, prepare, bindings, policy, postRun, ports.isolationVerifier, finalizeNow,
      ).state !== 'verified') {
        finalized = null;
        finalReason = 'finalize-attestation-failed';
      } else {
        const finalizedRecord = ports.journal.advance(journal.runId, journal.recordDigest, 'finalized', {
          finalAttestationDigest: finalized.attestationDigest,
        }, lock);
        if (!finalizedRecord.ok) finalReason = 'journal-unavailable';
        else journal = finalizedRecord.record;
      }
      if (finalReason === 'succeeded' && verifiedResponse) output = Buffer.from(verifiedResponse.output);
    } else if (execution && finalReason === 'succeeded') {
      finalReason = 'producer-failed';
    }
    const released = ports.capacity.release({ allocationId, ownerCapability, expectedLeaseEpoch: 1 });
    const capacityReleased = released.reason === 'released' && released.durable;
    if (!capacityReleased) finalReason = 'capacity-release-failed';
    const settled = ports.journal.advance(journal.runId, journal.recordDigest, 'settled', {
      outcome: outcomeFor(finalReason),
      leaseEpoch: released.leaseEpoch ?? 1,
    }, lock);
    if (!settled.ok) finalReason = 'journal-unavailable';
    return result(finalReason === 'succeeded' ? 'completed' :
      ['engine-unavailable', 'cleanup-failed', 'journal-unavailable',
        'capacity-release-failed'].includes(finalReason)
        ? 'unavailable' : 'withheld', finalReason, {
      ...base,
      prepareAttestation: prepare,
      finalizeAttestation: finalized,
      output: finalReason === 'succeeded' ? output : null,
      containerRemovalConfirmed: true,
      capacityReleased,
    });
  }

  async recover(): Promise<AgentOsLocalContainerBrokerRecoveryResultV1> {
    if (!this.#enabled) return { state: 'withheld', recoveredRuns: 0, unreconciledRuns: 0,
      stopReasons: ['disabled'], ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1 };
    if (!this.#ready()) return { state: 'unavailable', recoveredRuns: 0, unreconciledRuns: 0,
      stopReasons: ['invalid-dependencies'], ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1 };
    const ports = this.#ports!;
    const locked = ports.journal.acquireLifecycleLock();
    if (locked.state !== 'acquired') return { state: locked.state === 'contended' ? 'withheld' : 'unavailable',
      recoveredRuns: 0, unreconciledRuns: 0, stopReasons: [`journal-${locked.state}`],
      ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1 };
    let recovered = 0;
    let unreconciled = 0;
    const stopReasons: string[] = [];
    try {
      if (!ports.journal.recoverStore(locked.lock)) return { state: 'unavailable', recoveredRuns: 0,
        unreconciledRuns: 0, stopReasons: ['journal-unavailable'],
        ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1 };
      const active = ports.journal.readActive(locked.lock);
      if (!active) return { state: 'unavailable', recoveredRuns: 0, unreconciledRuns: 0,
        stopReasons: ['journal-unavailable'], ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1 };
      if (active.length > 0) {
        const engine = await ports.engine.inspectEngine(this.#expectedEngineDigest);
        if (!engine.ok) return {
          state: 'unavailable', recoveredRuns: 0, unreconciledRuns: active.length,
          stopReasons: [engine.reason], ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1,
        };
      }
      for (let current of active) {
        if (current.stage === 'finalized') {
          const settled = ports.journal.advance(current.runId, current.recordDigest, 'settled', {
            outcome: 'recovered-after-crash',
          }, locked.lock);
          if (settled.ok) recovered += 1; else { unreconciled += 1; stopReasons.push('journal-unavailable'); }
          continue;
        }
        if (current.stage === 'removed') {
          const abandoned = ports.journal.advance(current.runId, current.recordDigest, 'abandoned', {
            outcome: 'recovered-after-crash',
          }, locked.lock);
          if (abandoned.ok) recovered += 1;
          else { unreconciled += 1; stopReasons.push('journal-unavailable'); }
          continue;
        }
        let containerId = current.containerId;
        if (!containerId) {
          const resolved = await ports.engine.resolveContainerIdByName(current.containerName);
          if (!resolved.ok && resolved.reason === 'container-not-found') {
            // Create may still be completing after a lost transport receipt.
            // Preserve the active record and retry only cleanup on a later pass.
            unreconciled += 1;
            stopReasons.push('ambiguous-create-not-found');
            continue;
          }
          if (!resolved.ok) { unreconciled += 1; stopReasons.push(resolved.reason); continue; }
          containerId = resolved.value;
          const engineCreateRequestDigest = agentOsDockerEngineCreateRequestDigestV1(
            this.#policy!, this.#seccompProfile,
          );
          const created = ports.journal.advance(current.runId, current.recordDigest, 'created', {
            containerId, engineCreateRequestDigest,
          }, locked.lock);
          if (!created.ok) { unreconciled += 1; stopReasons.push('journal-unavailable'); continue; }
          current = created.record;
        }
        const inspected = await ports.engine.inspectContainer({
          containerId, containerName: current.containerName, policy: this.#policy!,
          seccompProfile: this.#seccompProfile,
        });
        if (!inspected.ok) {
          if (inspected.reason === 'container-not-found') {
            const removalDigest = digest('ashlr.agent-os.recovery-absence.v1', { containerId });
            const removed = ports.journal.advance(current.runId, current.recordDigest, 'removed', {
              removalEvidenceDigest: removalDigest,
            }, locked.lock);
            const abandoned = removed.ok ? ports.journal.advance(current.runId, removed.record.recordDigest,
              'abandoned', { outcome: 'recovered-after-crash' }, locked.lock) : removed;
            if (abandoned.ok) recovered += 1; else { unreconciled += 1; stopReasons.push('journal-unavailable'); }
          } else {
            ports.journal.advance(current.runId, current.recordDigest, 'unreconciled', {
              outcome: 'cleanup-failed',
            }, locked.lock);
            unreconciled += 1;
            stopReasons.push(inspected.reason);
          }
          continue;
        }
        if (inspected.value.running) {
          await ports.engine.killContainer(containerId);
          await ports.engine.waitContainer(containerId, AGENT_OS_LOCAL_CONTAINER_BROKER_MAX_KILL_WAIT_MS_V1);
        }
        const removed = await ports.engine.removeContainer(containerId);
        const absent = removed.ok ? await ports.engine.confirmContainerAbsent(containerId) : removed;
        if (!removed.ok || !absent.ok) {
          ports.journal.advance(current.runId, current.recordDigest, 'unreconciled', {
            outcome: 'cleanup-failed',
          }, locked.lock);
          unreconciled += 1;
          stopReasons.push('cleanup-failed');
          continue;
        }
        const removalDigest = digest('ashlr.agent-os.recovery-removal.v1', { containerId, absent: true });
        const removedRecord = ports.journal.advance(current.runId, current.recordDigest, 'removed', {
          removalEvidenceDigest: removalDigest,
        }, locked.lock);
        const abandoned = removedRecord.ok ? ports.journal.advance(current.runId,
          removedRecord.record.recordDigest, 'abandoned', { outcome: 'recovered-after-crash' }, locked.lock)
          : removedRecord;
        if (abandoned.ok) recovered += 1; else { unreconciled += 1; stopReasons.push('journal-unavailable'); }
      }
    } catch {
      unreconciled += 1;
      stopReasons.push('recovery-threw');
    } finally {
      if (!ports.journal.releaseLifecycleLock(locked.lock)) stopReasons.push('lifecycle-lock-release-failed');
    }
    return {
      state: unreconciled > 0 || stopReasons.length > 0 ? 'unavailable' : recovered > 0 ? 'recovered' : 'clean',
      recoveredRuns: recovered,
      unreconciledRuns: unreconciled,
      stopReasons,
      ...AGENT_OS_LOCAL_CONTAINER_BROKER_NO_AUTHORITY_V1,
    };
  }
}

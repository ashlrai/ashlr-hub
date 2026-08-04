import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';

import {
  parseRuntimeReleaseEvidenceEnvelope,
  parseRuntimeReleaseEvidenceTrustRoot,
  verifyRuntimeReleaseEvidenceEnvelope,
} from './runtime-release-evidence-envelope.js';
import { parseUnsignedRuntimeReleaseManifest } from './runtime-release-manifest.js';

const SHA256_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-f0-9]{40}$/;
const KEY_ID_RE = /^ed25519-sha256:[a-f0-9]{64}$/;
const POLICY_ID_RE = /^sha256:[a-f0-9]{64}$/;
const INVOCATION_DOMAIN = 'ashlr:runtime-release-service-invocation:v1';
const ENVELOPE_CANONICAL_DOMAIN = 'ashlr:runtime-release-launch-envelope-canonical:v1';
const POLICY_CANONICAL_DOMAIN = 'ashlr:runtime-release-launch-policy-canonical:v1';
const TRUST_ROOT_CANONICAL_DOMAIN = 'ashlr:runtime-release-launch-trust-root-canonical:v1';
const MAX_ARGUMENTS = 128;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RuntimeReleaseLaunchReadinessInputV1 {
  argv: string[];
  declaredInterpreterPath: string;
  declaredInterpreterVersion: string;
  dependencyRoot: string;
  envelope: string | Buffer;
  executablePath: string;
  expectedEnvelopeCanonicalSha256: string;
  expectedKeyId: string;
  expectedManifestDigest: string;
  expectedPackageName?: string;
  expectedPolicyId: string;
  expectedRevision: string;
  expectedServiceInvocationDigest: string;
  expectedStagedTreeIdentity: string;
  expectedTrustRootCanonicalSha256: string;
  manifest: string | Buffer;
  packageRoot: string;
  policy: string | Buffer;
  trustRoot: string | Buffer;
}

interface SourceObservationV1 {
  sourceState: 'healthy' | 'degraded';
  complete: boolean;
  reasonCode: string;
}

export interface RuntimeReleaseLaunchReadinessObservationV1 {
  releaseManifest: SourceObservationV1 & {
    state: 'observed' | 'invalid';
    manifestDigest: string | null;
  };
  releaseEvidence: SourceObservationV1 & {
    state: 'verified-observation-only' | 'invalid';
    keyId: string | null;
  };
  launchAdmission: SourceObservationV1 & {
    state: 'observed-blocked' | 'unavailable';
    blockerCodes: string[];
  };
}

const PERMANENT_BLOCKERS = Object.freeze([
  'atomic-launch-handoff-absent',
  'durable-replay-consumption-absent',
  'rollback-unresolved',
  'revision-provenance-unresolved',
  'trusted-activation-root-absent',
  'trusted-policy-authority-absent',
]);

function canonicalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('invalid JSON number');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid JSON value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('invalid JSON object');
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

function domainDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\n', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function domainBytesDigest(domain: string, value: string | Buffer): string {
  return createHash('sha256').update(domain, 'utf8').update('\n', 'utf8').update(value).digest('hex');
}

function parseCanonicalPolicy(value: string | Buffer): string | null {
  try {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    if (bytes.length === 0 || bytes.length > MAX_POLICY_BYTES) return null;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return null;
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const canonical = `${canonicalJson(parsed)}\n`;
    return canonical === text ? canonical : null;
  } catch {
    return null;
  }
}

function callerBindingsValid(input: RuntimeReleaseLaunchReadinessInputV1): boolean {
  try {
    if (!isAbsolute(input.packageRoot) || !isAbsolute(input.dependencyRoot) ||
      resolve(input.dependencyRoot) !== join(resolve(input.packageRoot), 'node_modules') ||
      !isAbsolute(input.declaredInterpreterPath) || !isAbsolute(input.executablePath) ||
      !SHA256_RE.test(input.expectedStagedTreeIdentity) ||
      !SHA256_RE.test(input.expectedEnvelopeCanonicalSha256) ||
      !SHA256_RE.test(input.expectedServiceInvocationDigest) ||
      !SHA256_RE.test(input.expectedTrustRootCanonicalSha256) ||
      !POLICY_ID_RE.test(input.expectedPolicyId) ||
      input.argv.length === 0 || input.argv.length > MAX_ARGUMENTS) return false;
    let argumentBytes = 0;
    for (const argument of input.argv) {
      if (argument.includes('\0')) return false;
      argumentBytes += Buffer.byteLength(argument, 'utf8');
      if (argumentBytes > MAX_ARGUMENT_BYTES) return false;
    }
    const policy = parseCanonicalPolicy(input.policy);
    if (!policy || `sha256:${domainBytesDigest(POLICY_CANONICAL_DOMAIN, policy)}` !==
      input.expectedPolicyId) return false;
    const envelope = parseRuntimeReleaseEvidenceEnvelope(input.envelope);
    if (!envelope.ok || domainBytesDigest(ENVELOPE_CANONICAL_DOMAIN, envelope.canonicalJson) !==
      input.expectedEnvelopeCanonicalSha256) return false;
    const trustRoot = parseRuntimeReleaseEvidenceTrustRoot(input.trustRoot);
    if (!trustRoot.ok || domainBytesDigest(TRUST_ROOT_CANONICAL_DOMAIN, trustRoot.canonicalJson) !==
      input.expectedTrustRootCanonicalSha256) return false;
    return domainDigest(INVOCATION_DOMAIN, {
      argv: [...input.argv],
      executablePath: input.executablePath,
    }) === input.expectedServiceInvocationDigest;
  } catch {
    return false;
  }
}

function failed(
  manifestValid: boolean,
  evidenceValid: boolean,
): RuntimeReleaseLaunchReadinessObservationV1 {
  return {
    releaseManifest: manifestValid
      ? {
        sourceState: 'healthy',
        complete: true,
        reasonCode: 'manifest-observed',
        state: 'observed',
        manifestDigest: null,
      }
      : {
        sourceState: 'degraded',
        complete: false,
        reasonCode: 'manifest-invalid',
        state: 'invalid',
        manifestDigest: null,
      },
    releaseEvidence: evidenceValid
      ? {
        sourceState: 'healthy',
        complete: true,
        reasonCode: 'release-evidence-observed',
        state: 'verified-observation-only',
        keyId: null,
      }
      : {
        sourceState: 'degraded',
        complete: false,
        reasonCode: 'release-evidence-invalid',
        state: 'invalid',
        keyId: null,
      },
    launchAdmission: {
      sourceState: 'degraded',
      complete: false,
      reasonCode: 'launch-observation-failed',
      state: 'unavailable',
      blockerCodes: ['launch-observation-failed'],
    },
  };
}

/**
 * Read-only readiness observation over caller-pinned bytes. This deliberately
 * does not import launch preparation or durability code and never grants
 * launch authority.
 */
export function observeRuntimeReleaseLaunchReadinessV1(
  input: RuntimeReleaseLaunchReadinessInputV1,
  packagingObservationComplete: boolean,
): RuntimeReleaseLaunchReadinessObservationV1 {
  let parsed: ReturnType<typeof parseUnsignedRuntimeReleaseManifest>;
  try {
    parsed = parseUnsignedRuntimeReleaseManifest(input.manifest);
  } catch {
    return failed(false, false);
  }
  const manifestValid = parsed.ok && SHA256_RE.test(parsed.manifest.manifestDigest) &&
    parsed.manifest.manifestDigest === input.expectedManifestDigest &&
    parsed.manifest.expectedRevision === input.expectedRevision && REVISION_RE.test(input.expectedRevision);

  let verified: ReturnType<typeof verifyRuntimeReleaseEvidenceEnvelope>;
  try {
    verified = verifyRuntimeReleaseEvidenceEnvelope({
      envelope: input.envelope,
      manifest: input.manifest,
      trustRoot: input.trustRoot,
    });
  } catch {
    return failed(manifestValid, false);
  }
  const evidenceValid = verified.ok && KEY_ID_RE.test(verified.keyId) &&
    verified.keyId === input.expectedKeyId &&
    verified.manifestDigest === input.expectedManifestDigest &&
    verified.expectedRevision === input.expectedRevision;
  if (!manifestValid || !evidenceValid || !parsed.ok || !verified.ok ||
    !callerBindingsValid(input) ||
    !packagingObservationComplete) {
    const result = failed(manifestValid, evidenceValid);
    if (manifestValid) result.releaseManifest.manifestDigest = parsed.ok
      ? parsed.manifest.manifestDigest
      : null;
    if (evidenceValid && verified.ok) result.releaseEvidence.keyId = verified.keyId;
    return result;
  }

  return {
    releaseManifest: {
      sourceState: 'healthy',
      complete: true,
      reasonCode: 'manifest-observed',
      state: 'observed',
      manifestDigest: parsed.manifest.manifestDigest,
    },
    releaseEvidence: {
      sourceState: 'healthy',
      complete: true,
      reasonCode: 'release-evidence-observed',
      state: 'verified-observation-only',
      keyId: verified.keyId,
    },
    launchAdmission: {
      sourceState: 'healthy',
      complete: true,
      reasonCode: 'read-only-launch-readiness-observed',
      state: 'observed-blocked',
      blockerCodes: [...PERMANENT_BLOCKERS],
    },
  };
}

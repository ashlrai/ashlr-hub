import {
  createHash,
  createPublicKey,
  KeyObject,
  verify,
  type JsonWebKey,
} from 'node:crypto';

export const ENGINEERING_ASSIGNMENT_PROTOCOL = 'ashlr-engineering-assignment/v1' as const;
export const ENGINEERING_ASSIGNMENT_VERSION = 1 as const;
export const ENGINEERING_ASSIGNMENT_SIGNATURE_DOMAIN =
  'ashlr-engineering-assignment-signature/v1' as const;

const WORKSTREAMS = ['personal', 'company', 'govcon', 'commercial'] as const;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

export type EngineeringAssignmentV1 = Readonly<{
  protocol: typeof ENGINEERING_ASSIGNMENT_PROTOCOL;
  version: typeof ENGINEERING_ASSIGNMENT_VERSION;
  issuer: string;
  audience: string;
  keyId: string;
  assignmentId: string;
  runId: string;
  issuedAt: string;
  expiresAt: string;
  organizationRef: string;
  workstream: (typeof WORKSTREAMS)[number];
  repo: Readonly<{
    owner: string;
    name: string;
    defaultBranch: string;
    sourceCommit: string;
  }>;
  mission: Readonly<{
    objective: string;
    successSignals: readonly string[];
    guardrails: readonly string[];
    allowedFiles: readonly string[];
  }>;
  resultContract: Readonly<{
    kind: 'verified-proposal';
    requireDiff: true;
    requireProposal: true;
    requireVerification: true;
    maxChangedFiles: number;
    maxChangedLines: number;
  }>;
  authority: Readonly<{
    effect: 'proposal-only';
    requiredTenantRef: string;
  }>;
  assignmentDigest: string;
  assignmentSignature: string;
}>;

export type EngineeringAssignmentPublicKey =
  | KeyObject
  | string
  | Buffer
  | Readonly<{ key: string | Buffer; format: 'pem' | 'der'; type: 'spki' }>
  | Readonly<{ key: JsonWebKey; format: 'jwk' }>;

export type EngineeringAssignmentVerifier = Readonly<{
  issuer: string;
  audience: string;
  publicKeys: Readonly<Record<string, EngineeringAssignmentPublicKey>>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index]);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 &&
    /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value);
}

function canonicalBranch(value: unknown): value is string {
  const forbidden = '~^:?*[\\';
  return typeof value === 'string' && value.length > 0 && value.length <= 255 &&
    value === value.trim() && !value.startsWith('/') && !value.endsWith('/') &&
    !value.endsWith('.') && value !== '@' && !value.includes('//') && !value.includes('..') &&
    !value.includes('@{') && ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 32 || code === 127 || forbidden.includes(character);
    }) && !value.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'));
}

function canonicalAllowedFile(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const segments = value.split('/');
  return value.length > 0 && value.length <= 500 && value === value.trim() &&
    !value.startsWith('/') && !value.startsWith('./') && !value.startsWith('~') &&
    !/^[A-Za-z]:/.test(value) && /^[\x21-\x7E]+$/.test(value) &&
    !/[\\:%?{}[\]()!|]/.test(value) && !segments.some((segment, index) => {
      if (!segment || segment === '.' || segment === '..') return true;
      if (segment.toLowerCase() === '.git') return true;
      if (segment === '*') return false;
      if (segment === '**') return index !== segments.length - 1;
      return !/^[A-Za-z0-9._@+-]+$/.test(segment);
    });
}

function canonicalStrings(
  value: unknown,
  options: { maxItems: number; maxLength: number; allowedFile?: boolean },
): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > options.maxItems) return false;
  if (!value.every((item) => typeof item === 'string' && item.length > 0 &&
    item.length <= options.maxLength && item === item.trim() &&
    (!options.allowedFile || canonicalAllowedFile(item)))) return false;
  return new Set(value).size === value.length;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function unsignedAssignment(
  value: Record<string, unknown>,
): Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'> | null {
  if (!exactKeys(value, [
    'protocol', 'version', 'issuer', 'audience', 'keyId',
    'assignmentId', 'runId', 'issuedAt', 'expiresAt',
    'organizationRef', 'workstream', 'repo', 'mission', 'resultContract',
    'authority', 'assignmentDigest', 'assignmentSignature',
  ]) || value.protocol !== ENGINEERING_ASSIGNMENT_PROTOCOL ||
    value.version !== ENGINEERING_ASSIGNMENT_VERSION || !identifier(value.issuer) ||
    !identifier(value.audience) || !identifier(value.keyId) || !identifier(value.assignmentId) ||
    !identifier(value.runId) || !canonicalIso(value.issuedAt) ||
    !canonicalIso(value.expiresAt) || !identifier(value.organizationRef) ||
    value.assignmentId !== value.runId ||
    !WORKSTREAMS.includes(value.workstream as EngineeringAssignmentV1['workstream']) ||
    !isRecord(value.repo) || !isRecord(value.mission) ||
    !isRecord(value.resultContract) || !isRecord(value.authority)) return null;

  const repo = value.repo;
  const mission = value.mission;
  const result = value.resultContract;
  const authority = value.authority;
  if (!exactKeys(repo, ['owner', 'name', 'defaultBranch', 'sourceCommit']) ||
    typeof repo.owner !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(repo.owner) || repo.owner.length > 100 ||
    typeof repo.name !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(repo.name) || repo.name.length > 100 ||
    !canonicalBranch(repo.defaultBranch) || typeof repo.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(repo.sourceCommit) ||
    !exactKeys(mission, ['objective', 'successSignals', 'guardrails', 'allowedFiles']) ||
    typeof mission.objective !== 'string' || mission.objective.length < 1 ||
    mission.objective.length > 20_000 || mission.objective !== mission.objective.trim() ||
    !canonicalStrings(mission.successSignals, { maxItems: 100, maxLength: 2_000 }) ||
    !canonicalStrings(mission.guardrails, { maxItems: 100, maxLength: 2_000 }) ||
    !canonicalStrings(mission.allowedFiles, {
      maxItems: 250, maxLength: 500, allowedFile: true,
    }) || !exactKeys(result, [
      'kind', 'requireDiff', 'requireProposal', 'requireVerification',
      'maxChangedFiles', 'maxChangedLines',
    ]) || result.kind !== 'verified-proposal' || result.requireDiff !== true ||
    result.requireProposal !== true || result.requireVerification !== true ||
    typeof result.maxChangedFiles !== 'number' || !Number.isInteger(result.maxChangedFiles) ||
    result.maxChangedFiles < 1 || result.maxChangedFiles > 500 ||
    typeof result.maxChangedLines !== 'number' || !Number.isInteger(result.maxChangedLines) ||
    result.maxChangedLines < 1 || result.maxChangedLines > 100_000 ||
    !exactKeys(authority, ['effect', 'requiredTenantRef']) ||
    authority.effect !== 'proposal-only' || !identifier(authority.requiredTenantRef) ||
    authority.requiredTenantRef !== value.organizationRef) return null;

  return {
    protocol: ENGINEERING_ASSIGNMENT_PROTOCOL,
    version: ENGINEERING_ASSIGNMENT_VERSION,
    issuer: value.issuer,
    audience: value.audience,
    keyId: value.keyId,
    assignmentId: value.assignmentId,
    runId: value.runId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    organizationRef: value.organizationRef,
    workstream: value.workstream as EngineeringAssignmentV1['workstream'],
    repo: {
      owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch,
      sourceCommit: repo.sourceCommit,
    },
    mission: {
      objective: mission.objective,
      successSignals: [...mission.successSignals],
      guardrails: [...mission.guardrails],
      allowedFiles: [...mission.allowedFiles],
    },
    resultContract: {
      kind: 'verified-proposal', requireDiff: true, requireProposal: true,
      requireVerification: true, maxChangedFiles: result.maxChangedFiles,
      maxChangedLines: result.maxChangedLines,
    },
    authority: { effect: 'proposal-only', requiredTenantRef: authority.requiredTenantRef },
  };
}

export function engineeringAssignmentDigest(
  value: Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'>,
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalUnsigned(value)), 'utf8').digest('hex')}`;
}

function canonicalUnsigned(
  value: Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'>,
): Omit<EngineeringAssignmentV1, 'assignmentDigest' | 'assignmentSignature'> {
  return {
    protocol: ENGINEERING_ASSIGNMENT_PROTOCOL,
    version: ENGINEERING_ASSIGNMENT_VERSION,
    issuer: value.issuer,
    audience: value.audience,
    keyId: value.keyId,
    assignmentId: value.assignmentId,
    runId: value.runId,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    organizationRef: value.organizationRef,
    workstream: value.workstream,
    repo: {
      owner: value.repo.owner,
      name: value.repo.name,
      defaultBranch: value.repo.defaultBranch,
      sourceCommit: value.repo.sourceCommit,
    },
    mission: {
      objective: value.mission.objective,
      successSignals: [...value.mission.successSignals],
      guardrails: [...value.mission.guardrails],
      allowedFiles: [...value.mission.allowedFiles],
    },
    resultContract: {
      kind: 'verified-proposal',
      requireDiff: true,
      requireProposal: true,
      requireVerification: true,
      maxChangedFiles: value.resultContract.maxChangedFiles,
      maxChangedLines: value.resultContract.maxChangedLines,
    },
    authority: {
      effect: 'proposal-only',
      requiredTenantRef: value.authority.requiredTenantRef,
    },
  };
}

function signaturePayload(assignmentDigest: string): Buffer {
  return Buffer.from(`${ENGINEERING_ASSIGNMENT_SIGNATURE_DOMAIN}\0${assignmentDigest}`, 'utf8');
}

function canonicalEd25519Signature(actual: string): Buffer | null {
  if (!/^ed25519:[A-Za-z0-9_-]{86}$/.test(actual)) return null;
  const encoded = actual.slice('ed25519:'.length);
  const decoded = Buffer.from(encoded, 'base64url');
  return decoded.length === 64 && decoded.toString('base64url') === encoded ? decoded : null;
}

function canonicalPublicJwk(value: JsonWebKey): boolean {
  if (!exactKeys(value as Record<string, unknown>, ['crv', 'kty', 'x']) || 'd' in value ||
      value.kty !== 'OKP' || value.crv !== 'Ed25519' || typeof value.x !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.x)) return false;
  const decoded = Buffer.from(value.x, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === value.x;
}

function publicEd25519Key(input: EngineeringAssignmentPublicKey): KeyObject | null {
  try {
    let publicKey: KeyObject;
    if (input instanceof KeyObject) {
      if (input.type !== 'public') return null;
      publicKey = input;
    } else if (typeof input === 'string' || Buffer.isBuffer(input)) {
      const encoded = Buffer.isBuffer(input) ? input.toString('utf8') : input;
      publicKey = createPublicKey({ key: encoded, format: 'pem', type: 'spki' });
      if (publicKey.export({ format: 'pem', type: 'spki' }).toString() !== encoded) return null;
    } else if (input.format === 'jwk') {
      if (!exactKeys(input as Record<string, unknown>, ['format', 'key']) ||
          !canonicalPublicJwk(input.key)) return null;
      publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: input.key.x }, format: 'jwk',
      });
    } else {
      if (!exactKeys(input as Record<string, unknown>, ['format', 'key', 'type']) ||
          input.type !== 'spki') return null;
      publicKey = createPublicKey({ key: input.key, format: input.format, type: 'spki' });
      const exported = input.format === 'pem'
        ? publicKey.export({ format: 'pem', type: 'spki' })
        : publicKey.export({ format: 'der', type: 'spki' });
      const supplied = typeof input.key === 'string' ? Buffer.from(input.key, 'utf8') : input.key;
      const canonical = typeof exported === 'string' ? Buffer.from(exported, 'utf8') : exported;
      if (!canonical.equals(supplied)) return null;
    }
    return publicKey.type === 'public' && publicKey.asymmetricKeyType === 'ed25519'
      ? publicKey : null;
  } catch {
    return null;
  }
}

function signatureMatches(
  actual: string,
  assignmentDigest: string,
  publicKeyInput: EngineeringAssignmentPublicKey,
): boolean {
  try {
    const signature = canonicalEd25519Signature(actual);
    const publicKey = publicEd25519Key(publicKeyInput);
    return signature !== null && publicKey !== null &&
      verify(null, signaturePayload(assignmentDigest), publicKey, signature);
  } catch {
    return false;
  }
}

export function parseEngineeringAssignmentV1(
  value: unknown,
  options: { now?: Date; verifier?: EngineeringAssignmentVerifier } = {},
): EngineeringAssignmentV1 | null {
  if (!isRecord(value)) return null;
  const unsigned = unsignedAssignment(value);
  if (!unsigned || !options.verifier || typeof value.assignmentDigest !== 'string' ||
      typeof value.assignmentSignature !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(value.assignmentDigest) ||
      !/^ed25519:[A-Za-z0-9_-]{86}$/.test(value.assignmentSignature)) return null;
  const now = options.now ?? new Date();
  const issuedMs = Date.parse(unsigned.issuedAt);
  const expiresMs = Date.parse(unsigned.expiresAt);
  if (!Number.isFinite(now.getTime()) || issuedMs > now.getTime() + MAX_FUTURE_SKEW_MS ||
    expiresMs <= issuedMs || expiresMs - issuedMs > MAX_TTL_MS ||
    expiresMs <= now.getTime() || unsigned.issuer !== options.verifier.issuer ||
    unsigned.audience !== options.verifier.audience ||
    engineeringAssignmentDigest(unsigned) !== value.assignmentDigest) return null;
  const key = options.verifier.publicKeys[unsigned.keyId];
  if (!key || !signatureMatches(value.assignmentSignature, value.assignmentDigest, key)) return null;
  return deepFreeze({
    ...canonicalUnsigned(unsigned),
    assignmentDigest: value.assignmentDigest,
    assignmentSignature: value.assignmentSignature,
  });
}

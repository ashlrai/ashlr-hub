import { createHash } from 'node:crypto';

export const ENGINEERING_ASSIGNMENT_PROTOCOL = 'ashlr-engineering-assignment/v1' as const;
export const ENGINEERING_ASSIGNMENT_VERSION = 1 as const;

const WORKSTREAMS = ['personal', 'company', 'govcon', 'commercial'] as const;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

export type EngineeringAssignmentV1 = Readonly<{
  protocol: typeof ENGINEERING_ASSIGNMENT_PROTOCOL;
  version: typeof ENGINEERING_ASSIGNMENT_VERSION;
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
  return typeof value === 'string' && value.length > 0 && value.length <= 500 &&
    value === value.trim() && !value.startsWith('/') && !value.startsWith('./') &&
    !value.startsWith('~') && !/^[A-Za-z]:/.test(value) && !value.includes('\\') &&
    !value.includes(':') && ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 31 || code === 127;
    }) && !value.split('/').some((segment) =>
      !segment || segment === '.' || segment === '..' || segment.toLowerCase() === '.git');
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
): Omit<EngineeringAssignmentV1, 'assignmentDigest'> | null {
  if (!exactKeys(value, [
    'protocol', 'version', 'assignmentId', 'runId', 'issuedAt', 'expiresAt',
    'organizationRef', 'workstream', 'repo', 'mission', 'resultContract',
    'authority', 'assignmentDigest',
  ]) || value.protocol !== ENGINEERING_ASSIGNMENT_PROTOCOL ||
    value.version !== ENGINEERING_ASSIGNMENT_VERSION || !identifier(value.assignmentId) ||
    !identifier(value.runId) || !canonicalIso(value.issuedAt) ||
    !canonicalIso(value.expiresAt) || !identifier(value.organizationRef) ||
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
  value: Omit<EngineeringAssignmentV1, 'assignmentDigest'>,
): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function parseEngineeringAssignmentV1(
  value: unknown,
  options: { now?: Date } = {},
): EngineeringAssignmentV1 | null {
  if (!isRecord(value)) return null;
  const unsigned = unsignedAssignment(value);
  if (!unsigned || typeof value.assignmentDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.assignmentDigest)) return null;
  const now = options.now ?? new Date();
  const issuedMs = Date.parse(unsigned.issuedAt);
  const expiresMs = Date.parse(unsigned.expiresAt);
  if (!Number.isFinite(now.getTime()) || issuedMs > now.getTime() + MAX_FUTURE_SKEW_MS ||
    expiresMs <= issuedMs || expiresMs - issuedMs > MAX_TTL_MS ||
    expiresMs <= now.getTime() ||
    engineeringAssignmentDigest(unsigned) !== value.assignmentDigest) return null;
  return deepFreeze({ ...unsigned, assignmentDigest: value.assignmentDigest });
}

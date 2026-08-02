import { createHash } from 'node:crypto';

export const AUTOMERGE_SCOPE_POLICY_SCHEMA_VERSION = 1 as const;
export const DEFAULT_AUTOMERGE_MAX_FILES = 4;
export const DEFAULT_AUTOMERGE_MAX_LINES = 150;
export const MAX_AUTOMERGE_POLICY_FILES = 10;
export const MAX_AUTOMERGE_POLICY_LINES = 300;

const SCOPE_POLICY_DOMAIN = 'ashlr:automerge-scope-policy:v1';

export type AutoMergeScopePolicySource = 'explicit' | 'default' | 'mixed';
export type AutoMergeScopePolicyInvalidReason =
  | 'max-files-invalid'
  | 'max-files-exceeds-policy'
  | 'max-lines-invalid'
  | 'max-lines-exceeds-policy';

export interface AutoMergeScopePolicy {
  schemaVersion: typeof AUTOMERGE_SCOPE_POLICY_SCHEMA_VERSION;
  maxFiles: number;
  maxLines: number;
  policyMaxFiles: typeof MAX_AUTOMERGE_POLICY_FILES;
  policyMaxLines: typeof MAX_AUTOMERGE_POLICY_LINES;
  source: AutoMergeScopePolicySource;
  explicitFiles: boolean;
  explicitLines: boolean;
  digest: string;
}

export type AutoMergeScopePolicyResolution =
  | { ok: true; policy: AutoMergeScopePolicy; reasons: [] }
  | { ok: false; policy: null; reasons: AutoMergeScopePolicyInvalidReason[] };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function digestPolicy(maxFiles: number, maxLines: number): string {
  return createHash('sha256').update(JSON.stringify([
    SCOPE_POLICY_DOMAIN,
    {
      schemaVersion: AUTOMERGE_SCOPE_POLICY_SCHEMA_VERSION,
      maxFiles,
      maxLines,
      policyMaxFiles: MAX_AUTOMERGE_POLICY_FILES,
      policyMaxLines: MAX_AUTOMERGE_POLICY_LINES,
    },
  ]), 'utf8').digest('hex');
}

/**
 * Resolve the sole canonical auto-merge scope policy used by observation,
 * judging, and the mutation gate. Missing values use conservative defaults;
 * malformed or over-policy explicit values are invalid and must fail closed.
 */
export function resolveAutoMergeScopePolicy(autoMerge: unknown): AutoMergeScopePolicyResolution {
  const value = record(autoMerge);
  const rawFiles = value?.['maxAutomergeFiles'];
  const rawLines = value?.['maxAutomergeLines'];
  const explicitFiles = rawFiles !== undefined;
  const explicitLines = rawLines !== undefined;
  const reasons: AutoMergeScopePolicyInvalidReason[] = [];

  const maxFiles = explicitFiles ? rawFiles : DEFAULT_AUTOMERGE_MAX_FILES;
  const maxLines = explicitLines ? rawLines : DEFAULT_AUTOMERGE_MAX_LINES;

  if (!Number.isSafeInteger(maxFiles) || Number(maxFiles) < 1) {
    reasons.push('max-files-invalid');
  } else if (Number(maxFiles) > MAX_AUTOMERGE_POLICY_FILES) {
    reasons.push('max-files-exceeds-policy');
  }
  if (!Number.isSafeInteger(maxLines) || Number(maxLines) < 1) {
    reasons.push('max-lines-invalid');
  } else if (Number(maxLines) > MAX_AUTOMERGE_POLICY_LINES) {
    reasons.push('max-lines-exceeds-policy');
  }
  if (reasons.length > 0) return { ok: false, policy: null, reasons };

  const files = Number(maxFiles);
  const lines = Number(maxLines);
  const source: AutoMergeScopePolicySource = explicitFiles && explicitLines
    ? 'explicit'
    : !explicitFiles && !explicitLines ? 'default' : 'mixed';
  return {
    ok: true,
    reasons: [],
    policy: {
      schemaVersion: AUTOMERGE_SCOPE_POLICY_SCHEMA_VERSION,
      maxFiles: files,
      maxLines: lines,
      policyMaxFiles: MAX_AUTOMERGE_POLICY_FILES,
      policyMaxLines: MAX_AUTOMERGE_POLICY_LINES,
      source,
      explicitFiles,
      explicitLines,
      digest: digestPolicy(files, lines),
    },
  };
}

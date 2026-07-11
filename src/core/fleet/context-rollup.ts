/**
 * Pure, metadata-only cadence gate for autonomous context rollup.
 *
 * Callers own persistence and supply the default contract explicitly. This
 * module deliberately performs no I/O and grants no authority beyond building
 * an agent-action ledger input.
 */

import { createHash } from 'node:crypto';
import type { AgentActionEvent } from './agent-action-ledger.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const CONTEXT_ROLLUP_ACTION = 'daemon:context-rollup';
export const CONTEXT_ROLLUP_SUMMARY = 'Autonomous context metadata rollup recorded.';
export const CONTEXT_ROLLUP_POLICY_VERSION = 'context-rollup-v1' as const;

export const CONTEXT_ROLLUP_COUNT_KEYS = [
  'eligibleEvents',
  'uniqueTrajectories',
  'proposalCreated',
  'diagnosticNoProposal',
  'policySuppressed',
  'blocked',
  'failed',
] as const;

export type ContextRollupCountKey = typeof CONTEXT_ROLLUP_COUNT_KEYS[number];
export type ContextRollupCounts = Partial<Record<ContextRollupCountKey, number>> & {
  eligibleEvents: number;
  uniqueTrajectories: number;
};

export interface ContextRollupContract {
  cadenceMs: number;
  minimumTerminalTrajectories: number;
}

export interface ContextRollupInput {
  observedAt: unknown;
  eligibleEventCount: unknown;
  latestSourceAt: unknown;
  persistedRollupEvents: unknown;
  counts?: unknown;
}

export interface ContextRollupOptions {
  /** Required integration defaults; this pure module does not read config. */
  defaultContract: ContextRollupContract;
  contract?: Partial<ContextRollupContract>;
}

export type ContextRollupNoopReason =
  | 'malformed-input'
  | 'below-trajectory-threshold'
  | 'cadence-active'
  | 'no-new-evidence';

export type ContextRollupDecision =
  | {
    disposition: 'emit';
    event: AgentActionEvent;
    counts: ContextRollupCounts;
    latestRollupAt: string | null;
  }
  | {
    disposition: 'noop';
    reason: ContextRollupNoopReason;
  };

const COUNT_KEYS = new Set<string>(CONTEXT_ROLLUP_COUNT_KEYS);

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function contractFrom(options: ContextRollupOptions): ContextRollupContract | null {
  if (!options || typeof options !== 'object') return null;
  const defaults = options.defaultContract;
  const override = options.contract;
  if (!defaults || typeof defaults !== 'object') return null;
  if (override !== undefined && (!override || typeof override !== 'object')) return null;

  const cadenceMs = override?.cadenceMs ?? defaults.cadenceMs;
  const minimumTerminalTrajectories = override?.minimumTerminalTrajectories ??
    defaults.minimumTerminalTrajectories;
  if (!positiveSafeInteger(cadenceMs) || !positiveSafeInteger(minimumTerminalTrajectories)) return null;
  return { cadenceMs, minimumTerminalTrajectories };
}

function rollupTimestamps(value: unknown, observedMs: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const timestamps: string[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const row = candidate as Record<string, unknown>;
    if (
      row['schemaVersion'] !== 1 ||
      row['actor'] !== 'daemon' ||
      row['kind'] !== 'context-rollup' ||
      row['outcome'] !== 'ok' ||
      row['action'] !== CONTEXT_ROLLUP_ACTION ||
      typeof row['contextRollupId'] !== 'string' ||
      !/^cr-[0-9a-f]{64}$/.test(row['contextRollupId']) ||
      row['contextRollupPolicyVersion'] !== CONTEXT_ROLLUP_POLICY_VERSION ||
      !canonicalTimestamp(row['contextRollupSourceMaxTs']) ||
      !canonicalTimestamp(row['ts']) ||
      Date.parse(row['contextRollupSourceMaxTs']) > Date.parse(row['ts']) ||
      Date.parse(row['ts']) > observedMs
    ) return null;
    timestamps.push(row['ts']);
  }
  return timestamps;
}

function sanitizeCounts(value: unknown): Partial<ContextRollupCounts> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output: Partial<ContextRollupCounts> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!COUNT_KEYS.has(key) || !nonNegativeSafeInteger(count)) return null;
    output[key as ContextRollupCountKey] = count;
  }
  return output;
}

/**
 * Decide whether a metadata-only rollup is due and build its ledger input.
 * Malformed or contradictory inputs always return a no-op.
 */
export function decideContextRollup(
  input: ContextRollupInput,
  options: ContextRollupOptions,
): ContextRollupDecision {
  const contract = contractFrom(options);
  if (
    !contract ||
    !input || typeof input !== 'object' ||
    !canonicalTimestamp(input.observedAt) ||
    !nonNegativeSafeInteger(input.eligibleEventCount) ||
    !canonicalTimestamp(input.latestSourceAt)
  ) return { disposition: 'noop', reason: 'malformed-input' };

  const observedMs = Date.parse(input.observedAt);
  const latestSourceMs = Date.parse(input.latestSourceAt);
  if (latestSourceMs > observedMs) return { disposition: 'noop', reason: 'malformed-input' };
  const timestamps = rollupTimestamps(input.persistedRollupEvents, observedMs);
  const suppliedCounts = sanitizeCounts(input.counts);
  if (!timestamps || !suppliedCounts) return { disposition: 'noop', reason: 'malformed-input' };
  if (
    suppliedCounts.eligibleEvents !== undefined &&
    suppliedCounts.eligibleEvents !== input.eligibleEventCount
  ) return { disposition: 'noop', reason: 'malformed-input' };

  if (input.eligibleEventCount < contract.minimumTerminalTrajectories) {
    return { disposition: 'noop', reason: 'below-trajectory-threshold' };
  }

  const latestRollupAt = timestamps.length > 0
    ? timestamps.reduce((latest, value) => value > latest ? value : latest)
    : null;
  if (
    latestRollupAt !== null &&
    observedMs - Date.parse(latestRollupAt) < contract.cadenceMs
  ) return { disposition: 'noop', reason: 'cadence-active' };
  if (latestRollupAt !== null && latestSourceMs <= Date.parse(latestRollupAt)) {
    return { disposition: 'noop', reason: 'no-new-evidence' };
  }

  const counts: ContextRollupCounts = {
    ...suppliedCounts,
    eligibleEvents: input.eligibleEventCount,
    uniqueTrajectories: input.eligibleEventCount,
  };
  const contextRollupId = `cr-${createHash('sha256').update(JSON.stringify({
    policyVersion: CONTEXT_ROLLUP_POLICY_VERSION,
    latestSourceAt: input.latestSourceAt,
    counts: CONTEXT_ROLLUP_COUNT_KEYS.map((key) => [key, counts[key] ?? 0]),
  })).digest('hex')}`;
  const event: AgentActionEvent = {
    schemaVersion: 1,
    ts: input.observedAt,
    actor: 'daemon',
    kind: 'context-rollup',
    outcome: 'ok',
    action: CONTEXT_ROLLUP_ACTION,
    summary: CONTEXT_ROLLUP_SUMMARY,
    reason: 'cadence-and-new-evidence',
    tags: ['context-rollup', 'autonomous', 'metadata-only'],
    counts,
    contextRollupId,
    contextRollupPolicyVersion: CONTEXT_ROLLUP_POLICY_VERSION,
    contextRollupSourceMaxTs: input.latestSourceAt,
  };
  return { disposition: 'emit', event, counts, latestRollupAt };
}

/** Strong, replay-idempotent identities for observe-only skill selections. */

import { createHash } from 'node:crypto';
import type { RouteSnapshot, SkillUseEvent } from '../types.js';
import { routeSnapshot } from '../learning/causal.js';
import { SKILL_RETRIEVAL_POLICY_VERSION, type ShadowSkillSummary } from './skill-retrieval.js';

const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,240}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export interface StrongSkillAttemptIdentity {
  trajectoryId?: string;
  runId?: string;
  proposalId?: string;
}

export interface BuildShadowSkillUseEventInput {
  identity: StrongSkillAttemptIdentity;
  selectedAt: string;
  skill: Pick<ShadowSkillSummary, 'skillId' | 'revision' | 'contentHash' | 'rank' | 'score'>;
  route: Pick<RouteSnapshot, 'backend' | 'tier' | 'model'>;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID_RE.test(value) ? value : undefined;
}

function strongIdentity(identity: StrongSkillAttemptIdentity): {
  key: string;
  trajectoryId?: string;
  runId?: string;
  proposalId?: string;
} | null {
  const trajectoryId = safeId(identity.trajectoryId);
  const runId = safeId(identity.runId);
  const proposalId = safeId(identity.proposalId);
  if (trajectoryId?.startsWith('work:')) return null;
  if (trajectoryId) return { key: `trajectory:${trajectoryId}`, trajectoryId, ...(runId ? { runId } : {}), ...(proposalId ? { proposalId } : {}) };
  if (runId) return { key: `run:${runId}`, runId, ...(proposalId ? { proposalId } : {}) };
  if (proposalId) return { key: `proposal:${proposalId}`, proposalId };
  return null;
}

function validSelectedAt(value: string): string | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms > Date.now() + MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

export function buildShadowSkillUseEvent(
  input: BuildShadowSkillUseEventInput,
): SkillUseEvent | null {
  try {
    const identity = strongIdentity(input.identity);
    const selectedAt = validSelectedAt(input.selectedAt);
    const skillId = safeId(input.skill.skillId);
    if (
      !identity ||
      !selectedAt ||
      !skillId ||
      !Number.isSafeInteger(input.skill.revision) ||
      input.skill.revision < 1 ||
      !SHA256_HEX_RE.test(input.skill.contentHash)
    ) return null;

    const policyVersion = SKILL_RETRIEVAL_POLICY_VERSION;
    const { key: identityKey, ...eventIdentity } = identity;
    const eventId = `skill-use:${createHash('sha256').update(JSON.stringify([
      identityKey,
      eventIdentity.trajectoryId ?? null,
      eventIdentity.runId ?? null,
      eventIdentity.proposalId ?? null,
      skillId,
      input.skill.revision,
      input.skill.contentHash,
      policyVersion,
      'selected',
      selectedAt,
    ])).digest('hex').slice(0, 32)}`;
    const snapshot = routeSnapshot({
      backend: input.route.backend,
      tier: input.route.tier,
      model: input.route.model,
      selectedSkillIds: [skillId],
      skillPolicyVersion: policyVersion,
      skillMode: 'shadow',
    });
    return {
      schemaVersion: 1,
      eventId,
      ts: selectedAt,
      skillId,
      skillRevision: input.skill.revision,
      contentHash: input.skill.contentHash,
      selectedAt,
      skillPolicyVersion: policyVersion,
      mode: 'shadow',
      stage: 'selected',
      outcome: 'unknown',
      rank: input.skill.rank,
      score: input.skill.score,
      ...eventIdentity,
      ...(snapshot ? { routeSnapshot: snapshot } : {}),
      learningSource: 'daemon-dispatch',
      labelBasis: 'unknown',
    };
  } catch {
    return null;
  }
}

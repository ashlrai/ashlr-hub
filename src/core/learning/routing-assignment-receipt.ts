/**
 * routing-assignment-receipt.ts — M-causal-routing: mints a
 * PolicyAssignmentReceiptV1 at ROUTING time, before the engine dispatches and
 * before any outcome is known, giving learned-router.ts's operational
 * (causal) admission path a real, joinable identity instead of the inert
 * observation-only placeholder policy-assignment-receipts.ts used to be.
 *
 * Join key: `dispatchTrajectoryId` is set to `run:${attemptId}` — exactly the
 * value causal.ts's `trajectoryIdFor()` already derives for every DecisionEntry
 * row belonging to the same dispatch attempt (`normalizeDecisionLearningFields`
 * runs on every ledger write). No change to DecisionEntry, sandboxed-engine.ts,
 * or any other decision write site is needed: the identity already exists on
 * both sides once this module exists to carry it onto the receipt.
 *
 * `workItemGenerationId` deliberately does NOT reuse the (unrelated) claimed-
 * batch admission module's generation helper — that module is walled off from
 * every other production consumer by its own m463 barrier test, guarding a
 * separate, not-yet-activated causal-experiment subsystem this task does not
 * touch. This module derives its own generation identity instead:
 * repair items reuse fleet/generated-repair-lifecycle.ts's existing lineage
 * id (the same one loop.ts already threads into the dispatch itself), and
 * plain items get a domain-separated HMAC scoped only to this module.
 *
 * The assignment recorded here is deliberately DETERMINISTIC (no exploration/
 * randomization exists in recommendRoute today): `reportedEligibleActions`
 * records every tier-matched candidate backend the caller actually had to
 * choose from (a real, evidence-based alternative set — not fabricated) with
 * the selected backend carrying all the probability mass. This is honest: it
 * neither claims randomized causal identifiability (causalIdentifiability
 * stays 'not-identifiable') nor collapses to a single-action receipt that
 * could never be "policy-eligible".
 */

import { realpathSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type { EngineId, WorkItem } from '../types.js';
import { generatedRepairGenerationId } from '../fleet/generated-repair-lifecycle.js';
import { existingWorkItemObjectiveHash } from '../fleet/work-item-objective.js';
import { loadExistingProvenanceKey } from '../foundry/provenance.js';
import {
  recordPolicyAssignmentReceipt,
  type PolicyAssignmentReceiptWriteDisposition,
} from './policy-assignment-receipts.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

function shaTuple(domain: string, values: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify([domain, ...values]), 'utf8').digest('hex');
}

function hmacTuple(key: Buffer, domain: string, values: readonly unknown[]): string {
  return createHmac('sha256', key).update(JSON.stringify([domain, ...values]), 'utf8').digest('hex');
}

function canonicalRepo(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) return null;
  try {
    const canonical = realpathSync(value);
    return isAbsolute(canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** Repair items already carry a durable lineage generation id; plain items get one scoped to this module. */
function workItemGenerationId(item: WorkItem, repo: string, objectiveHash: string, key: Buffer): string | null {
  const repairGeneration = generatedRepairGenerationId(item);
  if (repairGeneration !== null) return SHA256_RE.test(repairGeneration) ? repairGeneration : null;
  return hmacTuple(key, 'ashlr:learned-routing-generation:v1', [repo, item.id, item.source, objectiveHash]);
}

export interface RoutingAssignmentMintInput {
  /** The work item being dispatched. Only repo/id/source/title/detail are read. */
  item: WorkItem;
  /**
   * Must equal `run:${attemptId}` for the SAME attemptId that will end up on
   * this attempt's DecisionEntry rows (loop.ts already threads attemptId into
   * every dispatch trace as both `runId` and `trajectoryId: \`run:${attemptId}\``).
   */
  dispatchTrajectoryId: string;
  /** Should match causal.ts's ROUTER_POLICY_VERSION unless the caller runs a distinct routing policy. */
  policyVersion: string;
  /** Should match learningEpochFromTimestamp() at (approximately) this same instant. */
  learningEpoch: string;
  /** Stratification label, e.g. `${item.source}:${tier}`. */
  contextStratum: string;
  /** The backend this dispatch is actually about to run under. */
  selectedBackend: EngineId;
  /** Every backend that was actually eligible for the resolved tier — the recorded counterfactual set. Must include selectedBackend. */
  candidateBackends: readonly EngineId[];
  /** Defaults to now. */
  assignedAt?: string;
}

/**
 * Best-effort: never throws, and a failure to mint must never block dispatch.
 * Returns the underlying receipt-store disposition, or 'invalid'/'failed' for
 * anything that couldn't even be assembled (missing identity key, unresolved
 * repo, degenerate candidate set, etc).
 */
export function mintRoutingAssignmentReceipt(
  input: RoutingAssignmentMintInput,
): PolicyAssignmentReceiptWriteDisposition {
  try {
    const key = loadExistingProvenanceKey();
    if (!key) return 'failed';
    const repo = canonicalRepo(input.item.repo);
    if (!repo) return 'invalid';
    const canonicalItem: WorkItem = { ...input.item, repo };
    const objectiveHash = existingWorkItemObjectiveHash(canonicalItem);
    if (!objectiveHash) return 'invalid';
    const generationId = workItemGenerationId(canonicalItem, repo, objectiveHash, key);
    if (!generationId) return 'invalid';
    const candidates = [...new Set(input.candidateBackends)].sort();
    if (candidates.length < 1 || !candidates.includes(input.selectedBackend)) return 'invalid';

    const campaignDigest = shaTuple('ashlr:learned-routing-campaign:v1', [
      input.policyVersion,
      input.learningEpoch,
    ]);
    const eligibilityPopulationDigest = shaTuple('ashlr:learned-routing-eligibility-population:v1', [
      repo,
      input.item.source,
      input.policyVersion,
      input.learningEpoch,
      candidates,
    ]);
    const reportedEligibleActions = candidates.map((actionId) => ({
      actionId,
      actionDefinitionDigest: shaTuple('ashlr:learned-routing-action:v1', [actionId]),
      probabilityNumerator: actionId === input.selectedBackend ? 1 : 0,
    }));

    return recordPolicyAssignmentReceipt({
      reportedAssignedAt: input.assignedAt ?? new Date().toISOString(),
      dispatchTrajectoryId: input.dispatchTrajectoryId,
      repo,
      workItemId: canonicalItem.id,
      workSource: canonicalItem.source,
      workItemGenerationId: generationId,
      objectiveHash,
      campaignDigest,
      eligibilityPopulationDigest,
      contextStratum: input.contextStratum,
      policyVersion: input.policyVersion,
      learningEpoch: input.learningEpoch,
      reportedAssignmentMechanism: 'deterministic-policy',
      reportedProbabilityDenominator: 1,
      reportedEligibleActions,
      reportedSelectedActionId: input.selectedBackend,
    });
  } catch {
    return 'failed';
  }
}

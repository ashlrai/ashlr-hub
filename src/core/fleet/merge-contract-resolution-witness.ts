/**
 * Pure advisory derivation for a merge-contract resolution witness.
 *
 * This module deliberately records no evidence and grants no lifecycle,
 * proposal, verification, or merge authority.
 */

import type { ScannerObservation, SourceBaseConsistency } from '../types.js';
import {
  buildResolutionWitness,
  type ResolutionWitness,
} from './resolution-witness-ledger.js';
import { verifySourceBaseDigest } from './source-base-digest.js';
import { verifyScannerObservationDigest } from './scanner-observation-digest.js';

const SCANNER_ID = 'merge-verify-contract';
const ALLOWED_CONSISTENCY = new Set<SourceBaseConsistency>([
  'immutable',
  'locked',
  'stable-double-read',
]);

function canonicalTimestampMillis(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

export interface MergeContractResolutionWitnessInput {
  prior: ScannerObservation;
  current: ScannerObservation;
  observerRunId: string;
  decidedAt: string;
}

/**
 * Derive metadata-only evidence that an exactly matched merge-contract
 * observation changed from present to absent. Any ambiguity fails closed.
 */
export function deriveMergeContractResolutionWitness(
  input: MergeContractResolutionWitnessInput,
): ResolutionWitness | null {
  const { prior, current } = input;
  const priorObservedAt = canonicalTimestampMillis(prior.observedAt);
  const currentObservedAt = canonicalTimestampMillis(current.observedAt);
  const decidedAt = canonicalTimestampMillis(input.decidedAt);
  if (
    prior.schemaVersion !== 1
    || current.schemaVersion !== 1
    || prior.scannerId !== SCANNER_ID
    || current.scannerId !== SCANNER_ID
    || prior.domain !== 'verification'
    || current.domain !== 'verification'
    || prior.source !== 'test'
    || current.source !== 'test'
    || prior.repo !== current.repo
    || priorObservedAt === null
    || currentObservedAt === null
    || decidedAt === null
    || priorObservedAt >= currentObservedAt
    || currentObservedAt > decidedAt
    || prior.status !== 'present'
    || prior.reason !== 'item-observed'
    || typeof prior.itemId !== 'string'
    || prior.itemId.length === 0
    || typeof prior.objectiveHash !== 'string'
    || current.status !== 'absent'
    || current.reason !== 'source-confirmed-empty'
    || current.itemId !== undefined
    || current.objectiveHash !== undefined
    || !verifyScannerObservationDigest(prior)
    || !verifyScannerObservationDigest(current)
  ) return null;

  const priorBase = verifySourceBaseDigest(prior.repo, SCANNER_ID, prior.sourceBase);
  const currentBase = verifySourceBaseDigest(current.repo, SCANNER_ID, current.sourceBase);
  if (
    !priorBase
    || !currentBase
    || priorBase.scannerRevision !== currentBase.scannerRevision
    || priorBase.sourceKind !== currentBase.sourceKind
    || priorBase.requirementDigest !== currentBase.requirementDigest
    || priorBase.configDigest !== currentBase.configDigest
    || priorBase.sourceDigest === currentBase.sourceDigest
    || priorBase.baseDigest === currentBase.baseDigest
    || priorBase.dirty !== 'clean'
    || currentBase.dirty !== 'clean'
    || priorBase.consistency !== currentBase.consistency
    || !ALLOWED_CONSISTENCY.has(priorBase.consistency)
    || !ALLOWED_CONSISTENCY.has(currentBase.consistency)
  ) return null;

  return buildResolutionWitness({
    repo: current.repo,
    scannerId: SCANNER_ID,
    scannerRevision: currentBase.scannerRevision,
    itemId: prior.itemId,
    objectiveHash: prior.objectiveHash,
    observerRunId: input.observerRunId,
    postStateBaseDigest: currentBase.baseDigest,
    observationBaseDigest: priorBase.baseDigest,
    resolutionKind: 'merge-contract-satisfied',
    decidedAt: input.decidedAt,
  });
}

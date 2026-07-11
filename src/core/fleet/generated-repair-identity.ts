import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { RepairTreatment } from '../types.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

export const REPAIR_TREATMENTS = ['baseline-reslice', 'target-localization'] as const satisfies readonly RepairTreatment[];

export interface RepairTreatmentUnitIdentity {
  kind: 'no-diff-reslice';
  repo: string;
  parentItemId: string;
  parentObjectiveHash: string;
}

/** Canonical objective-scoped experiment unit shared by V1/V2 handoff aliases. */
export function repairTreatmentUnitId(fields: RepairTreatmentUnitIdentity): string | null {
  if (
    fields.kind !== 'no-diff-reslice' ||
    typeof fields.repo !== 'string' || fields.repo.length < 1 ||
    typeof fields.parentItemId !== 'string' || fields.parentItemId.length < 1 ||
    !SHA256_RE.test(fields.parentObjectiveHash)
  ) return null;
  let repo: string;
  try { repo = resolve(fields.repo); } catch { return null; }
  return createHash('sha256').update(JSON.stringify([
    'ashlr:repair-treatment-unit:v1',
    fields.kind,
    repo,
    fields.parentItemId,
    fields.parentObjectiveHash,
  ])).digest('hex');
}

export function repairGenerationIdFromHandoffId(eventId: string): string | null {
  if (!SHA256_RE.test(eventId)) return null;
  return createHash('sha256')
    .update(JSON.stringify(['ashlr:repair-handoff-generation:v1', eventId]))
    .digest('hex');
}

export function generatedRepairLifecycleAttemptHash(attemptId: string): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:generated-repair-attempt:v1',
    attemptId,
  ])).digest('hex');
}

/** Stable 50/50 assignment over canonical objective-scoped experiment identity. */
export function repairTreatmentForUnitId(unitId: string): RepairTreatment | null {
  if (!SHA256_RE.test(unitId)) return null;
  const bucket = createHash('sha256')
    .update(JSON.stringify(['ashlr:repair-treatment:v2', unitId]))
    .digest()[0]!;
  return REPAIR_TREATMENTS[bucket % REPAIR_TREATMENTS.length]!;
}

/** Historical phase facts only. No process probes, admission, repair or execution. */
import { isAbsolute, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import { readBuiltinTrialCustody } from '../universe/builtin-trial-custody.js';
import type { UniverseCampaignSummary, UniverseSummary } from '../universe/types.js';
import type { ResourceEngineeringPhaseEvidence } from './engineering-outcomes-types.js';
import type { ResourceTaskReceipt } from './pool-runtime.js';
import { resourceGenerationTaskId, validResourceTaskOrigin } from './task-origin.js';

export interface EngineeringPhaseEvidenceOptions {
  directory: string;
  campaign: UniverseCampaignSummary;
  universe: UniverseSummary;
  evaluatorDigest: string | null;
  receipts: ResourceTaskReceipt[];
}
export const MAX_ENGINEERING_PHASE_EVIDENCE_BYTES = 16 * 1024;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const iso = (value: unknown): value is string => typeof value === 'string' && value.length === 24 &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function fail(): never { throw new Error('Phase evidence unavailable'); }
export function unavailableEngineeringPhaseEvidence(reason: NonNullable<ResourceEngineeringPhaseEvidence['reason']> = 'phase-evidence-unavailable'): ResourceEngineeringPhaseEvidence {
  return { schemaVersion: 1, scope: 'recorded-execution-phases', liveness: 'not-attested', sourceState: 'unavailable', reason, seed: null, runs: [] };
}

/** Inputs are host reader snapshots, never browser-selected paths or callbacks.
 * The fingerprint stays private; it also binds custody facts not printed here. */
export function readEngineeringPhaseEvidence(input: EngineeringPhaseEvidenceOptions): { evidence: ResourceEngineeringPhaseEvidence; fingerprint: string } {
  let custodyFingerprint = 'unread';
  const result = (evidence: ResourceEngineeringPhaseEvidence) => ({ evidence, fingerprint: digest(canonical({ custodyFingerprint, evidence })) });
  try {
    const json = canonicalEvidencePackJsonV3(input);
    if (json === null || Buffer.byteLength(json) > 4 * 1024 * 1024) return result(unavailableEngineeringPhaseEvidence('phase-evidence-bounds-exceeded'));
    const value = JSON.parse(json) as EngineeringPhaseEvidenceOptions;
    if (Object.keys(value).sort().join() !== 'campaign,directory,evaluatorDigest,receipts,universe' ||
      typeof value.directory !== 'string' || !isAbsolute(value.directory) || resolve(value.directory) !== value.directory || value.directory === '/') fail();
    const { campaign, universe } = value;
    if (campaign.sourceState !== 'healthy' || universe.sourceState !== 'healthy' ||
      campaign.definition.universeId !== universe.manifest.id || campaign.manifestDigest !== universe.manifestDigest ||
      campaign.comparatorDigest !== universe.comparatorDigest || !HASH.test(campaign.definitionDigest) ||
      !HASH.test(universe.manifestDigest) || !HASH.test(universe.comparatorDigest) ||
      !Array.isArray(campaign.steps) || campaign.steps.length > 64 || !Array.isArray(universe.runs) ||
      !Array.isArray(value.receipts) || value.receipts.length > 10000 ||
      value.evaluatorDigest !== null && !HASH.test(value.evaluatorDigest)) fail();
    const custody = readBuiltinTrialCustody(value.directory);
    custodyFingerprint = digest(canonical(custody));
    const runs = new Map(universe.runs.map(run => [run.id, run]));
    const receipts = new Map(value.receipts.map(receipt => [receipt.id, receipt]));
    if (runs.size !== universe.runs.length || receipts.size !== value.receipts.length) fail();
    const evidence: ResourceEngineeringPhaseEvidence = { schemaVersion: 1, scope: 'recorded-execution-phases', liveness: 'not-attested',
      sourceState: 'available', reason: null, seed: { state: 'unmeasured', startedAt: null, finishedAt: null }, runs: [] };
    const seed = campaign.seedEvaluation;
    if (seed) {
      if (seed.intent.definitionDigest !== campaign.definitionDigest || seed.intent.manifestDigest !== universe.manifestDigest ||
        seed.intent.comparatorDigest !== universe.comparatorDigest || !iso(seed.intent.startedAt) ||
        seed.result && (seed.result.intentDigest !== digest(canonical(seed.intent)) || !iso(seed.result.finishedAt) || seed.result.finishedAt < seed.intent.startedAt)) fail();
      evidence.seed = { state: seed.result ? 'result-recorded' : 'intent-recorded', startedAt: seed.intent.startedAt, finishedAt: seed.result?.finishedAt ?? null };
    }
    const selected = new Map<string, ResourceEngineeringPhaseEvidence['runs'][number]>();
    let lanes = 0;
    for (const step of campaign.steps) {
      const run = runs.get(step.runId);
      if (!ID.test(step.runId) || selected.has(step.runId) || !Number.isSafeInteger(step.generation) || step.generation < 1 ||
        !Array.isArray(step.variantIds) || new Set(step.variantIds).size !== step.variantIds.length ||
        run && (run.campaign?.id !== campaign.definition.id || run.campaign.definitionDigest !== campaign.definitionDigest ||
          run.campaign.ordinal !== step.ordinal || run.generation !== step.generation || run.universeId !== universe.manifest.id ||
          run.manifestDigest !== universe.manifestDigest || run.comparatorDigest !== universe.comparatorDigest ||
          !['running', 'completed', 'interrupted', 'failed'].includes(run.status))) fail();
      const row: ResourceEngineeringPhaseEvidence['runs'][number] = { runId: step.runId, generation: step.generation,
        state: run?.status ?? 'not-recorded', workers: [], evaluators: [] };
      selected.set(step.runId, row); evidence.runs.push(row);
      for (const variantId of step.variantIds) {
        if (++lanes > 128 || !ID.test(variantId)) return result(unavailableEngineeringPhaseEvidence('phase-evidence-bounds-exceeded'));
        const variant = universe.manifest.variants.find(candidate => candidate.id === variantId);
        if (!variant) fail();
        if (variant.generation?.kind !== 'resource-pool') continue;
        const taskId = resourceGenerationTaskId({ universeId: universe.manifest.id, runId: step.runId, variantId });
        const receipt = receipts.get(taskId);
        let state: ResourceEngineeringPhaseEvidence['runs'][number]['workers'][number]['state'] = 'not-recorded';
        let startedAt: string | null = null, finishedAt: string | null = null;
        if (receipt) {
          const witness = run?.trials.find(trial => trial.variantId === variantId)?.generation?.resource;
          const origin = receipt.origin;
          const attributed = origin ? validResourceTaskOrigin(origin, taskId) && origin.kind === 'universe-generation' &&
            origin.universeId === universe.manifest.id && origin.runId === step.runId && origin.variantId === variantId
            : !!witness && witness.taskId === taskId && witness.taskDigest === receipt.taskDigest && witness.receiptDigest === digest(canonical(receipt));
          if (!attributed || receipt.poolDigest !== variant.generation.poolDigest || !variant.generation.allowedWorkerIds.includes(receipt.workerId)) state = 'unverified';
          else {
            if (!['reserved', 'completed', 'failed', 'timed-out', 'cancelled', 'uncertain'].includes(receipt.status) || !iso(receipt.startedAt) ||
              receipt.finishedAt !== null && (!iso(receipt.finishedAt) || receipt.finishedAt < receipt.startedAt)) fail();
            state = receipt.status; startedAt = receipt.startedAt; finishedAt = receipt.finishedAt;
          }
        }
        row.workers.push({ variantId, taskId, state, startedAt, finishedAt });
      }
    }
    const intents = new Map(custody.filter(row => row.kind === 'intent').map(row => [row.intent.trialId, row.intent]));
    const settlements = new Map(custody.filter(row => row.kind === 'settlement').map(row => [row.intent.trialId, row]));
    if (intents.size + settlements.size !== custody.length) fail();
    for (const record of custody) {
      const intent = record.intent, run = runs.get(intent.runId);
      if (intent.universeId !== universe.manifest.id || intent.manifestDigest !== universe.manifestDigest ||
        intent.comparatorDigest !== universe.comparatorDigest || intent.evaluatorId !== universe.manifest.evaluation.builtin ||
        intent.evaluatorDigest !== value.evaluatorDigest || !run ||
        record.kind === 'settlement' && canonical(intents.get(intent.trialId) ?? null) !== canonical(intent)) fail();
      if (!selected.has(intent.runId)) {
        if (run.campaign?.id === campaign.definition.id) fail();
        continue; // Other campaigns' exact runs are not attributed to this one.
      }
      if (record.kind !== 'intent') continue;
      if (++lanes > 128) return result(unavailableEngineeringPhaseEvidence('phase-evidence-bounds-exceeded'));
      const trial = run.trials.find(row => row.id === intent.trialId);
      if (trial && (!campaign.steps.find(step => step.runId === run.id)!.variantIds.includes(trial.variantId) ||
        trial.artifact && trial.artifact.digest !== intent.artifactDigest)) fail();
      const settlement = settlements.get(intent.trialId)?.settlement;
      selected.get(intent.runId)!.evaluators.push({ trialId: intent.trialId, variantId: trial?.variantId ?? null,
        state: settlement?.state ?? 'intent-recorded', startedAt: intent.startedAt, finishedAt: settlement?.finishedAt ?? null });
    }
    for (const run of evidence.runs) run.evaluators.sort((a, b) => a.trialId.localeCompare(b.trialId));
    if (Buffer.byteLength(canonical(evidence)) > MAX_ENGINEERING_PHASE_EVIDENCE_BYTES) return result(unavailableEngineeringPhaseEvidence('phase-evidence-bounds-exceeded'));
    return result(evidence);
  } catch { return result(unavailableEngineeringPhaseEvidence()); }
}

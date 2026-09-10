/** One host-enrolled portfolio operation. No commands or paths are accepted from graph input. */
import { isAbsolute, parse, resolve } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { validateResourcePool } from '../resources/pool-policy.js';
import { readResourceJson } from '../resources/pool-runtime.js';
import { validateResourceBindings } from '../resources/worker.js';
import { canonical, digest, inspectPrivateDirectory } from './artifacts.js';
import { campaignUniverse, readUniverseCampaign } from './campaign-store.js';
import { readCompletedCampaignDelivery } from './campaign-delivery-recovery.js';
import { validateUniverseCampaignDeliveryPlan, type UniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import type { ControlGraphHandlerRegistration, ControlHandlerContext, ControlHandlerResult, ControlGraphRecoveryHandler } from './control-graph.js';
import { readUniversePortfolioController, runUniversePortfolioController } from './portfolio-controller.js';
import { foldPortfolioController, portfolioControllerDirectory, readPortfolioControllerEvents,
  validatePortfolioControllerGraphDispatch } from './portfolio-controller-store.js';
import type { UniversePortfolioControllerReport, PortfolioControllerGraphDispatch } from './portfolio-controller-types.js';
import { validateUniversePortfolioDefinition } from './portfolio-plan.js';
import type { UniversePortfolioDefinition } from './portfolio-types.js';
import { validateResourceGenerationRuntime } from './resource-generation.js';
import { reconcileGraphControllerDispatch } from './graph-controller-reconciliation.js';

export interface FirmEngineeringControlHost {
  nodeId: string;
  root: string;
  constitutionVersion: string;
  policyEpoch: number;
  definition: UniversePortfolioDefinition;
  deliveryPlan: UniverseCampaignDeliveryPlan;
  resourceRuntime: string;
  expectedRuntimeDigest: string;
}
export interface FirmEngineeringControlBinding {
  handler: Readonly<Extract<ControlGraphHandlerRegistration, { effectClass: 'engineering-portfolio-local-delivery' }>>;
  nodeInput: Readonly<{ bindingDigest: string; requestDigest: string }>;
}
const branded = new WeakSet<object>();
const recoveries = new WeakMap<object, ControlGraphRecoveryHandler>();
/** Recognition only; no exported operation can brand a caller-supplied callback. */
export function isFirmEngineeringControlHandler(value: unknown): boolean {
  return value !== null && typeof value === 'object' && branded.has(value);
}
/** Internal registry lookup: a copied declaration never inherits recovery code. */
export function firmEngineeringControlRecovery(value: object): ControlGraphRecoveryHandler | undefined {
  return recoveries.get(value);
}
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_RESULT_BYTES = 48 * 1024;
/** Only the kernel's existing unresolved path may handle an unsettled acknowledgment. */
class EngineeringAcknowledgmentUnresolved extends Error {}
function snapshot<T>(value: unknown, maxBytes = 256 * 1024): T {
  const serialized = canonicalEvidencePackJsonV3(value);
  if (serialized === null || Buffer.byteLength(serialized) > maxBytes) throw new Error('Invalid engineering control enrollment');
  return JSON.parse(serialized) as T;
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function path(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && resolve(value) === value &&
    value !== parse(value).root && [...value].every((character) => {
      const code = character.charCodeAt(0); return code >= 32 && !(code >= 127 && code <= 159);
    });
}
function runtime(host: FirmEngineeringControlHost) {
  const value = validateResourceGenerationRuntime(readResourceJson(host.resourceRuntime));
  if (digest(canonical(value)) !== host.expectedRuntimeDigest) throw new Error('Engineering resource runtime changed');
  const pool = validateResourcePool(readResourceJson(value.poolPath));
  const bindings = validateResourceBindings(readResourceJson(value.bindingsPath), pool);
  return { poolId: pool.id, poolDigest: digest(canonical({ pool, bindings })) };
}
function campaignPins(host: FirmEngineeringControlHost, pool: { poolId: string; poolDigest: string }) {
  return host.definition.tasks.map(({ campaignId }) => {
    const campaign = readUniverseCampaign(campaignId, { root: host.root });
    const universe = campaignUniverse(campaign, { root: host.root });
    if (campaign.sourceState !== 'healthy' || universe.sourceState !== 'healthy' ||
      universe.manifestDigest !== campaign.manifestDigest || universe.comparatorDigest !== campaign.comparatorDigest ||
      universe.manifest.variants.some((variant) => !variant.generation || variant.generation.kind !== 'resource-pool' ||
        !variant.generation.fileOperations || variant.generation.poolId !== pool.poolId || variant.generation.poolDigest !== pool.poolDigest)) {
      throw new Error('Engineering campaigns require healthy confined resource-pool generation');
    }
    return { campaignId, universeId: campaign.definition.universeId, definitionDigest: campaign.definitionDigest,
      manifestDigest: campaign.manifestDigest, comparatorDigest: campaign.comparatorDigest };
  });
}

/**
 * Factory construction is read-only host enrollment, not a scheduling operation.
 * The fixed evaluator and exact delivered artifact establish only their local
 * acceptance scope, never deployment, general correctness, or business value.
 */
export function createFirmEngineeringControlHandler(input: FirmEngineeringControlHost): FirmEngineeringControlBinding {
  const host = snapshot<FirmEngineeringControlHost>(input);
  if (!exact(host, ['nodeId', 'root', 'constitutionVersion', 'policyEpoch', 'definition', 'deliveryPlan', 'resourceRuntime', 'expectedRuntimeDigest']) ||
    typeof host.nodeId !== 'string' || !ID.test(host.nodeId) || !path(host.root) || !path(host.resourceRuntime) ||
    typeof host.expectedRuntimeDigest !== 'string' || !HASH.test(host.expectedRuntimeDigest) ||
    typeof host.constitutionVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(host.constitutionVersion) ||
    !Number.isSafeInteger(host.policyEpoch) || host.policyEpoch < 0) throw new Error('Invalid engineering control enrollment');
  inspectPrivateDirectory(host.root);
  host.definition = validateUniversePortfolioDefinition(host.definition);
  host.deliveryPlan = validateUniverseCampaignDeliveryPlan(host.deliveryPlan, host.definition.tasks.map((task) => task.campaignId));
  if (host.deliveryPlan.deliveries.length !== host.definition.tasks.length) throw new Error('Every engineering campaign requires an explicit delivery target');
  const pool = runtime(host); const pins = campaignPins(host, pool);
  const bindingDigest = digest(canonical({ schemaVersion: 1, domain: 'firm-engineering-control-v1', host, pool, pins }));
  const requestDigest = digest(canonical({ nodeId: host.nodeId, definition: host.definition, deliveryPlan: host.deliveryPlan }));
  const nodeInput = Object.freeze({ bindingDigest, requestDigest });
  const artifactBase = { schemaVersion: 1, operation: 'engineering-portfolio-local-delivery', bindingDigest, requestDigest,
    acceptanceScope: 'fixed-evaluator-and-local-branch-only', resourceRuntimeDigest: host.expectedRuntimeDigest, poolDigest: pool.poolDigest };
  const reject = (reason: string, evidence: Record<string, unknown> = {}): ControlHandlerResult => ({ outcome: 'rejected',
    verifier: { id: 'universe-fixed-evaluator', verdict: 'unavailable', independent: false }, spend: { unknown: true },
    artifact: { ...artifactBase, reason, verifiedAccepted: false, ...evidence } });
  const dispatch = (context: ControlHandlerContext): PortfolioControllerGraphDispatch => {
    if (context.node.kind !== 'deliver' || context.node.id !== host.nodeId) throw new Error('Node not enrolled');
    const value = snapshot(context.node.input, 1024);
    if (!exact(value, ['bindingDigest', 'requestDigest']) || canonical(value) !== canonical(nodeInput)) throw new Error('Binding mismatch');
    const link = validatePortfolioControllerGraphDispatch(context.graphDispatch);
    if (link.nodeId !== host.nodeId) throw new Error('Dispatch node mismatch');
    return link;
  };
  const checkEnrollment = () => {
    inspectPrivateDirectory(host.root);
    if (canonical(runtime(host)) !== canonical(pool) || canonical(campaignPins(host, pool)) !== canonical(pins)) {
      throw new Error('Engineering enrollment changed');
    }
  };
  const matchesControllerEnrollment = (report: UniversePortfolioControllerReport, graphDispatch: PortfolioControllerGraphDispatch,
    compareOutcomes = true): boolean => {
    const directory = portfolioControllerDirectory(host.definition.id, { root: host.root });
    const events = readPortfolioControllerEvents(directory); const folded = foldPortfolioController(events);
    const enrollment = folded.first.enrollment;
    return report.controllerId === host.definition.id && report.definitionDigest === digest(canonical(host.definition)) &&
      report.deadlineAt === enrollment.deadlineAt && (!compareOutcomes || canonical(report.outcomes) === canonical([...folded.states.values()])) &&
      canonical(enrollment.graphDispatch) === canonical(graphDispatch) && canonical(enrollment.definition) === canonical(host.definition) &&
      canonical(enrollment.deliveryPlan) === canonical(host.deliveryPlan) &&
      canonical(enrollment.pins.map(({ campaignId, universeId, definitionDigest, manifestDigest, comparatorDigest }) =>
        ({ campaignId, universeId, definitionDigest, manifestDigest, comparatorDigest }))) === canonical(pins) &&
      canonical(readPortfolioControllerEvents(directory)) === canonical(events);
  };
  // A call can fail after its metadata was committed (for example lock cleanup).
  // Fresh exact settlement only preserves recovery; it is never a success result.
  const completedAfterCallFailure = (graphDispatch: PortfolioControllerGraphDispatch, stopped: () => boolean): boolean => {
    try {
      if (stopped()) return false;
      checkEnrollment();
      const fresh = readUniversePortfolioController(host.definition.id, { root: host.root });
      if (fresh.sourceState !== 'healthy' || fresh.status !== 'completed' || fresh.reasons.length !== 0 ||
          fresh.outcomes.length !== host.definition.tasks.length || fresh.outcomes.some(row => row.state !== 'completed') ||
          !matchesControllerEnrollment(fresh, graphDispatch)) return false;
      checkEnrollment();
      return !stopped();
    } catch { return false; }
  };
  // This proof collector is shared by initial execution and read-only restart
  // recovery. It never invokes the controller, a worker, or Git publication.
  const prove = (report: UniversePortfolioControllerReport, graphDispatch: PortfolioControllerGraphDispatch,
    stopped: () => boolean, recovered: boolean): ControlHandlerResult => {
    const controller = { id: report.controllerId, definitionDigest: report.definitionDigest, sourceState: report.sourceState,
      status: report.status, deadlineAt: report.deadlineAt };
    if (report.sourceState !== 'healthy' || report.status !== 'completed' || report.reasons.length !== 0 ||
      report.definitionDigest !== digest(canonical(host.definition))) return reject('controller-not-completed', { controller });
    const directory = portfolioControllerDirectory(host.definition.id, { root: host.root });
    const events = readPortfolioControllerEvents(directory);
    const folded = foldPortfolioController(events);
    const enrolled = folded.first.enrollment;
    if (report.controllerId !== host.definition.id || report.deadlineAt !== enrolled.deadlineAt ||
      canonical(report.outcomes) !== canonical([...folded.states.values()]) ||
      !enrolled.graphDispatch || canonical(enrolled.graphDispatch) !== canonical(graphDispatch) ||
      canonical(enrolled.definition) !== canonical(host.definition) || canonical(enrolled.deliveryPlan) !== canonical(host.deliveryPlan) ||
      canonical(enrolled.pins.map(({ campaignId, universeId, definitionDigest, manifestDigest, comparatorDigest }) =>
        ({ campaignId, universeId, definitionDigest, manifestDigest, comparatorDigest }))) !== canonical(pins)) {
      return reject('controller-enrollment-mismatch', { controller });
    }
    const deliveries = host.deliveryPlan.deliveries.map((target) => {
      const campaign = readUniverseCampaign(target.campaignId, { root: host.root });
      const receipt = readCompletedCampaignDelivery(campaign, target, { root: host.root });
      const outcome = report.outcomes.find((row) => row.campaignId === target.campaignId);
      if (!receipt || outcome?.state !== 'completed' || outcome.campaignDigest !== digest(canonical(campaign)) ||
        outcome.deliveryDigest !== digest(canonical(receipt))) throw new Error('Engineering delivery proof unavailable');
      const universe = campaignUniverse(campaign, { root: host.root });
      const run = universe.runs.find((row) => row.id === receipt.runId)!;
      const trial = run.trials.find((row) => row.id === receipt.trialId)!;
      return { campaignId: target.campaignId, universeId: receipt.universeId, campaignDigest: outcome.campaignDigest,
        campaignDefinitionDigest: campaign.definitionDigest, manifestDigest: receipt.manifestDigest, comparatorDigest: receipt.comparatorDigest,
        runId: receipt.runId, trialId: receipt.trialId, artifactDigest: receipt.artifactDigest,
        evaluationEvidenceDigest: digest(canonical({ comparatorDigest: receipt.comparatorDigest, runId: run.id,
          trialId: trial.id, artifactDigest: receipt.artifactDigest, status: trial.status, score: trial.score, metrics: trial.metrics })),
        deliveryDigest: outcome.deliveryDigest, branch: receipt.branch, baseCommit: receipt.baseCommit, commit: receipt.commit,
        generationReceiptDigest: trial.generation?.resource?.receiptDigest ?? null };
    });
    const evidence = { graphDispatch, controller: { ...controller, recordsDigest: digest(canonical(events)) }, deliveries };
    if (canonical(readPortfolioControllerEvents(directory)) !== canonical(events)) throw new Error('Controller evidence changed');
    if (stopped()) return reject('execution-stopped', evidence);
    const result: ControlHandlerResult = { outcome: 'completed', verifier: { id: 'universe-fixed-evaluator', verdict: 'pass', independent: true },
      // Campaign totals include prior work; do not misattribute them to this graph invocation.
      spend: { unknown: true }, artifact: { ...artifactBase, reason: recovered ? 'engineering-reconciled' : 'engineering-delivered',
        verifiedAccepted: true, ...evidence } };
    if (Buffer.byteLength(canonical(result)) > MAX_RESULT_BYTES) return reject('evidence-too-large', {
      controller, deliveryProofsDigest: digest(canonical(deliveries)), deliveryCount: deliveries.length });
    return result;
  };
  const handler = Object.freeze<FirmEngineeringControlBinding['handler']>({
    effectClass: 'engineering-portfolio-local-delivery', constitutionVersion: host.constitutionVersion,
    policyEpoch: host.policyEpoch, bindingDigest,
    run: async (context) => {
      const { node, signal, isExecutionStopped, deadlineMonotonicMs } = context;
      if (node.kind !== 'deliver' || node.id !== host.nodeId) return reject('node-not-enrolled');
      try {
        const value = snapshot(node.input, 1024);
        if (!exact(value, ['bindingDigest', 'requestDigest']) || canonical(value) !== canonical(nodeInput)) return reject('binding-mismatch');
      } catch { return reject('binding-mismatch'); }
      const stopped = () => signal.aborted || (isExecutionStopped?.() ?? false);
      try {
        if (stopped()) return reject('execution-stopped');
        const graphDispatch = dispatch(context);
        checkEnrollment();
        let report: UniversePortfolioControllerReport;
        try {
          report = await runUniversePortfolioController(host.definition, { root: host.root, deliveryPlan: host.deliveryPlan,
            resourceRuntime: host.resourceRuntime, expectedResourceRuntimeDigest: host.expectedRuntimeDigest,
            requireNewEnrollment: true, graphDispatch, isExecutionStopped: stopped, signal, deadlineMonotonicMs });
        } catch {
          if (completedAfterCallFailure(graphDispatch, stopped)) throw new EngineeringAcknowledgmentUnresolved('Engineering acknowledgment remains unresolved');
          return reject('engineering-evidence-unavailable');
        }
        if (report.outcomes.length > 0 && report.outcomes.every(row => row.state === 'completed') &&
            (report.status !== 'completed' || report.sourceState !== 'healthy' || report.reasons.length !== 0) &&
            completedAfterCallFailure(graphDispatch, stopped)) {
          throw new EngineeringAcknowledgmentUnresolved('Engineering acknowledgment remains unresolved');
        }
        if (report.sourceState === 'healthy' && report.outcomes.some(row => row.state === 'in-flight')) {
          if (matchesControllerEnrollment(report, graphDispatch, false)) {
            throw new EngineeringAcknowledgmentUnresolved('Engineering acknowledgment remains unresolved');
          }
        }
        return prove(report, graphDispatch, stopped, false);
      } catch (error) {
        if (error instanceof EngineeringAcknowledgmentUnresolved) throw error;
        return reject('engineering-evidence-unavailable');
      }
    },
  });
  branded.add(handler);
  recoveries.set(handler, (context) => {
    try {
      const stopped = () => context.signal.aborted || (context.isExecutionStopped?.() ?? false);
      if (stopped()) return null;
      const graphDispatch = dispatch(context);
      checkEnrollment();
      let report = readUniversePortfolioController(host.definition.id, { root: host.root });
      if (report.sourceState === 'healthy' && report.outcomes.some(row => row.state === 'in-flight')) {
        const reconciled = reconcileGraphControllerDispatch({ root: host.root, definition: host.definition,
          deliveryPlan: host.deliveryPlan, graphDispatch, pins, checkEnrollment, isExecutionStopped: stopped,
          ...(context.deadlineMonotonicMs === undefined ? {} : { deadlineMonotonicMs: context.deadlineMonotonicMs }) });
        if (!reconciled) return null;
        report = reconciled;
      }
      const result = prove(report, graphDispatch, stopped, true);
      return result.outcome === 'completed' ? result : null;
    } catch { return null; }
  });
  return Object.freeze({ handler, nodeInput });
}

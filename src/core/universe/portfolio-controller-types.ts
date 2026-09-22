import type { UniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import type { UniversePortfolioDefinition } from './portfolio-types.js';

/** Closed historical diagnoses; none of these codes grants settlement or retry authority. */
export const PORTFOLIO_CONTROLLER_DIAGNOSTIC_CODES = Object.freeze({
  'campaign-execution': Object.freeze(['campaign-call-threw'] as const),
  'campaign-verification': Object.freeze(['campaign-evidence-changed'] as const),
  'delivery-execution': Object.freeze(['delivery-call-threw'] as const),
  'delivery-verification': Object.freeze(['delivery-evidence-changed', 'delivery-receipt-unverified'] as const),
  'settlement-publication': Object.freeze(['settlement-write-failed'] as const),
});
export type UniversePortfolioControllerDiagnosticPhase = keyof typeof PORTFOLIO_CONTROLLER_DIAGNOSTIC_CODES;
export type UniversePortfolioControllerDiagnosticCode = typeof PORTFOLIO_CONTROLLER_DIAGNOSTIC_CODES[UniversePortfolioControllerDiagnosticPhase][number];
export interface UniversePortfolioControllerDiagnostic {
  campaignId: string;
  intentDigest: string;
  phase: UniversePortfolioControllerDiagnosticPhase;
  code: UniversePortfolioControllerDiagnosticCode;
  at: string;
}

export interface UniversePortfolioControllerOutcome {
  campaignId: string;
  /** In-flight means an unsettled durable intent, never proof of a live process. */
  state: 'pending' | 'in-flight' | 'completed' | 'held';
  /** Durable campaign-call intent, not proof or a count of provider/model requests. */
  attempted: boolean;
  reasonCode: string;
  campaignDigest: string | null;
  /** Digest of the verified local delivery receipt, not a deployment identity. */
  deliveryDigest: string | null;
}

export interface UniversePortfolioControllerReport {
  schemaVersion: 1;
  controllerId: string;
  definitionDigest: string | null;
  sourceState: 'healthy' | 'missing' | 'degraded';
  status: 'completed' | 'incomplete' | 'cancelled' | 'timed-out' | 'unavailable' | 'draining' | 'drained';
  createdAt: string | null;
  deadlineAt: string | null;
  observedAt: string;
  outcomes: UniversePortfolioControllerOutcome[];
  /** Recorded enrollment ordering only; prerequisites include planned ancestor delivery gates. */
  topology?: Array<{ campaignId: string; dependsOn: string[]; prerequisites: string[] }>;
  reasons: string[];
  control?: UniversePortfolioControllerControl;
  /** Historical call-boundary evidence, independent of current outcome or settlement. */
  diagnostics?: UniversePortfolioControllerDiagnostic[];
}

export interface UniversePortfolioControllerControl {
  mode: 'open' | 'drain';
  sequence: number;
  requestedAt: string;
  acknowledgedAt: string | null;
}

/** A durable owner request, not evidence that workers have exited. */
export interface UniversePortfolioControllerControlReceipt {
  schemaVersion: 1;
  controllerId: string;
  action: 'drain' | 'resume';
  changed: boolean;
  sequence: number;
  requestedAt: string;
}

/** Internal fixed enrollment; source refresh cannot renew these admission pins. */
export interface PortfolioControllerPin {
  campaignId: string;
  universeId: string;
  definitionDigest: string;
  manifestDigest: string;
  comparatorDigest: string;
  campaignDigest: string;
  recordsDigest: string;
  initialState: 'pending' | 'completed' | 'held';
  dispatch: 'campaign' | 'delivery' | 'none';
  reasonCode: string;
}

/** Association with one already-persisted signed graph intent, not an effect permit. */
export interface PortfolioControllerGraphDispatch {
  schemaVersion: 1;
  graphRootDigest: string;
  graphId: string;
  definitionDigest: string;
  nodeId: string;
  intentDigest: string;
}

export interface PortfolioControllerEnrollment {
  definition: UniversePortfolioDefinition;
  deliveryPlan: UniverseCampaignDeliveryPlan | null;
  definitionDigest: string;
  pins: PortfolioControllerPin[];
  deadlineAt: string;
  /** Absent on legacy/direct controllers; never backfilled after creation. */
  graphDispatch?: PortfolioControllerGraphDispatch;
}

export type PortfolioControllerEvent = { id: string; sequence: number; at: string } & (
  { kind: 'created'; enrollment: PortfolioControllerEnrollment } |
  { kind: 'observed' } |
  { kind: 'control'; action: 'drain' } |
  { kind: 'control'; action: 'resume'; drainSequence: number } |
  { kind: 'drained'; drainSequence: number } |
  { kind: 'intent'; campaignId: string; /** Absent for legacy and delivery-only intents. */ dispatchId?: string } |
  ({ kind: 'dispatch-diagnostic' } & Omit<UniversePortfolioControllerDiagnostic, 'at'>) |
  { kind: 'settled'; outcome: UniversePortfolioControllerOutcome; recordsDigest: string }
);

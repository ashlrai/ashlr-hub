import type { UniverseCampaignDeliveryPlan } from './campaign-delivery.js';
import type { UniversePortfolioDefinition } from './portfolio-types.js';

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
  reasons: string[];
  control?: UniversePortfolioControllerControl;
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

export interface PortfolioControllerEnrollment {
  definition: UniversePortfolioDefinition;
  deliveryPlan: UniverseCampaignDeliveryPlan | null;
  definitionDigest: string;
  pins: PortfolioControllerPin[];
  deadlineAt: string;
}

export type PortfolioControllerEvent = { id: string; sequence: number; at: string } & (
  { kind: 'created'; enrollment: PortfolioControllerEnrollment } |
  { kind: 'observed' } |
  { kind: 'control'; action: 'drain' } |
  { kind: 'control'; action: 'resume'; drainSequence: number } |
  { kind: 'drained'; drainSequence: number } |
  { kind: 'intent'; campaignId: string; /** Absent for legacy and delivery-only intents. */ dispatchId?: string } |
  { kind: 'settled'; outcome: UniversePortfolioControllerOutcome; recordsDigest: string }
);

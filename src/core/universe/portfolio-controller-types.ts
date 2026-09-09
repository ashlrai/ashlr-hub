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
  status: 'completed' | 'incomplete' | 'cancelled' | 'timed-out' | 'unavailable';
  createdAt: string | null;
  deadlineAt: string | null;
  observedAt: string;
  outcomes: UniversePortfolioControllerOutcome[];
  reasons: string[];
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
  { kind: 'intent'; campaignId: string; /** Absent for legacy and delivery-only intents. */ dispatchId?: string } |
  { kind: 'settled'; outcome: UniversePortfolioControllerOutcome; recordsDigest: string }
);

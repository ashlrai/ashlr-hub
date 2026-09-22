import type { ResourcePool } from './pool-policy.js';
import type { ResourceBinding } from './worker.js';

export type ResourcePoolEvolutionErrorCode = 'ownership-present' | 'uncertain-work' | 'incomplete-journal' | 'state-conflict';
const MESSAGES: Record<ResourcePoolEvolutionErrorCode, string> = {
  'ownership-present': 'Resource ownership is present; stop console, pool and quota collection before evolution',
  'uncertain-work': 'Uncertain quota collection or reserved or uncertain pool work requires reconciliation before evolution',
  'incomplete-journal': 'Pool evolution staging is incomplete; explicit inspection required',
  'state-conflict': 'Pool evolution state or plan changed; no repair performed',
};
/** Safe operator diagnostics; raw filesystem and validation errors are not exposed. */
export class ResourcePoolEvolutionError extends Error {
  constructor(readonly code: ResourcePoolEvolutionErrorCode) {
    super(MESSAGES[code]); this.name = 'ResourcePoolEvolutionError';
  }
}

export interface ResourcePoolConfigSnapshot { poolDigest: string; pool: ResourcePool; bindings: ResourceBinding[] }
export interface ResourcePoolEvolutionOptions {
  root: string; workspace: string; pool: unknown; bindings: unknown; nextPool: unknown; nextBindings: unknown;
}
export interface ResourcePoolEvolutionPlan {
  schemaVersion: 1; status: 'planned'; planDigest: string; fromPoolDigest: string; toPoolDigest: string;
  historyCount: number; preservedReceiptCount: number; preservedJobCount: number;
  addedWorkerIds: string[]; annotatedWorkerIds: string[]; heldQueuedIds: string[];
  executionStarted: false; providerContacted: false;
}
export interface ResourcePoolEvolutionReport extends Omit<ResourcePoolEvolutionPlan, 'status'> {
  status: 'applied'; disposition: 'created' | 'resumed' | 'replayed';
}

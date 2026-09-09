import type { UniverseIntegrationDeliveryRequest } from './integration-delivery-types.js';
import type { UniverseManifest } from './types.js';

/** Explicit enrollment only: this does not execute the new Universe. */
export interface UniverseIntegrationHandoffRequest {
  schemaVersion: 1;
  delivery: UniverseIntegrationDeliveryRequest;
  expectedDeliveryDigest: string;
  downstream: UniverseManifest;
}

/** Stored atomically with the new manifest, without inherited trial measurements. */
export interface UniverseIntegrationOrigin {
  schemaVersion: 1;
  requestDigest: string;
  deliveryDigest: string;
  deliveryId: string;
  acceptanceUniverseId: string;
  evaluationId: string;
  repo: string;
  commit: string;
  tree: string;
  artifactDigest: string;
}

export interface UniverseIntegrationHandoffReceipt {
  schemaVersion: 1;
  status: 'registered';
  targetUniverseId: string;
  manifestDigest: string;
  comparatorDigest: string;
  seedArtifactDigest: string;
  origin: UniverseIntegrationOrigin;
}

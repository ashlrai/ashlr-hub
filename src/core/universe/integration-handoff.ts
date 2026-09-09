import { resolve } from 'node:path';
import { canonical, defaultUniverseRoot, digest } from './artifacts.js';
import { assertUniverseExecution, withUniverseExecution } from './execution.js';
import { readUniverseIntegrationDelivery, validateUniverseIntegrationDeliveryRequest } from './integration-delivery.js';
import { assertUniverseIntegrationEvaluationsSettled } from './integration-evaluate.js';
import { initUniverseWithIntegrationOrigin, manifestRecord, projectUniverse, universePath, validateUniverseManifest } from './store.js';
import type { UniverseIntegrationHandoffReceipt, UniverseIntegrationHandoffRequest, UniverseIntegrationOrigin } from './integration-handoff-types.js';
import type { UniverseStoreOptions } from './types.js';

/** Capture explicit downstream intent; never derive a new objective or resource policy. */
export function validateUniverseIntegrationHandoffRequest(value: unknown): UniverseIntegrationHandoffRequest {
  const keys = ['schemaVersion', 'delivery', 'expectedDeliveryDigest', 'downstream'];
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || !Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
        keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    throw new Error('Invalid Universe integration handoff request');
  }
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.expectedDeliveryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedDeliveryDigest)) {
    throw new Error('Invalid Universe integration handoff request');
  }
  const delivery = validateUniverseIntegrationDeliveryRequest(row.delivery);
  const downstream = validateUniverseManifest(row.downstream);
  if ([delivery.evaluation.acceptance.universeId, ...delivery.evaluation.integration.sources.map((source) => source.universeId)]
    .includes(downstream.id)) throw new Error('Integration handoff requires a distinct downstream Universe id');
  return { schemaVersion: 1, delivery, expectedDeliveryDigest: row.expectedDeliveryDigest, downstream };
}

/** Register an explicitly defined experiment at a verified delivered commit, without running it. */
export async function handoffUniverseIntegration(input: unknown,
  options: UniverseStoreOptions = {}): Promise<UniverseIntegrationHandoffReceipt> {
  const request = validateUniverseIntegrationHandoffRequest(input);
  const root = resolve(options.root ?? defaultUniverseRoot());
  const acceptance = request.delivery.evaluation.acceptance;
  return withUniverseExecution(acceptance.universeId, { root }, async (lock) => {
    const directory = universePath(root, acceptance.universeId);
    const source = (): ReturnType<typeof readUniverseIntegrationDelivery> => {
      assertUniverseExecution(directory, lock);
      assertUniverseIntegrationEvaluationsSettled(acceptance.universeId, { root });
      const record = manifestRecord(directory);
      const universe = projectUniverse(directory);
      if (universe.sourceState !== 'healthy' || universe.activeRun || record.manifestDigest !== acceptance.manifestDigest ||
          record.comparatorDigest !== acceptance.comparatorDigest) throw new Error('Integration handoff requires healthy, idle acceptance evidence');
      const evidence = readUniverseIntegrationDelivery(request.delivery, { root });
      if (evidence.receipt.status !== 'delivered' || evidence.receiptDigest !== request.expectedDeliveryDigest ||
          canonical(evidence.request) !== canonical(request.delivery)) throw new Error('Integration handoff requires the pinned completed delivery');
      if (request.downstream.seed.repo !== evidence.receipt.repo || request.downstream.seed.revision !== evidence.receipt.commit) {
        throw new Error('Integration handoff downstream seed must match the delivered repository and commit');
      }
      assertUniverseExecution(directory, lock);
      return evidence;
    };
    const evidence = source();
    const origin: UniverseIntegrationOrigin = { schemaVersion: 1,
      requestDigest: digest(canonical({ domain: 'universe-integration-handoff-request-v1', request })),
      deliveryDigest: evidence.receiptDigest, deliveryId: evidence.receipt.id, acceptanceUniverseId: acceptance.universeId,
      evaluationId: evidence.receipt.evaluationId, repo: evidence.receipt.repo, commit: evidence.receipt.commit,
      tree: evidence.receipt.tree, artifactDigest: evidence.receipt.artifactDigest };
    // The store's source guard runs under the destination initialization lock,
    // after materialization and immediately before the single manifest append.
    const record = initUniverseWithIntegrationOrigin(request.downstream, origin, () => { source(); }, { root });
    return { schemaVersion: 1, status: 'registered', targetUniverseId: record.manifest.id,
      manifestDigest: record.manifestDigest, comparatorDigest: record.comparatorDigest,
      seedArtifactDigest: record.seedArtifact.digest, origin: JSON.parse(canonical(record.integrationOrigin)) as UniverseIntegrationOrigin };
  });
}

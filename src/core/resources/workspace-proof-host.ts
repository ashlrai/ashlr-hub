/** Read-only parent answers shared by fixed engineering isolates. */
import { join } from 'node:path';
import { canonicalEvidencePackJsonV3 } from '../foundry/provenance.js';
import { canonical, digest } from '../universe/artifacts.js';
import { readResourceJson, type ResourceTaskReceipt } from './pool-runtime.js';
import { ResourceSupervisorError } from './pool-supervisor.js';
import { readResourceWorkspaceCustody, type ResourceWorkspaceCustody } from './workspace-custody.js';
import { isWorkspacePoolAvailable } from './workspace-proof-context.js';

const unavailable = () => new ResourceSupervisorError('UNAVAILABLE', 'Mission proof unavailable or stopped');
export function createWorkspaceProofHandlers(custody: ResourceWorkspaceCustody | undefined, assertActive: () => void, maxSamples = 128) {
  if (!Number.isSafeInteger(maxSamples) || maxSamples < 1 || maxSamples > 4096) throw unavailable();
  const samples = new Map<number, ReturnType<typeof readResourceWorkspaceCustody>>();
  let sampleId = 0;
  return { close: () => samples.clear(), handlers: {
    'custody.sample': (input: unknown) => {
      assertActive(); if (input !== null || !custody || samples.size >= maxSamples) throw unavailable();
      const owner = readResourceWorkspaceCustody(custody);
      // Validate FULL durable state before excluding ordinary job rows from
      // the read-only scope projection. Pause, projects and epoch remain exact.
      const state = readResourceJson(join(owner.root, 'resource-console-state.json'), 4 * 1024 * 1024) as object;
      if (digest(canonical(state)) !== owner.stateDigest) throw unavailable();
      samples.set(++sampleId, owner);
      return { sampleId, root: owner.root, workspace: owner.workspace, poolDigest: owner.poolDigest,
        stateDigest: owner.stateDigest, consoleScopeDigest: digest(canonical({ ...state, jobs: [] })),
        lockPaths: owner.locks.map(lock => lock.path), metadataPending: owner.metadataPending };
    },
    'custody.receipt': (input: unknown) => {
      assertActive();
      const bytes = canonicalEvidencePackJsonV3(input);
      if (bytes === null || Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw unavailable();
      const value = JSON.parse(bytes) as { sampleId: number; receipt: ResourceTaskReceipt };
      if (!value || Object.keys(value).sort().join(',') !== 'receipt,sampleId' || !Number.isSafeInteger(value.sampleId)) throw unavailable();
      const owner = samples.get(value.sampleId); if (!owner || !custody) throw unavailable();
      const fresh = readResourceWorkspaceCustody(custody, owner);
      return fresh.ownsReceipt(value.receipt) || fresh.ownsSettledReservation(value.receipt);
    },
    'custody.poolAvailable': (input: unknown) => {
      assertActive(); if (!Number.isSafeInteger(input)) throw unavailable();
      const owner = samples.get(input as number); if (!owner || !custody) throw unavailable();
      // A parent transaction finishes before this message can be handled.
      // External/unknown ownership still refuses; vacancy never lends a lease.
      return isWorkspacePoolAvailable(readResourceWorkspaceCustody(custody, owner).root);
    },
  } };
}

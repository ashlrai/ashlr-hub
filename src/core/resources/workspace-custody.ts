/** In-process joins for a persistent workspace. No serialized value grants custody. */
import { readResourceSupervisorCustody, type ResourcePoolSupervisor } from './pool-supervisor.js';
import { readResourceQuotaRefreshCustody, type ResourceQuotaRefreshLease } from './quota-refresh-lease.js';

export interface ResourceWorkspaceCustody { readonly kind: 'live-resource-workspace' }
type Scope = { root: string; workspace: string; poolDigest: string };
type Sample = ReturnType<typeof readResourceSupervisorCustody> & {
  locks: ReturnType<typeof readResourceSupervisorCustody>['lock'][]; metadataPending: boolean;
};
const owners = new WeakMap<ResourceWorkspaceCustody, () => Sample>();

/** The optional host guard may restrict genuine ownership, never manufacture it. */
export function createResourceWorkspaceCustody(supervisor: ResourcePoolSupervisor,
  quota: ResourceQuotaRefreshLease | null, assertHost: () => void): ResourceWorkspaceCustody {
  if (typeof assertHost !== 'function') throw new Error('Invalid workspace custody guard');
  const guard = () => {
    const result: unknown = assertHost();
    if (result instanceof Promise) void result.catch(() => {});
    if (result !== undefined) throw new Error('Workspace custody guard must be synchronous');
  };
  const sample = (): Sample => {
    guard();
    const owner = readResourceSupervisorCustody(supervisor);
    const collector = quota ? readResourceQuotaRefreshCustody(quota) : null;
    if (collector && collector.root !== owner.root) throw new Error('Workspace collector scope changed');
    guard();
    return { ...owner, locks: [owner.lock, ...(collector ? [collector.lock] : [])], metadataPending: collector?.pending === true };
  };
  sample();
  const custody = Object.freeze({ kind: 'live-resource-workspace' as const });
  owners.set(custody, sample);
  return custody;
}

export function readResourceWorkspaceCustody(custody: ResourceWorkspaceCustody, scope?: Scope): Sample {
  const read = owners.get(custody);
  if (!read) throw new Error('Unrecognized workspace custody');
  const owner = read();
  if (scope && (owner.root !== scope.root || owner.workspace !== scope.workspace || owner.poolDigest !== scope.poolDigest)) {
    throw new Error('Workspace custody scope changed');
  }
  return owner;
}

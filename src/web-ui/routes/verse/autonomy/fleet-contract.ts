/**
 * routes/verse/autonomy/fleet-contract.ts — the shapes the local-fleet
 * surfaces are typed against.
 *
 * This module is now a re-export seam, not a declaration site: the contract
 * lives in `src/core/verse/fleet-types.ts` beside the projectors that produce
 * it. Consumers in this folder keep importing from here so that the eventual
 * shape of the import graph did not have to be decided while the routes were
 * still being written.
 *
 * The three fields that are NOT negotiable, because a surface that lies about
 * them is worse than no surface, are `ServingRuntimeParallelism.capable`,
 * `slotsTotal` and `slotsBusy` — see the header of `fleet-model.ts`.
 *
 * Nothing here carries a secret. `endpoint` is host:port so an operator can
 * tell two runtimes apart; a full URL with credentials, a bearer token, or a
 * launcher command must never reach this layer (VERSE-CONTRACT-V2, "Ground
 * rules").
 */

/**
 * The contract, re-exported from its single declaration site.
 *
 * These shapes were transcribed here while `/api/verse/{runtime,fleet,
 * local-only}` were still being built. They are now declared by
 * `src/core/verse/fleet-types.ts` — the same module that projects the routes'
 * bodies out of the runtime, policy and fleet lanes — and re-exported through
 * `src/web-ui/data/api-types.ts`, exactly the way `control-types.ts` resolved
 * when owner B's module landed. Every consumer in this folder imports from
 * here, so nothing else had to change.
 *
 * Two things the transcription got wrong, and the real contract gets right:
 *
 *  - `LocalOnlySource` is the policy resolver's OWN union
 *    (`'off' | 'config' | 'env' | 'config+env' | 'latch'`), not a flattened
 *    four-value version of it. Flattening mapped `'latch'` onto `'config'`,
 *    which says "editable" about a mode that is pinned for the process — only
 *    the separate `mutable` flag was stopping that from becoming a lie on
 *    screen.
 *  - `contextTokens` is per-slot, and the server now commits to that rather
 *    than leaving each client to choose between `contextPerSlot` and
 *    `contextTotal` and hope they all choose alike.
 */
export type {
  FleetAgent,
  FleetAgentState,
  FleetSnapshot,
  LocalOnlyPolicy,
  LocalOnlyRefusal,
  LocalOnlySource,
  LocalOnlyUpdate,
  LocalOnlyUpdateResult,
  RuntimeAction,
  RuntimeActionResult,
  ServingRuntimeKind,
  ServingRuntimeParallelism,
  ServingRuntimeSnapshot,
  ServingRuntimeState,
} from '../../../data/api-types.js';

/**
 * A read that is allowed to be absent.
 *
 * Same discipline as `usage-queries.ts`'s `OptionalRead`, and for the same
 * reason doubled: these three routes are landing in parallel with this
 * surface, so a 404 means "this panel has no source yet", not "Autonomy is
 * broken". It is declared here rather than imported from the usage folder
 * because that folder is owner E's and this one must not depend on it.
 */
export interface OptionalFleetRead<T> {
  value: T | null;
  available: boolean;
  /** A sentence explaining the absence. null when the read succeeded. */
  reason: string | null;
  /** The route's machine-readable refusal code, when it sent one (optional reads only). */
  code?: string | null;
}

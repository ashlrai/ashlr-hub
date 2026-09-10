# Scoped controller inspector

## Objective

Make persisted portfolio controller progress and drain acknowledgement observable
from the existing authenticated read-only Universe console. No new execution,
provider, credential, discovery or browser mutation authority.

## Architecture and ownership

- Backend agent: explicit public controller view, bounded reader/worker dispatch,
  and authenticated GET-only `/api/universe/controller-status?controllerId=ID`.
- UI agent: scoped console inspector and validated query with focused UI tests.
- Acceptance agent: reader, worker, serialization, HTTP and private-root native
  tests. Root handles documentation, integration, build and release evidence.

Public view fields: `schemaVersion`, `controllerId`, `sourceState`, `status`,
`createdAt`, `deadlineAt`, `observedAt`, `reasons`; outcomes contain only
`campaignId`, `state`, `attempted`, `reasonCode`. Optional `control` contains
`mode`, `sequence`, `requestedAt`, `acknowledgedAt`. Omit all digests and unknown
fields. Preserve original persisted meanings; no process-liveness inference.

## User experience

Explicit controller ID entry triggers a bounded read; no automatic whole-store
scan or polling. Mount separately from experiment overview success. Show original
deadline, observation time, drain request/acknowledgement and recorded campaign
outcomes. Distinguish missing, degraded, loading and historical/error states.
Changing IDs must not relabel a previous result. Keep controls read-only.

Reuse the existing Space Grotesk/IBM Plex typography and theme tokens. A compact
admission-state sequence is meaningful only where a control record exists; no
decorative fake topology. Accessible forms, status labels, keyboard focus, mobile
layout, explicit refresh and no motion required.

## Verification and delivery

Test strict IDs and query shape, root override rejection, authentication, GET-only
access, public allowlisting, worker bounds, immutable read behavior, original
deadline, missing/degraded states and stale refresh labeling. Run core/web tests,
typecheck, lint, docs and production build locally. Browser acceptance uses an
isolated inert fixture and the scoped console, not operational accounts.

Preserve the user's primary checkout. Do not enable Actions. Source publication,
local installed candidate and resident/provider activation remain distinct.

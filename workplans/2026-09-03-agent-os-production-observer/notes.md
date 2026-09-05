# Notes: Agent OS Production Observer

## Starting state

- The authenticated Agent OS runtime read path is implemented and scoped-verification complete.
- Its default state is intentionally missing or degraded because no production source bundle or scheduled producer exists.
- The existing snapshot store requires an explicit external read-model verifier and exposes no mutation API.
- The standing-permit implementation is shadow-only and grants no authority.
- The branch contains active uncommitted work that must be preserved.

## Research findings

- Mission receipts are the closest durable source but use a same-user HMAC and explicitly lack verifier isolation. They cannot alone establish independent truth.
- Specs, provider capacity, hypotheses, portfolios, outcomes, and the evidence index currently lack complete independently signed production registries.
- The original snapshot append path persisted a caller-selected `sourceDigest`. It now derives that identity only from the exact verified signed source bundle and binds the resulting snapshot to a durable observer attempt.
- The durable cutoff scheduler is the lifecycle reference for reservation, cancellation, deadlines, termination, and recovery. The observer tranche itself uses durable attempt identity and locked record transitions plus process-local child ownership; it does not claim a separate cross-process observer reservation primitive.
- The observer requires an attempt-to-snapshot binding; otherwise a crash after snapshot commit but before a terminal attempt receipt is unverifiable.
- Observation trust roots must be separate from effect-authority roots to prevent confused-deputy escalation.
- The original `tick()` accepted a plain already-verified activation scope from in-process callers. Production authorization now requires a process-resident opaque capability minted by the daemon authority boundary; legacy structural compatibility cannot authorize a production tick.

## Integration findings

- The observer is default-off and runs only after a successful durable resident tick. It does not run for dry-run, once, failed, disabled, invalid-policy, missing-source, or degraded-source states.
- Trust policy is default-empty and uses role-separated Ed25519 source, evidence-index, and outcome-observer identities; observation keys never become activation keys.
- Child execution inherits an explicit environment allowlist, no production preload hooks, deadline-triggered TERM/KILL escalation, KILL/config/source rechecks, process-local overlap suppression, and shutdown cancellation. If exit is not confirmed, ownership remains stuck/degraded instead of fabricating completion.
- Cross-repository consumers accept canonical aggregate-only efficiency, Stack observation, and Stack planned-effect bytes. All derived planning, execution, effect, promotion, approval, and performed fields remain false.
- Core Efficiency, Plugin, and Stack producer candidates pass the versioned M544 protocol/byte/digest/authority checks in isolated uncommitted worktrees. Plugin correctly classifies chars-div-4 savings as estimated. The historical Stack fixture intentionally fails live-current freshness, and synthetic provenance keeps every producer `releaseReady: false`. None is published or installed.
- Independent lifecycle review found repeated-source attempt exhaustion, cancellation-before-close overlap, mid-attempt source supersession, conflicting crash-resume deadlines, signer-role confusion, and mutable digest-bound projections. These are code-closed and passed focused plus broad validation.
- Both source and attempt registries are deliberately bounded. Cross-ledger rollover plus an external monotonic/transparency anchor remain prerequisites for an indefinite unattended-runtime claim.
- Successful-attempt deduplication now requires an exact authenticated terminal-to-snapshot join. A wholly absent snapshot ledger admits one bounded regeneration path; corrupt, partial, conflicting, or orphan-checkpoint state remains degraded and untouched.
- Official source publication and source-bound snapshot publication now share one observation transaction lock. The child holds the exact current source stable through verification, snapshot append, and terminalization. Mixed-version writers remain a commissioning constraint.
- Child startup derives and verifies the attempt ID, requires the exact tick digest in persisted daemon history, and the resident loop schedules only the exact process-resident tick object marked after successful persistence.
- Snapshot replay now keys on source digest, snapshot digest, and producer attempt. A refreshed signed source with the same projection receives its own source-bound envelope rather than exhausting retries.
- Administrative cancellations no longer consume the three-failure source budget. A final commit guard rechecks cancellation and deadline immediately before immutable snapshot publication, and successful terminals at or after the deadline are invalid.
- The synthetic Plugin stats contamination was removed with an exact compare-and-swap repair. The repaired live ledger has SHA-256 `c36c0ddebe1e2081fafc0140f161d18478186e4aa1423d5bfcbc0edd7771b219`; a mode-0600 incident backup has SHA-256 `692aefdb980d7cd68135d656436d6a979d81aabd4086ee692e016c22f32e157e`.

## Verification evidence

- Current Agent OS/source/external-contract matrix M531 and M533-M543: 173/173 passed across 12 files.
- Final M536/M543 lifecycle subset after the last scheduler edit: 42/42 passed; M535/M538/M539 trust subset: 37/37 passed.
- Exact-final M201 daemon-loop regression: 255/255 passed.
- Exact-final Agent OS/modified-adjacent matrix: 372 passed, one platform skip across 23 files.
- Exact-final daemon loop M201: 255/255 passed; web suite: 107/107 passed; core and web typechecks passed.
- Full repository test attempt: 15,338 passed, 45 skipped, and one M30 CI-partition expectation failed. The expectation was corrected and exact-final M30 passed 7/7; the entire 687-file suite was not rerun after that test-only correction.
- Full lint completed with zero errors and 108 baseline warnings. Production build passed with 183 web modules transformed. Config JSON, focused Semgrep, npm audit, scoped Gitleaks, and `git diff --check` passed.
- M545 observation-coherence focused matrix after final independent red-team repair: 95/95 passed across M533/M536/M538/M539/M543; core and web typechecks, scoped ESLint, and `git diff --check` passed.
- The second and final reviews caught repair-budget ordering, aged-out open-attempt provenance confusion, an inner immutable-writer deadline gap, and ignored shared-lock release failure. Repair now checks failure/backoff/capacity first; an open start degrades when its initiating tick ages out of bounded daemon history because attempt receipts grant no tick authority; the immutable writer rechecks after stage validation at the actual no-clobber link boundary; and source operations downgrade when lock release is not confirmed.

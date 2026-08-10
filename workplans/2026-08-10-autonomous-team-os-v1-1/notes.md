# Notes: Ashlr Autonomous Team OS V1.1+

## Starting Point
- Draft PR #238 introduced planning-only Ecosystem Mission Graph V1, digest-bound goals, explicit one-goal reconciliation, and the read-only Mission Outcome Room.
- The committed roadmap prioritizes a durable mission receipt before daemon-driven reconciliation or external Cortex/Locus effects.

## Research Log
- PR #238 remains open/draft/mergeable and is two daemon-only commits behind `origin/master`; those upstream changes do not overlap its mission files.
- The installed fleet remains stopped, auto-merge is disabled, and proposal-production evidence remains degraded. No runtime activation is authorized by this program.
- Existing `ImmutablePrivateRecordStore` provides the bounded, atomic, replay-aware persistence substrate for Mission Receipt V1.
- The current Locus drop-in permits a missing `pin`; its result is therefore only a readiness hint. Hub must require an explicit exact, healthy, sealed, unexpired, unfrozen pin and must not infer execution evidence.
- Numerous active receipt, daemon, and web/API branches exist. Avoid editing shared web/API and daemon authority seams until ownership is isolated.
- `createGoalIfAbsent()` creates a `planning` goal, and `scanGoals()` loads planning goals, may invoke the frontier planner to expand one, and emits ordinary daemon work. Automatic goal materialization is therefore execution steering, not harmless metadata.
- Cortex has no governed mission-candidate endpoint; current proposal payloads are arbitrary and its Hub bridge is stub/in-memory. V1 will accept no live Cortex transport.
- Locus claim verification is heuristic and forensics include sensitive local detail. V1 will accept no raw reports, seals, credential locators, provider payloads, home paths, or forensics packs as mission realization evidence.
- Mission Receipt V1 now uses exact own-data schemas, read-only key loading for in-memory operations, immutable private persistence, HMAC-obscured local identifiers, final record bounds, and replay-stable semantic identity.
- `ashlr vision shadow [--json]` records one authenticated observation from the same bounded source snapshots used by the preview and emits one all-false suggestion. It creates no goal or outward effect.
- Shadow planning cryptographically re-verifies its receipt and binds the active-goal threshold into suggestion identity; a structural `state:verified` assertion is insufficient.
- Cortex candidate and Locus evidence validators reject hidden fields/accessors, return sanitized clones, and remain connector-free. Locus realization requires an exact externally verified envelope digest plus exact identity and operation context.
- Adversarial capture fixes preserve authoritative missing-empty stores, cap aggregate milestones and verification commands, and include a production-verifier negative regression.

## Risks
- Concurrent Ashlr work is extensive; branch and file ownership must be established before edits.
- A receipt is evidence, not authority. It must never silently authorize dispatch, merge, release, deployment, publication, credentials, or Cortex mutation.
- Cross-product integration can leak tenant, credential, or company-sensitive data unless envelopes are deeply allowlisted and bounded.

# Task Plan: Agent OS Production Observer

## Goal

Deliver the first durable, bounded, default-off Agent OS observer that compiles independently verifiable operational evidence into authenticated snapshots and attempt receipts without creating execution authority.

## Phases

- [x] Phase 1: Restore repository, Entire, memory, skills, and prior Agent OS state
- [x] Phase 2: Map durable evidence sources, daemon lifecycle, cancellation, and existing effect-authority seams in parallel
- [x] Phase 3: Confirm the smallest production-grade architecture and exact trust boundaries
- [x] Phase 4: Implement durable source bundles, independent verifier adapters, and bounded observer attempts
- [x] Phase 5: Integrate default-off runtime configuration and truthful operational status
- [x] Phase 6: Add adversarial, crash, overlap, cancellation, privacy, and regression tests
- [x] Phase 7: Run focused and repository-level verification, security review, and independent red-team
- [x] Phase 8: Record exact achieved state, remaining authority bridges, and live activation boundary
- [x] Phase 9: Close cross-ledger coherence, durable-tick provenance, source-publication race, retry classification, and final deadline fencing

## Key Questions

1. Which existing durable receipts can supply each required Agent OS source without translating self-asserted runtime state into evidence?
2. Where can the observer run after durable daemon ticks while inheriting ownership loss, kill, deadline, and cancellation behavior?
3. How should observer attempts be journaled so missing and degraded states remain informative but never appear healthy?
4. What must remain default-off until an operator deliberately configures trusted sources and independent verifier identities?

## Decisions Made

- Preserve the established Ashlr Hub runtime; do not scaffold a second Eve runtime inside this mature system.
- This tranche may observe, verify, persist, and report. It may not grant execution, invoke models, edit workspaces, or bridge external effects.
- Reuse existing durable stores, signer registries, activation permits, kill state, and effect journals wherever their contracts actually fit.
- Production-readiness requires adversarial tests and exact source/build evidence; it does not imply installed, scheduled, or live activation.
- Use a dedicated default-empty Ed25519 observation trust policy with distinct source, evidence-index, and outcome-observer roles; activation keys are not observation keys.
- Pin one verified projection and close verifier adapters over it, while re-reading the authenticated current source and policy at every authorization gate. Never replace the pinned payload with mutable re-read data during snapshot append.
- Bind every committed snapshot to both the verified bundle digest and a durable observer attempt identity so crash recovery can distinguish success, replay, and ambiguity.
- Model the observer lifecycle on the durable cutoff scheduler, using durable attempt identity and locked record transitions, an allowlisted child environment, deadline enforcement, process-local overlap suppression, KILL checks, and terminal attempt receipts. Do not claim a separate cross-process observer reservation primitive.
- Do not bridge workspace editing or model dispatch in this tranche. A newly identified plain-object activation-scope seam must be hardened before any future standing-permit bridge.
- Run the observer only after a successful durable resident daemon tick. Dry runs, one-shot runs, failed ticks, and disabled or invalid observation policy must never schedule it.
- Keep scheduler status explicitly process-local and non-durable; authenticated source, attempt, and snapshot stores remain the only durable truth.
- Suppress an already successful source only when its authenticated terminal receipt joins the exact authenticated snapshot envelope. Regenerate only when the snapshot ledger is wholly absent; corruption, gaps, conflicts, and orphan checkpoints remain degraded.
- Serialize official source publication with snapshot compilation/publication under one observation lock, while retaining exact source-digest binding and all-false authority.
- Require both a process-resident exact durable-tick object at scheduling and an exact digest match in persisted daemon history inside the child. Direct structural scheduling cannot create durable observer records for a fabricated tick.
- Treat operator cancellation and source supersession as administrative closure, not a failed-source retry. Enforce deadline/cancellation again immediately before immutable snapshot publication.
- Treat Plugin/Core Efficiency and Stack as independent producers. Compatibility must be established with canonical bytes and versioned subpath contracts rather than root-barrel imports, shared databases, or ambient credentials.

## Errors Encountered

- The first ecosystem-document patch used a paragraph fragment that did not match the existing one-line text; no files changed, the exact line was located, and the patch was reapplied narrowly.
- The command runner rejected `rm -rf` for the isolated Sea Strike review directory; cleanup was retried with explicit file deletion and `rmdir`.
- Cross-cutting review found that a started attempt could not persist its terminal `source-invalid` state when malformed input supplied no digest. The attempt contract now accepts an explicit null digest for invalid or incomplete sources, and focused regression tests close that orphan-attempt path.
- Scheduler red-team found that an overlap-suppression handle could cancel the actual owning child, arbitrary parent preloads could cross the child boundary, and an unreferenced child could outlive truthful tracking. The overlap handle is now inert, production forwards no preload arguments, development permits only the exact tsx bootstrap, and the child remains referenced until close.
- An independent Core Efficiency verification command initially called a nonexistent `build:receipts` script. No source changed; the package exposes the receipt build through its existing `build` script, and verification was rerouted to that exact contract.
- The first direct Hub/producer compatibility probe used a guessed efficiency-consumer export name and failed at module linking. No files changed; the actual exported compiler name was located before retrying.
- A pre-existing Plugin repository integration test was run once without an isolated HOME and wrote synthetic accounting records into the live `~/.ashlr/stats.json` ledger. Further Plugin validation moved to an isolated HOME. The nine synthetic buckets and September 3 aggregate were removed under an exact compare-and-swap guard; the repaired live file is SHA-256 `c36c0ddebe1e2081fafc0140f161d18478186e4aa1423d5bfcbc0edd7771b219`, and a recoverable mode-0600 incident backup is retained at SHA-256 `692aefdb980d7cd68135d656436d6a979d81aabd4086ee692e016c22f32e157e`.
- A combined documentation update initially targeted phase text that an independent claims review had already changed, so the patch failed without modifying files. The exact current paragraphs were reread and updated narrowly.
- The first full Hub test run found one CI-matrix expectation that omitted the already-added M526 Windows portability entry. The expected exact partition was updated; M30 then passed 7/7. No runtime source changed for this correction.

## Status

**Source and observation-coherence tranche complete.** The observer remains default-off and uncommissioned. Released producer artifacts, trust-key provisioning, live freshness, authenticated rollover/external anchoring, and one deliberately enabled local observer lane are separate future gates.

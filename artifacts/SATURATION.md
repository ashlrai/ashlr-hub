# Firm build evidence — September 10, 2026

## Actual work, not simulated agent counts

- Host limit: four concurrent agents including the parent.
- Six distinct worker/reviewer identities participated across reused work waves;
  three cold reviewers started without implementer conversation history.
- Parent was the sole committer/integrator. Eleven package artifacts landed locally:
  ten code-and-test packages plus one source inventory. Twelve signed merge
  attestations include the separate CLI/SDK integration commit.
- `auto/p00` is the integration branch. Package branches/worktrees use `auto/pNN`.
  P01 was initially produced as an independent inventory in P21's worktree and
  subsequently retained on its own `auto/p01` branch; no overlapping code ownership.
- The original working checkout and previous planning worktree were preserved.
- No model-provider calls, account allocation changes, service activation, public
  deployment, npm publication, GitHub Actions or remote pushes were performed.

## Landed artifacts

| Package | Tested artifact | Focused tests |
| --- | --- | ---: |
| P00 | Durable artifact-bearing graph, signed event chain, restart/stop behavior | 24 |
| P01 | Source-backed autonomy gap inventory | Source/path validation, not code tests |
| P02 | DecisionTraceV1 signing and conflict-preserving query | 48 |
| P06 | Evidence-pinned caller of the existing pure portfolio scorer | 22 |
| P07 | Immutable signed allocation storage, conflict/replay and capacity admission | 18 |
| P13 | Minimal bound cold-verification transport contract | 45 |
| P21 | Frozen baseline/evaluator archive, protected-path refusal, retained failures | 38 |
| P27 | Immutable daily memory and CAS-linked consolidation versions | 30 |
| P35 | Deterministic capped payment simulation with carried holds | 38 |
| P37 | Shared KILL admission and active native/local cancellation | 12 |
| P43 | Fixed plan→implementation→check→trace fixture and query CLI | 34 |

Additional integration coverage includes real CLI processes with test-owned
provenance and the exact public-document distribution allowlist. Original
package commits and their patch digests are in `merge-traces.json`; later P00
fixes and shared wiring are in integration commit `307a55de`.

## Findings corrected during independent review

- Graph/node ID collisions could prevent trace signing.
- Valid large definitions and fan-in exceeded implicit serialization limits.
- Immediate promises could starve signal callbacks; admissions now yield the
  event loop and recheck ownership/stop state.
- Harness archive admission could exceed the readable aggregate bound under
  concurrent writes; complete count/byte admission is now serialized.
- Mandatory owned cancellation exposed an existing Windows native limitation.
  It now reports `worker-kill-cancellation-unsupported` before any native launch;
  local HTTP remains supported. No unsupported cleanup is fabricated.

## Acceptance boundary

Integrated local gates: 317 feature/package/CLI tests passed; 1,005 UI tests
passed; 67 existing release-artifact tests passed. Full core/web typecheck,
build, documentation checks and real-I/O classification passed. Whole-repository
lint passed with 105 existing warnings and no errors. The final H1–H8 invariant
suite rerun passed 449 tests with five skips. These counts overlap other targeted runs and
must not be added together as independent observations.

The real CLI-process fixture has two competing strategies, a correct declarative
artifact, a deliberately lying artifact rejected by its checker, eleven signed
traces and a conflict retained across a fresh query process. The fixture's
deterministic checker is in-process: this does not prove independent model
judgment or a physically separate verifier transport.

The actual host reports global KILL **active**. A compiled CLI demo invocation
returned `stopped`, with zero dispatches and zero traces. That sentinel was not
cleared. Existing daemon/conductor roots remain unchanged and empty.

## Yield and remaining work

Verified engineering yield delta is **unknown**: no accepted product change,
model-token denominator, retention change or live autonomous run was measured.
Tests and commits are not substitutes for that metric.

The 48-package plan contains 11 locally landed component artifacts and 37 planned
packages. The requested 40 terminal packages and 20 tested packages are **not
met**. Nor is the full autonomous firm complete. Main gaps are receipt-consuming
resource dispatch, fresh confined model verification, integration/CAS advancement,
resident ticks behind existing activation, real product acceptance, harness
promotion and the operator/MCP projections. See `docs/AUTONOMY-GAP.md`.

Same-user access to provenance keys or storage can defeat local integrity;
signatures are not effect permits. Payment storage, capacity leasing and live
memory projections remain separate from their tested component contracts.

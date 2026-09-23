# Open-PR triage — 2026-09-22

The autonomous fleet opened these over June–August 2026 and none was ever reviewed.
By the time this was triaged the newest was 35 days old, the oldest 64, and master had
shipped 3.4.0 past all of them. They were closed as stale, not rejected.

**Nothing here is lost.** Every branch below still exists on the remote, and a closed PR
reopens in one click. `mergeable` is recorded as it stood at triage: `yes` means the branch
still applied cleanly to master and is the cheaper set to resurrect; `no` means it needs a
rebase first. Neither value says the change is still *correct* — master moved a long way.

| PR | age | applies cleanly | size | branch | title |
|---|---|---|---|---|---|
| [#57](https://github.com/ashlrai/ashlr-hub/pull/57) | 64d | no | +813/-63 in 11f | `codex/source-revision-current` | fix: fence stale sandbox source revisions |
| [#59](https://github.com/ashlrai/ashlr-hub/pull/59) | 64d | no | +30/-1 in 4f | `codex/causal-coverage-unavailable` | fix: distinguish unavailable causal coverage |
| [#60](https://github.com/ashlrai/ashlr-hub/pull/60) | 64d | no | +48/-14 in 4f | `codex/draft-base-verification` | fix: bind draft verification to base commands |
| [#63](https://github.com/ashlrai/ashlr-hub/pull/63) | 64d | no | +566/-5 in 4f | `codex/cutoff-retention-rotation` | feat: rotate cutoff observation checkpoints |
| [#65](https://github.com/ashlrai/ashlr-hub/pull/65) | 64d | no | +78/-18 in 7f | `codex/repo-scoped-cooldown` | fix: scope cooldowns by repository |
| [#66](https://github.com/ashlrai/ashlr-hub/pull/66) | 64d | yes | +125/-17 in 6f | `codex/judge-feedback-repo-scope` | fix: scope judged feedback cooldowns |
| [#67](https://github.com/ashlrai/ashlr-hub/pull/67) | 64d | yes | +395/-130 in 7f | `codex/shared-queue-collision-fence` | fix: reject ambiguous shared queue claims |
| [#68](https://github.com/ashlrai/ashlr-hub/pull/68) | 64d | yes | +166/-69 in 8f | `codex/dispatch-bookkeeping-repo-scope` | fix: scope dispatch bookkeeping by repository |
| [#69](https://github.com/ashlrai/ashlr-hub/pull/69) | 64d | yes | +29/-15 in 4f | `codex/route-preflight-repo-scope` | fix: scope route preflight state by repository |
| [#70](https://github.com/ashlrai/ashlr-hub/pull/70) | 64d | yes | +36/-18 in 6f | `codex/concurrent-route-repo-scope` | fix: scope concurrent routes by repository |
| [#71](https://github.com/ashlrai/ashlr-hub/pull/71) | 64d | yes | +23/-10 in 3f | `codex/repair-reservation-repo-scope` | fix: scope repair reservations by repository |
| [#72](https://github.com/ashlrai/ashlr-hub/pull/72) | 64d | yes | +30/-0 in 3f | `codex/concurrent-route-identity-regression` | test: cover concurrent route repository identity |
| [#73](https://github.com/ashlrai/ashlr-hub/pull/73) | 64d | yes | +30/-12 in 4f | `codex/repo-scoped-ci-fixtures` | test: align repository-scoped daemon fixtures |
| [#86](https://github.com/ashlrai/ashlr-hub/pull/86) | 63d | no | +64/-2 in 5f | `codex/evidence-verifier-controls` | Fence verifier-control diffs in evidence mode |
| [#88](https://github.com/ashlrai/ashlr-hub/pull/88) | 63d | no | +510/-65 in 9f | `codex/web-operation-receipts` | Add idempotent receipts to web mutations |
| [#92](https://github.com/ashlrai/ashlr-hub/pull/92) | 63d | no | +26/-7 in 4f | `codex/fleet-source-provenance` | fix(fleet): require complete source provenance |
| [#97](https://github.com/ashlrai/ashlr-hub/pull/97) | 63d | no | +65/-0 in 4f | `codex/operational-projection-readiness` | feat(fleet): expose operational projection readiness |
| [#98](https://github.com/ashlrai/ashlr-hub/pull/98) | 63d | no | +177/-9 in 4f | `codex/agent-actions-freshness` | fix(fleet): withhold stale evidence inputs |
| [#103](https://github.com/ashlrai/ashlr-hub/pull/103) | 63d | no | +16/-1 in 4f | `codex/readiness-source-completeness` | fix(fleet): lower confidence for blocked readiness |
| [#108](https://github.com/ashlrai/ashlr-hub/pull/108) | 62d | no | +824/-112 in 25f | `codex/measured-judge-spend` | fix(fleet): make decision accounting durable |
| [#112](https://github.com/ashlrai/ashlr-hub/pull/112) | 62d | no | +2648/-77 in 27f | `codex/verifier-authority-digest` | feat(verify): enforce Git-tree verifier authority |
| [#120](https://github.com/ashlrai/ashlr-hub/pull/120) | 62d | no | +288/-14 in 8f | `codex/verify-only-freshness-v2` | fix(fleet): refresh backlog during verify-only |
| [#139](https://github.com/ashlrai/ashlr-hub/pull/139) | 43d | no | +31782/-42 in 61f | `codex/claimed-batch-admission` | feat(learning): record exact claimed batches |
| [#154](https://github.com/ashlrai/ashlr-hub/pull/154) | 55d | no | +1653/-0 in 2f | `codex/operational-projection-writer-v2` | feat(inbox): add projection shadow recovery writer |
| [#157](https://github.com/ashlrai/ashlr-hub/pull/157) | 55d | yes | +1119/-0 in 2f | `codex/projection-monotonic-anchor-v1` | feat(inbox): define monotonic anchor receipts |
| [#159](https://github.com/ashlrai/ashlr-hub/pull/159) | 55d | no | +135/-0 in 2f | `codex/terminal-repair-queue-truth-v1` | fix(fleet): project terminal queue truth |
| [#162](https://github.com/ashlrai/ashlr-hub/pull/162) | 55d | yes | +594/-6 in 2f | `codex/stale-repair-backlog-retirement-v1` | feat(fleet): retire terminal backlog projections |
| [#165](https://github.com/ashlrai/ashlr-hub/pull/165) | 55d | yes | +1289/-0 in 2f | `codex/projection-cas-recovery-v1` | feat(inbox): gate projection CAS recovery |
| [#172](https://github.com/ashlrai/ashlr-hub/pull/172) | 52d | yes | +4907/-0 in 7f | `codex/projection-cas-composition-v1` | feat(inbox): compose durable projection CAS recovery |
| [#175](https://github.com/ashlrai/ashlr-hub/pull/175) | 43d | no | +155/-11 in 2f | `codex/projection-transaction-cold-start-v1` | fix(inbox): create private projection storage on cold start |
| [#176](https://github.com/ashlrai/ashlr-hub/pull/176) | 43d | no | +521/-52 in 7f | `codex/daemon-crash-restart-truthfulness-v2` | fix(daemon): expose retryable exit disposition |
| [#211](https://github.com/ashlrai/ashlr-hub/pull/211) | 47d | no | +3200/-20 in 12f | `codex/production-activation-readiness-v1` | feat: add production activation readiness evidence |
| [#212](https://github.com/ashlrai/ashlr-hub/pull/212) | 43d | no | +5090/-20 in 15f | `codex/activation-handoff-observation-v1` | feat(daemon): prove bounded release launch handoff |
| [#213](https://github.com/ashlrai/ashlr-hub/pull/213) | 43d | no | +4138/-111 in 17f | `codex/zero-step-backend-failover-v1` | fix(fleet): retry true zero-step backend failures |
| [#214](https://github.com/ashlrai/ashlr-hub/pull/214) | 48d | yes | +376/-5 in 6f | `codex/worked-outcome-recovery-v1` | fix(fleet): recover durable worked outcomes |
| [#215](https://github.com/ashlrai/ashlr-hub/pull/215) | 43d | no | +4332/-76 in 21f | `codex/api-model-token-efficiency-v1` | Bound local model execution and token use |
| [#221](https://github.com/ashlrai/ashlr-hub/pull/221) | 48d | yes | +1766/-8 in 9f | `codex/harness-observed-execution-spine-v1` | Record harness-observed execution metadata |
| [#224](https://github.com/ashlrai/ashlr-hub/pull/224) | 47d | no | +4226/-214 in 25f | `codex/zero-step-backend-failover-forward-v2` | Bind zero-step failover to execution authority |
| [#226](https://github.com/ashlrai/ashlr-hub/pull/226) | 47d | no | +580/-1 in 5f | `codex/rfs-outcome-control-plane-v1` | feat(fleet): add denominator-first outcome assurance |
| [#229](https://github.com/ashlrai/ashlr-hub/pull/229) | 47d | yes | +612/-10 in 3f | `codex/post-merge-denominator-v1` | feat(fleet): compute authenticated post-merge denominator |
| [#233](https://github.com/ashlrai/ashlr-hub/pull/233) | 43d | no | +918/-34 in 16f | `codex/immutable-attempt-identity-v1` | feat(fleet): carry immutable attempt identity |
| [#234](https://github.com/ashlrai/ashlr-hub/pull/234) | 47d | no | +2182/-171 in 15f | `codex/lane6-enterprise-authority-audit-v1` | feat(web): bind mutation roles to durable receipts |
| [#235](https://github.com/ashlrai/ashlr-hub/pull/235) | 47d | yes | +1822/-0 in 6f | `codex/outcome-cohort-drift-v1` | feat(fleet): detect outcome cohort drift |
| [#247](https://github.com/ashlrai/ashlr-hub/pull/247) | 43d | no | +5207/-27 in 11f | `codex/candidate-repo-admission-preflight-v1` | feat(enroll): add observation-only candidate admission preflight |
| [#249](https://github.com/ashlrai/ashlr-hub/pull/249) | 43d | no | +2657/-2 in 8f | `codex/cortex-relay-shadow-v1` | feat(fleet): add signed Cortex relay shadow admission |
| [#260](https://github.com/ashlrai/ashlr-hub/pull/260) | 43d | no | +512/-1028 in 4f | `codex/raycast-toolchain-bridge-v1` | chore(raycast): bridge toolchain to TypeScript 6 |
| [#261](https://github.com/ashlrai/ashlr-hub/pull/261) | 42d | no | +1605/-336 in 21f | `codex/daemon-spend-reservation-v1` | Prevent daemon spend oversubscription across concurrent model work |
| [#263](https://github.com/ashlrai/ashlr-hub/pull/263) | 42d | no | +406/-22 in 2f | `codex/public-json-hardening-v1` | fix(web): bound public JSON sanitization |
| [#266](https://github.com/ashlrai/ashlr-hub/pull/266) | 42d | no | +2517/-0 in 3f | `codex/capability-catalog-router-v1` | feat: add auditable capability outcome routing foundation |
| [#267](https://github.com/ashlrai/ashlr-hub/pull/267) | 42d | no | +556/-20 in 8f | `codex/linear-time-input-hardening-v1` | fix: make uncontrolled input scans linear |
| [#268](https://github.com/ashlrai/ashlr-hub/pull/268) | 42d | no | +894/-56 in 10f | `codex/windows-open-shell-elimination-v1` | fix: eliminate shell lookup from Windows desktop launchers |
| [#269](https://github.com/ashlrai/ashlr-hub/pull/269) | 42d | no | +214/-48 in 14f | `codex/run-identity-git-argv-hardening-v1` | fix(security): harden run identities and remote refs |
| [#272](https://github.com/ashlrai/ashlr-hub/pull/272) | 42d | no | +16/-12 in 1f | `codex/m201-midnight-fixture-v1` | test(ci): stabilize UTC spend evidence fixtures |
| [#278](https://github.com/ashlrai/ashlr-hub/pull/278) | 42d | no | +3060/-1 in 11f | `codex/activation-authority-v2` | feat: add mutation-disabled runtime activation admission |
| [#324](https://github.com/ashlrai/ashlr-hub/pull/324) | 35d | no | +4487/-387 in 57f | `codex/v332-iteration` | 3.3.1: heartbeat truth, real best-of-N judge, causal routing spine, live run streaming |

## Why this was allowed to build up

Nothing closed the loop. The fleet opened a PR per unit of work and moved on; no pass
ever merged, rebased or closed them, so the pile only grew. The fix is upstream of this
file — a PR that cannot be landed within a few days of being opened should not be opened.

# Notes: Unified Ashlr Agent Operating System

## Evidence ledger

### Live repository and storage evidence (2026-09-02/03)

- Hub canonical checkout: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`, branch `codex/v333-iteration`, HEAD `6d1bf2fe`, eight commits ahead of its tracking branch. Live GitHub `master` is `d6c1a5ec`.
- Before cleanup, the Hub Git store registered 268 worktrees: 258 on the Desktop, nine in `.codex/worktrees`, and one installed release. The Desktop set was 235 clean and 23 dirty (including the canonical root), occupying about 40.61 GiB.
- The Data volume initially had about 12 GiB free and reported 100% utilization.
- Authorized cleanup removed 235 clean linked worktrees using `git worktree remove`, preserving branch refs and creating archive refs for detached tips. It recovery-archived and removed 22 dirty noncanonical worktrees. Total reclaimed: 39.46 GiB. Recovery receipts: 48 files, all size/SHA-256 verified. The two standalone clones were moved intact to `~/.ashlr/recovery/ashlr-hub-standalone-clones-20260902/`.
- After cleanup, Hub has one visible Desktop folder and 11 registered worktrees total (one Desktop canonical root, nine Codex-managed worktrees, one installed release). Free space increased to about 52 GiB.
- Locus is now canonical at `/Users/masonwyatt/Desktop/github/dev-tools/locus` on live `main=8c6cfae`, with one registered worktree. Verified bundles/archive refs/recovery payloads preceded removal of 49.544 GiB of redundant clean worktrees.
- Cortex is now canonical at `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex` on live `main=f4aa45b0`, with one registered worktree and preserved untracked `.locus.toml`. Verified bundles, 52 archive refs, four dirty-tree recovery sets, and a separate scheduler/OIDC head preceded a 27.61 GiB visible Desktop reduction.
- Combined visible Desktop reduction across Hub, Locus, and Cortex is about 116.6 GiB. Recovery evidence remains retained under `~/.ashlr/recovery`; current free space is about 110 GiB.
- Entire is enabled in manual-commit mode on the active Hub branch but has no checkpoint to resume.

### Product boundary evidence

- Hub source already implements the proposal-only fleet kernel, mission DAG/receipts, sandboxing, provider routing, spend/resource controls, MCP aggregation, operator UI, and explicit release/deploy authority separation. It is mature enough that a ground-up rewrite would discard substantial verified IP.
- The decisive missing Hub primitive is account-aware execution identity. Current engine and resource types collapse each provider to one generic identity, ambient `HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR` are inherited by child processes, and usage/backoff keys collide by engine.
- Cortex has a bounded `EngineeringAssignmentV1` contract that is explicitly intended for a future Cortex-to-Hub relay. Its real Hub adapter remains stubbed. Cortex should own governed business intent, accountability, company memory, and business-state approval—not engineering scheduling.
- Locus should own principal, tenant, provider, and sealed-session identity. Hub should request an opaque execution identity/session, not copy Locus pin/seal logic or consume secrets.
- Phantom should own vaulting and network-edge secret injection. Its stronger Phantom-Locus lease kernel is roadmap/source work, not current active enforcement.
- wrkpad should remain a guarded physical operator surface consuming a bounded fleet/session projection. It must not become a second scheduler or approval authority.

### Current vendor/platform evidence

- OpenAI documents ChatGPT-subscription and API-key login for local Codex. Cached credentials live under `CODEX_HOME` or the OS credential store. The Codex SDK can start/resume local threads, and App Server exposes thread lifecycle, device/browser login, and ChatGPT rate-limit readings. This supports one isolated App Server/runtime per legitimate account, with Hub storing only opaque locator refs and capacity receipts.
- Anthropic documents `claude -p`/Agent SDK automation and explicit permission/MCP controls. However, beginning 2026-06-15, Agent SDK and `claude -p` no longer consume the user's interactive Max allowance; eligible Max accounts receive a separate monthly Agent SDK credit. Hub must not model unattended `claude -p` as the Claude Max interactive pool.
- Claude agent teams are experimental, token-intensive, and have coordination/resumption limitations. They are useful as an optional interactive execution surface, not the fleet's canonical durable scheduler.
- Ollama exposes OpenAI-compatible chat/responses endpoints, tools, and structured outputs. Its Responses implementation is non-stateful; Hub must own conversation/checkpoint state and qualify each local model through evals before granting authority.

## Gap matrix

| Claim family | Evidence | Confidence | Contradictions or gaps | Next check |
| --- | --- | --- | --- | --- |
| Canonical repository topology | Live Git/GitHub inventory plus independent audits | High | Locus/Cortex consolidation still executing; Phantom root is intentionally dirty | Complete recovery manifests and verify final paths |
| Hub control-plane readiness | Current source/runtime audit | High | Source, compiled dist, installed binary, and daemon state disagree | Implement identity fabric, rebuild exact source, then stage runtime separately |
| Phantom role and integration seam | Current source/docs audit | High | Opaque lease kernel not active | Treat current integration as status/injection; build lease transport later |
| Locus role and protocol surface | Current source/docs audit | High | Canonical clone name/path was wrong; unique stale-clone tips exist | Preserve/reconcile tips and consolidate path |
| Cortex knowledge-plane role | Current source/docs audit | High | Hub bridge stub; duplicate clone and moved worktrees | Preserve/reconcile, consolidate, then implement signed assignment transport |
| wrkpad physical-control role | Current source and live read-only preflight | High | Native route remains human-blocked by Input integrity/physical acceptance | Integrate projection only; keep commissioning separate |
| Multi-account Codex scheduling | Official App Server/auth docs + current Hub source | High | Hub lacks identity dimension and private locator store | Implement Execution Identity V1 shadow fabric |
| Claude Max unattended capacity | Current Anthropic support/docs | High | Existing Hub assumptions are obsolete | Separate interactive Max, SDK credit, and API billing pools |
| Local-model execution | Current Hub/Ollama evidence | Medium-high | Hub observability currently contradicts endpoint reachability | Unify adapter health/capacity and require model eval profiles |
| NIWC/DON design translation | Official NIWC/DVIDS, DON CIO, DoD CIO, NIST, CDAO sources | High for doctrine; inference for Ashlr | Public film is aspirational; no verified public monolithic product named SPECTRUM | Build Capability-on-Demand as Ashlr IP and validate in a digital mission range |

## Research log

- Historical guidance supports a federated architecture: Hub owns intent/planning/execution/verification/operator UX; Locus supplies governed tools/context; Cortex supplies durable company knowledge/reasoning; consequential releases, credentials, irreversible actions, and material spend remain human-controlled.
- Historical runtime state was rechecked and is not production-ready: daemon stopped, source/dist/installed versions disagree, backlog is stale/degraded, and execution authority is withheld.
- Recommended target is a federation with one scheduler and four explicit planes: Cortex intent, Hub execution/evidence, Locus identity/session, Phantom secret lease/injection. wrkpad is an operator projection/control surface.
- Recommended GitHub pattern is separate product repositories plus a versioned contract/conformance package and cross-repository compatibility matrix. Avoid a source monorepo, Git submodules, copied TypeScript contracts, and competing schedulers.
- Recommended first build is `Execution Identity V1`; recommended second build is the signed Cortex `EngineeringAssignmentV1` transport and Hub receipt return; recommended third build is Phantom-Locus opaque execution leasing.
- Sea Strike 2043 adds the mission loop: sense uncertainty, simulate courses of action, reframe under human intent, compose modular capabilities, run specialists in parallel, then request authority for synchronized effects.
- Spectrum-on-Demand adds the control-theory loop: distributed sensing, predictive resource modeling, dynamic deconfliction/allocation, closed-loop notification, resilience under contention, governance, and human oversight.
- Zero trust/ICAM makes the loop safe: identity for every human/agent/model/tool/workload/resource, deterministic policy decisions, short-lived signed capability leases, enforcement at every effect boundary, continuous re-evaluation, and fail-closed revocation.
- Product clarification: no fixed unattended duration is required. The fleet should continuously invest expiring subscription quota, local inference, wall time, and compute toward the best evidence-supported end state.
- Avoid governance theater: one compact value loop, five inter-product envelopes, a deterministic fast lane for routine reversible work, and adaptive independent evaluation only when risk or uncertainty warrants it.
- Standing constitutional permits should make bounded merge/canary/deploy/observe/rollback classes autonomous. Human attention is reserved for amending that envelope or taking unmodeled, irreversible, or externally committing effects.
- Work may be marked technically, product, or business effective only from frozen thresholds and attributable outcome receipts. Token spend, agent count, PR count, and self-report are not value metrics.
- Execution Identity V1 final audit closed its Windows portability gap by refusing private-store loading on Windows until an exact-DACL contract exists. Combined focused verification passes on macOS; live dispatch remains unwired.
- Living End-State portfolio shadow now binds hypotheses to vision/mission digests, carries estimate and shard-plan provenance refs, prices expiring capacity, holds during an open outcome window, stops on evidence or stop-loss, and never grants an effect. Its second and third independent reviews closed false effectiveness, impossible allocation, premature outcome, and observing-state defects.

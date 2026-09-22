# Notes: Agent-Native Engineering OS

## Existing verified foundation

- `Execution Identity V1` is internal, default-off, and shadow-only; it isolates account capacity and private runtime locators without live dispatch.
- `Living End-State portfolio shadow` deterministically ranks falsifiable hypotheses against expiring resource inventory and frozen outcome evidence, with every effect bit false.
- Hub already owns mission DAGs, provider routing, worktree isolation, receipts, policy gates, fleet status, and the desktop/web operator interface.
- The next value is integration, not more standalone conceptual frameworks.

## Constraints

- Preserve the active uncommitted source work.
- Do not expose identity refs, runtime paths, secrets, prompts, or raw provider errors in public status.
- Do not imply authentication, installed-artifact, daemon, dispatch, merge, release, deployment, or business-outcome readiness from source tests.

## Integration seam findings

- The existing read-only operator aggregate is `buildControlSnapshot()` in `src/core/web/control.ts`; `/api/control` and `controlSnapshotQuery` already provide a cached, independently degraded fleet view.
- `/api/vision/mission` already compiles a persisted strategist briefing, goal inventory, enrollment, proposal state, mission graph, and a proposal-only mission reconciliation shadow. It is the correct source of end-state/mission inputs, not a second vision store.
- `src/web-ui/data/api-types.ts` imports backend types directly and `src/web-ui/data/queries.ts` owns all HTTP query definitions. Any future live Agent OS view should reuse those seams.
- The current working slice must not add an API that fabricates hypotheses or capacity. Pure kernel, capability-spectrum, and presentational contracts come first; a later observer will join only verified persisted sources.
- The established non-Eve runtime remains the right foundation. Eve's durable-agent model is useful comparative input, but introducing a second runtime would fragment Hub's existing scheduler, mission, sandbox, receipt, and policy IP.

## Operator cockpit slice

- `AgentOsCockpit` presents one decision spine: living end state, bottleneck, exception-first action, capacity/reset lanes, and at most three active value bets.
- Outcome state and evidence state are visually distinct; unknown/empty capacity stays explicit.
- The component has no links, buttons, prompt/account/identity/path/secret fields, or live-effect controls.
- It was initially isolated and is now mounted only behind the authenticated, observation-only `/api/agent-os` read path. Missing or inconsistent snapshots render as missing/degraded; existing `/api/portfolio` process metrics are not relabeled as product-value hypotheses.
- Isolated verification reported 4/4 component tests, 100/100 full web tests, web typecheck, targeted lint, and production web build passing.

## Implemented control-loop slices

- `agent-native-kernel.ts` composes verified identity, exact resource envelope, portfolio, evidence, and the complete prior verified cycle. It enforces bounded freshness/skew, exact source coverage, strict checkpoint ancestry, mutually exclusive decision counts, and separate refutation versus guardrail-breach learning.
- `capability-spectrum.ts` creates an atomic, reset-aware values-free allocation projection. Its verifier bounds hostile input, rejects expired available capacity, and binds its execution-identity model plus resource-envelope lineage to the kernel.
- `strategic-investment-compiler.ts` requires one explicit numeric contract per modern mission node. Its canonical acceptance digest covers the entire frozen contract, while hypothesis provenance binds the briefing source, spec, mission graph, repository, dependencies, deliverable, acceptance evidence, and desired outcome.
- The strategist objective now optimizes retained product/user value, reusable IP, information gain, and value per expiring resource window. Merge volume, token burn, and hours saved are diagnostic only.
- The Claude strategist invocation is inference-only: policy is carried in the system prompt; every repository/spec/playbook block is serialized as untrusted data; built-in tools, ambient customizations, and MCP are disabled for the call.
- `agent-os-read-model.ts` joins only exact fresh receipts, derives capacity state/headroom/reset urgency from inventory, requires all active bets and resources to be accounted for, rejects private display text, and digests the exact rendered snapshot.

## Adversarial findings closed

- Oversized/cyclic verifier inputs and reset windows elapsed before `asOf`.
- Stale or unrelated evidence/resource/identity snapshots and forged checkpoint assertions.
- Guardrail breaches mislabeled as hypothesis refutations.
- Acceptance receipt replay after weakening a threshold.
- Briefings with different repositories/deliverables compiling to identical hypotheses.
- Prompt injection through commit/repository/ecosystem text and unintended strategist tool access.
- Private text in estimate/evidence fields, cyclic mission dependencies, empty contracts, and deadlines before observation completion.
- Persuasive cockpit receipts whose displayed prose was not digest-bound.
- Healthy cockpit composition from unrelated spectrum/kernel identities, omitted capacity identities, impossible kernel count partitions, and conflicting clock-skew policy.
- Kimi, NIM, or Grok cloud identities mislabeled as local capacity; provider mapping is now an explicit Codex/Claude/local-coder allowlist.

## Remaining activation boundary

- A default-off source implementation now authenticates a complete signed kernel/spectrum/portfolio/display bundle and can append an observation-only snapshot; the cockpit route is mounted but has no healthy data until trust keys and an external producer are separately commissioned.
- Source bundles use role-separated Ed25519 signatures and append-only source/attempt/snapshot stores, but the host-local checkpoint HMAC is not same-user rollback protection. Snapshot reconciliation, bounded rollover, and an external monotonic/transparency anchor remain required before unattended commissioning; standing-permit evaluation remains separate before any dispatch.
- Live identity/account authentication, daemon activation, model dispatch, reservation, repository mutation, merge, release, deployment, publication, and business-outcome verification were not performed.

## Expanded ecosystem inventory added 2026-09-03

- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-plugin` is a cross-host Codex/Claude efficiency product with compact MCP tools, hooks, genome context, savings accounting, and opt-in telemetry. Its checkout contains active uncommitted work and must be treated as independently owned.
- `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-core-efficiency` is the reusable library for compression, token estimation, budgets, genome, session logs, prompt caching, and local-context management. Its checkout also contains active work.
- `/Users/masonwyatt/Desktop/github/dev-tools/stack` is the Ashlr Stack monorepo and provider control plane, with a provider catalog plus CLI, MCP, and plugin surfaces and Phantom-backed secret references. Its checkout contains active verification work.
- Integration should begin with read-only, versioned receipts and package contracts. Do not merge repositories or let Hub bypass the projects' provider, credential, or effect boundaries.
- After an exact compare-and-swap cleanup removed nine test-created buckets and their September 3 aggregate, a bounded read of the local `~/.ashlr/stats.json` confirmed schema version 2 with 959 sessions, 80,174 lifetime calls, and 266,578,850 `tokensSaved` against `rawTotal` 272,248,538. `tokensSavedMeasured` and `measuredCalls` remain absent, so this is a locally recorded estimate, not an independently measured or causal outcome claim.

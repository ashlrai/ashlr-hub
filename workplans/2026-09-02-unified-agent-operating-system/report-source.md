# Ashlr Unified Agent Operating System — Research Source

Audience: Mason / Ashlr founder-operator  
Date: 2026-09-02  
Status: Evidence synthesis and workspace consolidation complete; Execution Identity V1 and Living End-State allocator independently verified in shadow mode

## Scope and assumptions

This research answers how to turn the existing Ashlr products and the founder's legitimate Codex, Claude, and local-model capacity into one desktop-operated autonomous engineering fleet while retaining independent product value. It covers current local source, Git/GitHub topology, runtime authority, provider integration options, storage/worktree operations, and a staged target architecture. It does not assume that source completeness proves a deployed, installed, authenticated, resident, or production-authorized system.

## Direct executive answer

Ashlr should not merge the products into one source repository or rewrite Hub from scratch. Hub already contains a mature proposal-first fleet kernel, mission system, sandboxing, trust/provenance, resource controls, MCP aggregation, and an operator UI. The 10x move is to turn Hub into the sole scheduler and execution-evidence kernel, then federate four independently valuable planes through strict versioned contracts:

1. Cortex owns governed business intent, responsibility, company memory, and business-state approval.
2. Hub owns mission compilation, provider/account/local-model scheduling, sandboxes/worktrees, engineering verification, and evidence receipts.
3. Locus owns principal, tenant, provider, and sealed execution-session identity.
4. Phantom owns vaulting and value-blind secret leasing/injection at the network edge.
5. wrkpad consumes a bounded Hub projection and provides guarded physical operator controls; it owns neither scheduling nor approval.

The decisive first Hub primitive is `Execution Identity V1`: Hub currently has one generic Codex and Claude backend, inherits ambient credential homes, and collides usage/backoff by engine. The second is a Living End-State allocator that treats subscription quota and local compute as expiring investment capacity, ranks falsifiable product hypotheses by expected outcome and information gain, and reallocates from weak work. These should remain a compact control loop, not an agent bureaucracy. Connect Cortex's signed intent envelope and Phantom/Locus execution leases after those two foundations.

## Current-state evidence

### Hub

- Architecture and authority separation: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/docs/ARCHITECTURE.md`, `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub/docs/MISSION-OS.md:1-50`.
- Mission OS explicitly distinguishes intent, evidence, and authority; its existing Cortex/Locus references are contract boundaries rather than active connectors: `docs/MISSION-OS.md:14-50,275-304`.
- Engine identity is closed around one Codex/Claude family: `src/core/types.ts:2569-2581`.
- Dispatch assignment lacks an account/identity dimension: `src/core/fabric/concurrent-dispatch.ts:83-99`.
- Child processes inherit ambient `HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`: `src/core/run/sandboxed-engine.ts:816-855`.
- Codex usage sensing reads the default Codex session tree and selects the newest session: `src/core/observability/codex-source.ts:45-48,450-475`.
- Subscription capacity is keyed by engine and can fail open when unknown: `src/core/fleet/subscription-usage.ts:155-185,197-260`.
- Enabled plugins execute in-process and are not a credential-isolation boundary: `src/cli/plugins.ts:160-171`.
- Current source, compiled build identity, installed binary, and resident daemon disagree. This is a staged-runtime blocker, not a reason to discard the source.

### Cortex

- Cortex product role: durable memory, responsibility, and proposal-oriented agent collaboration: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex/PRODUCT.md:17-36,137-235`.
- Permission-filtered MCP and proposal-only writes: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex/docs/mcp.md:123-193`.
- Bounded `EngineeringAssignmentV1` already binds issuer/audience, replay, org/workstream, exact repo revision, success signals, guardrails, file allowlists, and proposal-only authority: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex/packages/api/src/fleet/engineering-assignment.ts:16-29,54-115,146-184`.
- The contract is documented as a future Cortex-to-Hub relay; execution/key distribution/Hub consumer are not active: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex/docs/ENGINEERING-ASSIGNMENT-V1.md:1-18,41-46`.
- Current Hub bridge defaults to a stub and mirrors locally: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-cortex/packages/api/src/lib/hub-bridge.ts:46-66,114-120`.

### Locus

- Canonical source is `/Users/masonwyatt/Desktop/github/dev-tools/locus`, remote `ashlrai/locus`, live `main=8c6cfae`.
- Existing Hub integration contract instructs Hub to use Locus sessions and pre-mutation gates without reimplementing pin/seal logic: `/Users/masonwyatt/Desktop/github/dev-tools/locus/integrations/ashlr-hub/README.md:17`.
- Locus's independent role is identity and tenant safety, not fleet scheduling: `/Users/masonwyatt/Desktop/github/dev-tools/locus/docs/ARCHITECTURE.md:144`.

### Phantom

- Phantom's independent value is scoped placeholder tokens, OS-backed vaulting, authenticated proxying, and value-blind MCP operations: `/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets/README.md:31`.
- The stronger Phantom-Locus lease contract exists as inactive metadata/source work and must not be presented as active enforcement: `/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets/crates/phantom-locus-contract/src/lib.rs:1`, `/Users/masonwyatt/Desktop/github/dev-tools/phantom-secrets/PHANTOM_EXECUTION_KERNEL_ROADMAP.md:3`.
- Hub currently retains an in-process reveal exception for API backends: `src/core/integrations/secrets.ts:1`. Target design removes raw secret access from the Hub process.

### wrkpad

- wrkpad architecture is lifecycle JSON to authenticated loopback service to six sticky slots; HID writing is disabled: `/Users/masonwyatt/Desktop/work louder board/wrkpad/docs/architecture.md:3-24`.
- It is observe-first, token-protected, content-discarding, and claim-layer separated: `docs/architecture.md:45-66`.
- Consequential controls are hold-gated, and no generic push/merge/deploy/publish/delete/spend/credential executor exists: `app/docs/controls.md:68-92`, `app/electron/action-registry.cjs:13-38,57-120`.
- Live physical commissioning remains blocked by Work Louder Input integrity and a required human Flight Check. Source/runtime readiness is not device acceptance.

### Workspace topology

- Hub cleanup started with 268 registered worktrees, 258 visible on Desktop, 40.61 GiB total. The Data volume had about 12 GiB free.
- Authorized cleanup removed 235 clean worktrees through Git and archived/recovered 22 dirty worktrees before removal. Two standalone clones were moved intact to recovery. Reclaimed total: 39.46 GiB. Recovery receipts were SHA-256 and size verified.
- Phantom has one canonical root and Codex-managed/release worktrees, not duplicate source roots. Its dirty root is active work and was not altered.
- Locus consolidation left one canonical checkout, preserved 64 archive refs across current/stale histories, verified complete bundles and 27 checksum-indexed recovery files, and removed 49.544 GiB of clean redundant worktrees.
- Cortex consolidation left one canonical checkout on live `main`, preserved 52 archive refs for 30 commits, verified complete bundles plus 19 recovery payloads, and reduced the visible Desktop footprint by 27.61 GiB.

## NIWC/DON mission-systems evidence

- The linked [NIWC Pacific VISION page](https://www.niwcpacific.navy.mil/VISION/) hosts *Sea Strike 2043*, a 4:32 future-concept film about distributed maritime operations in a contested environment. The [official DVIDS record](https://www.dvidshub.net/video/950543/sea-strike-2043) identifies NIWC Pacific/NAWC Weapons Division, author Aaron Lebsack, VIRIN `250101-N-ZB499-1002`, and a January 2025 release.
- The video depicts uncertainty, course-of-action simulation, human reframing, modular reconfiguration, parallel specialists, resilient communications, AI coordination, and explicit human authorization for synchronized automated effects. This is an aspirational narrative, not an operational capability assertion.
- No public official source verified one monolithic DON software platform formally named “SPECTRUM.” Official sources instead describe an Electromagnetic Spectrum Enterprise and a Spectrum-on-Demand operating vision.
- DON's [Spectrum-on-Demand](https://www.doncio.navy.mil/%28emrqdynnvd5tp0y4kvriys55%29/CHIPS/ArticleDetails.aspx?ID=20514) concept uses distributed sensing, real-time closed-loop notifications, predictive congestion/interference models, dynamic coexistence and surge access, AI/ML mitigation, governance, and human oversight.
- The [DoD Zero Trust Strategy](https://dodcio.defense.gov/Portals/0/Documents/Library/DoD-ZTStrategy.pdf) rejects implicit trust based on location/ownership and organizes target capabilities around User, Device, Application/Workload, Data, Network/Environment, Automation/Orchestration, and Visibility/Analytics.
- DON's [ICAM capability statement](https://www.doncio.navy.mil/%28cyg51dffug4mbb45uqya2y45%29/ContentView.aspx?ID=18058) connects identity to SSO, least privilege, auditable access controls, MFA, and denied/degraded/intermittent/limited operation.
- The [DoD Responsible AI pathway](https://www.ai.mil/Portals/137/Documents/Resources%20Page/DoD%20Responsible%20AI%20Strategy%20and%20Implementation%20Pathway.pdf) reinforces lifecycle evaluation, traceability, reliability, governance, and the ability to disengage unintended behavior.
- Ashlr inference: turn provider quota, model competence, compute, context, workspaces, tools, human attention, and effect authority into a continuously sensed and deconflicted “agentic spectrum.”

## External platform evidence

### OpenAI Codex

- [Authentication](https://learn.chatgpt.com/docs/auth) documents ChatGPT-subscription and API-key login for local Codex. It also documents credential caching under `CODEX_HOME`/OS keyring and warns that `auth.json` contains access tokens.
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) starts, continues, and resumes local threads programmatically.
- [Codex App Server](https://learn.chatgpt.com/docs/app-server) exposes thread start/resume/fork, browser/device login, account updates, and ChatGPT rate-limit reads. These are the appropriate supported primitives for a Hub Codex adapter.
- Inference: one App Server/runtime per legitimate account, isolated by a private credential domain, gives Hub an observable capacity pool without copying tokens into config or prompts. The implementation must still respect plan limits and current account terms; capacity is not guaranteed.

### Anthropic Claude

- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) supports JSON/streaming non-interactive runs, explicit tools, MCP config, permission modes, and bounded turns.
- [Claude Max/Code support](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan) says interactive surfaces share plan usage limits.
- [Agent SDK plan policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says that from 2026-06-15 Agent SDK and `claude -p` use a separate monthly credit rather than the interactive Max allowance; production automation should use API billing for predictable capacity.
- [Agent teams](https://code.claude.com/docs/en/agent-teams) are experimental and token-intensive with known coordination/resumption limitations. Hub should interoperate with them as an optional interactive surface, not duplicate or depend on them for durable scheduling.

### Local models

- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) includes chat/responses, streaming, tool calls, structured output, reasoning controls, and embeddings. Stateful Responses continuity is not supported, so Hub owns durable conversation state.
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling) supports agent tool loops. Capability presence does not prove coding quality; each exact model/quantization/context configuration needs an evidence-backed graduation profile.

## Reconciled architecture

```text
Cortex intent/accountability
  -> Signed EngineeringAssignmentV1
Hub mission kernel
  -> account-aware ExecutionIdentityRef selection
Locus sealed execution session
  -> opaque Phantom SecretLeaseRef
Provider worker (Codex App Server / Claude Agent SDK / local OpenAI-compatible)
  -> sandboxed diff + verification evidence
Hub proposal/effect gate
  -> immutable RunReceipt / ProposalReceipt / OutcomeReceipt
Cortex outcome memory + Hub UI + wrkpad projection
```

The core rule is one scheduler, one authority ledger, multiple independently shippable capability planes. No plane infers authority from another plane's successful output.

## Recommended protocol kernel

Use five durable cross-product envelopes rather than manufacturing a service around every concern:

1. `IntentEnvelopeV1`: company intent, end-state version, falsifiable hypothesis, baseline, frozen acceptance, and exact source.
2. `CapabilityLeaseV1`: opaque identity, Locus session, runtime capability, resource envelope, Phantom references, expiry, and revocation.
3. `EffectPermitV1`: standing or one-shot task-class authority, consequence ceiling, obligations, and recovery contract.
4. `RunReceiptV1`: exact execution, artifact, resource-spend, test, and policy evidence.
5. `OutcomeReceiptV1`: technical, product, and business effectiveness across a defined observation window.

Types such as execution identity, attestation, secret lease, risk signal, and policy decision remain facets of those envelopes, not independent organizational boundaries. Routine reversible work uses a deterministic fast lane; separate critique/evaluation is invoked adaptively for novelty, consequence, uncertainty, disagreement, or weak evidence.

## GitHub topology recommendation

- Keep product source in separate repos: `ashlr-hub`, `phantom-secrets`, `locus`, `ashlr-cortex`, `wrkpad`.
- Publish a small versioned `@ashlr/protocol` package (or equivalent language-neutral JSON Schemas plus generated bindings) with canonical fixtures, digest rules, compatibility policy, and conformance tests.
- Add an integration/meta repository only for compatibility manifests, end-to-end contract tests, release evidence, architecture decision records, and rollout playbooks. Do not vendor product source and do not use Git submodules.
- Hub's compatibility CI should test released protocol versions and pinned product revisions. Product repos remain independently releasable and usable.
- Use ephemeral leased worktrees under a non-Desktop runtime directory such as `~/.ashlr/worktrees/<repo>/<run-id>`, with TTL, owner/session ID, exact base SHA, dirty-state protection, recovery receipts, and bounded garbage collection.

## Strategic interpretation

The defensible IP is not another chat UI. It is a local-first, evidence-bearing investment and autonomy kernel that turns expiring model intelligence into retained product and business value. It continuously evolves a working end state, prices competing hypotheses, concentrates capacity on the bottleneck, builds and tests, observes outcomes, and kills or reallocates without treating activity as progress. A small founder-defined constitution plus standing permits keeps routine work autonomous; only proposed expansion beyond that envelope becomes a human exception. Hub's operator topology and wrkpad make the system legible and interruptible; Cortex makes it business-aware; Locus and Phantom bind execution to the right identity and secret scope.

## Material limitations

- The Hub implementation in this workstream is not installed, activated, or production-authorized merely because source tests pass.
- Two Codex subscription accounts must be authenticated by the user into isolated credential domains; no credentials were accessed or changed here.
- Claude Max interactive allowance is not an unattended Agent SDK pool under current policy.
- Phantom-Locus secret leases and Cortex-Hub transport are not currently active.
- wrkpad physical commissioning is still a separate human acceptance gate.
- No GitHub remote creation, release, merge, provider activation, daemon installation, or live dispatch occurred in this workstream; local source readiness does not prove any of those states.

## Stop condition

Research stopped after current local source, Git/GitHub topology, runtime state, material provider primitives, and consequential architecture claims were supported. Additional broad search was unlikely to change the first two implementation decisions: build account-aware execution identity and a shadow outcome/value allocator before enabling cross-product runtime effects.

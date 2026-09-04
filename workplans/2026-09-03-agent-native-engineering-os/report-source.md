# Research Source: Ashlr Agent-Native Engineering OS Ecosystem

Audience: Ashlr founder and engineering leads
Date: 2026-09-03
Status: research and observation-first source implementation complete; live commissioning and effect authority not performed

## Scope and assumptions

This research asks how Ashlr Hub, Plugin, Core Efficiency, Stack, Cortex, Phantom, Locus, MMCP, and wrkpad should compose into an agent-native engineering operating system while remaining independently useful products. Local repositories are the primary source for current Ashlr capabilities. Authoritative external sources are used for identity, zero trust, interoperability, telemetry, and provenance patterns.

No repository merge, deployment, provider activation, credential use, external communication, or live autonomous effect is part of this research tranche.

## Direct executive answer

Hub should be the mission and resource kernel, not a monorepo containing every product. The ecosystem should communicate through versioned, signed, privacy-classified observation receipts and narrow effect manifests:

1. Plugin and Core Efficiency report context efficiency and quality outcomes.
2. Cortex supplies durable organizational knowledge and evidence references.
3. Locus and MMCP expose governed tools and workspace context.
4. Stack reports service topology, health, quotas, and proposed provider effects.
5. Phantom brokers secret capabilities without disclosing secret values.
6. Hub selects value hypotheses, allocates model/time/context capacity, and issues only the smallest permitted work package.
7. Independent observers verify artifacts and outcomes before the portfolio learns.
8. The Hub cockpit exposes exceptions, evidence quality, capacity, and next action without exposing private source content.

## Evidence and implications

### Distributed mission operations

NIWC Pacific describes Sea Strike 2043 as distributed maritime operations in a contested environment combining emerging technology and real-time intelligence. The transferable engineering pattern is a common operating picture, heterogeneous resource coordination, graceful degradation, and decision advantage—not military functionality. Source: [NIWC Pacific Sea Strike 2043](https://www.niwcpacific.navy.mil/VISION/).

The complete 4:32 film and its official closed captions were inspected. Its decision loop starts with incomplete location evidence and a hard time budget, runs multiple courses of action, requests additional reconnaissance, reconfigures modular hardware and software, relays observations over resilient distributed communications, and synchronizes effects only after an explicit authorization request. For Agent OS, that translates into uncertainty-preserving state, deadline-aware parallel simulation, evidence-seeking tasks, composable capabilities, resilient event/receipt transport, and a separately enforced effect gate. Source: [official DVIDS Sea Strike 2043 record](https://www.dvidshub.net/video/950543/sea-strike-2043).

### Zero trust and workload identity

NIST SP 800-207 separates policy decision and policy enforcement and requires authentication of the subject plus validity of each resource request. Hub should therefore separate portfolio recommendation, authority issuance, and final effect enforcement. Source: [NIST SP 800-207](https://doi.org/10.6028/NIST.SP.800-207).

NIST SP 800-207A applies zero trust to application/service identities in multi-cloud systems and explicitly points to SPIFFE-style identity infrastructure. SPIFFE further defines administratively isolated trust domains, short-lived workload identity documents, and federation through public trust bundles. Ashlr should use separate trust domains/roles for observation, execution, provider operations, and external outcome verification. Sources: [NIST SP 800-207A](https://doi.org/10.6028/NIST.SP.800-207A), [SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/), and [SPIFFE federation](https://spiffe.io/docs/latest/spiffe-specs/spiffe_federation/).

### Tool and provider authorization

The MCP authorization specification requires target-resource audience binding and forbids token passthrough because of confused-deputy risk. Ashlr MCP, Stack, Locus, and Phantom integrations should exchange resource-specific credentials/capabilities, never reuse a Hub UI token or upstream provider token as downstream authority. Source: [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

### Telemetry and privacy

OpenTelemetry's GenAI conventions provide useful names for model, operation, workflow, conversation, and token usage, but explicitly warn that input messages, system instructions, retrieval queries, and output messages may contain sensitive information. Ashlr should standardize low-cardinality operation/resource/usage attributes while keeping raw prompts and tool arguments opt-in and outside default receipts. Source: [OpenTelemetry GenAI semantic attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/).

### Artifact provenance

SLSA provenance uses in-toto attestations to bind artifacts to build definitions and run details, with the builder identity representing the trusted build platform. Ashlr should model mission outputs similarly: subject digest, exact inputs/materials, workload identity, policy generation, runtime, and independent verification predicate. Source: [SLSA provenance specification](https://github.com/slsa-framework/slsa/blob/main/spec/build-provenance.md).

## Local evidence

- Ashlr Plugin currently presents 40 compact MCP tools, Codex/Claude packaging, genome retrieval, hooks, and savings accounting. After removal of a proven test-created delta under compare-and-swap, its local stats ledger reports 959 sessions, 80,174 lifetime calls, and 266,578,850 estimated tokens saved; measured-call fields are absent. A separate isolated, uncommitted V1 receipt producer passes direct Hub acceptance but is not installed or published.
- `@ashlr/core-efficiency` exports compression, budget, token, genome, session-log, Anthropic cache, and local-context modules. It is the reusable algorithm layer, not another daemon.
- Ashlr Stack is a provider/service control plane with CLI, MCP, plugin, and core packages plus a split public/local stack configuration and Phantom-backed secret references.
- Every inspected checkout contains active uncommitted work. Cross-repo changes must use isolated branches/worktrees and cannot treat current dirty state as disposable.

## Gap matrix

| Claim or decision | Evidence state | Confidence | Remaining gap | Next action |
| --- | --- | --- | --- | --- |
| Hub should remain sole scheduler | Existing Hub runtime and product doctrine | High | Cross-repo contract versions not defined | Specify protocol schemas |
| Plugin can supply efficiency evidence | Local stats and session accounting exist | High | No independent signed receipt or measured-quality join | Define efficiency receipt V1 |
| Core Efficiency should be shared library | Package exports and algorithms exist | High | Version compatibility and browser/runtime boundaries | Define supported API surface |
| Stack can supply topology/health | Provider catalog and doctor/scan surfaces exist | Medium-high | No signed read-only snapshot contract | Define stack observation receipt V1 |
| Phantom should broker capability refs | Existing ecosystem role and Stack references | Medium | Exact current Phantom API needs dedicated audit | Map Phantom contracts next |
| SPIFFE should influence identity model | NIST and SPIFFE primary sources | High | Desktop-first implementation may not need full SPIRE | Adopt compatible identity semantics before infrastructure |
| OpenTelemetry should shape metrics | Official GenAI conventions | High | GenAI conventions remain partly developmental | Version and isolate the compatibility adapter |
| Signed receipts imply outcome truth | Disconfirmed by trust analysis | High | Independent observer deployment absent | Keep authenticity, independence, and truth separate |

## Material limitations

- The Sea Strike film is a future-oriented concept narrative, not evidence that any depicted operational technology is deployed or effective. Its use here is limited to control-loop and human-authorization design patterns.
- Plugin lifetime savings are local estimated counters until measured-call provenance and downstream quality outcomes are joined.
- A signed receipt proves origin and integrity under its trust policy; it does not by itself prove the real-world claim, rollback-resistant history, trusted time, or operator independence.
- Current source and test completion does not establish installed, scheduled, authenticated, or live runtime behavior.

## Research stopping rule

This research phase stops when each product has an exact versioned contract, consequential security decisions have primary support, the first cross-repo slice has executable acceptance tests, and additional sources are unlikely to change the architecture. It does not stop at a strategy document alone.

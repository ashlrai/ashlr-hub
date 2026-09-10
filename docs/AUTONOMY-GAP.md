# Autonomous firm: implementation and activation gaps

This is the implementation map for the September 10, 2026 firm build, based on
`5c270bc73890e474463c31764d51e76196ad2e3f` and the local `auto/p00` package branch.
It is not a commissioning certificate. No production authorization, account
connection or running resident process was established by this source audit.

The executable package plan lives in
[`artifacts/control-graph.json`](../artifacts/control-graph.json). Planned `requires`
are not execution edges. A runtime edge exists only after its source artifact
digest is committed into a dispatch intent. Package reports and unsigned trace
stubs are review aids, not signed runtime evidence.

## Classification

- **EXISTS-LIVE** requires current end-to-end operational evidence. No item below
  receives this classification merely because source or a CLI exists.
- **UNWIRED** means some tested implementation exists but the complete firm path
  is not connected or commissioned. Existing command callers are noted explicitly.
- **MISSING** means the required behavior is not implemented in the reviewed path.

## Function map

| North-star function | State | Existing machinery and remaining gap |
| --- | --- | --- |
| Purpose and living end state | UNWIRED | `value-allocation.ts` now binds mission/spec evidence to the existing pure portfolio scorer; `value-allocation-store.ts` persists signed ID-bound receipts. A dispatcher consuming those receipts and leasing capacity is still missing. |
| Competing plans and artifact graph | UNWIRED | New `src/core/universe/control-graph.ts` persists signed intent/settlement and artifact dependencies. Trusted callbacks are not a model execution backend. |
| Worker identity, quotas and reserves | UNWIRED | `src/core/resources/pool-runtime.ts` and `native-profile.ts` already implement explicit bindings, admission and profile isolation. Actual account commissioning remains unverified here. |
| Codex, Claude and local execution | UNWIRED | Existing resource generation calls the pool. Preserve personal-worker exclusion and configured reserve ceilings; do not interpret worker usage as account-wide spend. |
| Grok execution | MISSING | Account connection/display is distinct from the core pool provider enum, which supports Codex, Claude and local workers. |
| Learned routing | UNWIRED | `src/core/run/router.ts` and daemon already call learned routing. New accepted-work receipts still need an evidence-backed feedback connection. |
| Best-of-N worktree execution | UNWIRED | `src/cli/swarm.ts` dispatches existing swarms. The new firm graph does not yet dispatch these swarms or isolate their sessions. |
| Cold rival verification | UNWIRED | `cold-verifier.ts` binds a minimal request to distinct enrolled execution IDs and a nonce. Physical isolation and evaluator quality belong to the transport; identity strings alone do not prove either. |
| Signed decisions and conflicts | UNWIRED | `decision-trace.ts` signs with existing read-only provenance and preserves conflicts. The graph uses it; sandboxed engine, daemon and all other effects are not yet joined. |
| Agent-first queries and MCP | UNWIRED | Pure trace queries and existing Universe graph queries exist. A signed-graph MCP resource is not wired in this wave. |
| Integration and handoff | UNWIRED | Existing integration/evaluation/delivery/handoff commands are functional local primitives. New integrate/deliver graph kinds remain withheld until these gates are explicitly connected. |
| Automatic branch advancement | MISSING | Existing delivery creates a new branch. Expected-old-commit CAS advancement must preserve unexpected human commits and exact evaluation evidence. |
| Restart recovery | UNWIRED | Existing portfolio controller reconciles proven dispatch completion. New graph keeps unresolved intents held; it does not silently replay interrupted workers. |
| Resident company ticks | MISSING | Active-goal `runConductor()` is one bounded pass. No resident caller of the Universe portfolio controller was found. A watch flag does not close this gap. |
| Enrollment of the ecosystem | UNWIRED | Existing enrollment machinery must be reused. Thirteen trusted product roots were not independently enumerated or enrolled in this run. |
| Daily and consolidated memory | UNWIRED | `firm-memory.ts` stores immutable daily entries and CAS-linked master versions under an explicit private root. It does not modify real user memory or provide the full Markdown/wiki/genome projection yet. |
| Harness archive and frozen evaluation | UNWIRED | `harness-archive.ts` stores baseline/evaluator bytes and successes/failures with strict mutable-path admission. No proposer or promotion effect is connected; supplied verifier linkage is not authenticated outcome evidence. |
| Harness evolution and Red Queen | MISSING | Separate proposer, matched evaluation, memory-program evolution and evaluator-copy populations remain required. Candidates cannot change their selecting evaluator. |
| New product universes and mass sensor | MISSING | Existing invention/experiment primitives are not a complete brand→repo→preview→real sister-product acceptance loop. |
| Payment broker | UNWIRED | `payment-broker.ts` is a pure capped simulation with carried holds. No rail, keys, transfers or AP2/x402 compatibility is claimed. Durable authenticated serialization remains the caller's responsibility. |
| Exception-only inbox | UNWIRED | Existing daemon opt-in auto-merge pass already uses inbox authority. Reuse it; do not create a parallel ungated drainer. |
| Global stop | UNWIRED | Existing sandbox KILL policy is authoritative. New graph checks it plus a restrictive root-local sentinel. Resource workers now use the same shared policy before transport and during active cancellation; broader pre-intent controller integration still needs wiring. Native Windows dispatch is explicitly unavailable until owned cancellation is supported; local HTTP still works. |
| Operator interface | UNWIRED | Reuse `UniverseControllerInspector` and existing console. Historical intents, live ownership and acknowledged controls must remain distinct. No new visual console was implemented in this wave. |
| Activation | UNWIRED | Existing daemon/conductor compiled roots remain empty, and broader conductor activation returns false. Runtime source completeness is not permission to bypass that door. |

## Next executable milestones

1. Exercise the signed graph demo, its lying-builder rejection and conflict query.
2. Connect allocation receipts to existing resource reservations and owned worker
   transports; verify current account exclusions without reading keys into prompts.
3. Wire existing integration/evaluation/delivery APIs into graph nodes, then add
   independently tested expected-old-commit branch advancement.
4. Add durable tick production, overlap suppression and exact attempt receipts
   behind the existing activation consumer. Test real process death and restart.
5. Commission one Hub feature end to end: idea, competing plans, confined change,
   independent checks, integrated artifact and measured accepted-work yield.
6. Expand to a sister product only after the Hub loop has acceptance evidence.

## Evidence and limitations

The detailed baseline call-site audit is
[`artifacts/firm-gap-inventory.json`](../artifacts/firm-gap-inventory.json).
That inventory deliberately records its earlier package-worktree revision;
new package results are tracked separately rather than retroactively described as
baseline behavior. Tests must run locally: GitHub Actions remain unused.

An HMAC proves integrity under the existing host-local provenance key, not
separation from a same-user process that can read that key, external truth,
effect authority or anti-rollback storage. A cooperative handler must return
after cancellation; the graph does not claim JavaScript can terminate an
uncooperative callback. Unavailable evidence remains unavailable.

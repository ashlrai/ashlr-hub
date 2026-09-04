# Task Plan: Agent OS Authenticated Runtime Read Path

## Goal

Turn the verified Tier 0–1 Agent OS source primitives into a truthful internal runtime read path: authenticated append-only snapshots, local replay/fork detection, a read-only authenticated API and mounted cockpit, plus an inert standing-permit contract for later bounded execution.

This tranche is an observation path. It does not create a production source, schedule an observer, grant a standing permission, execute an effect, or claim historical rollback protection.

## Phases

- [x] Phase 1: Restore branch, Entire, memory, skills, and prior implementation context
- [x] Phase 2: Map existing receipt stores, authentication roots, API composition, UI routing, daemon scheduling, and policy/effect seams
- [x] Phase 3: Implement authenticated append-only snapshot storage and local replay/fork canaries
- [x] Phase 4: Implement a pure standing-permit evaluation contract with every authority and effect bit disabled
- [x] Phase 5: Compose the read-only runtime projection, authenticated API, typed query, and cockpit route without fabricated data
- [x] Phase 6: Add focused adversarial coverage for authentication, privacy, lineage, crash consistency, and UI withholding
- [x] Phase 7: Parent integration owner reports the final focused, adjacent, web, typecheck, lint, build, and security gates
- [x] Phase 8: Record achieved architecture and the exact production-source, daemon, authority, rollback, and activation boundaries

Phase 7 was completed against the reconciled post-red-team tree. Exact evidence is recorded below and in `.security/audit-2026-09-03-agent-os-runtime-read-path.md`.

## Architecture decisions

- Preserve Hub's established non-Eve scheduler and runtime.
- Reuse `ImmutablePrivateRecordStore`, the existing foundry provenance HMAC key, private atomic writes, and local-store locking. Do not create another credential or trust-root system.
- Accept the complete `AgentOsReadModelInputV1` at the internal append boundary and rebuild it with `buildAgentOsReadModelV1` plus an explicit external verifier; do not persist an arbitrary caller-declared snapshot and digest as trusted.
- Persist strict sequence, predecessor, source-binding, payload, envelope, and authenticated tip evidence. Withhold the current snapshot unless the complete visible chain and tip are coherent.
- Publish `sameUserTamperResistant:false`, `rollbackProtected:false`, and `historicalAuthority:false`. The local authenticated chain detects visible inconsistency but cannot prove that the whole store was not replaced with an older valid copy.
- Keep `GET /api/agent-os` independent from `buildControlSnapshot`. `server.ts` supplies the existing authenticated read boundary; there is no write endpoint or route-local mutation authority.
- Expose only the verified read-model payload and bounded source-quality metadata. Private envelopes, HMACs, key IDs, digests, sequence numbers, and filesystem paths do not cross the web boundary.
- Keep the standing-permit implementation a pure shadow evaluator. A criteria-satisfied verdict is not a grant, activation, execution, merge, release, deployment, budget, rollback, or external-mutation capability.
- Leave the producer unscheduled because no production registry and verifier adapter currently supplies the exact authenticated mission, capability, portfolio, hypothesis, outcome, and evidence-index inputs. Public prose is a closed deterministic projection, not caller-supplied display metadata.

## Completed source boundaries

- `src/core/vision/agent-os-snapshot-store.ts` — private authenticated append/read/recovery path with strict local lineage and a signed current-tip checkpoint.
- `src/core/vision/agent-os-runtime-read.ts` — narrow fail-closed public projection using read-only default dependencies.
- `src/core/web/api.ts` — authenticated `GET /api/agent-os`, always returning an epistemic state envelope and never exposing a mutation route.
- `src/core/autonomy/standing-permit-shadow.ts` — deterministic policy canaries with all authority and effects fixed false.
- `src/web-ui/data/api-types.ts`, `queries.ts`, and `sse.ts` — backend-owned response type, authenticated query, and existing snapshot-event invalidation.
- `src/web-ui/routes/agent-os/`, `app/routes.tsx`, and `app/nav-config.ts` — mounted cockpit route that renders only a healthy, complete, authenticated, observation-only response with every unsupported authority claim false.
- `test/m532.standing-permit-shadow.test.ts`, `test/m533.agent-os-snapshot-store.test.ts`, `test/m534.agent-os-runtime-read-api.test.ts`, and the Agent OS web tests — focused policy, storage, API/auth, privacy, and UI-withholding coverage.

## Remaining production work

1. Add durable production registries and independent verifier adapters for the exact mission, capability, portfolio, hypothesis, outcome, and evidence-index inputs.
2. Add a bounded producer only after those sources exist. Schedule it after durable daemon ticks with overlap suppression, kill-state checks, deadlines, cancellation on ownership loss, allowlisted environment, and attempt receipts.
3. Define an explicit bridge from standing-permit eligibility into the existing activation-permit and effect-journal machinery. Recheck current authority immediately before each effect; do not introduce a parallel grant system.
4. Add an external transparency service, hardware-backed monotonic counter, or equivalent independent anchor before claiming historical rollback resistance.
5. Add effectiveness observation windows and outcome-backed portfolio reallocation.
6. Verify exact source SHA, built artifact, installed artifact, daemon/service state, and live authority independently before any activation claim.

## Errors and reconciliations

- `entire resume codex/v333-iteration` found no checkpoint; context was restored from Git, workplans, memory, and current source.
- The snapshot store's explicit `sameUserTamperResistant:false` field initially revealed a frontend fixture/type drift. The backend public contract and frontend consumer now require the literal false claim; final combined verification remains Phase 7 work.
- The original phrase “rollback/fork-resistant lineage” was too broad for a same-user local store. The implemented claim is local visible-chain replay/fork/inconsistency detection with rollback and historical authority explicitly false.
- Independent red-teaming found caller-asserted `preverified-*` markers, arbitrary public display prose, an unverified standing-permit evidence bundle, and incomplete signed-tip temp recovery. The final source requires external verifier dependencies, closed deterministic display templates, an independently verified standing-permit anchor, and strict fixed-path crash-residue recovery.

## Final verification

- New/adjacent backend M526-M534: 9 files, 99 passed, 1 platform-specific skip, 0 failed.
- Full web suite: 29 files, 107 passed, 0 failed.
- Full core and web TypeScript: passed.
- Focused changed-file ESLint: 0 errors; one pre-existing unrelated unused-variable warning.
- Focused Semgrep over the Agent OS tranche: 0 findings, 0 errors.
- `npm audit`: 0 vulnerabilities across 434 dependencies after compatible `fast-uri` and `qs` override updates.
- Production build: passed; 183 web modules transformed.
- Tracked `git diff --check`: passed. Current-tranche untracked files also pass; older untracked 2026-09-02 workplan files retain pre-existing Markdown hard-break whitespace.
- The monolithic backend suite was not run.

## Status

**Source implementation, red-team hardening, documentation, and scoped integration verification complete.**

There is no live producer, daemon observer, provider dispatch, model call, grant, effect, merge, release, deployment, publication, external communication, destructive mutation, or installed-runtime activation in this tranche. Until production sources and a producer exist, the truthful runtime state is missing or degraded.

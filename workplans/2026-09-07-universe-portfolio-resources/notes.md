# Findings

Prior PR371 connects explicit resource workers to individual Universe campaigns.
Actual local acceptance retained a 57/57 candidate and rejected a 55/57 regression.
Portfolio forwarding and continued fresh observations remain known gaps. This
increment will inspect the existing coordinator before choosing an integration.

## Verified integration seam

portfolio.ts calls runUniverseCampaign with root, signal and exact admitted
summary identity but currently drops resourceRuntime. Capture that primitive
once and forward it only on execution calls; read-only plan/observations and
portable results stay unchanged. Campaigns still validate pinned pool+bindings
and read fresh explicit observations per handoff. No automatic discovery.

Dependencies require campaign completion for ordering, not evaluator acceptance
or artifact transfer. Shared-ledger caps remain account/worker-wide across
campaigns. Missing runtime, pool mismatch, quota denial, and occupied capacity
pause resource campaigns and block descendants for the current invocation.
Mixed command/direct-local campaigns ignore the optional resource binding.

## Documentation and verification skills

Engineering documentation guides precise option examples and status boundaries.
Ashlr change-verification guides focused tests, typecheck/lint, and exact source
and installed handoff records. Existing runtime is retained per build-agents'
established-stack exception; no framework or model-provider migration.

## Independent review

The core locator snapshot is isolated from read-only store options and cannot be
redirected by later mutation of the caller's options object. It does not freeze
private runtime file contents. Existing summary identity checks and owner controls
remain intact. The CLI does not open private bindings and omits the option when
absent. Agent-facing help and the existing verified-runtime launcher expose and
forward the new option without changing their safety/JSON contracts.

The shared-slot contention test uses a test-owned release gate, avoiding timing
assumptions about other work on the machine. The cancellation test preserves
explicit uncertain settlement and occupied capacity; observing the fixture leader
exit does not prove every possible process-group member has terminated.

## Installed acceptance plan

An independent harness uses the clean offline package, an inert loopback response
server, two dependent Universes, one shared resource ledger, and frozen evaluators.
It checks planning has no effects, plan rejects private runtime arguments, CLI
execution yields two independently evaluated artifacts, and a terminal rerun makes
no new requests. This tests executable plumbing, not model intelligence or account
commissioning. Fixture server and child execution have bounded cleanup handling.

Evidence directory: `/Users/masonwyatt/.codex/artifacts/ashlr-portfolio-resources.aVrhwO`.
Provider configuration, credentials, persistent services, and original user
checkout are excluded from all acceptance operations.

# Task Plan: Autonomous Production Integration

## Goal

Integrate the reviewed Ashlr autonomy stack into protected `master`, publish/install only artifacts proven from that exact protected source, and activate only the maximum autonomous authority supported by complete security, release, rollback, and live-runtime evidence.

## Phases

- [x] Phase 1: Create an isolated integration worktree from exact `origin/master` and deploy parallel integration, security, and release audits.
- [x] Phase 2: Restore the known M380 protected-master clock fixture and build an exact dependency/conflict graph for reviewed autonomy candidates.
- [x] Phase 3: Integrate the smallest coherent source stack with fail-closed effects and observation-only shadow evaluation.
- [ ] Phase 4: Run focused, adjacent, full local, security, and independent-review gates. Focused/type/build/lint/security review and serial full invariants are complete; exact-head hosted checks remain.
- [ ] Phase 5: Push, open/update PRs, satisfy protected checks, and merge through the repository's required process.
- [ ] Phase 6: Build/publish/install the exact protected artifact and prove rollback before resident activation.
- [ ] Phase 7: Activate the maximum safe runtime mode, verify live outcomes, and produce a production evidence report.

## Key Questions

1. Which reviewed candidates remain valid on current protected master, and in what order can they compose without authority gaps?
2. Which protected checks are real product failures versus bounded CI fixture/load failures?
3. What autonomous authority is safe today: read-only, planning-only, proposal-only, PR-opening, merge, release, or deploy?
4. Are package publication, installed identity, resident launch, rollback, credentials, model digest, spend reservation, and confinement independently proven?

## Decisions Made

- Scope is the reviewed autonomy program, not indiscriminate merging of unrelated drafts.
- The dirty/divergent primary checkout is preserved. All integration work occurs in this clean worktree.
- Protected master, source integration, npm publication, installation, resident service, model execution, provider spend, merge authority, and deployment are separate evidence gates.
- No runtime or provider activation will be inferred from source tests.

## Errors Encountered

- `entire resume codex/autonomous-production-integration-v1` was invoked from the primary worktree after creating the new worktree; Entire refused because the branch was already checked out elsewhere. No files changed. Entire status will be checked from this integration worktree instead.
- The first local M380 test attempt could not resolve `vitest` because the new worktree has no installed dependency closure. The reviewed commit cherry-picked cleanly; dependency installation and all tests are deferred until the candidate stack is composed to avoid repeated installs.
- A read-only inventory loop used `path` as a zsh variable, which replaced zsh's special command-search array and made `git`, `sort`, and `comm` temporarily unavailable inside that shell only. It made no changes; the inventory was rerun with a non-reserved variable name.
- Running build, full quiet lint, and invariant tests concurrently caused two H1 daemon-gate timeouts and the build's release-dependency inventory rejected the symlinked shared `node_modules` closure. The same dependency version was installed locally with `npm ci --ignore-scripts` (0 vulnerabilities); the affected gates are being rerun serially so resource contention and symlink packaging cannot masquerade as product evidence.
- The first broad invariant run was stopped after H1 and H4 timing failures while the H7 repeat specialist was simultaneously exercising process-heavy Git worktree fixtures. These are not claimed green; exact affected tests and the full invariant gate must be rerun serially on the installed dependency closure.
- The affected process-heavy invariant files passed 76/76 with one worker and the full invariant gate then passed 449 tests with 5 expected skips. The full M201 daemon-loop suite separately passed 245/245.

## Status

**Phase 4 in progress** — the integration candidate is composed and independently reviewed. The maximum safe publication is a draft proposal-lab PR. The serial invariant run is complete; protected merge, package publication, installation, and resident activation remain blocked on exact-head hosted checks and an externally authenticated human-effect capability.

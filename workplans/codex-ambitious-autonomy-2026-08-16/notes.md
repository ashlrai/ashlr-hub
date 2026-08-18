# Notes: Ambitious Ashlr Hub Autonomy Expansion

## Current State

- Claude's primary checkout is on `codex/locus-firm-fleet-docs`, 71 commits behind current protected master, with many modified and untracked files. It is out of scope for mutation.
- Codex isolated worktree: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub-autonomy-expansion-v1`.
- Codex branch: `codex/autonomy-expansion-v1`.
- Exact baseline: protected master `80d49d718d893d0cb02f85a62cd9d2691f4f39c3` (`v3.2.6`).
- Entire has no checkpoint for the new branch.
- Many historical autonomy worktrees exist; their names are overlap signals, not trusted current implementation baselines.

## Findings

- Architecture, operator-product, and fail-closed safety audits are running independently.
- Memory guidance says to avoid duplicating Mission Compiler, Operator Briefing, spend durability, and readiness surfaces already covered by prior Fleet OS work; prefer useful verified outcomes over telemetry fan-out.
- A live read-only `ashlr fleet status --json` probe found the installed runtime inactive and fail-closed: daemon state is degraded, activation lacks trusted roots, queued autonomy has no actionable items, and the status command correctly withholds resident authority.
- The source tree already implements mission briefing, next-action synthesis, stale-lane recovery, goal-loop dispatch, proposal-only self-healing, and metadata-only self-improvement. A new slice must complement these rather than rename or duplicate them.
- The active local runtime remains separate from the source candidate. This task may improve source behavior and open a reviewable PR, but it will not install, activate, restart, or grant new production authority without a separate explicit gate.
- Safety audit: configured backend quotas are currently advisory at the provider-effect boundary. Corrupt/unreadable quota state becomes zero usage, persistence failures are swallowed, and daemon/Best-of-N provider calls proceed without durable reservation.
- Operator audit: the TUI still begins with telemetry even though FleetStatus already carries the browser's exception-first operator briefing. This is a strong separate product slice that can avoid Claude-owned files.
- Architecture audit: live goal-conductor activation is deliberately hard-disabled and trust roots are empty. A bounded signed one-shot goal permit is feasible, but it is a separate authority-bearing project and should follow durable quota enforcement.

## Selected Slice

- Add a locked, atomic, fsynced, idempotent quota reservation primitive.
- Configured limits must refuse provider contact when durable quota authority is exhausted or unavailable.
- Preserve unlimited behavior for backends without configured limits.
- Count actual Best-of-N candidate engines at their individual effect boundaries.
- Prefer conservative overcount after a crash to an untracked provider call.

## Implemented Contract

- Preserve `quota.json` as backwards-compatible best-effort actual-attempt telemetry.
- Add a separate exact-private `quota-reservations.json` authority ledger so normal legacy `0644` telemetry cannot block or overwrite launch authority.
- Reserve configured direct and Best-of-N provider work durably, with one atomic all-or-none candidate batch bound to actual child backends and stable child attempt identities.
- Unknown windows, invalid caps, corrupt authority state, exhaustion, identity conflict, lock failure, and bounded-capacity failure never authorize provider contact.
- Bootstrap from owned, strict-valid legacy telemetry so upgrades cannot forget active-window usage; corrupt, writable, or symlinked migration state refuses launch.
- Retain the newest 2,000 events per known backend for the maximum supported 30-day window, then apply the live configured window only when counting. This preserves dynamic limit enablement/widening without creating a fleet-wide capacity fuse.
- Fence shadow inventory calls, every candidate runner, and post-inference shadow verification against live daemon ownership/cancellation.
- Record actual-attempt telemetry only at the final candidate/direct handoff; zero-runner fan-outs remain `dispatched:false` and do not create worked/production evidence.
- Project corrupt/invalid/capacity authority as quota `over` in FleetStatus and Mission Control rather than claiming healthy availability; keep actual-attempt telemetry separately visible.
- Use reservation standing for advisory routing only when authority health is known-good. Ambiguous authority continues to the final effect gate for a structured refusal instead of silently downgrading to builtin.

## Verification

- `m46` quota authority: 43/43 pass, including legacy migration, config transitions, unsafe storage, and the exact 22,000-row bound.
- Cross-surface suite (`m46`, `m113`, `m142`, `m200`, `m49`, `m61`): 356/356 pass.
- Best-of-N/daemon/status focused suite (`m46`, `m49`, `m61`, `m333`, `m170`): 324/324 pass before the final 22k regression; the final changed quota suite was rerun separately green.
- Full `m201` daemon loop: 247/247 pass, including zero-runner and invalid-candidate non-dispatch behavior.
- Typecheck, quiet lint, build, and `git diff --check` pass on the final source bytes.
- Independent architecture, operator-product, and fail-closed safety reviewers report no P0/P1 blockers for the bounded daemon quota-authority slice.
- Residuals are explicit: pre-effect reservations conservatively consume capacity after later failure; mixed-version legacy writers rely on daemon singleton ownership; public/CLI `runBestOfN` remains outside this daemon-only authority slice.

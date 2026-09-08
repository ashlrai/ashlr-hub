# Universe operational readiness

## Goal

Close a verified gap between packaged Universe functionality and useful unattended
operation, with clear evidence of configured, ready and actually running states.

## Phases

- [x] Explore execution, restart, commissioning and user-facing gaps in parallel.
- [x] Select the highest-value vertical slice and ask about live workload direction.
- [x] Implement reusable runtime and interface behavior with focused tests.
- [ ] Independently verify end-to-end behavior and record exact release status.

## Constraints

Preserve original Desktop checkout. No GitHub Actions. Do not inspect global
configuration/credentials or reset prior one-use calibration claims. Reuse existing
runtime and confinement; separate package validation from real fleet activation.
Live execution needs an explicit workload, source, evaluator and resource budget.

## Status

Implement two prerequisites for unattended campaigns: read-only machine-readable
campaign recovery checks and opt-in pinned local model inventory refresh before
resource generation. Agents own readiness core/tests, CLI/tests, and local refresh
core/tests. Main owns integration, shared budget policy, docs and acceptance.
No resident supervisor is installed or claimed by this increment.
Started clean branch codex/universe-operational-readiness from PR374 master.
Entire resume found no checkpoint. Strategic question asks whether to prioritize
useful Hub campaigns or restart supervision; current default is useful campaigns.

## Errors

- An in-flight typecheck briefly observed readiness imports before the agent's new
  module existed; the completed tree passes core and web typecheck.
- Initial integration assertions matched a shared fixture parent path and the
  `resourceRuntimeRequired` metadata prefix too broadly. Narrowed assertions to
  exact private fields/paths; no production privacy behavior was weakened.
- A static check import broke an existing minimal filesystem mock. The CLI now
  lazily imports the check implementation only for that command.
- Three readiness tests tried spying on a non-configurable native ESM export.
  Replaced the test spy with the existing execution-admission seam; all 63 pass.

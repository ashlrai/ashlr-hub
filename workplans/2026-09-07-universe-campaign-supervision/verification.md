# Verification

## Source evidence

- New supervisor unit tests: 56/56.
- New CLI plus existing campaign CLI: 92/92.
- Supervisor/CLI/real integration combined: 104/104 (including 11 confined
  execution tests, actual worker PID cleanup, queued and last-moment controls).
- Prerequisite control/expectation/readiness/review tests: 126/126. Additional
  matching-record recovery assertion passed a targeted rerun.
- Core/web typecheck, full lint and final changed-file lint pass. Lint retains
  105 existing warnings and zero errors. Lane guard: 187 real-IO / 633 unit files.
- Documentation check passes: eight entrypoints, 70 local and 28 source links,
  zero errors or network requests.
- Independent source review found no implementation blockers. Misleading callback
  test corrected with active-drain coverage. Broader regression is running.

## Exact release evidence

Artifact directory: `/Users/masonwyatt/.codex/artifacts/ashlr-supervision.tac1Cu`.
Prepare and review a one-use installed CLI test after a clean source build. It
must use only fixed command/evaluator fixtures, verify parallel two-generation
campaigns and terminal rerun nonmutation, and keep installed/source bytes unchanged.
Do not rerun or remove an acceptance claim. Final exact archive/source/merge
evidence goes in external RELEASE.md to preserve clean accepted source identity.

No actual model inference, resident installation, account changes or provider
activation is part of fixture acceptance. Original Desktop checkout remains
untouched. Entire resume found no checkpoint on the new branch.

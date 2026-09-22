# Hub Worktree Cleanup Recovery

Cleanup date: 2026-09-02  
Canonical checkout retained: `/Users/masonwyatt/Desktop/github/dev-tools/ashlr-hub`

## What happened

- 235 clean linked worktrees were removed with `git worktree remove`.
- 22 dirty noncanonical worktrees were captured and then removed with `git worktree remove --force`.
- Dirty-tree recovery artifacts live under `/Users/masonwyatt/.ashlr/recovery/ashlr-hub-worktrees-20260902/`.
- Two independent clones were moved intact to `/Users/masonwyatt/.ashlr/recovery/ashlr-hub-standalone-clones-20260902/`.
- No branch was deleted. Dirty and detached heads received refs under `refs/archive/worktrees/`.

## Evidence

- `cleanup-clean-manifest.json` records every clean-tree disposition.
- `cleanup-dirty-manifest.json` records every dirty-tree head, branch, archive ref, patch/archive receipt, byte count, and SHA-256.
- The cleanup completed with zero removal failures.
- All 48 dirty recovery-file receipts were re-read and matched their recorded sizes and SHA-256 values.

## Restore a dirty worktree

1. Read the matching entry in `cleanup-dirty-manifest.json`.
2. Create a new worktree from its `archiveRef` or branch.
3. Apply `tracked.patch` with `git apply --index` after inspecting it.
4. Extract `untracked.tar.gz` from inside the new worktree after inspecting its file list.
5. Re-run the relevant focused tests before treating the recovered state as usable.

Do not apply every archive in bulk. Several archived trees represent competing or superseded approaches and require reconciliation against the current canonical source.

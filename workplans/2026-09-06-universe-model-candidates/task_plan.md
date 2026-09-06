# Universe model-driven candidates

## Goal

Advance the merged experiment kernel toward model-authored, independently tested
improvements, measured against the operator-selected objective of verified
engineering yield. Reuse Hub's established runtime and preserve local-only
verification without GitHub Actions.

## Phases

- [x] Verify source/worktree ownership and resume Entire context.
- [x] Explore existing model adapters, usage evidence, runner contracts, and UX.
- [x] Select and document one complete integration slice and its acceptance tests.
- [x] Implement collision-free runtime, CLI/console, and accounting changes.
- [ ] Independently test real behavior, failure paths, build/package compatibility,
  then integrate via normal GitHub PR and report exact limits.

## Decisions

- Preserve the primary checkout and continue in the clean Universe worktree.
- Starting point: merged PRs #352/#353, master
  `c3741b6979925c11d35f288841af48e8ba95bab0`.
- Existing Hub stack remains the implementation foundation; no new framework.
- Do not infer measured tokens, accepted product changes, provider activation,
  or publication from a successful synthetic experiment.

## Unknowns

- Local numeric-loopback OpenAI-compatible transport supports bounded prompt-only
  generation. Subscription CLIs require separate tool/account integration.
- Only complete transport-reported usage counts; no estimated billing. Failed
  generations retain observed usage; replay recomputes aggregate coverage.
- An installed Ollama model can provide a real bounded generation after fixture
  verification. A small project-derived seed remains to be selected.

## Errors / setup notes

- No repository AGENTS.md was found by the targeted file search; user-supplied
  project instructions govern this task.
- Entire resume found no checkpoint on the new branch.

## Status

Runtime, UI, durable accounting, and independent fixture tests are implemented.
Three real local model trials all failed the unchanged 5,236-check evaluator;
none was admitted. A separately authored Hub date fix passed all 5,236 checks and
51 independent regression tests, without claiming a successful local-model artifact.
Final source integration and exact artifact/preview verification remain.

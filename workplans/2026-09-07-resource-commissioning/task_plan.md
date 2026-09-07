# Task plan: Resource commissioning and sustained evidence

## Goal

Make the existing multi-subscription resource pool more operational through
supported account/launcher commissioning and fresh quota evidence, without
confusing configured accounts with verified identity or stale limits with capacity.

## Phases

- [x] Explore launcher, quota, console and durable-store patterns in parallel.
- [x] Confirm supported native protocols and choose a bounded integrated design.
- [x] Implement independent transport, integration and acceptance lanes.
- [ ] Verify focused/adjacent tests, UI if changed and installed artifact locally.
- [ ] Push reviewed source and retain exact release/commissioning evidence.

## Constraints and decisions

- Start from PR #366 merge `a8803142cf4cd21dba24673b33ca74c50ee16bd8` on
  `codex/resource-commissioning` in the existing clean integration worktree.
- Preserve the original Desktop checkout and its untracked plans.
- No GitHub Actions, model downloads, credential extraction/account switching,
  paid API fallback, reset redemption or resident service installation.
- Prefer documented native metadata reads; no prompts to manufacture quota data.
- Continue to optimize verified engineering yield, not raw completion counts.
- Keep the established non-eve runtime, following the agent-building skill's
  existing-stack exception. Reuse its process ownership and private storage.
- Build a fixed Codex metadata probe helper beneath the existing owned subprocess
  runner. No new general interactive execution hook; no thread/turn creation.
- Add an explicitly configured console-owned collector. Base evidence for
  unmanaged Claude/local workers remains unchanged. Managed failed/expired reads
  become unavailable even when the worker permits unknown quota.
- Pin exact pool/bindings and expected reported account hint, with reads before
  and after quota collection. The hint is not stable workspace identity or proof
  of independent subscription capacity. Never infer separate capacity keys.

## Questions

1. What native account identity is actually available without credential reads?
2. Which complete quota scopes can refresh safely, and how do aliases agree?
3. What lifecycle/lock paths should own bounded refresh and shutdown?

## Errors

- Broad memory keyword output was truncated; reuse only the relevant scoped
  runtime/release entries and current repository evidence.
- Entire resume found no checkpoint for this new branch.
- Incorrect guessed stylesheet/test paths were resolved with `rg --files`.
- The first broad run had one old help-text expectation; updated for `probe`.
- Two newly added ledger-preflight test fixtures used an incorrect basename;
  corrected to the existing `pool-state.json` contract and reran successfully.

## Status

Implementation and source verification complete: 1,077 selected backend tests
passed (one Windows-only test skipped), 323 web tests passed. Typecheck, full lint
(105 existing warnings, zero errors), build and diff checks passed. One actual
default Codex launcher metadata probe succeeded with no generation. Preparing
the immutable installed artifact and browser acceptance; no fleet activated.

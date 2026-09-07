# Resource intelligence, subscriptions and evidence

## Goal

Extend the operating desk toward useful multi-subscription/local-model engineering
with measured performance, explicit provider capability evidence and actionable
observability. Preserve account isolation, existing quota semantics and scoped
execution. Do not confuse subscription access with API credit or synthetic tests
with measured model quality.

## Phases

- [x] Explore existing resource/benchmark/telemetry patterns and current integrations.
- [x] Verify vendor protocols, desktop-control options and a local-model baseline.
- [x] Choose and implement one integrated, testable capability set in parallel.
- [ ] Verify focused/adjacent tests, UI where changed and exact local artifacts.
- [ ] Deliver verified source and explicit remaining commissioning gaps.

## Scope and assumptions

- User prioritizes verified engineering yield and now wants multi-Codex, Claude,
  possible SuperGrok/Grok Build/Grok Bot, desktop control and one local baseline.
- Use official vendor/model sources for changing product capabilities; retain
  unknown support as unknown instead of inventing subscription entitlements.
- Keep GitHub Actions off; do not switch accounts, redeem credits, enable overage,
  scrape credential stores or start recurring services.
- Benchmark local fixtures first; real provider/model execution requires its
  explicit binding and resource selection. Desktop app code is not a third-party
  exploitation workflow and must retain app/task scope and action evidence.
- Preserve Desktop untracked workplans. New integration branch is
  `codex/resource-intelligence` from merged resource-console source.

## Questions to resolve from exploration

1. Which existing receipt/evaluation abstractions provide trustworthy benchmark
   coverage without accepting a model's self-score as measured success?
2. Which subscription/desktop control interfaces are actually documented and
   compatible with isolated native account ownership?
3. Which already installed local model fits this Mac and the relevant benchmark?

## Errors and status

- No Entire checkpoint exists on the new branch.
- A discovery chain ended when no tracked AGENTS.md matched; hardware/tool
  inventory was run separately instead.
- Guessed subprocess/test filenames and an unmatched zsh glob failed; subsequent
  discovery uses imports and `rg --files` instead of assumed milestone filenames.
- Phase 3: implement four disjoint lanes: durable monotonic measurements/report;
  worker usage provenance/provider guide; truthful browser observation receipts;
  fixed read-only review calibration benchmark and measured-performance UI.
- Initial benchmark fixtures lacked required ready-health observations; corrected
  fixture evidence, not admission policy. Parameterized CLI test args were also
  corrected. Independent review fixed mutable benchmark scope across awaits.
- Independent review fixed omitted-history aggregate token inconsistency and
  impossible reserved-task usage in public summaries. Maximum measured-active
  evidence remains below the existing 4 MiB limit.
- Broad local run passed 831 tests with one stale CLI-help assertion; assertion
  updated for the new command and the entire selected set rerun.
- Final selected source gates: 836 backend/adjacent, 269 web and 60 release
  artifact contract tests passed. Full typecheck/scoped lint passed. Browser
  acceptance confirmed desktop/mobile and corrected a narrow worker-name column.
  Exact installed-artifact verification is retained outside the committed source.
- Final independent review found overflowing JSON numbers could match expected
  null values. Added bounded finite-number validation and four regressions;
  the full selected backend set passed again. Preserve earlier artifact evidence
  separately and rebuild the candidate with the correction before release.

## Implementation decisions

- Preserve the established non-eve runtime; no framework migration or scheduler
  rewrite. Existing strict Universe evaluation patterns inform the benchmark,
  but its model-variant comparability contract will not be weakened.
- New receipt execution measurements are optional/versioned: old receipts have
  unknown duration, not wall-clock-derived provider latency. No throughput or
  accepted-work claims from completion counts.
- The first benchmark is a fixed, bounded prompt/output review calibration;
  it never executes generated code or accepts arbitrary test commands. It runs
  through the existing resource ledger, quota admission and cancellation path.
- Local baseline: already installed qwen3-coder:30b Q4_K_M, one concurrent task,
  pinned inventory digest. No downloads or permanent service changes.
- Provider research establishes Grok Build's documented native interface, not a
  verified Hub adapter or the user's account entitlement. Grok Bot remains an
  external product until a supported task-control contract is established.
- UI: extend the existing dispatch desk with a compact worker-performance table,
  left-aligned labels and numeric columns. Reuse its blue/neutral theme tokens,
  typography and responsive layout; no decorative leaderboard or new dashboard
  chrome. Missing samples stay visible beside p50/p95 and token scope.
- Real calibration: Qwen3-Coder30B twice and installed Qwen2.5-Coder32B once,
  each 6 requests (two repetitions of three cases). Each passed only 2/6 cases.
  Preserve all results; do not revise prompts/checks to manufacture improvement.
  Neither model is promoted to acceptance authority or an autonomous default.

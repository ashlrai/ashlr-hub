# Overnight Autonomous Buildout — Quality Review Findings

> Read-only senior-code-review pass over the ~460 commits the fleet shipped across
> the 11 tool repos during the 12h unattended run (2026-06-29, ~02:00–10:00).
> 10 repos reviewed (morphkit excluded — push blocked on a package.json conflict).
> Every commit was build-verified + tests-green + gated when shipped; this pass is
> the **human-equivalent quality signal** on top of that gate. **Honest takeaway: the
> scale is real and most work is solid, but the green-gate let real bugs through —
> several critical/security. Triage these before treating the night as production-final.**

## Verdict by repo

| Repo | Commits | Verdict | Headline |
|------|--------:|---------|----------|
| phantom-secrets | 28 | mostly-solid | Crypto core solid; **critical** TOCTOU vault race + audit data-loss |
| binshield | 61 | mostly-solid | Strong batch; use-after-delete in PyPI wheel path |
| ashlrcode | 44 | **mixed** | **Working tree has no source files**; git hooks disabled; heavy feature duplication |
| stack | 5 | mostly-solid | `compliant[]` never populated; cycle-path + rollback dead-code |
| webfetch | 42 | mostly-solid | auth-free plugins report `complete=false`; confidence-constant mismatch |
| ashlr-core-efficiency | 41 | mostly-solid | process-global session counter; tier-5 dropped from ROI dashboards |
| prompt-trackr | 48 | **mixed** | **3 security bugs**: IDOR + unauth'd endpoint + missing team-auth |
| ashlr-pulse | 47 | mostly-solid | **critical** UUID-crash kills anomaly writes; webhook-secret exposure |
| ashlr-md | 42 | mostly-solid | OT op-log persistence silently broken; inverted memory priority |
| ashlr-workbench | 25 | mostly-solid | EXIT-trap overwrite silences agent cleanup; plaintext key in settings.json |

## CRITICAL (fix before relying on these paths)

1. **phantom-secrets — TOCTOU double-pull race** (`crates/phantom-core/src/teams_vault.rs` ~318/411). `revoke_member`/`rotate_vault` pull twice; the OCC version comes from pull #2 but plaintext from pull #1 → a concurrent push between them is silently overwritten, and a **revoked member's share can be re-included**. Fix: single pull at top, use it for both decrypt + expected_version.
2. **ashlr-pulse — anomaly write crash** (`server/src/lib/fleet-anomaly-correlator.ts:389`). `affectedIds.map(id => id + '::uuid')` builds invalid UUID strings → every `recordDiagnosis` throws → anomaly root-cause feature is fully disabled. Fix: cast the array in SQL (`${ids}::text[]::uuid[]`), not per-element.

## HIGH (real bugs / security — triage soon)

- **prompt-trackr — IDOR** (`api/analytics/peer-percentiles/route.ts`): `userId` from request body, not the auth token → any Pro user reads any user's scores. Assert `userId === user.id`.
- **prompt-trackr — unauthenticated compute endpoint** (`api/analytics/prompt-similarity/route.ts`): no auth at all on a CPU-bound route; body `user_id` injected into logs. Add Bearer auth.
- **prompt-trackr — missing team-membership check** (`api/scoring/profiles/apply-to-team/route.ts`): never verifies caller belongs to `team_id` → any Pro user overwrites another team's default scoring profiles. Query `team_members` for owner/admin.
- **ashlr-pulse — webhook_secret plaintext exposure** (`server/src/lib/webhook-db.ts`): `listOrgsWithWebhook` SELECTs + returns raw HMAC secrets for all orgs. Fetch on-demand per-org at signing time; encrypt at rest.
- **phantom-secrets — audit data-loss** (`audit.rs` `flush_sidecar_queue`): events dropped permanently on POST failure (no re-queue/retry/disk fallback). Compliance trail loses events on any network blip.
- **phantom-secrets — fake-parallel validation** (`validator.rs` `run_validation_pipeline_parallel`): advertises threads but runs synchronously; `_jobs` unused. AI-slop dead code shipping a misleading public API.
- **phantom-secrets — GCP false-positive** (`validator.rs` ~473): treats HTTP 400 as `Valid` → a disabled/deleted GCP key reports Valid forever. Parse the 400 body.
- **binshield — use-after-delete** (`apps/worker/src/package-source.ts` ~288): wheel-only path `rm(tempRoot)` then returns it as `packageRoot` → downstream ENOENT (ghost dir). Don't delete before the caller is done.
- **ashlrcode — working tree has no source files**: tree contains only `node_modules` + a docs dir; all source lives in git objects. Build/test/CI on a fresh checkout would operate on an empty tree — **the night's local "green" may not reflect real source**. Run `git restore .` + re-verify `bun test` before trusting these 44 commits.
- **ashlrcode — git hooks disabled** (`.git/config` `hooksPath` → a non-existent `~/Desktop/ashlrcode/...` path): every hook (incl. Entire session-capture) skipped for all 44 commits. Fix: `git config --local core.hooksPath .git/hooks`.
- **stack — `compliant[]` never populated** (`packages/core/src/provision-schema.ts` ~726): declared, never pushed to → callers enumerating schema-passing providers get an empty array (gate boolean still correct).
- **webfetch — auth-free plugins report incomplete** (`packages/core/src/provider-registry.ts:651`): `required.length > 0 && …` → `complete=false` when no auth needed → callers wrongly block credential-free providers. Use `required.length === 0 || …`.
- **ashlr-md — OT op-log persistence broken** (`src/store/documentStore.ts:379`): never calls `useOtLogStore.append()` → reconnecting agents get an empty log → session-recovery silently does nothing.
- **ashlr-pulse — activeAgents undercount** (`server/src/lib/fleet-oversight.ts:314`): `Math.max` over daily rows instead of distinct-union → peak-day value, not window total; depresses productivity score + can misfire the idle gate (all windows ≥7d).
- **ashlr-workbench — EXIT trap overwrite** (`scripts/start-aider.sh:158-159`, also start-goose/start-ashlrcode): second `trap … EXIT` silently overwrites the lifecycle-cleanup trap → checkpoint_save + signal TERM never run on agent exit.

## MEDIUM / LOW (worth fixing; full detail in the review transcript)

phantom: monthly-rotation 30-day drift; non-atomic `leak-profiles.jsonl` rewrite; `verify_sidecar_event` accepts self-supplied pubkey (integrity ≠ authenticity).
binshield: `scan_submitted` analytics fires on every auth'd request (inflates counts); InstallPackageSource never re-runs with scripts → native prebuilds never acquired; SSRF guard misses `0.x/8` + CGNAT `100.64/10`.
ashlrcode: massive feature duplication (4 overlapping "surgical-tier" features, 2× streaming, 2× multi-provider-fallback) — competing implementations; consolidation pass needed.
stack: cycle-path duplicates start node; provision-timeout rollback guard is dead code (`resolvedExistingResourceId` undefined on fresh provision); Stripe detector uses a pattern string as a scope name.
webfetch: metadata quality scorer uses 0.1 where comment says 0.4 (kills the tiebreaker); attribution validator re-fetches original URL instead of the redirect target.
core-efficiency: process-global tier-5 counter (breaks multi-session isolation); tier-5 dropped from ROI dashboards; UCB NaN edge case; bidirectional substring provider match.
prompt-trackr: unauth'd `compare-dimensions` writes unbounded prompt content to DB (~500MB/day/IP possible).
ashlr-pulse: flat improvement-trend mapped to `warn` (chronic false alerts on steady fleets); zero-mean history → spurious trend flags.
ashlr-md: `memoryBlock()` keeps oldest facts, drops newest (inverted priority); `ct_eq` doc comment claims constant-time it doesn't implement.
ashlr-workbench: plaintext LLM key in mounted `settings.json`; Ollama per-model registration lost in subshell (dead code); `aider-mcp-bridge.sh` uses `set -e` + arrays (violates bash-3.2 discipline).

## Recommendation

- **Critical + security first**: the 2 criticals + the prompt-trackr auth trio + pulse webhook-secret are the must-fix set.
- **ashlrcode needs your eyes**: the empty-working-tree + disabled-hooks combination means its 44 commits should be re-verified from a restored checkout before trusting; the heavy duplication likely wants a consolidation pass, not more features.
- The rest are clean, well-specified fixes a follow-up pass (or the fleet itself, once these patterns become anti-playbooks) can close.

*This is the honest quality picture: a genuinely productive night (real features across 10 products) with a real bug tail that volume-plus-green-gate did not catch. The review pass is now part of the loop.*

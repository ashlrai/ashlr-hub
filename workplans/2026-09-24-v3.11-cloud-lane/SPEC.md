# 3.11 — Cloud lane: Ashlr Verse spends Claude cloud credits, including on itself

Status: contracts frozen on branch `v3110-cloud`. Units build in parallel as Claude Code **cloud sessions**, each on
its own branch, each delivering a draft PR against `v3110-cloud`.

## Why

Mason has $250 of Claude cloud credits. Claude Code cloud sessions (claude.ai/code) keep running on them after the
subscription's weekly window is spent. Verified on 2026-09-24: a session launched while the 7-day limit was rejected
still ran and finished. Verse should launch these sessions on demand, from chat or Command, and on its own for
self-improvement. It tracks what they deliver, keeps spend inside limits Mason sets, and never merges anything
itself.

## Verified mechanics (Claude Code 2.1.280) — read `src/core/cloud/types.ts` header

- **Creating sessions.** Only the interactive CLI can create a session: `claude --cloud "<task>"`. Run under a
  PTY, it prints `Created cloud session: <title>`, `View: https://claude.ai/code/session_<id>?…` and
  `Resume with: claude --teleport session_<id>`, then exits 0. `-p` is refused.
- **Authentication.** Sessions must be launched through the `claude-a` seat's native-profile launcher: the argv
  array in `~/.ashlr/native-profiles/claude-a/command.json`, which is claude.ai-authenticated. The ambient `claude`
  may be API-key-authenticated, and sessions refuse that.
- **Repo and branch.** The session clones the cwd's GitHub `origin` at the current branch, which must be pushed.
  The Claude GitHub app already covers `ashlrai/*`.
- **No read-back.** Verse cannot read a session back (attach is "not enabled for your account"). Tasks deliver to
  GitHub instead: branch `ashlr-cloud/<taskId>` and a draft PR carrying an `ashlr-cloud-report` JSON block. `gh` is
  authenticated on this machine.
- **Balance.** The credit balance is not readable, so spend is an estimate and always labelled as one. The UI links
  to https://claude.ai/settings/usage.

## Frozen contracts (do not change signatures; implement them)

- `src/core/cloud/types.ts` — all types, constants and routes.
- `src/core/cloud/{store,delivery-contract,launcher,checkout,tracker,budget,backlog,service}.ts` — signatures and
  doc comments are the spec. Replace the `notImplemented` bodies; delete `_stub.ts` when nothing imports it.
- `src/core/cloud/improvement-backlog.ts` — built-in self-improvement items (content owned by the operator; C1 may
  only fix typing).
- `src/core/cloud/cloud-api.ts` — mounted as `cloud` in `src/core/verse/verse-api.ts` (already done). It is a stub
  that claims no path.

## Units (exclusive file ownership)

### C1 — core (`src/core/cloud/**` except `cloud-api.ts` and `improvement-backlog.ts`, plus `test/cloud-*.test.ts`)

Implement every stub.

- **Launcher.**
  - Wrap the seat argv under a PTY. On darwin: `/usr/bin/script -q /dev/null <argv…>`. On linux:
    `script -qec <shell-quoted argv> /dev/null`.
  - Pass the prompt as ONE argv element, `--cloud <prompt>`, never through a shell on darwin.
  - Strip the environment the same way the seat launcher does; the launcher already strips it.
  - Enforce the timeout. Kill the process group on timeout.
- **Parser.**
  - Strip ANSI and OSC sequences, then match the three lines.
  - Classify errors from their text:
    - `requires authentication with a Claude.ai account` → `auth`
    - `not enabled` → `not-enabled`
    - `rate limit` / `usage limit` / `out of credits` → `rate-limited`
    - `not a git repository` / `no remote` / `push` → `no-remote`
    - anything else → `unparsed` or `unknown`.
  - Test against real captured output. The success sample is in the `types.ts` header. The auth-error sample is:
    `Error: Claude Code cloud sessions require authentication with a Claude.ai account. API key authentication is
    not sufficient. Please run /login to authenticate…`
- **Checkout.** A shallow clone under `<cloudHome>/checkouts/<owner>__<name>`, plus fetch/checkout of the base branch
  with upstream set. Serialise launches per folder with an in-process mutex.
- **Store.** Atomic writes, 0600/0700, `O_NOFOLLOW|O_NONBLOCK`. Resolve the ashlr home the way
  `src/core/routing/capacity-history.ts` does, and honour `ASHLR_HOME`/HOME test isolation.
- **Tracker.** Use `gh`, injected in tests. Parse the report with `parseCloudReport`. Transitions:
  - running → pr-open
  - pr-open → merged/closed
  - expire running tasks older than `CLOUD_TASK_EXPIRY_MS` with no PR.
- **Budget.** Implement `cloudBudgetView` and its gates, with local-day counting. Gate reasons are plain sentences.
  `estimateNote` is: `"Estimated at $N per session — Claude doesn't expose the credit balance. Check it on claude.ai
  and adjust here."`
- **Backlog.** Built-in items plus `<cloudHome>/backlog.json` (validated, capped at 200 items). Claim rules are in
  the doc comment.
- **Service.**
  - Validate the repo against `/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/`.
  - Truncate the prompt to `CLOUD_PROMPT_MAX_CHARS`.
  - Derive the title from the first line (≤ 80 chars).
  - Order: gates, then persist, then launch.
  - `runSelfImprove` picks `nextBacklogItem` for `budget.selfImprove.repo`.
  - `cloudOverview` refreshes nothing itself (cheap). It returns tasks, budget, backlog and seat status.
  - `cloudSeatStatus`:
    - ready when the claude-a native profile's `command.json` exists and parses to an argv array;
    - otherwise not ready, with the reason "The Claude seat isn't set up on this Mac."
    - Do NOT run the CLI to check auth; that would cost a process.
- **Tests.** Parser samples, prompt contract, report parsing (well-formed, malformed, multiple blocks, oversized),
  budget math and gates, backlog claims, the service flow with fake deps (success, each failure code, budget
  refusal), the tracker transitions, and store permissions. All HOME-isolated.

### C2 — API, CLI, scheduler, Needs-you

Ownership:
- `src/core/cloud/cloud-api.ts`
- `src/cli/cloud.ts` (new), plus registration in `src/cli/index.ts`, `src/cli/help.ts` and
  `src/cli/completions.ts`
- an additive Needs-you source in the server's activity/Needs-you model (find it: `src/core/verse/activity.ts` or
  whatever builds `/api/verse/activity` Needs-you items)
- `docs/VERSE-CONTRACT-V1.md` route rows
- `test/cloud-api*.test.ts`, `test/cli-cloud*.test.ts`

Scope:
- **Routes.** Everything in `types.ts` (GET overview; POST launch, budget, refresh, improve,
  `tasks/<id>/dismiss`). Posture matches other Verse modules:
  - GET needs the read session;
  - POST needs the write token, a JSON content type and a bounded body;
  - bad input is a 400 with a plain error;
  - no absolute paths or secrets in responses.
  - Dismiss marks the task `closed` with the reason "Dismissed in Verse." It never touches GitHub.
- **Background scheduler.** It starts on the module's first load and never under a test runner. `ASHLR_CLOUD_AUTO=0`
  disables it.
  - Every 10 min: `refreshCloudTasks()`.
  - Every 60 min, and 2 min after start: `runSelfImprove({ auto: true })`.
  - Both are guarded against overlapping runs. Log failures once per distinct error.
- **Needs-you items.**
  - For tasks in `pr-open`, "Cloud task ready for review" with the title, PR link and report summary.
  - For `failed` launches in the last 24 h, with the plain reason.
  - Use the existing Needs-you item shape and kinds; add a kind only if the contract allows it additively.
- **CLI.** `ashlr cloud` offers:
  - `launch "<task>" [--repo owner/name] [--base branch] [--json]` — the default repo is the cwd's GitHub origin;
  - `list [--json] [--all]`;
  - `refresh`;
  - `improve [--count N]`;
  - `budget [--total N] [--spent N] [--per-session N] [--max-per-day N] [--self-improve on|off]
    [--self-improve-max N] [--reserve N]`;
  - `backlog`.
  - Output is human-readable by default, with local times, no ISO and no absolute paths.
- **Tests.** HOME-isolated, with the service mocked through its deps or module mocks.

### C3 — web UI (`src/web-ui/routes/verse/cloud/**` new, plus minimal edits listed below)

- **Data.** A `cloud/cloud-queries.ts` query for `GET /api/verse/cloud`, polled every 30 s while visible and added to
  the idle prefetch table in `shell/surface-prefetch.ts` for Command. Mutations use the existing write-token
  pattern (see other POSTs in the web UI).
- **Command surface: a new `CloudCard`** (mounted in `sections/CommandSection.tsx` next to the burn-downs). It shows:
  - estimated credits remaining as a meter, with "$X of $250 · estimate" and a link to claude.ai usage;
  - sessions today, and running tasks with state chips, the session link ("Open in Claude") and the PR link;
  - a **New cloud task** button (dialog: repo field defaulting to `ashlrai/ashlr-hub`, base branch, task text,
    launch);
  - an **Improve Verse** button (launch the next backlog item);
  - a self-improvement toggle with its daily cap, and an **Edit budget** popover.
  - Errors use the NoticeSlot/ChartFrame conventions. Nothing truncates mid-word. Every icon button has a tooltip.
- **Chat.** In the composer's ⋯ sheet (`composer/ControlsSheet.tsx`) add **Run in cloud**. It launches the typed
  prompt as a cloud task for the current chat's project when the project has a GitHub origin (read it from the
  existing git/branch data the BranchBar uses). Then a confirmation toast appears with the session link, and the
  draft is cleared. Disable it, with a tooltip saying why, when there is no GitHub origin or the seat isn't ready.
- **Settings/Usage.** Add a "Cloud credits" panel in the usage area (`usage/**`) with the same budget fields.
- **Fleet.** Add a "Cloud · N running" chip in the lanes row (`fleet/**`).
- **Formatting.** Use the shared helpers: `describeResetAt`, `relativePhrase`, `usedPercentText`, and `tidyProse`
  where server text is shown. Local times only.
- **Tests.** Component tests for the card states (loading, empty, running, pr-open, failed, budget-refused), the
  launch dialog validation, the composer action (enabled/disabled), and the prefetch table entry. First-paint must
  stay ≤ 370 KB; nothing cloud-related may be in the chat first-paint path (lazy only).
- **Allowed edits outside `cloud/**`:** `sections/CommandSection.tsx` (mount the card), `composer/ControlsSheet.tsx`
  (one action), `usage/` (one panel mount), `fleet/` lanes row (one chip), `shell/surface-prefetch.ts` (one
  entry), plus their tests.

### C4 — website, README, docs (`site/**`, `README.md`, `docs/CLOUD.md` new, `docs/VERSE.md` cloud section)

- The website `site/index.html` (deployed at https://verse.ashlr.ai) was last updated at 3.6. Refresh its content
  for 3.9–3.11:
  - verified context windows and handoff;
  - live reasoning;
  - autonomy with custody (Touch ID grant, gates, reversible merges, dormant until setup);
  - budget modes;
  - the workbench (⌘K, ⌘J, dock, composer);
  - Command/Fleet/Growth/Mind with the chart kit;
  - burn-down history;
  - the new cloud lane.
- Keep the site's existing design system, CSS and tone: factual, no hype, numbers only where verified in
  CHANGELOG.md. Keep it fast (no new JS frameworks) and accessible.
- **README.md:**
  - title "Ashlr Verse";
  - lead with the desktop app (install, open, sign in seats);
  - then the CLI;
  - remove stale version pins (3.3.2 / 3.4.0 as "current");
  - a current quickstart;
  - the one-time `ashlr authority setup` (✋ steps);
  - the cloud lane.
- Keep the deeper reference sections, trimmed where they contradict current behaviour. Check claims against the
  code.
- **`docs/CLOUD.md`:** how the cloud lane works (mechanics above), the budget and why it is an estimate,
  self-improvement and its caps, the delivery contract, failure codes, and how to turn it off.
- `npm run check:docs` must pass.

### C5 — Leader suggestions into the backlog (`src/core/vision/**` leader code only, plus its tests)

- When the Leader writes a memo, it may propose cloud-worthy improvement tasks. The action kind already carries
  free text; find the leader action model. For actions that are code changes to a repo on GitHub, convert them into
  `CloudBacklogItem`s (id `leader-<memoId>-<n>`, priority from the action class, prompt = the action text plus the
  memo's bottleneck context) and call `appendUserBacklogItems`.
- This is the ONLY integration: the scheduler/Improve button launches them under the budget. Class-C actions stay
  Needs-you items as today.
- **Tests:** conversion, dedupe, and no backlog write when the memo has no code-change actions.

## Global rules for every unit

- Branch from `origin/v3110-cloud`. Work only in your owned files. Commit, then push branch
  `ashlr-cloud/3110-<unit>` (for example `ashlr-cloud/3110-c1`). Open a DRAFT PR against `v3110-cloud`, titled
  `[ashlr-cloud] 3.11 <unit>: <summary>`, with a short report (what changed, tests run with counts, anything
  declined). Never push to `master` or `v3110-cloud`; never merge.
- `npm ci` first. Verify with both `tsc` configs, eslint on changed files, and your tests. On Linux, skip macOS-only
  suites you didn't touch.
- No paid model calls in tests. Tests must stay HOME-isolated. Never write a real `~/.ashlr`.
- Keep comment density and naming like the surrounding code, and write WHY comments for non-obvious decisions.

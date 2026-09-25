/**
 * Built-in self-improvement backlog for Ashlr Verse (3.11 cloud lane).
 *
 * Each item is a COMPLETE brief for a Claude Code cloud session working in
 * ashlrai/ashlr-hub. The delivery contract (branch, draft PR, report block)
 * is appended by delivery-contract.ts — do not repeat it here. Items are
 * real, verified gaps as of 3.10.1 (2026-09-24), highest leverage first.
 * Operator and Leader items are added at runtime in <cloudHome>/backlog.json.
 */
import type { CloudBacklogItem } from './types.js';

const REPO_NOTES = [
  'Repo: TypeScript (Node 22+/Bun), `npm ci` then verify with `npx tsc --noEmit -p tsconfig.json`,',
  '`npx tsc --noEmit -p src/web-ui/tsconfig.json`, `npx eslint <changed files>`, and the relevant',
  'tests: backend `npx vitest run <test files>`, web `npx vitest run --config vitest.config.web.ts <paths>`.',
  'Tests must stay HOME-isolated (never write a real ~/.ashlr). Never make paid model calls in tests.',
  'Some suites are macOS-only (sandbox-exec, custody, launchd); on Linux skip ones you did not touch.',
  'Keep changes focused; add a regression test for every behaviour change; write clear WHY comments.',
].join(' ');

const item = (id: string, priority: 1 | 2 | 3, area: string, title: string, task: string): CloudBacklogItem =>
  Object.freeze({ id, priority, area, title, prompt: `${task}\n\n${REPO_NOTES}` });

export const BUILTIN_IMPROVEMENT_BACKLOG: readonly CloudBacklogItem[] = Object.freeze([
  item('fix-universe-recovery-tests', 1, 'tests', 'Fix the 8 long-failing Universe campaign-recovery tests',
    'Eight backend tests have failed since 3.9.1 and are treated as known failures: test/universe-campaign-seed-evaluation.test.ts (4, "Installed built-in evaluator unavailable or changed"), test/universe-dispatch-recovery-integration.test.ts (2, "Controller diagnostic does not match an unresolved dispatch intent"), test/universe-delivery-recovery.test.ts (1, readCompletedCampaignDelivery returns null for a verified strict improvement — commit f8cd6f1e "require delivered work to beat its seed" likely left the fixture without seed evidence), and test/universe-resource-integration.test.ts (1, campaign reaches "failed" instead of "completed" on deadline). Diagnose each root cause (product bug vs stale fixture) and fix it properly so all four files pass. Do not weaken assertions; if an evaluator requires macOS, make the test skip cleanly on other platforms with a reason.'),
  item('fix-release-policy-pins', 1, 'tests', 'Bring the release-policy pin tests up to the current release line',
    'These backend tests fail because they pin old release lines: test/m454.agent-skills-routing-challenge.test.ts, test/m440.dependency-audit-ci.test.ts, test/m468.release-desktop-workflow-policy.test.ts (2), test/m522.production-promotion-admission.test.ts ("binds the frozen release lane to 3.3.2 and the unreleased product line to 3.4.0"). Releases are now manual and local (GitHub Actions is off; npm latest is 3.10.x). Read the policy each test protects and update the policy data and tests together so they describe the real current process, keeping the safety intent (no silent weakening). Also fix test/m231.north-star-grounding.test.ts and test/npm-cli-launch.test.ts if their failures are the same kind of staleness; explain each in the PR.'),
  item('m571-gen-dir', 2, 'tests', 'Make the local production gate robust to Tauri build output',
    'test/m571.local-production-gate.test.ts fails on any machine that has run a Tauri build, because desktop/src-tauri/gen exists (generated schema output). Decide whether the gate should ignore generated Tauri output (add it to the right ignore list / .gitignore handling) or whether the check is wrong, fix it at the root, and add a test proving a generated gen/ directory no longer trips the gate while a genuinely unexpected file still does.'),
  item('first-paint-350', 1, 'performance', 'Get chat first-paint JavaScript to 350 KB',
    'Chat first-paint critical JS is ~367 KB against a 350 KB target (npm run check:first-paint enforces 370). Use the build output (npm run build, then the report from scripts/check-first-paint-budget.mjs) to find what the chat first paint statically pulls in that it does not need before first interaction (e.g. panels, markdown extensions, charts, stores, date helpers) and move it behind dynamic import or lighter code. Keep behaviour identical; keep src/web-ui/routes/verse/VerseApp.first-paint.test.ts passing and tighten it so regressions are caught. Then lower the budget in package.json check:first-paint to the new measured size + 3 KB (and at most 355).'),
  item('probe-event-loop', 2, 'performance', 'Remove the runtime-probe event-loop stall',
    'The Verse server\'s runtime probe stalls the Node/Bun event loop for 53–78 ms per run against a 20 ms budget (noted in CHANGELOG 3.10.0 "Not yet met"). Find the probe (search src/core/verse and src/core/local-runtime for the runtime/health probe that runs on an interval) and the synchronous work inside it (sync fs, JSON of large files, child_process sync calls). Make it asynchronous or chunked so no single tick exceeds 20 ms, and add a test that measures the max synchronous slice with a fake heavy input.'),
  item('harness-dispatch', 2, 'autonomy', 'Apply harness effort and sampling at dispatch',
    'Harness experiments (src/core/learn/harness-*.ts) choose effort/sampling settings, but those settings are not applied when the fleet dispatches a run (known gap in 3.10). Trace a dispatch from src/core/fleet/dispatch-router.ts through src/core/run/ engines, find where the adopted HarnessVersion should feed effort/temperature/sampling into the engine invocation, wire it through with the engine-specific flag mapping, and add tests proving an adopted harness changes the engine argv/options and the compiled defaults apply otherwise.'),
  item('router-lambda', 2, 'autonomy', 'Use the router\'s λ weights',
    'The cost-aware router (src/core/routing/router.ts and related) declares λ weights for its objective but does not use them (known gap). Read the scoring code, apply the weights as documented in the code/doc comments (quality vs cost vs latency vs headroom), keep the current default behaviour when weights are at defaults, and add table-driven tests that show changing a weight changes the ranking in the expected direction.'),
  item('server-lane-wording', 3, 'ux', 'Write lane and seat reasons in plain words on the server',
    'The web UI now translates router jargon ("2 slot(s)", "(a class-B action)", "grok-cli") via laneReasonText in src/web-ui/routes/verse/fleet/, but the server still produces it in src/core/fleet/dispatch-router.ts (~lines 223/229) and src/core/fleet/tick-hooks-live.ts (~line 1499). Make the server write plain, correctly pluralised sentences at the source (keeping any machine-readable fields unchanged), update CLI output that prints them, and simplify the web translation to a pass-through where it becomes redundant. Tests for both.'),
  item('account-health-reset', 2, 'accounts', 'Pick the latest spent window server-side in account health',
    'The Accounts panel now chooses the LATEST reset among a seat\'s spent windows (seatReopensAt in src/web-ui/routes/verse/), matching Fleet\'s "eligible again", but the server (account-health.ts resetAt and its tie-break) still picks differently. Find the server computation, make it return the time the seat actually reopens (latest spent-window reset; no time when a spent window only has provider text), and add tests. Keep the API shape backward compatible.'),
  item('pulse-local-days', 3, 'ux', 'Bucket Pulse days by the viewer\'s local calendar day',
    'src/web-ui/intelligence/pulse/PulseView.tsx (~line 89) buckets days at UTC midnight, so charts show days one day early west of UTC. Reuse the shared helper src/web-ui/routes/verse/growth/calendar-day.ts (do not duplicate) and add tests that run under America/Los_Angeles and Pacific/Kiritimati semantics (see src/web-ui/routes/verse/growth/time-zone.test-support.ts).'),
  item('barstack-titles', 3, 'charts', 'Give chart categories full-name tooltips',
    'BarStack (src/web-ui/components/charts/BarStack.tsx) uses one label for axis, tooltip and table, so Growth "Model outcomes" can only show shortened model names. Add an optional per-category `title` (full name) used by the tooltip and table while the axis keeps the short label, then pass full model ids from Growth (src/web-ui/routes/verse/growth/). Tests for both.'),
  item('meter-percent-rule', 3, 'accessibility', 'Apply the one percent rule to the shared Meter',
    'src/web-ui/components/primitives/Meter.tsx builds screen-reader text with Math.round, so a 99.6% meter announces "100%". Use usedPercentText from src/web-ui/routes/verse/percent-text.ts for aria-valuetext (keep aria-valuenow numeric), and audit other remaining Math.round percent text in src/web-ui (outside chart tick math) for the same rule. Tests.'),
  item('dependabot-32', 1, 'security', 'Fix the open moderate Dependabot alert',
    'GitHub reports one moderate vulnerability on the default branch (Dependabot alert #32). Find which dependency it is (npm audit / package-lock.json), upgrade or override to a patched version with the smallest safe change, confirm `npm audit` is clean for it, and run the full typecheck, lint, web suite and the backend suites that exercise the dependency. Explain the advisory and the fix in the PR.'),
  item('verse-error-forwarding', 2, 'reliability', 'Forward budget and activity API errors instead of swallowing them',
    'Known gap: src/core/routing/budget-api.ts and src/core/verse/activity-api.ts swallow some upstream errors and answer with empty/partial data, so the UI shows "nothing" instead of "could not read X". Make them return a structured error (status + plain reason, no absolute paths or secrets) that the existing web ChartFrame/NoticeSlot conventions can display, and update the web consumers to show it. Tests for server responses and one consumer.'),
]);

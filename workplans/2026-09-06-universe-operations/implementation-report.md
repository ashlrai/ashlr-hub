# Universe repository delivery

Implementation verification snapshot: 2026-09-06. This snapshot precedes the
feature commit and final package acceptance; it does not claim publication.

## Source and behavior

- Worktree: `/Users/masonwyatt/.codex/worktrees/ashlr-hub/ashlr-universe-kernel`.
- Branch: `codex/universe-operations`.
- Base: `14f8f8637b5cbdd38ce7d71e27de7889692b35ec`.
- Primary checkout and its unrelated untracked workplans were preserved.
- Entire is enabled in manual-commit mode; branch resume found no checkpoint.

The public SDK and CLI deliver a current selected elite into a new explicit
`codex/` branch in its pinned seed repository. Git plumbing preserves original
checkout/index/HEAD bytes and avoids hooks, filters, signing, external protocols,
and candidate execution. Added/deleted files, binary data, and executable modes
are preserved. An unchanged tree creates no branch.

Private immutable intent and receipt records bind the historical trial, run,
manifest, comparator, artifact, seed, deterministic commit, tree, branch, and
changed files. Readers independently recheck those bindings. Historical receipts
remain readable after a newer elite wins. Retry reconciles exact intent without
overwriting an unrelated ref. A Git-owned prepared transaction holds the ref
lock for the final existence check and commit; this addresses cooperating Git
writers, not hostile same-user direct filesystem edits. Each report bounds Git
inspection to ten seconds; large fleet-wide synchronous projection remains a
future scaling concern.

The console extends existing design tokens and native disclosures to expose
branch provenance and exact source-trial navigation. Pending, unchanged,
degraded, local branch delivery, and production acceptance are distinct. The
documentation skill kept the operator instructions in the canonical
[Universe guide](../../docs/ASHLR-UNIVERSE.md), not a competing runbook.

## Local verification

These are separate test groups; reruns are not additional unique tests.

| Check | Result |
| --- | --- |
| Existing Universe core/CLI/API/store/feedback/model unit groups | 211 passed / 9 files |
| Native model, campaign, replay, demo, confinement | 38 passed / 5 files; no skips |
| Delivery core and independent real-Git review, final patch | 37 passed / 2 files |
| Delivery CLI | 68 passed; combined existing/delivery CLI run 120 passed |
| Full web suite | 193 passed / 33 files |
| Invariants | 449 passed / 41 files; 5 existing skips |
| Installed-smoke regression and local-gate contracts | 28 passed (7 smoke, 21 gate) |
| TypeScript, scoped ESLint, whitespace | Passed |
| Production build and full lint | Passed; 0 errors, 106 existing warnings |

Real-Git tests cover dirty checkout preservation, additions/deletions/modes,
SHA-256 repositories, no-op results, pre-/post-ref intent reconciliation,
missing/altered artifacts, historical provenance, unrelated/symbolic refs,
execution exclusion, and configured Git side effects remaining unexecuted.
Mock/ledger fixtures do not imply real model or evaluator execution.

The installed-smoke program checks public exports, CLI help and invalid flags,
missing-root noncreation, campaign registration/control/terminal idempotence,
and delivery refusal without a selected elite. Its regression fixtures resolve
source through temporary package wrappers; actual clean tarball acceptance is
a separate final step, not inferred from these wrappers.

## Handoff limits

No model calls were made for this increment. The existing calendar benchmark
may be delivered during final package acceptance; that would prove the delivery
flow, not a new product fix or additional evaluator success.

`npm whoami --registry=https://registry.npmjs.org/ --json` returned E401 on
2026-09-06. npm `latest` and `candidate` remain 3.3.2. GitHub Actions remain
repository-disabled. A source merge/local console is not an npm release,
resident activation, subscription-account integration, multi-repository product
delivery, or customer acceptance. Public publication also needs a compatible
successor local publishing path; the frozen 3.3.2 OIDC workflow is not one.

The final external handoff must record the exact feature/merge SHA, tarball
digest, installed acceptance, live console state, and rollback source. The
pre-increment rollback source is the base SHA above.

## Packaged acceptance and browser follow-up

Feature commit `6a0fe2c3fd60945b425116b8444a04b36d34be0b` was built clean and
installed offline. The enhanced package smoke passed. Independent fresh
extraction checked every file and ran the packaged deterministic demo, then
delivered its elite to an isolated Git branch with unchanged checkout/index/HEAD
and exact repeat idempotence. All five native demo checks passed.

The installed feature build also delivered the already evaluated calendar
benchmark `campaign-calendar-94544f09` to local branch
`codex/universe-calendar-delivery`, commit
`57ff416c55868b543beefa37378d0ed5bb8068f4`. Only `format.ts` changed in that
branch; the seed checkout/index/HEAD remained unchanged. The result is a delivery
of existing evidence, not a new model call, fresh evaluation, or production fix.

Live browser inspection caught a privacy-filter interaction: the API abbreviates
home paths to `~/...`, but quoting that string literally prevents shell
expansion. The follow-up UI patch separates quoted home expansion from safely
quoted path data and explains hidden digests without disabling privacy filters.
The successor package must be rebuilt and reverified; the initial artifact is
intermediate, not the final handoff.

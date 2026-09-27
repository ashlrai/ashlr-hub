/**
 * Starter playbooks shipped with ashlr.
 *
 * A built-in is VIRTUAL until edited: its v1 lives here, not on disk, so a
 * machine that never touches playbooks writes nothing. The first edit
 * persists this v1 text verbatim and then the edit as v2, so the history on
 * disk always starts from exactly what tasks ran under before.
 *
 * WHY every starter ships `auto: false`: auto-matching changes the prompt of
 * every matching fleet task. That is Mason's call per playbook (the Playbooks
 * view has the switch), not a default an upgrade flips on.
 *
 * Kept short on purpose: a playbook is injected into every run that uses it,
 * so each line has to earn its bytes.
 */

export const BUILTIN_PLAYBOOK_SOURCES: readonly string[] = [
  `---
id: fix-failing-test
name: Fix a failing test
macro: !fix-test
description: Find why a test fails, fix the cause (not the assertion), keep the suite green.
kinds: [fix, tests]
repos: []
globs: []
auto: false
budget-usd: 5
budget-minutes: 45
done-when:
  - The named failing test passes
  - The full test suite passes with no newly skipped tests
---

## Outcome

The failing test passes because the code (or a genuinely wrong test) was fixed, and nothing else regressed.

## Procedure

1. Run the failing test alone and read the full failure output.
2. Decide which side is wrong: the code under test, or the test's expectation. Check git history of both when unsure.
3. Make the smallest change that fixes the cause.
4. Re-run the test alone, then the whole suite.
5. In the PR description, state the root cause in one sentence and how you proved it.

## Specifications

- Keep the change scoped to the failure; no drive-by refactors.
- If the test was flaky (timing, ordering, shared state), fix the flakiness itself and say so.

## Advice

- A failure that only happens in the full suite usually means shared state between tests.
- Read the assertion message before the stack trace.

## Forbidden actions

- Do not delete, skip, or weaken the failing test or its assertions to make it pass.
- Do not add retries or longer timeouts to hide a real bug.

## Required from user

- The failing test's name or file, or the CI run that shows it.
`,
  `---
id: fix-issue
name: Fix a reported bug
macro: !fix-bug
description: Reproduce the bug, fix it at the root, and prove it with a regression test.
kinds: [fix]
repos: []
globs: []
auto: false
budget-usd: 8
budget-minutes: 60
done-when:
  - A regression test fails before the fix and passes after it
  - The full test suite passes
---

## Outcome

The reported bug no longer happens, a regression test guards it, and the PR explains the root cause.

## Procedure

1. Restate the bug as expected vs. actual behaviour.
2. Reproduce it with a failing automated test before changing any code.
3. Trace the failure to its root cause; fix that, not the symptom.
4. Run the new test, then the full suite, then the linter and type checker if the project has them.
5. Link the issue in the PR and summarise cause, fix, and test.

## Specifications

- The regression test must fail on the old code.
- Public behaviour other than the bug stays unchanged.

## Advice

- If you cannot reproduce it, stop and report what you tried instead of guessing a fix.
- Search for the same pattern elsewhere; mention other instances in the PR rather than fixing them all.

## Forbidden actions

- Do not change unrelated files or reformat code you did not touch.
- Do not silence errors (empty catch blocks, broad try/except) to make the symptom disappear.

## Required from user

- The issue link or a description with steps to reproduce.
`,
  `---
id: dependency-bump
name: Bump a dependency
macro: !bump-deps
description: Upgrade one dependency, adapt to breaking changes, keep the lockfile honest.
kinds: [deps]
repos: []
globs: []
auto: false
budget-usd: 5
budget-minutes: 45
done-when:
  - The lockfile is updated by the package manager, not by hand
  - Build, type check and the full test suite pass
---

## Outcome

The dependency is on the requested version, the code is adapted to any breaking changes, and everything builds and passes.

## Procedure

1. Read the dependency's changelog between the current and the target version; list breaking changes.
2. Upgrade with the project's own package manager so the lockfile is regenerated.
3. Fix every breaking change the build, type checker or tests surface.
4. Run build, type check, lint and the full test suite.
5. In the PR, list the versions, the breaking changes that applied, and what you changed for each.

## Specifications

- One dependency (or one tightly coupled family) per PR.
- Keep the project's existing version range style (^, ~, exact).

## Advice

- Major versions often move config files or default options; check both.
- If a transitive dependency conflict appears, report it instead of forcing resolutions.

## Forbidden actions

- Do not edit the lockfile by hand.
- Do not add overrides/resolutions or disable type checks to get past an error.
- Do not upgrade unrelated packages in the same change.

## Required from user

- The package name and the target version (or "latest").
`,
  `---
id: add-tests-for-module
name: Add tests for a module
macro: !add-tests
description: Cover a module's public behaviour with focused, deterministic tests.
kinds: [tests]
repos: []
globs: []
auto: false
budget-usd: 5
budget-minutes: 45
done-when:
  - The new tests pass and are deterministic (run them twice)
  - The full test suite passes
---

## Outcome

The module's public behaviour — normal cases, edge cases and error paths — is covered by tests that follow the project's existing conventions.

## Procedure

1. Read the module and list its public functions and their contracts.
2. Find the project's existing test style (framework, file naming, helpers, fixtures) and follow it.
3. Write tests for the main paths, the edge cases (empty, boundary, invalid input) and the error paths.
4. Run the new tests twice to prove they are deterministic, then the full suite.
5. If a test reveals a bug, keep the test, mark it clearly, and report the bug in the PR instead of fixing it silently.

## Specifications

- Test behaviour through the public API, not private internals.
- No network, real clock, or real home directory in tests; use the project's fakes.

## Advice

- One behaviour per test, named after the behaviour.
- Prefer a few precise assertions over snapshots of large objects.

## Forbidden actions

- Do not change the module's behaviour to make it easier to test.
- Do not add tests that only assert the code runs without throwing.

## Required from user

- The module path, and any behaviour that matters most.
`,
  `---
id: docs-sync
name: Sync docs with the code
macro: !docs-sync
description: Bring READMEs and docs back in line with what the code actually does.
kinds: [docs]
repos: []
globs: []
auto: false
budget-usd: 3
budget-minutes: 30
done-when:
  - Every command, flag and example in the changed docs matches the code
  - Doc checks (links, formatting) pass if the project has them
---

## Outcome

The documentation describes the code as it is today: commands, options, defaults and examples are accurate.

## Procedure

1. Identify the docs in scope and the code they describe.
2. For every command, flag, config key, default and example in those docs, check it against the code.
3. Fix what is wrong or missing; remove what no longer exists.
4. Run any doc tooling the project has (link check, formatter).
5. In the PR, list each correction with the code location that proves it.

## Specifications

- Match the existing tone and structure of the docs.
- Examples must be copy-pasteable and actually work.

## Advice

- Help text and CLI usage strings in code are often the most accurate source.
- Prefer fewer, correct words over more words.

## Forbidden actions

- Do not change code to match the docs; if the docs describe desired behaviour, report it.
- Do not invent features or roadmap claims.

## Required from user

- Which docs (or which area of the code) to sync.
`,
  `---
id: perf-regression
name: Fix a performance regression
macro: !perf-fix
description: Measure the regression, find the cause, fix it, and prove it with numbers.
kinds: [fix]
repos: []
globs: []
auto: false
budget-usd: 10
budget-minutes: 90
done-when:
  - A before/after measurement shows the regression is gone
  - The full test suite passes
---

## Outcome

The slow path is back to (or better than) its previous speed, proven by a repeatable measurement, with behaviour unchanged.

## Procedure

1. Build a repeatable measurement of the slow path (benchmark, timing script or profiler run).
2. Measure the current code and, when possible, the last known good version.
3. Profile to find the cause; bisect commits if needed.
4. Fix the cause and re-measure several times.
5. Add a benchmark or guard test if the project has a place for one.
6. Report before/after numbers, the environment, and the cause in the PR.

## Specifications

- Correctness first: the full test suite must still pass.
- Report medians of several runs, not single runs.

## Advice

- Look for accidental quadratic loops, repeated I/O, missing caching, and work moved onto a hot path.
- Measure before optimising; the obvious suspect is often wrong.

## Forbidden actions

- Do not trade correctness, safety checks or error handling for speed.
- Do not claim an improvement without a measurement.

## Required from user

- What got slower, roughly when, and how it is observed (command, endpoint, test).
`,
  `---
id: security-fix
name: Fix a security issue
macro: !security-fix
description: Fix a vulnerability at its root with a test that proves it is closed.
kinds: [fix, deps]
repos: []
globs: []
auto: false
budget-usd: 10
budget-minutes: 90
done-when:
  - A test demonstrates the vulnerable input is now rejected or handled safely
  - The full test suite passes
---

## Outcome

The vulnerability is closed at its root, a test proves it, and nothing sensitive is disclosed in the change.

## Procedure

1. Understand the vulnerability class and every entry point that reaches the vulnerable code.
2. Write a test with the malicious input that shows the problem.
3. Fix it at the root (validation, encoding, authorisation check, safe API) rather than filtering one payload.
4. Check the other entry points and similar code for the same flaw.
5. Run the full suite. Describe the fix in the PR in neutral terms.

## Specifications

- Prefer the platform's or framework's safe primitives over hand-rolled sanitising.
- Fail closed: on doubt, reject.

## Advice

- For a vulnerable dependency, upgrade to the first fixed version and follow the dependency-bump procedure.
- Least privilege: remove access that is not needed rather than adding checks around it.

## Forbidden actions

- Do not include exploit payloads, secrets or real user data in commits, PR text or logs.
- Do not disable security checks, linters or tests to get the fix through.
- Do not weaken authentication or authorisation anywhere to make tests pass.

## Required from user

- The advisory, report or description of the issue and where it was found.
`,
];

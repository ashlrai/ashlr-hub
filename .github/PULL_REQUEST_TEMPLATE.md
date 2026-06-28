<!-- Thanks for contributing to ashlr-hub! -->

## What & why

<!-- What does this change and why? Link any issue: Closes #123 -->

## How it was verified

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run build` succeeds
- [ ] Hermetic test suite green: `HOME=$(mktemp -d) npx vitest run --no-file-parallelism` (no decrease in test count; new behavior has tests)
- [ ] `ashlr verify-safety` still passes (5/5) if any safety-relevant code changed

## Safety checklist (for anything touching the autonomous path)

- [ ] No new outward capability (push / PR / deploy / apply) outside the Approval Inbox
- [ ] Autonomous work stays sandboxed (never the real working tree)
- [ ] Enrollment / kill-switch / budget guards unchanged or strengthened (never weakened)
- [ ] No code-to-cloud by default; secrets never logged
- [ ] If a guard's behavior changed, the change is intentional and the regression test was updated deliberately
- [ ] **Behavior changes are flag-gated** — new behavior is off by default; `--flag-off` parity verified (see CONTRIBUTING.md invariants)

## Dependency / zero-dep invariant

- [ ] No new runtime dependencies added to `dependencies` in `package.json` (the zero-runtime-dep core invariant; see CONTRIBUTING.md)

## Notes

<!-- Anything reviewers should know: trade-offs, follow-ups, deliberately-deferred items -->

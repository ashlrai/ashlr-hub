# Ashlr Autonomous Production Evidence

This report will contain only evidence observed from the exact integrated protected source and any artifact built, published, installed, or activated from it. Source completion, protected merge, package publication, installation, resident service health, autonomous authority, and production outcomes are reported separately.

## Status

Not production-proven. The source candidate is eligible only for a draft,
review-only proposal-lab PR.

## Source Candidate Evidence

- Base: protected `origin/master` `d9046fe5c99c2454c65f56e4849d20e86cef1d05`.
- Local focused authority/model suites: 234/234 passed.
- Shadow production-isolation regressions: passed.
- Full M201 daemon loop: 245/245 passed.
- Full invariants: 449 passed / 5 expected skips.
- Previously contended invariant subset: 76/76 passed serially.
- Typecheck, build, quiet full lint, package dry-run, and diff check: passed.
- `npm audit`: zero known vulnerabilities.
- Local Semgrep/Gitleaks: no confirmed introduced secret or P0/P1 finding, but
  scanner coverage was incomplete and not SHA-bound; exact-head hosted security
  checks remain required.

## Runtime Evidence

- Installed Ashlr: 3.1.0 at revision `18a60269`.
- Source package candidate: 3.2.0.
- Published npm latest observed: 3.0.1.
- Resident daemon: stopped; service not loaded.
- Proposal store: healthy, 672 rejected / 0 pending / 0 applied.
- Autonomy evidence packs: 0.
- Dispatch-production evidence: degraded, 4 invalid rows.

No source protection in this draft is credited to the installed runtime.

## Explicitly Withheld

- Protected merge and ready-for-review state.
- npm publish, tag, install, or service activation.
- Human approve/reject/verify/apply authority.
- Autonomous merge, PR opening, deploy, release, or rollback authority.
- Unattended cloud/provider spend or unconfined execution.
- A production outcome, useful merge, or self-improvement claim.

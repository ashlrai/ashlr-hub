# Task Plan: Ashlr Hub Next-Level Autonomous Lab

## Goal

Define and begin the highest-leverage, evidence-backed program that turns Ashlr Hub into a useful, trustworthy autonomous engineering team and research lab while preserving fail-closed production authority.

## Phases

- [x] Phase 1: Create an isolated program worktree and parallel audit lanes
- [x] Phase 2: Map current product, research, architecture, security, and production gaps
- [x] Phase 3: Select the first product slice and define its safe prerequisite — **First Outcome Mode** selected; unattended implementation stopped at an independent security NO-GO
- [x] Phase 4: Independently review, validate, and preserve the strategic program as a local draft; defer a GitHub PR to avoid adding to the existing draft inventory
- [ ] Phase 5: Convert the agreed 30/90/180-day sequence into an execution backlog with owners, dependencies, exact files/tests, and evidence gates

## Key Questions

1. What measurable user outcome should be Ashlr Hub's North Star?
2. Where does the current intent-to-useful-merged-work loop lose the most value?
3. Which frontier-agent mechanisms are evidence-backed enough to adopt now?
4. What is the smallest next slice that improves useful autonomy without expanding deployment authority?
5. Which release, security, spend, privacy, and rollback gates remain non-negotiable?

## Decisions Made

- Prioritize useful verified work and proposal-to-merge conversion over raw agent count or telemetry volume.
- Keep planning/research separate from deployment authority; no tag, publication, installation, or resident activation is implied.
- Use three independent critiques: product/founder, frontier research, and autonomous-team systems architecture.
- Preserve the root planning files and use this scoped directory to avoid overwriting shared history.
- Adopt **Weekly Active Outcome Teams** as the product North Star: at least one mission-linked, accepted, protected merge that remains green and unreverted for seven days with at most ten minutes of operator intervention.
- Sequence the program as: prove a first stable outcome; make dispatch economically atomic and mandatorily confined; then build the causal experiment/evaluation lab.
- Freeze new dashboards, provider aliases, judge personas, broad fan-out, and speculative control-plane abstractions until at least 20 real stable outcomes exist.
- Build First Outcome Mode before the research lab because the live system must first demonstrate user value; keep its authority proposal-only.
- Do not implement a general `--until-proposal` loop on the current execution boundary. First close exact run/proposal correlation, immutable human-only review policy, cross-process lane identity, atomic budget reservations, continuous kill/un-enrollment cancellation, and mandatory sealed confinement.
- Preserve the existing all-or-nothing resident setup boundary. Any future non-service onboarding path must be separately named and explicitly authorized; it must never be a caller-controlled bypass in `setupWizard`.
- Keep the strategic program draft-only. It does not authorize First Outcome implementation until the concrete credential and egress boundary receives an independent review.

## Errors Encountered

- Initial worktree creation command used the not-yet-created worktree as its process cwd and failed with `No such file or directory`; reran from the primary checkout successfully.

## Status

**Phase 5 pending** - The strategic program passed independent product, research, systems, and security review and is preserved locally. Product code was intentionally not changed after the authority audit returned NO-GO. The next authorized step is to convert the agreed sequence into a dependency-ordered execution backlog; no GitHub PR, release, installation, or runtime authority is implied.

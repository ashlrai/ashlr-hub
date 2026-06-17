# CONTRACT-M56 — mid→branch auto-apply (the M51 graduated-trust path, wired)

**Pillar:** Ashlr v5 Open Fleet — give the `mid` tier its graduated-trust action:
a fully-verified MID-tier (strong open model) proposal may auto-apply to a
BRANCH / PR, but NEVER to `main`.

**Mason's hard rule:** authority still never leaks upward. Mid opens a PR and
STOPS — it is never squash-merged to `main` and never merged locally to `main`.
It is gated behind a SEPARATE, DEFAULT-OFF sub-flag `cfg.foundry.autoMerge.
midToBranch` (so enabling main auto-merge does not implicitly enable it), and runs
the SAME provenance + risk + full-verification + self-target gates as the main
path. Flag-off byte-identical: the frontier→main path is untouched.

---

## 1. Gate (`inbox/merge.ts`)

- `evaluateBranchAuthority(proposal, cfg)` — PURE. Authorized iff: `midToBranch`
  flag is on AND `mergeTargetForTier(engineTier) === 'branch'` (engineTier 'mid')
  AND engineModel is concrete (not ':default'). Never grants main authority.
- `autoMergeProposal` now computes `target = mergeTargetForTier(engineTier)`:
  - `main` (frontier) → `evaluateMergeAuthority` + squash-merge to main (UNCHANGED).
  - `branch` (mid) → `evaluateBranchAuthority`; open a PR (or stage a branch when
    no host) and STOP — `gh pr merge` is guarded by `toMain`, `mergeLocally` by
    `toMain`. Marks the proposal `applied` (so the pass doesn't re-open a PR).
  - `none` (local) → refused (proposal-only).
  Provenance (M47.1), risk≤maxRisk, and full verification (incl. the M54
  self-target guard) apply to BOTH paths.

## 2. Pass (`fleet/automerge-pass.ts`)

- Pre-filter now also considers `mid` proposals when `midToBranch` is on; counts a
  new `branched` total alongside `merged`. Still default-off; gate re-checks all.

## HARD RULES + verification (`test/m56.*`)

1. **Mid never reaches main** — `evaluateBranchAuthority` only ever grants BRANCH;
   the squash-merge + local-merge are guarded by `toMain` (frontier-only). → pure
   gate tests + a structural source-guard on `autoMergeProposal`.
2. **Default-off + separate flag** — mid is refused unless `midToBranch === true`;
   enabling `autoMerge.enabled` alone does not enable it. → `m56` gate test.
3. **Frontier→main path byte-identical** — `target==='main'` runs exactly the
   pre-M56 code. → m47 regression green.
4. **Same provenance/risk/verify/self-guard gates** — mid goes through the same
   Gates 4.5/5/6. → covered by the shared gate code + m47/m54 regression.

## Deliverables checklist

- [ ] `types.ts`: `cfg.foundry.autoMerge.midToBranch`.
- [ ] `inbox/merge.ts`: `evaluateBranchAuthority` + target-based branching in
      `autoMergeProposal` (squash/local-merge guarded by `toMain`); `AutoMergeResult.branched`.
- [ ] `fleet/automerge-pass.ts`: mid pre-filter + `branched` count.
- [ ] Tests: `m56.branch-gate`.

## Non-goals

Auto-merging mid to main (forbidden) · enabling any of this by default · a new
apply mechanism (reuses the existing buildMergeBranch + createPr path).

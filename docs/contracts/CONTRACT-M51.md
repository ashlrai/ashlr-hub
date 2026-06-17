# CONTRACT-M51 — Tri-tier trust

**Pillar:** Ashlr v5 Open Fleet — graduate trust into three tiers so a strong
*open* model earns more than proposal-only but never reaches `main`.

**Mason's hard rule:** authority never leaks upward. `frontier → main`; `mid →
branch only, NEVER main`; `local → proposal-only`. The tier is provenance-bound
(M47.1): a record can never claim a tier higher than its signed
`{engineModel, engineTier}`. Flag-off behavior is byte-identical: the merge gate
already requires `frontier` for main authority, so adding `mid` cannot widen it.

---

## 1. The tier (`types.ts`)

- `EngineTier = 'local' | 'mid' | 'frontier'`. `mid` = a strong open model
  (Nous Hermes, Kimi K2.7, a NIM-hosted ≥70B) trusted to auto-apply to a BRANCH
  after full verification, but never to `main`/prod.

## 2. Registry (`run/engine-registry.ts`)

- `VALID_TIERS += 'mid'`. Reclassify `hermes → 'mid'` (strong open agent).
  `opencode` stays `local` (runs arbitrary models — no unearned trust). New
  api-model backends may declare `tier: 'mid'` via `cfg.foundry.engines`.

## 3. The gate (`inbox/merge.ts`)

- `evaluateMergeAuthority` UNCHANGED in effect: still authorizes MAIN only for
  `frontier` + `mergeAuthority` match. Its rejection reason becomes tier-aware
  (names the tier). `mid`/`local` are refused for main exactly as before.
- NEW pure policy seam `mergeTargetForTier(tier): 'main' | 'branch' | 'none'`
  (`frontier→main`, `mid→branch`, else `none`). It introduces NO new default
  behavior — it is the seam a future (default-off, gated) auto-apply pass consumes.

## HARD RULES + verification

1. **`mid`/`local` can never reach `main`** — `evaluateMergeAuthority` refuses any
   non-`frontier` tier regardless of green status / mergeAuthority contents.
   → `m51.trust` (mid + local refused; frontier authorized).
2. **Tier is provenance-bound** — a tampered record claiming `frontier` over a
   diff signed as `mid` fails `verifyProvenance` (HMAC over the tier). → `m51.trust`.
3. **`mergeTargetForTier` policy** — frontier→main, mid→branch, local/undefined→
   none. → `m51.trust`.
4. **Flag-off byte-identical** — existing gate/risk behavior unchanged; whole
   suite green. → regression + `m51.trust`.

## Deliverables checklist

- [ ] `types.ts`: `EngineTier += 'mid'`.
- [ ] `engine-registry.ts`: `VALID_TIERS += 'mid'`; `hermes → 'mid'`.
- [ ] `inbox/merge.ts`: tier-aware reason + `mergeTargetForTier`.
- [ ] Update `m50.engine-registry` hermes-tier expectation to `'mid'`.
- [ ] Tests: `m51.trust`.

## Non-goals

Wiring actual branch auto-apply (a future default-off gated pass) · per-tier
risk-threshold tightening (deferred; classifyRisk stays byte-identical here).

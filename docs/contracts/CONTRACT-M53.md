# CONTRACT-M53 — Fleet intelligence

**Pillar:** Ashlr v5 Open Fleet — make the fleet route smart and stay
cost-predictable, building on the v4 quota/observability layer.

**Mason's hard rule:** learned actions stay INSIDE the gate. Routing, cost
forecasting, and anomaly detection may change *which backend/tier* runs an item
and *whether the daemon pauses* — they may NEVER auto-apply, bypass the trust
gate, or weaken proposal-only defaults. Every anomaly outcome is a held proposal
or a `TuningProposal` (human-reviewed). Flag-off byte-identical.

---

## 1. Learned router (`src/core/run/learned-router.ts`, new)

- `recommendRoute(item, cfg, opts)` — PURE over its inputs. Combines the existing
  `routeBackend` (M46) decision with verified-outcome priors and an `estimateRun`
  cost estimate (`observability/estimate.ts`) to recommend `{ backend, tier,
  reason, confidence }`. Priors come from reflect-outcome history
  (`learn/*` / run records): a task class with a low frontier verified-success
  rate relative to its cost is nudged toward `mid`/`local`. NEVER recommends a
  tier the producer can't be trusted at; never expands merge authority.
- It only REORDERS/SELECTS backends `routeBackend` already considers — it cannot
  introduce a backend not in `cfg.foundry.allowedBackends`.

## 2. Budget-breach auto-recovery (`fleet/router.ts` + `daemon/loop.ts`)

- A pure `recoverWithinBudget(decision, cfg, spentUsd, forecast)` that, on a
  predicted daily-budget or rate-quota breach, CASCADES the chosen backend
  frontier→mid→local; at the hard cap it returns a `pause` signal. The daemon tick
  consults it AFTER `routeBackend`/`withinLimit` (which already falls back on
  quota) — this adds budget-aware tier cascade + pause, no new outward action.

## 3. Per-run cost-anomaly hold (`daemon/loop.ts` + inbox)

- After a dispatch, if a run's cost exceeds `k × p50` (from `estimateRun`, k
  configurable, default 4) the resulting proposal is HELD: it stays PENDING and a
  `TuningProposal` (existing `learn/tuning` type) is filed describing the anomaly.
  No auto-apply, ever. The hold is recorded in the tick record + audit.

## HARD RULES + verification (`test/m53.*`)

1. **No auto-apply / no gate bypass** — every learned path produces a PENDING
   proposal or a TuningProposal; none imports or calls an apply/merge primitive
   (source grep-guard, reusing the daemon-no-primitive precedent). → `m53.intel`
   + source scan.
2. **Cascade order** — `recoverWithinBudget` returns frontier→mid→local→pause in
   that order as budget tightens; never escalates a local item to frontier to
   overspend. → `m53.intel`.
3. **Anomaly hold** — a seeded cost > k×p50 holds the proposal PENDING + files a
   TuningProposal; a normal-cost run does not. → `m53.intel`.
4. **Learned router stays in-bounds** — never recommends a backend outside
   allowedBackends; never a tier the engine can't carry. → `m53.intel`.
5. **Flag-off byte-identical** — absent cfg.foundry, tick routing is exactly v4. →
   regression.

## Deliverables checklist

- [ ] `src/core/run/learned-router.ts` (new): `recommendRoute`, `recoverWithinBudget`.
- [ ] `observability/estimate.ts`: small extension to expose p50 + anomaly ratio.
- [ ] `fleet/router.ts` / `daemon/loop.ts`: wire recommend + recover + anomaly hold.
- [ ] Tests: `m53.intel` (+ source grep-guard).

## Non-goals

Online model training · changing the trust gate · auto-applying anything.

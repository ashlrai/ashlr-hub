# CONTRACT-M64 — Codex usage + real subscription rate-limits

**Pillar:** ashlr-hub as the unifying harness — capture a sibling tool's (Codex)
real activity + limits into the hub's observability + Mission Control, the same
way Claude usage already flows. The first "limits" data that's genuinely real.

**Mason's hard rule:** metadata-only (token counts, model, project basename, ts —
never message content); read-only; never throws; no fabricated numbers (Codex
exposes REAL rate-limits in its session files, so we surface those, not guesses).

---

## 1. Source (`observability/codex-source.ts`, new)

- `collectCodexEvents(sinceMs)` — walk `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
  (mtime-skip, streamed, bounded, never-throws); ONE UsageEvent per session using
  the FINAL `token_count` event's `total_token_usage` (cumulative ⇒ no
  double-count); `model:'codex'` (→ `modelToProviderKey`→'codex'), project = cwd
  basename.
- `readCodexRateLimits()` — the most-recently-modified session's last
  `token_count.rate_limits` → `{ primary{usedPercent,windowMinutes,resetsAt},
  secondary{…}, planType }` (REAL: 5h + 7d windows, reset times, plan).

## 2. Wiring

- `usage-source.ts collectUsageEvents` merges `collectCodexEvents` (Codex now in
  the rollup / pulse / dashboard usage).
- `limits.ts` providers: the codex entry carries the REAL `used` % + `resetAt` +
  a human detail ("Codex prolite — 15% of 5h window, resets … / 10% of 1w").
- `app.js`/`styles.css`: subscription providers with a `used` % render a
  color-graded bar (green ≤70 / amber ≤90 / red >90) + reset time.

## HARD RULES + verification (`test/m64.*`)

1. **Real, never fabricated** — limits come from session `rate_limits`; absent ⇒
   null, no invented numbers. → `m64.codex-usage`.
2. **No double-count** — one event/session from the final cumulative total. →
   `m64.codex-usage`.
3. **Never throws / metadata-only** — missing ~/.codex ⇒ [] / null; malformed
   lines tolerated; no content read. → `m64.codex-usage` (tmp HOME fixture).
4. **Consistent cost model** — `model:'codex'` priced at cloud-equivalent like
   subscription Claude already is (notional, not real billing). → by construction.

## Deliverables
- [ ] `observability/codex-source.ts` + wiring (usage-source, limits, app.js, css)
      + `test/m64.codex-usage` (23).

## Non-goals
Cursor usage (opaque leveldb storage — separate spike) · real billing $ (notional
cloud-equivalent, consistent with Claude) · Codex as a usage *control* surface.

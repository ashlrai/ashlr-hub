# CONTRACT-M63 — real usage/limit ingestion (Mission Control)

**Pillar:** Replace the "cloud limits not wired" stub with what's actually
knowable, honestly — so the dashboard shows real usage windows instead of a TODO.

**Mason's hard rule:** never fabricate a limit number. Subscription (Pro/Max,
Codex) caps are NOT API-exposed — say so. Surface the REAL rolling-window usage we
already collect, and the key-based provider usage API only when a key is present.
Read-only; metadata-only (transcripts); no new deps.

---

## 1. Resolver (`src/core/observability/limits.ts`, new)

`resolveUsageWindows(cfg)` → `{ connected, windows[], providers[], note }`:
- `windows` — REAL: per-provider token+cost for last **5h** (Claude Code's true
  session window) and **24h**, from `collectUsageEvents` (transcript metadata).
- `providers` — when `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` present: `kind:'api-key'`
  + a best-effort call to the provider usage API (short timeout, degrade on any
  error). Else `kind:'subscription'` + an honest detail (caps not API-exposed).
  No fabricated `limit`.
- `note` — honest one-liner.

## 2. Wiring (`control.ts` + `app.js`/`styles.css`)

- `subscriptionLimits` in `buildControlSnapshot` becomes `{ connected, note,
  windows, providers }` (keep `connected`+`note` so the existing note still
  renders). The frontend Backends & Limits panel renders `windows` (rolling 5h/24h
  per-provider usage) + `providers` (kind badge + detail) beneath the note. The
  existing `limits[]` rate-window rendering is unchanged.

## HARD RULES + verification (`test/m63.*`)

1. **No fabricated caps** — with no API key, `providers` is `kind:'subscription'`
   with an honest detail and NO `limit`. → `m63.limits`.
2. **Real rolling windows** — `windows` computed from seeded usage events
   (5h/24h sums). → `m63.limits`.
3. **Never throws / degrades** — empty history + key-API failure ⇒ safe result. →
   `m63.limits`.
4. **Read-only + parity** — adds only a resolver + render; no mutation; existing
   `limits[]`/usage rendering unchanged. → full suite + `node --check app.js`.

## Deliverables
- [ ] `observability/limits.ts` · `control.ts` subscriptionLimits · `app.js`+`styles.css`
      rolling-window render · `test/m63.limits`.

## Non-goals
Fabricating subscription caps · scraping provider dashboards · Codex/Cursor admin
API (note as future) · changing the metadata-only privacy floor.

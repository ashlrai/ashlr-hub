# CONTRACT-M32 — Living Command Center: web approvals, cost estimates, help UX

**Pillar:** Ashlr v2.2 — turn the dashboard into a real command center (inbox
approve/reject, daemon visibility, dispatch with cost preview) and make the
day-to-day UX faster (topic help, knowledge progress, proposal notifications).

**Mason's hard rule:** the web security posture is UNCHANGED — 127.0.0.1 bind,
Host allowlist, every mutation behind `--allow-dispatch` + the per-session
constant-time-compared `x-ashlr-token`, application/json Content-Type required,
and applies still flow ONLY through `applyProposal`'s gates (enrollment, kill
switch, confirm). Notifications are opt-in and metadata-only.

---

## 1. Web inbox + daemon + dispatch

### Server (`src/core/web/api.ts`)
- `GET /api/inbox/:id` — full proposal detail incl. diff (read-only).
- `POST /api/inbox/:id/approve` / `POST /api/inbox/:id/reject` — gated
  IDENTICALLY to `POST /api/run`: routes return 404 unless the server was
  started `ashlr serve --allow-dispatch`; token + Content-Type checks; 409 when
  the proposal is not pending. Approve mirrors the CLI flow exactly
  (`setStatus('approved')` → `applyProposal(id, { confirmed: true })`).
- SSE `GET /api/events` gains named events `inbox` (pending count + metadata
  list — id/title/kind/repo/origin/createdAt, NEVER diffs) and `daemon`
  (DaemonState), alongside the existing `runs`/`swarms`.
- `GET /api/snapshot` gains the additive boolean `dispatchEnabled` so the
  frontend shows (not guesses) whether mutation surfaces exist.

### Frontend (`src/core/web/public/` — vanilla SPA, no framework, no deps)
- `#inbox` view: pending list + detail pane (diff HTML-escaped in `<pre>`),
  Approve/Reject buttons disabled-with-explanation unless `dispatchEnabled`
  AND a session token is entered. Token lives in **sessionStorage only**.
- `#daemon` view: state card + nav pending badge fed by SSE.
- Dispatch panel in `#runs`: goal + budget → live `/api/estimate` → POST
  `/api/run` (same gating as approve).

## 2. Pre-flight cost estimator (`src/core/observability/estimate.ts`)

- `estimateRun` / `estimateSwarm`: p25/median/p75 of tokens, steps, cost,
  duration from completed history (`listRuns()` / `listSwarms()`), keyword
  similarity weighting, budget clamping (`budgetClamped`), confidence tiers
  low (<3) / medium (<10) / high (≥10). PURE READ-ONLY; NEVER throws — empty
  or corrupt history yields a zeroed low-confidence estimate.
- Surfaces: `ashlr run "<goal>" --estimate`, `ashlr swarm "<goal>" --estimate`,
  an estimate footer in swarm `--dry-run`, and `GET /api/estimate` (read-only,
  no token — pure local computation).
- `RunEstimate` typed in `src/core/types.ts`.
- Supporting fix: `runsDir()` in `core/run/orchestrator.ts` is now re-resolved
  at call time (matches `swarmsDir()` convention) so tests can relocate HOME.

## 3. Help UX (`src/cli/help.ts`)

- The 96-entry inline table moved out of `cli/index.ts` into `HELP_ENTRIES`
  (topic-tagged data). `ashlr help` → grouped topic summary; `help <topic>` →
  per-topic table + flags + examples; `help --search <term>`; `help --all` →
  the legacy full table. Help always exits 0.

## 4. Knowledge build progress (`src/core/knowledge/index.ts`)

- `buildKnowledge` accepts `onProgress(ev)` (repo, repoIndex, repoCount,
  newChunks), wrapped so a throwing callback never violates the build's
  never-throws contract. CLI renders a single `\r`-rewritten stderr line only
  when stderr is a TTY and not `--json`; stdout stays clean.

## 5. Proposal notifications (opt-in, metadata only)

- `src/core/integrations/desktop-notify.ts` — macOS `osascript` via execFile
  (never a shell), title/body escaped into the AppleScript literal, 2s
  timeout, never throws. STRICT NO-OP unless `process.platform === 'darwin'`
  AND `cfg.notify.desktop === true`.
- `src/core/inbox/notify-proposal.ts` — fan-out (desktop + existing webhook
  `notify()`); carries title/kind/id ONLY — never the diff. Kept out of
  `inbox/store.ts` (pure-persistence contract).
- Fired from the swarm runner's propose path (the daemon-dispatched,
  unattended route) — fire-and-forget, never blocks the runner.
- `ashlr notify test` also pings the desktop channel when enabled.
- `NotifyTarget.desktop?: boolean` (additive).

## HARD RULES + verification

1. **Mutation routes don't exist without --allow-dispatch** (404, not 401).
   → m32.inbox-api.
2. **Token is constant-time-compared; wrong → 401; wrong type → 415; not
   pending → 409.** → m32.inbox-api.
3. **Apply path unchanged**: web approve goes through `applyProposal` and its
   triple gate; reject is pure persistence. → m32.inbox-api.
4. **SSE inbox event carries metadata only — no diffs.** → m32.inbox-api.
5. **Estimator is read-only + never throws; budget clamp visible.**
   → m32.estimate.
6. **Help never fails the shell (exit 0) and has no table drift vs
   completions.** → m32.help.
7. **Desktop notify is opt-in, darwin-only, escaped, never throws, never
   carries the diff.** → m32.desktop-notify.
8. **Progress callback can't break the knowledge build.**
   → m32.knowledge-progress.
9. **Non-regression**: full suite green; web token storage is
   sessionStorage-only; no new runtime deps; no framework added to public/.

## Deliverables checklist

- [x] api.ts: inbox detail + approve/reject routes, SSE inbox/daemon events,
      snapshot.dispatchEnabled, /api/estimate.
- [x] estimate.ts + RunEstimate type + run/swarm `--estimate` + dry-run footer.
- [x] help.ts topics/search/all + index.ts delegation.
- [x] knowledge onProgress + CLI progress line.
- [x] desktop-notify.ts + notify-proposal.ts + runner hook + notify test ping.
- [x] Frontend: #inbox, #daemon, dispatch panel, token drawer, SSE wiring.
- [x] Tests: m32.inbox-api, m32.estimate, m32.help, m32.desktop-notify,
      m32.knowledge-progress.
- [x] Docs: CHANGELOG M32 entry; README serve section updated.

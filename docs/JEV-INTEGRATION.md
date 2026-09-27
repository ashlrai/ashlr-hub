# TypeSafe AI (Jev) integration contract

Jev is a "System One" decision model: you send state plus typed questions and get back a label, a
probability distribution over the options, and a **separate confidence value**. Their framing is the
one that matters for this codebase: *the answer tells you what, confidence tells you whether to act.*

## Verified wire format (tested live against the real API)

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

Request. Note `criteria` is FLAT on the question, not nested under a `choice` key — the validator's
error path includes the union variant name, which is misleading:

```json
{ "model": "jev-latest",
  "state": "<the text being classified>",
  "questions": {
    "error_kind": { "type": "choice", "instructions": "...",
                    "criteria": { "label-a": "when this applies", "label-b": "..." } },
    "retryable":  { "type": "noul",  "instructions": "yes/no question" } } }
```

Response:

```json
{ "model": "jev-1.13.0",
  "answers": {
    "error_kind": { "type": "choice", "choice": "rate-limit", "confidence": 1.0,
                    "probabilities": { "rate-limit": 1.0, "timeout": 0.0 } },
    "retryable":  { "type": "noul", "noul": 0.91 } },
  "usage": { "input_tokens": 478, "output_tokens": 91 } }
```

Models: `jev-latest`, `jev-preview`. Several questions may be asked in ONE call — prefer that over
N calls. Credential lives at `~/.ashlr/secrets/typesafe.env` (mode 0600) as `TYPESAFE_API_KEY`;
resolve it through `resolveProviderKey` so Phantom wins when installed.

Measured behavior worth relying on: a bug-fix titled "Stop the dashboard from double-counting merges"
— zero bug-fix keywords — classified correctly at confidence 1.0, where the existing keyword table
fails. A deliberately ambiguous title returned confidence 0.57 with probability spread across
bug-fix/refactor. The calibration is real, so confidence is usable as a gate rather than decoration.

## Non-negotiable rules

1. **Never a hard dependency.** Every call site keeps its existing deterministic implementation and
   uses it when the API is unkeyed, unreachable, slow, or low-confidence. This hub is local-first and
   must work with no network. A classifier outage must degrade accuracy, never availability.
2. **Confidence-gated.** Below the call site's threshold, fall back to the deterministic answer. Do
   not silently accept a coin-flip. Record which path produced the answer.
3. **Never on a safety gate.** `swarm/gate.ts` riskScan, `inbox/merge.ts` classifyRisk and
   evaluateMergeAuthority, and the operational/cryptographic state machines stay deterministic. What
   matters there is auditability and reproducibility, not accuracy: a tightened regex is reviewable,
   a model changing its mind is not. If a classifier is ever wanted near these, it may only escalate
   further, never de-escalate.
4. **Never on a hot path.** Nothing per-token, per-keystroke, or per-filesystem-item. Classification
   is for decisions made once per task, per failure, or per proposal.
5. **Budget-aware.** This is a paid API. Batch questions into single calls, cache by input hash where
   the input repeats, and make it observable — a call that costs money should show up in usage the
   way engine dispatches do.

## Approved integration targets, in priority order

**1. Engine error classification** — `src/core/run/agent-diagnostics.ts:188`
`classifyAgentDiagnosticError` and `src/core/run/self-heal.ts:92` `classifyHealEvent`.
Seven ordered regexes plus a second overlapping substring table that already disagree about what
counts as a rate limit. Input is genuinely open-vocabulary: arbitrary stderr from the Claude CLI,
Codex, Ollama, LM Studio and NIM, each phrasing things differently and changing between versions.
Off the hot path (only fires on failure), small closed label set, recoverable if wrong, and the
output feeds retry policy, heal strategy and routing analytics. Unify the two into one typed call
with one label set. Ask the retryability Noul in the same request.

**2. Task-class labelling** — `src/core/fleet/skill-library.ts:294` `deriveTaskClass` and
`src/core/learn/reflect.ts:99` `classifyGoal`. Two keyword tables with *different* label
vocabularies doing the same job. `deriveTaskClass` is the partition key for learned routing priors
and skill retrieval, so a mislabel silently corrupts the statistics that choose engines. Runs once
per merged proposal, so latency is irrelevant. Consolidate to one label set; keep the regex table as
the offline fallback.

**3. Judge verdict extraction** — `src/core/fleet/manager.ts:381-455`. Do NOT replace the judge.
Replace its parser. Today: strict JSON.parse, then brace/bracket repair, then a multi-value scan,
then a stricter reprompt retry, then a synthetic 'review' tagged `judgeFailure: 'parse'` — a tracked,
recurring outcome. Typed questions make the four 1-5 dimensions and the four-value verdict a schema
guarantee and remove the wasted reprompt round-trip. The same treatment applies to
`fleet/taste-critic.ts:167` and `fleet/red-team.ts:159`, which hand-roll the same recovery — including
a fallback that *derives* a missing verdict label from the numeric score, exactly the silent
degradation a schema prevents.

Secondary, lower priority: `src/core/phantom.ts:804` `normalizeAgentReportCountKey` — four hardcoded
synonym tables over third-party agent output where every unrecognized value collapses to 'other'.

## The decision layer (`src/core/decide/**`)

Every call site goes through `decide(kind, state, questions, { fallback, threshold?, interpret?, escalateOnly? })`
or `decideEach(kind, items, question, …)` (N items, one call per 10). The layer supplies, for every site: a required
deterministic fallback, a per-kind threshold (registry → `~/.ashlr/jev/config.json` `thresholds` → call override), an
input-hash cache (6 h, in memory, successful answers only), a daily paid-call budget (`dailyCallBudget`, default 1500),
kill switches (`ASHLR_JEV_DISABLE=1`, `ASHLR_CLASSIFY_DISABLE=1`, or `enabled: false` / `disabledKinds` in the config
file — all checked before the cache), and a ledger at `~/.ashlr/jev/decisions/YYYY-MM-DD.jsonl` (path, reason,
confidence, tokens, est. cost, latency — never the classified text or the key). Safety-adjacent kinds are advisory or
escalate-only. Observability: `ashlr jev status`, `ashlr jev test "<text>"`, GET `/api/verse/jev`, the Resources (⌘.)
Jev card and the Usage "Jev decisions" panel. Cost is an estimate at placeholder per-token rates until real ones are set
(`inputUsdPerMTok` / `outputUsdPerMTok`).

| Kind | Where | Threshold | Fallback | Bound |
|---|---|---|---|---|
| engine-error | `classify/engine-errors.ts` (sandboxed-engine diagnostics) | 0.75 | unified regex/substring table | retry Noul in the same call |
| completion-claim | `classify/completion-claims.ts` | 0.75 | claim regexes | — |
| task-class | skill-library `deriveTaskClass`, reflect `classifyGoal`, retro `classifyTaskKind` | 0.75 | each module's own keyword table | sync memo primed in one batched call by async parents |
| judge-verdict | `fleet/manager.ts` before the reprompt | 0.9 | existing reprompt → tracked `parse` failure | verdict must be stated; no invented or negated `ship`; ship needs value≥3, correctness≥4 |
| taste-verdict | `fleet/taste-critic.ts` | 0.9 | neutral score / verdict derived from score | — |
| red-team-verdict | `fleet/red-team.ts` (prose replies only) | 0.85 | no finding | escalate-only: can only add a finding |
| retro-root-cause | `learn/retro/sweep.ts` | 0.75 | fixed code → category table | adds `category`; codes/labels untouched |
| needs-you-priority | `verse/activity.ts` (background, never awaited) | 0.75 | severity → expiry → age | re-ranks within a severity band only |
| interrupt-worthiness | exported `worthInterrupting` | 0.8 | severity/expiry/quiet-hours rule | never suppresses high/blocking |
| lane-choice | exported `chooseLane`; Devin fleet `laneAdvisor` | 0.8 | size/keyword heuristic over available lanes | advisor returns null on fallback; launcher only narrows |
| trigger-triage | exported `triageTrigger` | 0.8 | label/keyword triage | every part must clear the gate |
| action-class | `suggestActionClass`, called by `vision/leader-advice.ts` after `enactLeaderActions` (≤ 8 actions per memo) | 0.85 | the deterministic class | advisory, escalate-only: a `memo.actionAdvice` label and a line in the memo message; asked after every class and window is decided, read by no gate, can never lower a class or approve |
| operator-intent | exported `classifyOperatorIntent` | 0.8 | regex ladder | routing only; Jev can never introduce `approval` |

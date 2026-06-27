# SPEC-V6 — The Verification-First Fleet

> **North star:** ashlr-hub is an autonomous engineering fleet that ships
> production-quality software to main, end-to-end, with **zero human bottleneck** —
> the human supplies vision; the fleet builds, *verifies*, measures, and improves itself.
>
> **The 2026 thesis (this spec's reason to exist):** the frontier has moved
> **from generation to verification.** Modern models already write good code;
> what separates a ~66% SWE-bench fleet from a ~79% one is a **trained critic +
> best-of-N + an execution-feedback loop** — not a better generator. ashlr-hub's
> machinery is broad, but its *verification* and *signal* have been thin. V6 fixes
> that. (Research synthesis: 6 parallel streams, 2026-06-27 — see Provenance.)

## The loop V6 closes

```
   clean INPUTS  →  VERIFY outputs  →  MEASURE  →  SELF-IMPROVE  →  (better inputs)
   (v4/v5 + M133/    (M140/M142)       (M143/M141)   (M141-fed)
    M135/M136 — done)
```

The v4/v5 work (tiered backends, tiered-trust merge-to-main, the Manager judge,
the Elon strategist, value-filtered backlog, the iMessage channel) built the
*organism*. V5.x this cycle cleaned the **inputs** (scanTodos-off killed the
marker-flood; the judge now runs on claude-sonnet not a parse-failing 72b). V6
makes the fleet **verify what it produces, measure whether it's improving, and use
that signal to improve itself.**

## Pillars (milestones)

### M140 — The engine actually verifies *(foundation)*
The test-iterate loop must **run the repo's real tests in the sandbox** and iterate
to green (not a heuristic + a cheap "looks done?" check), lint/typecheck each edit
before spending a test run, and apply patches through an **Aider-style fuzzy ladder**
(exact → whitespace-flex → elision → fuzzy-0.8 → structured "did-you-mean" re-prompt)
so the cheap local tier — which drifts most — stops wasting calls on exact-match
failures. *Closes the gap between "engine claims done" and the suite-green merge gate.*

### M141 — Persist the judge's reasoning *(the substrate)*
The Manager judge emits a **full CoT trace + sub-scores**, persisted with the
proposal's eventual real-world **outcome** (merged / reverted / rejected). Today only
a 200-char rationale survives — V6 keeps the teacher signal. This single store is the
prerequisite for calibration (below), best-of-N critics, and distillation.

### M142 — Best-of-N with a critic *(free quality)*
Local compute is free. Generate **N candidate diffs**, score each with the judge as a
**Rubric-Supervised critic**, prefer candidates that **pass the real test loop**, and
propose the winner. 2026 evidence: Best@8 ≈ **+15.9 points** over a single sample.

### M143 — Measure: internal SWE-bench regression gate *(the missing instrument)*
A **self-hosted SWE-bench Verified / SWE-rebench** harness as an internal regression
benchmark — the fleet can finally answer "are we improving?" with a number, fixing the
broken/NaN health signal the strategist flagged. (Public leaderboards take only academic
submissions, so this stays internal; SWE-rebench is contamination-free for honest self-eval.)

### M144 — Faster, better local *(the substrate under everything)*
A **llama.cpp `llama-server`** backend with **EAGLE-3 speculative decoding + continuous
batching + prefix-caching** (all now native on Apple Silicon in 2026) — ~1.5–2.5×+ faster
local at zero quality cost — and a model upgrade: **qwen2.5-coder:32b → qwen3-coder-next**
(80B-A3B q4, ~52GB, fits the 128GB Mac, a generation ahead). Best-of-N (M142) is only free
*because* local is fast.

## The horizon (V6.x — self-improvement, fed by M141)
- **ACE delta-curated playbooks** for the strategist spec + judge rubric — append/curate
  deltas instead of rewriting whole memory each loop (kills "context collapse").
- **DSPy 3.3 + GEPA/SIMBA** optimizing the judge + strategist prompts against accept/reject
  outcomes (~35× fewer rollouts than RL).
- **EDV — separate-verifier-before-memory-write:** never let the judge's own accepted
  trajectory feed back as ground truth; a separate local verifier confirms before the
  re-ranker updates (closes the "self-confirmation trap").
- **Judge calibration:** report Cohen's **kappa** (not accuracy), subtract per-judge
  "dark current," and a **BabelJudge degradation harness** (corrupt known-good merged
  commits, check the judge recovers them) — self-calibration with **zero human labels**.
- **On-policy / ROPD distillation** of the claude-sonnet judge into a reasoning-native
  local base (DeepSeek-R1-Distill / Qwen3) using the M141 traces + test-pass signal —
  a frontier-quality judge that runs free, locally.
- **DBOS durable suspend/resume** of in-flight ticks — crash-safe long-running work
  (the one primitive every 2026 orchestration framework converged on).
- **Localization + repo-map** (Agentless/LocAgent graph-guided + tree-sitter PageRank)
  feeding a **cheap-first cascade gated on build/test** before any frontier escalation
  (45–85% cost cut at ~95% quality); escalation-rate tracked as a first-class metric.

## Invariants (unchanged from v4/v5 — V6 strengthens, never weakens)
- **Proposal-only floor**, kill-switch, enrollment, append-only audit.
- **Merge gates**: risk ≤ low, scope-cap, **suite-green** (now *honest* — M140 makes the
  engine actually run it), frontier-provenance, M54 never-weaken-self + parity.
- Best-of-N / critic selection happens **before** the gate, never bypasses it.
- iMessage human-gate (approve-by-text) sits **on top of** the automated gates.
- `$0` posture: prefer local/subscription; frontier only on verified escalation.

## Reference architectures (study; verify repos firsthand — see caveat)
OpenHands `software-agent-sdk` + ACP (cross-backend protocol) · AgentScope 2.0 permission
guards (maps to tri-tier trust) · mini-SWE-agent (~100 LOC, >74% Verified — a cheap executor
tier + eval harness) · Kilo Code git-worktree-per-session (safe parallel workers).

## Provenance & integrity
Synthesized 2026-06-27 from six parallel research streams (coding harnesses · model
routing/serving · agent reasoning/quality · orchestration · + live-2026 passes on models
and reasoning). **Caveat:** WebSearch was blocked that session; agents used WebFetch, whose
summarizer was caught **fabricating GitHub repo/star data** — so arXiv IDs, official release
dates, and technique *mechanisms* are trustworthy, but any specific repo/popularity claim
(e.g. "Hermes"/"OpenClaw") must be verified firsthand before it's load-bearing.

# Ashlr v3 — Local Engineering Weapon (end-state spec)

> A sibling to `docs/SPEC-V3-TEAM.md`. That spec makes ashlr **plural** across
> machines. This one makes the **local model** on each of those machines a
> genuine autonomous engineer — so the $0, private, local-first path is not the
> compromise option but the weapon. Same safety posture, zero new runtime deps.

---

## 1. North Star

**A local model on your own machine, driven by ashlr's harness, completes real
engineering tasks — read, reason, edit, run, verify, repair — reliably enough to
trust, for $0 and fully private. The harness, not the model, is what makes it
incredible.**

v1 built the command center. v2 made it an autonomous, safe organization. v2.2
made it agent-native. v3-Team makes it plural. **v3-Weapon makes the local tier
strong** — so most work never needs the cloud at all.

The premise: weak local models live or die by their scaffolding. A 7B coder with
a disciplined prompt, a real tool surface, model-adaptive limits, and a
verify→repair loop outperforms a 70B model poked with two sentences and no tools.
We already route local-first (`src/core/run/router.ts`); v3-Weapon makes that
default path actually capable.

## 2. A Day in the Life (the end state, as scenes)

Every scene maps to a roadmap row in §7 — no scene ships without its milestone.

- **Prompt.** `ashlr run "fix the failing date-parsing test"` picks the best
  local model, resolves its capability profile, and assembles a Fable-5-grade
  system prompt sized to that model's context window. *(M41 — shipped)*
- **Act.** The agent calls `grep` and `read_file` to locate the bug, `edit_file`
  to fix it — all inside a throwaway git worktree, never the live tree. *(M42)*
- **Verify.** It detects `vitest`, runs the suite, sees one still-red test, and
  feeds the failure back to itself. *(M43)*
- **Repair.** Two bounded repair iterations later the suite is green; the diff
  lands in the approval inbox as a PENDING proposal. Mason approves it. *(M42, M43)*
- **Prove.** `ashlr eval --local` reports that qwen2.5-coder:7b now solves 8/10
  fixture tasks vs 3/10 before the harness — measured, not asserted. *(M44)*

## 3. Operating Principles (adds to v1/v2/v3-Team)

1. **The harness carries the model.** Capability comes from scaffolding —
   prompts, tools, loops, limits — not from hoping the model is smart.
2. **Adaptive, never one-size.** A 1.5B model and a 32B coder get different
   prompts, step caps, temperatures, and tool formats. Auto-detected, no config.
3. **Token-frugal by construction.** Small context windows are the constraint.
   Terse profiles must make small-model prompts *shorter* than the legacy two
   sentences, not longer. This repo's identity is token savings.
4. **Real tools, real sandbox.** A local agent that can't edit/run code isn't an
   engineer. Give it the tools — inside a worktree, behind the kill-switch, with
   diffs gated to the human inbox. Nothing reaches the live tree unapproved.
5. **Recover, don't just fail.** plan→act→verify→repair. A weak model that fixes
   its own red test beats a strong model that confidently ships a broken one.
6. **Local-first degradation is sacred.** Every feature here is additive and
   gated. Flag off ⇒ exactly today's behavior, byte-for-byte.

## 4. Architecture Overview

The hub already owns its agent loop: `runGoal` → `planGoal` → task DAG →
`runTask` ReAct loop (`agent-loop.ts`), over `provider-client.ts`
(Ollama `/api/chat`, LM Studio `/v1/chat/completions`). v3-Weapon adds three
layers around that spine, all gated by `cfg.models.adaptivePrompts` /
`ASHLR_ADAPTIVE_PROMPTS`:

- **Prompt suite** (`src/core/run/prompts/`): layered, verbosity-tiered system
  prompts (base persona → tool discipline → output contract → role → memory),
  budgeted by a single authority that truncates memory before discipline.
- **Model profiles** (`src/core/run/model-profile.ts`): name-pattern → profile
  (verbosity, tool format, step cap, temperature, prompt/context budget),
  reusing the existing size/coder vocabulary from `pickModel`.
- **Engineering surface + repair** (M42/M43): in-process executable tools and a
  verify→repair controller wrapping the existing M11 retry / M20 self-heal.

## 5. Capability Pillars

| Pillar | What it delivers | Milestone |
|---|---|---|
| Adaptive prompt suite | Disciplined, model-sized system prompts replacing the 2-sentence executor prompt | **M41 (shipped)** |
| Model profiles | Auto-tuned verbosity / step-cap / temperature / tool-format per installed model | **M41 (shipped)** |
| Engineering tool surface | Sandboxed read/glob/grep/write/edit/bash, diffs → inbox (scrubbed) | M42 ✓ |
| Verify→repair loop | Detect typecheck/test/lint, feed failures back, bounded repairs | M43 ✓ |
| Local-agent eval + hardening | `ashlr eval` measures uplift per model; profile overrides | M44 ✓ |

## 6. Roadmap (M41–M44)

| M | Name | Value | Effort | Status |
|---|---|---|---|---|
| **M41** | Adaptive Prompt Suite + Profiles | Disciplined, model-adaptive prompts; auto-detected profiles | M | **Shipped** |
| **M42** | Engineering Tool Surface | Local agent can actually edit/run code (sandboxed, gated, inbox-routed) | M–L | **Shipped** |
| **M43** | Verify→Repair Loop | Local agent recovers from its own failures | M | **Shipped** |
| **M44** | Local-Agent Eval + Hardening | Prove the uplift via `ashlr eval` | M | **Shipped** |

**M42 hardening (post adversarial review):** symlink-parent write/read escape closed (canonical-ancestor boundary check); sandbox teardown guaranteed via `try/finally` on every exit incl. exceptions; inbox proposal diff scrubbed; secret-file (`.env`/`*.pem`/`id_rsa`/credentials) reads refused; `bash` URL-host allow-list (localhost only) + expanded deny-list; pre-read size guard. `bash` stays double-opt-in (`--engineer --bash`), off by default, documented as local code execution.

Effort: S ≈ 1–2d, M ≈ 3–5d, L ≈ 1–2w.

**Key pre-M42 finding:** the hub's own loop currently advertises tools but cannot
execute them — `loadGatewayTools` returns specs with no `fn`, so every tool call
returns *"Tool '<name>' is not available in this context."* M42 must make tools
executable in-process before adding the engineering surface.

## 7. Hard Gates (the loop STOPS and asks)

- Any `write`/`exec` tool while the kill-switch (`~/.ashlr/KILL`) is present.
- Applying a diff to the live working tree — only via the human approval inbox.
- Enabling `bash` (M42) — double opt-in (`--engineer` then `--bash`).
- Flipping `adaptivePrompts` to default-ON — requires the eval suite (M44) to
  show non-regression on the founders' installed models.

## 8. Safety Invariants (each → a named adversarial test)

1. **Local-first degradation** — flag off ⇒ legacy prompts + `TASK_STEP_CAP`
   unchanged. → `m41.prompts` legacy-default test; full suite green flag-off.
2. **Token frugality** — every profile's assembled prompt ≤ its `promptCharCap`;
   small-model prompts ≤ the legacy length. → `m41.prompts` cap tests.
3. **Discipline survives budget pressure** — memory truncated/dropped first,
   never base/tool/output/role. → `m41.prompts` truncation test.
4. **Profile purity** — resolution is deterministic, no I/O, never mutates shared
   constants. → `m41.model-profile` immutability test.
5. **Verbatim contracts** — planner/synthesizer text is single-sourced and
   byte-identical across flag states. → `m41.prompts` verbatim tests.
6. **(M42 ✓) Kill-switch refuses write/exec structurally; capability-gated.** → `m42.engineer-tools` tests.
7. **(M42 ✓) Writes stay in a sandbox worktree; diffs only reach the tree via the
   human approval inbox (scrubbed).** → orchestrator `finalizeEngineer` + `m42` tests.
8. **(M42 ✓) Path/symlink escape from the workspace boundary is refused** (incl.
   symlinked-parent on not-yet-existing targets). → `m42.engineer-tools` escape tests.
9. **(M43 ✓) Repair bounded by `maxRepairs` + step-cap + global budget.** → `m43` + orchestrator tests.
10. **(M42 ✓) `bash` double-opt-in, off by default, env-sanitized (no inherited API
    keys), localhost-only egress allow-list, timeout+SIGKILL bounded.** → `m42` tests.

## 9. Non-Goals (explicit)

- Training/fine-tuning models. We only orchestrate them.
- A new local-model runtime — we use Ollama / LM Studio as they are.
- Cloud parity. The cloud tier still exists for escalation; this makes the local
  tier *good enough that escalation is rare*, not identical.
- OS-level sandboxing. The boundary is the git worktree + sanitized env + gates.
- New runtime dependencies. v3-Weapon ships with zero.

## 10. Success Metrics (measurable)

- A 7B coder model solves ≥ 2× the fixture tasks with the harness vs without
  (M44 eval), at $0.
- Small-model system prompts are *shorter* than the legacy prompt (token check).
- Flag-on full suite is green except pre-existing environmental failures.
- Median local run needs **zero** cloud escalation on the fixture set.

## 11. Verification (per milestone)

- **M41 (done):** `tsc` clean; `eslint` clean; full suite green flag-off
  (byte-identical) and flag-on (except pre-existing env failures); 21 new unit
  tests; end-to-end before/after on a real local model via
  `ASHLR_ADAPTIVE_PROMPTS=0|1 ashlr run "<task>" --json`.
- **M42:** boundary-escape + kill-switch refusal tests; sandboxed diff → inbox.
- **M43:** verify-command detection on fixtures; bounded repair test.
- **M44:** the eval harness itself is the verification — uplift numbers per model.

## 12. Living-Spec Mechanics

This spec travels through git and is reviewed like code. Each milestone updates
its row in §6 and ticks its invariants in §8 with the test that proves them. When
M44's eval shows non-regression on the founders' models, the §7 gate to flip
`adaptivePrompts` default-ON opens.

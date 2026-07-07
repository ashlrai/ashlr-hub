# cfg.foundry — Polyglot Backend Configuration

This document describes every field in the `foundry` block of `~/.ashlr/config.json`.
A copy-pasteable example lives at `docs/examples/foundry.config.json`.

See `docs/SPEC-V5-OPEN-FLEET.md` for the full v5 Open Fleet design that this
configuration severs.

---

## Overview

`cfg.foundry` is **entirely opt-in**. When absent, ashlr behaves identically to
v4: the builtin local agent runs unmodified, no external CLI is spawned, and
nothing auto-merges. Every field below only takes effect when `foundry` is present.

All of the v5 fleet safety guarantees are enforced regardless of what you put in
this block:

- **Proposal-first**: work is always a diff proposal routed through the M23 inbox
  before any outward mutation.
- **Tier gate**: only `frontier` backends (claude + codex in the builtin roster)
  may ever reach `main`. Mid-tier and local backends are branch-eligible only.
- **No implicit frontier**: a malformed or tier-less entry added via
  `cfg.foundry.engines` is silently dropped, never promoted.

---

## Fields

### `allowedBackends`

```json
"allowedBackends": ["builtin", "claude", "codex", "hermes"]
```

An allowlist of backend ids the fleet scheduler may dispatch work to. Any id not
in this list is never used, even if an `engines` entry defines it.

- Absent → `["builtin"]` only (the pre-v4 default).
- The builtin engine is always available regardless of this list.
- Only ids that are either in the builtin registry OR defined in `engines` are
  meaningful here.

**Installed backends on this machine (probed):** `claude`, `codex`, `hermes`, `aw`,
`ollama`. `opencode` and `kimi` are config-only additions (binary absent / API
key required).

---

### `models`

```json
"models": {
  "claude": "claude-opus-4-5",
  "codex":  "gpt-5o",
  "hermes": "hermes-3-llama-3.1-70b"
}
```

Per-backend preferred model id. Keyed by engine id. Passed as `--model` (or
equivalent) when the engine supports a model override. Absent for an engine means
the engine's own default is used.

- `builtin` has no model override; omit it here.
- The string is passed verbatim as a single argv element (injection-safe).
- For `api-model` engines, this overrides `api.defaultModel`.

---

### `claude5` (M320–M321)

```json
"claude5": {
  "enabled": true,
  "fable": true
}
```

Claude 5 generation rollout. **Absent ⇒ enabled** — both fields default `true`.

- `enabled: false` — full rollback: `claude:sonnet-5` / `claude:fable-5` are
  excluded from routing and every model default reverts to the pre-M320 values
  (byte-identical routing, verified by the m128/m164/m155 parity suites).
- `fable: false` — keep Sonnet 5 as the routing workhorse but revert the
  judge + strategist defaults to `claude-opus-4-8`.
- With the rollout on: Sonnet 5 (`claude-sonnet-5`, frontier-class coding at
  $3/$15 per MTok) is the default claude pick for hard/medium work; Fable 5
  (`claude-fable-5`, Mythos-class, $10/$50) is the default judge/strategist,
  with an automatic per-call fallback to Opus 4.8 when a Fable call fails, is
  refused, or returns empty.
- Claude 5 dispatches always use the FULL API id (`--model claude-sonnet-5`);
  legacy entries keep their short tags.
- **Auto-merge note:** if `autoMerge.enabled` is on, add
  `{ "engine": "claude", "model": "claude-sonnet-5" }` to `mergeAuthority` —
  otherwise Sonnet 5 proposals verify + judge but never auto-merge (an
  effective-config warning surfaces this).

---

### `modelGranularRouting` (M323)

```json
"modelGranularRouting": {
  "enabled": true,
  "minShipRate": 0.6
}
```

Cost-aware, model-granular learned routing. **DEFAULT OFF.** When enabled,
`routeTask` prefers the CHEAPEST catalog model whose learned producer
ship-rate clears `minShipRate` (default 0.6) with ≥5 judged samples for the
task class. Ship-rates are producer-attributed: judge verdicts are joined back
to the `proposed` ledger entry by proposalId, so the judge's own model never
pollutes the scores.

- Cold start / thin samples → the static policy pick, byte-identically.
- The selector never learns INTO a bad model: candidates scoring < 0.5 are
  refused even when nothing clears the bar.
- Hard constraints are untouched: `models` overrides, availability, quota,
  trust tier, and `claude5` gating all still apply first.
- Deliberately NOT under `intelligence` — that block's presence activates the
  M53 anomaly/budget nudges, which this flag must not silently switch on.

---

### `verifyToGreen` (M331)

```json
"verifyToGreen": {
  "enabled": true,
  "maxIterations": 3,
  "perRunTimeoutMs": 180000,
  "failureTailBytes": 8192
}
```

Bounded engine repair loop before a proposal is filed. **DEFAULT OFF.** When
the M275 completeness gate fails a cli-agent run, the SAME engine is
re-invoked inside the SAME confined worktree (identical contained env + OS
sandbox launcher — jail and severed push fully preserved) with the
verification-failure tail, up to `maxIterations` (clamped 1–5) times. A green
worktree is re-captured and RE-SIGNED before filing; a still-red worktree is
simply not filed (fail-closed). Flag-off is the byte-identical single-shot
gate. The api-model path is out of scope (agent-loop patch application).

---

### `bestOfN` / `bestOfNCandidates` / `bestOfNMinItemScore` (M170/M333)

```json
"bestOfN": 3,
"bestOfNCandidates": [
  { "engine": "claude", "model": "claude-sonnet-5" },
  { "engine": "codex" },
  { "engine": "local-coder" }
],
"bestOfNMinItemScore": 7
```

Multi-model best-of-N: generate N candidates and let the critic pick the
winner (test-passing candidates preferred once M331's `run-tests` is
available — it is, since M331).

- `bestOfN` (default 1 = single dispatch) — formalized in M333 after being
  read via `as any` since M170.
- `bestOfNCandidates` — candidate i runs on `specs[i % specs.length]` with
  its own engine/model + runner kind. Entries not in `allowedBackends` are
  dropped at dispatch. Absent → single-engine stochastic resampling.
- `bestOfNMinItemScore` — fan out only for items whose score clears the
  threshold; below it, single dispatch. Absent → every item fans out.
- **Cost:** the daemon counts EVERY candidate's billable spend (the M80
  subscription-\$0 rule applied per candidate) against the tick budget — not
  just the winner's. Losers are rejected with a provenance reason naming the
  winner, so the inbox holds exactly one pending proposal per item.
- **Trust unchanged:** a winning mid/local candidate keeps its tier tag and
  can never gain main merge authority.
- Per-candidate records land in `~/.ashlr/best-of-n/` (win rates feed the
  dashboard Models tab).

---

### `outcomeWatcher` (M332)

```json
"outcomeWatcher": true
```

Maintenance pass linking REAL-WORLD outcomes back onto judge traces: a
`git revert` of an auto-merged proposal → outcome `reverted`; a near-term fix
commit touching the same files → `followed-up`. READ-ONLY on repos,
append-only ledgers, internally throttled to one scan per 6h. **DEFAULT ON**
(telemetry enrichment only — no behavior change); set `false` to disable.
Learned routing counts a reverted merge as a full extra reject on the
producer model (follow-up = half), so the judge's moment-of-merge verdict is
corrected by what actually happened on `main`.

---

### `fabric.gatewayShadow` (M334 stage 1)

```json
"fabric": { "gatewayShadow": true }
```

Runs the M247 InferenceGateway OBSERVE-ONLY beside the live legacy routing
path and records decision divergences to
`~/.ashlr/fabric/gateway-shadow-*.jsonl`. **The legacy result always wins.**
`divergenceStats()` evaluates the staged-activation exit criteria live
(≥200 decisions, <2% divergence, ZERO safety-relevant divergences — see
[`docs/contracts/CONTRACT-M334.md`](./contracts/CONTRACT-M334.md) for the
full three-stage program before flipping `fabric.gateway` /
`fabric.concurrentDispatch` defaults). DEFAULT off; ignored when
`fabric.gateway` is already live.

---

### `engines`

```json
"engines": {
  "kimi": { "kind": "api-model", "tier": "mid", "api": { ... } },
  "opencode": { "kind": "cli-agent", "tier": "local", "bin": "opencode", ... }
}
```

Declarative engine additions (and overrides). Merged over `BUILTIN_ENGINE_REGISTRY`
by `resolveEngineRegistry`. **Adding a backend is config-only** — no code branch,
no code change.

Every entry must have:

| Field  | Required | Values                              |
|--------|----------|-------------------------------------|
| `id`   | yes      | `[a-z][a-z0-9-]{0,39}` (map key honored if omitted) |
| `kind` | yes      | `"builtin"` · `"cli-agent"` · `"api-model"` |
| `tier` | yes      | `"local"` · `"mid"` · `"frontier"` |

A missing or invalid `tier` causes the entry to be **dropped** — never silently
promoted. This is the "no implicit frontier" guardrail.

#### `cli-agent` shape

```json
{
  "id": "opencode",
  "kind": "cli-agent",
  "tier": "local",
  "bin": "opencode",
  "bins": ["opencode"],
  "argv": ["run", "$GOAL", { "optModel": ["--model", "$MODEL"] }],
  "capabilities": ["agent", "edit"]
}
```

- `bin`: executable name to spawn.
- `bins`: PATH probe candidates for `engineInstalled` (defaults to `[bin ?? id]`).
- `argv`: declarative argv template. The special tokens `$GOAL`, `$CWD`, `$MODEL`
  are substituted as whole argv elements (never shell-split). `{ "optModel": [...] }`
  is emitted only when a model is present.
- `autonomousArgv`: extra args appended when running unattended (e.g. `["--yolo"]`
  for hermes).
- `capabilities`: free-form tags for capability-aware routing.

#### `api-model` shape

```json
{
  "id": "kimi",
  "kind": "api-model",
  "tier": "mid",
  "api": {
    "envKey": "MOONSHOT_API_KEY",
    "defaultBaseUrl": "https://api.moonshot.ai/v1",
    "defaultModel": "kimi-k2-0711-preview",
    "protocol": "openai"
  },
  "capabilities": ["agent", "edit", "architecture"]
}
```

`api-model` engines have no CLI argv; the run loop drives them directly through
`buildOpenAICompatibleClient`. `buildEngineCommand` returns `null` for these
entries — this is expected and correct.

#### API provider env vars and base URLs

| Provider id    | Env key               | Default base URL                         | Needs `--allow-cloud` |
|----------------|-----------------------|------------------------------------------|-----------------------|
| `nvidia_nim`   | `NVIDIA_NIM_API_KEY`  | `https://integrate.api.nvidia.com/v1`    | yes                   |
| `moonshot`/`kimi` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1`            | yes                   |
| `hermes_api`   | `HERMES_API_KEY`      | `https://openrouter.ai/api/v1`           | yes                   |

All cloud providers require `--allow-cloud` to be passed at runtime and the env
key to be present. Without both, the run refuses with a local-first error. Secrets
are managed by phantom — never put raw keys in `config.json`.

The base URL can be overridden per-provider with a `baseUrlEnv` field (e.g.
`"baseUrlEnv": "MOONSHOT_BASE_URL"`).

---

### `mergeAuthority`

```json
"mergeAuthority": [
  { "engine": "claude", "model": "claude-opus-4-5" },
  { "engine": "codex",  "model": "gpt-5o" }
]
```

Allowlist of `{engine, model}` pairs that may ever auto-apply a proposal to `main`.
The gate is enforced by the M47 tiered-trust merge gate — a proposal only passes
when **all** of the following hold:

1. The engine's registry `tier` is `"frontier"`.
2. The `{engine, model}` pair appears in this list.
3. `autoMerge.enabled` is `true`.
4. Full verification passes and risk class ≤ `autoMerge.maxRisk`.

**Mid-tier and local backends are intentionally absent from this list.** `hermes`
(tier `"mid"`), `kimi` (tier `"mid"`), `opencode` (tier `"local"`), `builtin`
(tier `"local"`) can never satisfy rule 1, so they can never reach `main` even
if you added them here. The fleet scheduler enforces this invariant (tested in
`test/m51.trust.test.ts`).

**M320 — spelling-variant-safe matching.** Entries match through
`canonicalModelTag`, so `"sonnet-5"`, `"claude-sonnet-5"`, and a proposal's
doubled `claude:claude-sonnet-5` engineModel all land on the same key — a
spelling mismatch can never silently disable auto-merge for an authorized
model. With the Claude 5 rollout on, include
`{ "engine": "claude", "model": "claude-sonnet-5" }` so the Sonnet 5 workhorse
can auto-merge (and optionally `claude-fable-5`).

---

### `limits`

```json
"limits": {
  "claude": { "window": "5h", "max": 50 },
  "codex":  { "window": "5h", "max": 50 }
}
```

Per-backend rate caps for subscription backends (flat-fee, rate-limited — not
token-billed). `window` is a human label (`"1m"`, `"5m"`, `"1h"`, `"5h"`, `"1d"`);
`max` is the maximum dispatches per rolling window. Absent → unlimited.

Use this to stay within your Claude Pro or Codex subscription quotas without
watching usage manually.

---

### `confinement`

```json
"confinement": {
  "*": {
    "mode": "os",
    "networkEgress": false,
    "onUnsupported": "fallback"
  }
}
```

OS-level confinement profiles for spawned external engines (M52). When present,
external engine spawns are wrapped in a platform-native read-jail:

- **macOS**: `sandbox-exec` with a generated policy that confines file reads to
  the worktree + vendor config homes.
- **Linux**: `bwrap` (bubblewrap) with an equivalent bind-mount policy.

`*` sets a fleet-wide default; per-engine keys (e.g. `"claude": { ... }`) override
it for that engine only.

| Field           | Values                         | Default      |
|-----------------|-------------------------------|--------------|
| `mode`          | `"off"` · `"os"`              | `"off"`      |
| `readAllowed`   | extra absolute read paths     | `[]`         |
| `networkEgress` | `true` · `false`              | `false`      |
| `onUnsupported` | `"fallback"` · `"fail"`       | `"fallback"` |

`"fallback"` means: if the platform has no jail binary (e.g. `bwrap` not
installed), fall back to env-only containment (v4 behavior) and emit an audit
entry. `"fail"` aborts the run instead.

Setting `"mode": "off"` restores v4 env-only containment for that engine.

---

### `autoMerge`

```json
"autoMerge": {
  "enabled": false
}
```

**Default: disabled.** The kill switch for the entire tiered-trust auto-merge
path. When `false` (or absent), proposals never auto-apply to `main` regardless
of tier, mergeAuthority, or verification result — everything goes through the M23
inbox for manual approval.

Set `enabled: true` only after you have validated the mergeAuthority list and
are confident in the verification harness. Additional guards:

| Field                     | Default   | Effect when `enabled: true`                         |
|---------------------------|-----------|-----------------------------------------------------|
| `maxRisk`                 | `"low"`   | Only `"low"` risk proposals auto-merge.             |
| `pushToRemote`            | `false`   | Also run `gh pr merge` when applying.               |
| `allowWithoutVerification`| `false`   | Fail-closed: refuse auto-merge with no tests found. |

---

## Adding a Backend (Config-Only Walkthrough)

No source edits needed. The three curated api-model engines (`nim`, `kimi`,
`openai-compat`) are **already in the builtin registry** — they just need to be
opted into via `allowedBackends` and have their API key set.

---

### Enabling NVIDIA NIMs

NVIDIA NIM exposes an OpenAI-compatible API at `https://integrate.api.nvidia.com/v1`.
It supports any model on [build.nvidia.com](https://build.nvidia.com).

**Step 1 — Set your API key via phantom (never put keys in config.json):**

```sh
phantom add NVIDIA_NIM_API_KEY
```

**Step 2 — Add `nim` to `allowedBackends` in `~/.ashlr/config.json`:**

```json
{
  "foundry": {
    "allowedBackends": ["builtin", "claude", "codex", "nim"],
    "models": {
      "nim": "meta/llama-3.1-70b-instruct"
    }
  }
}
```

`nim` is already registered in the builtin engine roster as an `api-model` (tier
`mid`) pointing at `https://integrate.api.nvidia.com/v1`. No `engines` block
needed unless you want to override the base URL or default model.

**Optional — override the base URL or model:**

```json
{
  "foundry": {
    "allowedBackends": ["builtin", "claude", "codex", "nim"],
    "engines": {
      "nim": {
        "id": "nim",
        "kind": "api-model",
        "tier": "mid",
        "api": {
          "envKey": "NVIDIA_NIM_API_KEY",
          "baseUrlEnv": "NVIDIA_NIM_BASE_URL",
          "defaultBaseUrl": "https://integrate.api.nvidia.com/v1",
          "defaultModel": "meta/llama-3.1-405b-instruct",
          "protocol": "openai"
        },
        "capabilities": ["agent", "edit", "tools"]
      }
    }
  }
}
```

Or set a custom endpoint at runtime: `NVIDIA_NIM_BASE_URL=https://my-nim.internal/v1`

**Step 3 — Run with `--allow-cloud`:**

```sh
ashlr run --allow-cloud "harden the inbox apply path"
```

`ashlr models` will show NIM with its readiness status (key present? reachable?).

**Trust tier:** `nim` is `mid` — branch-eligible after verification, never
merge-authority for `main`. It cannot reach `main` regardless of `mergeAuthority`
unless you explicitly promote it to `frontier` and add it to `mergeAuthority`
(requires a code-reviewed change to the builtin registry).

---

### Enabling Moonshot/Kimi

```sh
phantom add MOONSHOT_API_KEY
```

```json
{
  "foundry": {
    "allowedBackends": ["builtin", "claude", "kimi"],
    "models": {
      "kimi": "kimi-k2-0711-preview"
    }
  }
}
```

Base URL: `https://api.moonshot.ai/v1`. Override via `MOONSHOT_BASE_URL`.

---

### Enabling a Generic OpenAI-Compatible Endpoint

Covers vLLM, Together AI, Fireworks, Anyscale, local `openai-compat` servers, etc.

```sh
phantom add OPENAI_COMPAT_API_KEY
```

```json
{
  "foundry": {
    "allowedBackends": ["builtin", "openai-compat"],
    "models": {
      "openai-compat": "my-model-name"
    }
  }
}
```

Set the base URL: `OPENAI_COMPAT_BASE_URL=https://my-vllm.example.com/v1`

The `openai-compat` engine defaults to `http://localhost:8000/v1` (common vLLM
default). Any server that speaks `/v1/chat/completions` works.

---

### API Engine Environment Variables

| Engine id      | Key env var               | Base URL env var          | Default base URL                      |
|----------------|---------------------------|---------------------------|---------------------------------------|
| `nim`          | `NVIDIA_NIM_API_KEY`      | `NVIDIA_NIM_BASE_URL`     | `https://integrate.api.nvidia.com/v1` |
| `kimi`         | `MOONSHOT_API_KEY`        | `MOONSHOT_BASE_URL`       | `https://api.moonshot.ai/v1`          |
| `openai-compat`| `OPENAI_COMPAT_API_KEY`   | `OPENAI_COMPAT_BASE_URL`  | `http://localhost:8000/v1`            |

All three require `--allow-cloud` at runtime (cloud-provider gate). Secrets are
managed by phantom — never put raw keys in `config.json`.

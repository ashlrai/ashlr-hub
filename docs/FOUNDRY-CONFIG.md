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

No source edits needed. Example: adding NVIDIA NIM as a mid-tier api-model.

1. Set your API key via phantom: `phantom add NVIDIA_NIM_API_KEY`

2. Add the engine entry to `~/.ashlr/config.json`:

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
          "defaultBaseUrl": "https://integrate.api.nvidia.com/v1",
          "defaultModel": "meta/llama-3.1-70b-instruct",
          "protocol": "openai"
        },
        "capabilities": ["agent", "edit"]
      }
    }
  }
}
```

3. Run with `--allow-cloud` since NIM is a cloud provider:
   `ashlr run --allow-cloud "harden the inbox apply path"`

The engine is picked up by `resolveEngineRegistry`, routed by the fleet scheduler,
contained by the confinement profile, and its proposals land in the inbox exactly
like any other backend. It can never reach `main` (tier `"mid"`) unless you
explicitly promote it to `"frontier"` and add it to `mergeAuthority` — and even
then only if `autoMerge.enabled` is `true`.

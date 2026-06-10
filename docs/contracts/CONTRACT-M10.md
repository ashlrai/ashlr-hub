# CONTRACT-M10 — Config → Env Bridge (Ecosystem Cohesion)

The hub spawns independently-shipped ecosystem tools (ashlrcode/aw, MCP downstream
servers, stack/vercel/gh/morphkit). M10 projects the unified `~/.ashlr/config.json`
into each spawned child's environment so every tool honors ONE config **without
modifying those tools**. The child still inherits `process.env`; we ADD/override
only the ashlr-derived, **non-secret** keys below.

**HARD RULE — NO SECRET VALUES.** The bridge maps endpoints, model names, paths,
and flags only. Phantom owns secrets; never read or inject secret VALUES into the
returned env. API keys already present in `process.env` flow through via normal
inheritance — the bridge does not touch them.

---

## Module to implement: `src/core/env-bridge.ts`

### Signatures (EXACT)

```ts
import type { AshlrConfig } from './types.js';

/**
 * Build ONLY the ashlr-derived env keys to merge into a spawned child's env.
 * Returns a flat, non-secret map (endpoints, model names, paths, flags).
 * Pure: no I/O, no process.env reads except where noted (active-key passthrough
 * is NOT done here — keys flow via inheritance). Deterministic for a given cfg.
 */
export function buildToolEnv(
  cfg: AshlrConfig,
  opts?: { model?: string; provider?: string },
): Record<string, string>;

/**
 * Merge buildToolEnv(cfg, opts?) over a base environment.
 * base defaults to process.env. Returned object is a NEW env suitable for
 * passing as `{ env: withToolEnv(cfg) }` to spawn/spawnSync/execFile.
 * The ashlr-derived keys OVERRIDE any same-named keys in base.
 */
export function withToolEnv(
  cfg: AshlrConfig,
  base?: NodeJS.ProcessEnv,
  opts?: { model?: string; provider?: string },
): NodeJS.ProcessEnv;
```

> `ToolEnv = Record<string,string>` is exported from `src/core/types.ts` (M10
> block) as an optional alias for the `buildToolEnv` return type. Implementers
> MAY annotate with `ToolEnv` but the literal return type `Record<string,string>`
> in the signature above is authoritative.

### Behavioral notes for the implementer

- **`buildToolEnv`** returns ONLY ashlr keys (never a spread of `process.env`).
- **`provider` / `model` resolution**: `opts.provider` overrides the derived
  active provider; `opts.model` overrides the derived model name. When not
  supplied, derive the active provider id from `cfg.models.providerChain[0]`
  (the configured preference head — do NOT perform network probes in this
  module; live resolution belongs to callers via `resolveActiveProvider`, and
  the caller may pass the resolved id through `opts.provider`). Derive the
  model name from the active provider: `lmstudio`/`ollama` → the corresponding
  `cfg.models.lmstudio`/`cfg.models.ollama` is an ENDPOINT not a model name, so
  the model name is only set when `opts.model` is provided or a future config
  model field exists; emit model keys only when a concrete model string is known.
- **Omit empty keys**: never emit a key with an empty-string value. Skip a
  mapping entirely when its source is absent (e.g. no genome config → still emit
  `ASHLR_GENOME_DIR` since the dir is path-derived and always known; but skip
  `ASHLR_MODEL` when no model is known).
- **Paths**: `ASHLR_CONFIG` and `ASHLR_GENOME_DIR` derive from the config home
  (`CONFIG_DIR` = `~/.ashlr`, exported by `src/core/config.ts`). Genome dir is
  `join(CONFIG_DIR, 'genome')`.
- **`withToolEnv`** = `{ ...(base ?? process.env), ...buildToolEnv(cfg, opts) }`.
  ashlr keys win on collision.

---

## Env-var mapping table (config → env, NON-SECRET)

| Env var(s) emitted          | Source in `AshlrConfig` / derivation                              | Notes |
|-----------------------------|-------------------------------------------------------------------|-------|
| `OLLAMA_HOST`               | `cfg.models.ollama`                                               | Ollama base endpoint (e.g. `http://localhost:11434`). |
| `OLLAMA_BASE_URL`           | `cfg.models.ollama`                                               | Alias many tools read; same value as `OLLAMA_HOST`. |
| `LM_STUDIO_URL`             | `cfg.models.lmstudio`                                             | LM Studio base endpoint (e.g. `http://localhost:1234`). |
| `OPENAI_BASE_URL`           | `cfg.models.lmstudio`                                             | LM Studio is OpenAI-compatible; point OpenAI-SDK tools at it. Endpoint only — never the key. |
| `ASHLR_LLM_PROVIDER`        | `opts.provider` ?? `cfg.models.providerChain[0]`                  | Active local-first provider id. |
| `ASHLR_PROVIDER_CHAIN`      | `cfg.models.providerChain.join(',')`                             | Full preference chain, comma-joined. |
| `ASHLR_MODEL`               | `opts.model` (when provided/known)                               | Chosen model name. OMITTED when no concrete model string is known. |
| `AC_MODEL`                  | `opts.model` (when provided/known)                               | ashlrcode-specific model var; mirrors `ASHLR_MODEL`. OMITTED when unknown. |
| `ASHLR_LOCAL_FIRST`         | constant `"1"`                                                    | Flag: signal local-first intent to children. |
| `ASHLR_CONFIG`              | `CONFIG_PATH` (`~/.ashlr/config.json`)                           | Absolute path to the unified config file. |
| `ASHLR_GENOME_DIR`          | `join(CONFIG_DIR, 'genome')` (`~/.ashlr/genome`)                 | Absolute path to the genome store dir. |
| `ASHLR_ROOTS`              | `cfg.roots.join(':')`                                             | Colon-joined absolute scan roots. |

### Explicitly NOT mapped (secrets — never emitted)

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `COHERE_API_KEY`,
  `GROQ_API_KEY`, or any other credential. These are owned by phantom and flow to
  children ONLY through normal `process.env` inheritance (via `withToolEnv`'s
  `base`). `buildToolEnv` must never read or set them.

> Conservative-by-design: every row above is a non-secret endpoint, model name,
> path, or flag. Add new rows only for non-secret config; document each.

---

## Spawn sites that MUST call `withToolEnv` (build agents apply, disjoint files)

1. **`src/core/run/orchestrator.ts`** — engine-delegation `spawnSync(engine, …)`
   (currently no `env:`). Pass `env: withToolEnv(cfg)` (with the resolved active
   provider/model in `opts` when available). NOTE: this same file also gets the
   **resume-before-delegation reorder** fix — apply the env bridge to the
   delegation spawn after reordering so `--resume` short-circuits first.
2. **`src/core/mcp-gateway.ts`** — each downstream MCP server spawn. Merge the
   server's own `spec.env` AFTER `withToolEnv` base so per-server overrides win
   over the bridge where they collide, while ashlr keys still seed the child.
3. **`src/core/lifecycle/ship.ts`** — `stack` / deploy (vercel/gh/morphkit)
   spawns. Pass `env: withToolEnv(cfg)`.

Each spawn site passes the loaded `cfg` (from `loadConfig()`) and, where a live
active provider/model has been resolved, forwards it via `opts`.

---

## Guardrails recap

- No new runtime deps. No secret VALUES in env. No git commit.
- Preserve all existing behavior except the targeted fixes.
- Tests stay ≥932 green. `buildToolEnv` is pure + deterministic → trivially unit-testable.

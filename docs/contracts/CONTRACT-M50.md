# CONTRACT-M50 — Polyglot backend registry (v5 keystone)

**Pillar:** Ashlr v5 Open Fleet — make the backend roster **open and declarative**
and make API models **actually work**, WITHOUT weakening containment, trust, or
the proposal seam. Adding a backend becomes config-only.

**Mason's hard rule:** flag-off is byte-identical (the registry must resolve the
existing engines — builtin/ashlrcode/aw/claude/codex — to the SAME argv the
hand-written switch produced); a backend with no declared tier is refused (never
implicitly `frontier`); the OpenAI-compatible API client stays behind the existing
`allowCloud` + key gate; zero new runtime dependencies (API calls use platform
`fetch`).

---

## 1. The declarative registry (`src/core/run/engine-registry.ts`, new)

- `EngineKind = 'builtin' | 'cli-agent' | 'api-model'`.
- `EngineSpec` — `{ id, kind, tier: 'local'|'mid'|'frontier', bins?: string[],
  argv?: ArgvTemplate, autonomousArgv?: ArgvTemplate, api?: { envKey: string;
  baseUrlEnv?: string; defaultBaseUrl?: string; defaultModel?: string;
  protocol: 'openai' }, capabilities?: string[] }`.
- `ArgvTemplate` — an ordered list of literal strings and placeholders
  (`$GOAL`, `$CWD`, `$MODEL`, and `?--flag $MODEL` optional segments) compiled by a
  pure `compileArgv(template, { goal, cwd, model })`. No `eval`, no shell.
- `BUILTIN_ENGINE_REGISTRY: Record<EngineId, EngineSpec>` — encodes the CURRENT
  five engines so `compileArgv` reproduces today's argv exactly, PLUS new entries:
  - `hermes` (cli-agent, tier `mid`): `hermes -z $GOAL` + autonomous `--yolo`,
    `?-m $MODEL`; bins `['hermes']`.
  - `opencode` (cli-agent, tier `frontier`): config-only default entry; bins
    `['opencode']` (absent on this machine — resolves installed=false, never
    breaks).
- `resolveEngineRegistry(cfg)` — merges `BUILTIN_ENGINE_REGISTRY` with
  `cfg.foundry?.engines` (user/declared overrides + additions); validates each
  entry (id pattern, tier ∈ enum, kind-appropriate fields); a malformed entry is
  dropped + (audit) noted, never fatal.

## 2. Wiring the registry into the engine layer

- `engines.ts` — `buildEngineCommand(engine, goal, cfg, opts)` resolves the spec
  and calls `compileArgv`; the existing five produce byte-identical results
  (locked by test). `engineInstalled(engine, cfg)` reads `spec.bins`.
- `sandboxed-engine.ts` — `engineTierOf(engine, cfg)` reads `spec.tier`
  (`FRONTIER_ENGINES` retained as the default-registry source of truth; the
  function gains an optional `cfg` arg, defaulting to the builtin registry so all
  existing call-sites compile unchanged and return identical results).
- `EngineId` (`types.ts`) widens to include `'hermes' | 'opencode'` plus an open
  `(string & {})` tail ONLY internally via the registry — public `EngineId` union
  stays explicit for the known set; registry-added ids are validated strings.

## 3. The OpenAI-compatible API client (`provider-client.ts`)

- Replace the `throw "does not yet implement cloud completions"` with a real
  `buildOpenAICompatibleClient(baseUrl, apiKey, model, supportsTools, temp?)` —
  generalizes the existing LM Studio `/v1/chat/completions` builder (same request
  shape, `Authorization: Bearer <key>` added). Pure `fetch`; bounded; never throws
  raw (maps errors to the client's normal failure shape).
- `getActiveClient` routes an `api-model` provider through it. The cloud gate is
  UNCHANGED: cloud requires `opts.allowCloud` AND the spec's `envKey` present, else
  the same fail-closed error.
- Extend `CLOUD_PROVIDER_ENV` + `defaultCloudModel` + `getProviderRegistry` probes
  with: `nvidia_nim` (`NVIDIA_NIM_API_KEY`, base `https://integrate.api.nvidia.com/v1`),
  `moonshot`/`kimi` (`MOONSHOT_API_KEY`, base `https://api.moonshot.ai/v1`),
  `hermes_api` (`HERMES_API_KEY` / OpenRouter-compatible). All OpenAI-protocol.

## HARD RULES + verification

1. **Flag-off byte-identical** — `buildEngineCommand` for builtin/ashlrcode/aw/
   claude/codex returns the SAME argv as the pre-M50 switch, with and without
   `opts.autonomous`/`model`. → `m50.engine-registry` argv-parity (table of the
   exact expected argv, copied from the current switch).
2. **Registry is the single source of engine truth** — every `EngineId` has a
   registry entry; `engineInstalled`/tier/argv all route through it. →
   `m50.engine-registry` coverage test (iterate `EngineId`, assert a spec exists).
3. **No implicit frontier** — a registry entry missing `tier`, or an unknown id,
   resolves to refused/`local` per validation, NEVER `frontier`. → `m50.*`.
4. **API client works + stays gated** — mocked `fetch` proves the request shape
   (url, bearer, messages, tools) and response parsing; AND `getActiveClient`
   still throws the local-first error when `allowCloud` is false or key absent. →
   `m50.api-client` + `m50.cloud-gate`.
5. **`compileArgv` is pure + injection-safe** — placeholders only; a goal
   containing `$CWD`/`;`/backticks is passed as a single argv element, never
   expanded or shelled. → `m50.argv`.
6. **No new runtime dependency** — API calls use global `fetch`; package.json deps
   unchanged. → dependency-manifest assertion.

## Deliverables checklist

- [ ] `src/core/run/engine-registry.ts` (new): `EngineKind`, `EngineSpec`,
      `ArgvTemplate`, `compileArgv`, `BUILTIN_ENGINE_REGISTRY`,
      `resolveEngineRegistry`.
- [ ] `engines.ts` / `sandboxed-engine.ts` rewired to the registry (parity-locked).
- [ ] `provider-client.ts`: `buildOpenAICompatibleClient` + real cloud routing;
      `providers.ts`/`router.ts`: NIM/Moonshot/Hermes provider entries + defaults.
- [ ] `types.ts`: `EngineTier` unchanged here (mid lands in M51); `EngineId`
      += `'hermes' | 'opencode'`; `cfg.foundry.engines?: Record<string, EngineSpec>`.
- [ ] Tests: `m50.engine-registry`, `m50.argv`, `m50.api-client`, `m50.cloud-gate`.

## Non-goals (explicit)

The `'mid'` tier itself (M51) · OS confinement (M52) · learned routing (M53) ·
shipping provider keys · a provider marketplace.

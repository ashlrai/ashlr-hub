# CONTRACT-M65 — phantom-vault provider-key resolution

**Pillar:** ashlr-hub as the unifying harness — leverage phantom (the ecosystem's
secret vault) so the polyglot api-model backends draw their keys from the vault,
not plaintext env. Complements the existing CLI-agent phantom-exec wrap.

**Mason's hard rule:** keep `core/phantom.ts` VALUES-FREE; the one place a real
secret value enters the process is the new, documented `integrations/secrets.ts`,
and only for an in-process api-model fetch that genuinely needs it. Never logged;
never cached. Flag-off / phantom-off ⇒ exactly today's env behavior.

---

## 1. Resolution (`integrations/secrets.ts`, new)

- `revealSecret(name)` — `phantom reveal <name> --yes --quiet` via spawnSync;
  null on not-installed / not-in-vault / non-zero / empty; never throws; never
  logs the value.
- `resolveProviderKey(envKey, cfg)` — when `cfg.phantom.enabled` && installed,
  prefer the vault value (phantom rewrites `.env` to worthless tokens, so a raw
  env read would send a token to the API); else fall back to `process.env[envKey]`.
  Undefined when neither has a non-empty value. Resolved on demand (no cache).

## 2. Wiring (`provider-client.ts`)

- The cloud-key gate (`getActiveClient`) and the OpenAI-compatible client build
  read the key via `resolveProviderKey(envVar, cfg)` instead of `process.env`.
  So NIM / Moonshot(Kimi) / Hermes-API keys can live in the phantom vault.

## Model note (why this is the right boundary)
CLI-agent backends (claude/codex/aw/hermes/opencode) already run under
`phantom exec` (engines.ts phantomWrap) — the proxy swaps the real key at the
network layer and the agent never sees it. api-model backends fetch IN-PROCESS,
so they need the value; `phantom reveal` is the narrow, documented exception.

## HARD RULES + verification (`test/m65.*`)

1. **phantom.ts stays values-free** — the value path lives only in
   integrations/secrets.ts. → unchanged phantom.ts + its existing guard.
2. **Phantom-off parity** — phantom disabled ⇒ resolveProviderKey === env read. →
   `m65.secrets`.
3. **Never throws / honest fallback** — bogus/absent secret ⇒ null/undefined,
   falls back to env; portable with or without phantom installed. → `m65.secrets`.
4. **No value logged/cached** — resolved on demand; never written to logs/audit
   values. → code review + by construction.

## Deliverables
- [ ] `integrations/secrets.ts` (revealSecret, resolveProviderKey).
- [ ] `provider-client.ts`: key reads via resolveProviderKey (2 sites).
- [ ] `test/m65.secrets`.

## Non-goals
Routing in-process fetches through the phantom network proxy (a larger,
proxy-lifecycle effort) · changing the CLI-agent exec-wrap · caching secret values.

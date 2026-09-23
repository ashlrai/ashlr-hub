# Locality is not the same claim as spend

**Status: recommendation only. No behaviour changed. Needs Mason's decision.**

`src/core/policy/local-only.ts` answers one question — `EngineLocality = 'local' | 'cloud'`
— and that answer is used to decide two different things:

1. **Where does the inference run?** (a fact about processes and endpoints)
2. **Can this spend money?** (a fact about credentials and billing)

The module's stated purpose is the second one. The UI promises *"Nothing can spend money
while this is on."* For every subject except CLI agents the two questions happen to have
the same answer, which is why this has held up. For `ashlrcode` they do not.

## The concrete gap

- `local-only.ts:237` — `LOCAL_CLI_AGENTS = new Set(['ashlrcode','aw'])`; `:316` classifies
  a `cli-agent` as local on that basis. So `enginePermitted('ashlrcode')` and
  `binPermitted('ac')` both **permit** while local-only is ON.
- `docs/ECOSYSTEM-MAP.md:151` — ashlrcode *"Consumes `@anthropic-ai/sdk` + OpenAI (routes
  xAI/DeepSeek/Groq/Ollama)"*. A local **process**; cloud inference **by default**.
- `src/core/run/sandboxed-engine.ts:782` — `ENGINE_AUTH_ALLOW` (`CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_AUTH_TOKEN`) is applied to **every** spawned cli-agent, and the env builder
  (~`:860-895`) forwards `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `XDG_CONFIG_HOME` —
  commented *"their subscription auth lives here."*

So under local-only the hub hands `ac` **working paid credentials** and controls nothing
past the spawn. `aw` is the same shape but milder: `ECOSYSTEM-MAP.md:155` calls it
local-first with cloud fallback **opt-in**.

## The consumer map, and which axis each site actually needs

Every caller of the authority, grouped by the question it is really asking:

**Asking "where do the bytes go?" — sound today, unaffected by the split.** A loopback URL
genuinely cannot bill you; these are correct under either axis.

| Site | Call |
|---|---|
| `comms/director.ts:154` | `endpointPermitted(url)` |
| `comms/elon-dialogue.ts:105` | `endpointPermitted(url)` |
| `fleet/manager.ts:907` | `endpointPermitted(url)` |
| `genome/playbook.ts:227` | `endpointPermitted(chatUrl)` |
| `run/provider-client.ts:951` | `endpointPermitted(baseUrl)` |
| `run/provider-client.ts:1413` | `providerPermitted(activeId)` |
| `verse/session-engine.ts` (local seats) | `endpointPermitted(anthropicBaseUrl ?? ollamaBaseUrl)` |

**Asking "can this spend?" while reading the locality answer — these are the sites the
split is for.**

| Site | Call | Why it matters |
|---|---|---|
| `run/engines.ts:455` | `binPermitted(cmd.bin)` | **The hole.** `ac` is permitted, then spawned with paid credentials. |
| `fleet/router.ts:131, :241, :340, :484` | `enginePermitted(backend)` | Routes work to `ashlrcode` as "free local capacity". |
| `verse/session-engine.ts` (cloud seats) | `enginePermitted(engine)` | Correct today only because claude/codex/grok are honestly cloud. |
| `daemon/loop.ts` `isLocalBackend` | via authority | Decides local-fleet membership and budget posture. |
| `autonomy/resource-strategy.ts` | via authority | Was the **only** module calling ashlrcode cloud; the recent unification removed that, so nothing throttles for it now. |

## Recommendation

**Add a second axis rather than reclassifying.** Reclassifying `ashlrcode` as `'cloud'`
would fix spend and break locality: the local-fleet membership, pool tiering and
local-context injection all legitimately want "runs on this machine".

```ts
type EngineLocality  = 'local' | 'cloud';          // where the process runs — unchanged
type Meteredness     = 'free' | 'metered' | 'unknown';  // NEW: can this bill you?
```

- `'free'` — loopback endpoints, `llama-server`, `builtin`, `ollama`, `lmstudio`.
- `'metered'` — every cloud provider, **and `ashlrcode` by default**, because the hub
  hands it credentials it cannot supervise.
- `'unknown'` — a cli-agent whose configuration the hub cannot read. **`unknown` must be
  refused under local-only**, not permitted. A policy whose purpose is preventing spend
  cannot treat "I can't tell" as "safe" — that is precisely how this gap survived.

**What local-only should refuse:** anything not provably `'free'`. That is the one-line
statement of intent, and it makes the UI copy true.

### On `ashlrcode` specifically — two options, Mason's call

**Option A — classify `ashlrcode` as `metered`, locality unchanged.** Under local-only it
is refused. Honest and immediate; costs you the ability to use `ac` in a local-only run
even when it is pointed at Ollama.

**Option B — make it conditional on an ashlrcode-side guarantee.** `ac` gains a verifiable
local-model mode (a flag the hub passes and `ac` honours, or a probe the hub can read),
and the hub classifies it `'free'` **only** when that is confirmed. Strictly better, and it
is real work in a second repo. Until that exists the honest default is A.

Recommend **A now, B as the target** — A is a few lines and closes a live gap; B keeps the
capability and can land whenever ashlrcode is ready. Do not ship B's classification before
B's enforcement exists, or local-only becomes a promise resting on a flag nobody checks.

## The id-space bug, which must be fixed with this, not after

`estCostUsd` (`src/core/run/budget.ts`) is documented as taking a **provider** id, but
`sandboxed-engine.ts` calls it with an **engine** id at `:1825`, `:2161`, `:3061`.

Today that mismatch is load-bearing in our favour: `'ashlrcode'` matches no price key and
falls to the conservative `$3/$15` estimate — a wrong number, but **visible spend**.

Two branches currently in flight would remove that accidental safety net. `budget.ts`'s
`isFreeSubject()` tries `providerLocality` and then **falls through to `engineLocality`**;
`ashlrcode` is an EngineId the authority calls local, so every `ashlrcode` run would cost
**$0** and disappear from the ledger. **Zero is worse than wrong** — a wrong number invites
scrutiny; a zero ends it.

So: `estCostUsd` should key on **meteredness**, never on locality, and the engine/provider
id-space confusion should be resolved in the same change.

## Suggested order

1. Add `Meteredness` alongside `EngineLocality`; classify everything; default cli-agents to
   `'unknown'`.
2. Point `local-only` at meteredness (refuse anything not `'free'`). `endpointPermitted`
   sites are already correct and need no change.
3. Fix `estCostUsd` to take meteredness and settle the engine-vs-provider id space.
4. Then, and only then, merge the budgets and locality-unification branches.
5. Option B, if and when ashlrcode grows a verifiable local mode.

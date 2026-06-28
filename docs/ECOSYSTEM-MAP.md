# Ashlr Ecosystem Map

> The fleet's knowledge of its own platform. ashlr-hub is the orchestrator; the
> other repos are **composable capabilities**. The leverage is in the
> *compositions* — the fleet using its own tools to fix its own weaknesses and
> to build incredible things. Feeds the strategist (direction), the invent
> engine (compositional ideas), and build agents (cross-tool reuse).
> Generated 2026-06-28 from a 4-agent parallel mapping pass; verify surfaces firsthand before load-bearing use.

## The repos (capability profiles)

### Agent / coding core
- **ashlr-hub** — autonomous engineering fleet orchestrator. CLI: `daemon, loop, goal, fleet, manager, invent, inbox, digest, spec, swarm, run, sandbox, ...`. Native MCP tool registry (`callNativeTool`). Proposal-only, tiered-trust, verification-gated merge. *The conductor.*
- **ashlr-plugin** — token-efficiency MCP layer, **40 tools** (`ashlr__read/grep/edit/bash/genome_*/...`): snipCompact (−82% tokens), genome-aware RAG grep (−84% warm), AST structural rename, savings dashboard. Bun/TS. *Makes every agent cheaper.*
- **ashlrcode** (`ac`) — multi-provider terminal agent: **45 tools**, 6 LLM providers w/ failover, KAIROS autonomous mode, sub-agent orchestration, **worktree isolation**, bridge server (HTTP API). Bun/Ink. *A full executor in a box.*
- **ashlr-workbench** (`aw`) — wires 4 OSS agents (OpenHands/Goose/Aider/ashlrcode) to one LM Studio model + shared ashlr-plugin MCP. *A local executor fleet.*
- **@ashlr/core-efficiency** — token-efficiency primitives: `snipCompact`, `autoCompact`, `contextCollapse`, genome RAG (`retrieveSectionsV2`), provider budget limits, `estimateTokens*`, `cacheBreakpoints`. Pure TS. *The compression substrate under plugin + hub.*

### Security / trust
- **phantom-secrets** — secret-leak prevention via local reverse proxy (token→real-secret at the network edge). **25 MCP tools** (`phantom_add_secret`, `phantom_cloud_push`, `phantom_team_vault_push`, `phantom_wrap`, ...), OS keychain vault, E2E team vaults, audit chain, response scrubbing. Rust. *Real secrets, never in config/logs.*
- **binshield** — supply-chain security: install-script + native-binary analysis, AI threat classification, OSV malware feed, **GitHub Action** (CI gating, SARIF), scan API (`POST /public/scan`), CycloneDX SBOM. Next/Hono/TS. *Stops malicious deps before they ship.*

### Infra / data
- **stack** — infra provisioning control plane: one command wires **29 services** (Supabase/Vercel/Stripe/Clerk/OpenAI/...), **19 MCP tools** (`stack_init/add/apply/recommend/...`), **secrets routed through phantom**, `.stack.toml`. Bun. *Scaffolds + wires a project's whole backend.*
- **webfetch** — license-first federated image search across **25 providers**, **6 MCP tools** (`search_images`, `fetch_with_license`, `probe_page`, ...), content-addressed cache, license ranking. Bun. *Safe content sourcing.*

### Content / viz / telemetry
- **ashlr-pulse** — mission control: **OTLP ingest** (`POST /api/otlp/v1/traces`, GenAI OTel), dashboard (source×model×project×repo + cost), peer-share, daily digest, `pulse-agent` (tails Claude/codex/aider sessions). Next/Rust. *The fleet's live dashboard.*
- **ashlr-md** — AI-native Markdown app (Tauri): GFM/Mermaid/KaTeX render, WYSIWYG+source, PDF/DOCX export, on-device AI, `mdopen` CLI + MCP. *Renders fleet reports beautifully.*
- **morphkit** — semantic web→iOS SwiftUI converter: analyze(ts-morph)→model(Zod)→generate, **9 MCP tools**, confidence scoring. Bun/Swift. *TS/React app → native iOS.*
- **prompt-trackr** (`measurably`) — prompt-quality scorecard: scans Claude transcripts, AES scoring (clarity×conciseness×specificity), watch mode, cloud sync. Next/TS. *Measures + improves prompt quality.*

## Composition bets (the "limitless potential", prioritized)

**Tier 1 — the fleet uses its own ecosystem to fix its own weaknesses:**
1. **phantom → fleet auth.** Inject real engine/API keys into the daemon + sandboxes via phantom; phantom tokens stay safe in config/logs/git. *Fixes the auth-in-daemon friction directly.*
2. **ashlrcode / workbench → executor backend.** Dispatch fleet work to `ac` (45 tools, worktree isolation, real test loop) or the workbench's local-agent pool — a genuine executor instead of raw `runGoal`. *Fixes local-execution quality (the root of the 0-ship problem).*
3. **core-efficiency / plugin → the fleet's own token cost.** Run the fleet's strategist/judge/invent prompts through snipCompact + genome + cacheBreakpoints. *Slashes the fleet's burn.*
4. **binshield → dep-safety gate.** Scan the fleet's own + every proposed dependency change via binshield before merge; risk feeds the trust gate. *Makes dep work safe + kills blind dep-bump trivia.*

**Tier 2 — observability + provisioning:**
5. **pulse → fleet telemetry.** Emit OTLP traces (proposals, merges, judge verdicts, cost) → live mission-control dashboard of the fleet.
6. **stack → provisioning.** The fleet uses stack to provision infra for the products it builds.
7. **prompt-trackr → self-improvement.** Score + iterate the fleet's own prompts.

**Tier 3 — product-building capabilities the fleet can compose:**
8. **webfetch + morphkit + ashlr-md** — content sourcing, web→iOS, and report rendering as building blocks for the products the fleet creates.

## How this composes back into the fleet
- **Direction (strategist):** reason across the ensemble; prefer compositional moves over isolated per-tool features.
- **Ideas (invent):** the best inventions are A×B (e.g. "phantom-backed stack provisioning driven by the fleet, visualized in pulse").
- **Execution (agents):** reuse phantom/stack/plugin/core-efficiency instead of reinventing; dispatch to ashlrcode/workbench for local muscle.
- **Selection + safety:** binshield on deps; pulse for the audit trail; the taste critic for vision-alignment.

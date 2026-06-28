# Ashlr Platform Efficiency Roadmap

> The ecosystem should be a **platform, not 13 silos.** Each repo separately
> reinventing + paying for the same foundation (Supabase, auth, billing,
> telemetry, MCP boilerplate, cost-tracking) is the core inefficiency. The
> efficient + more *powerful* end-state is a shared platform layer the fleet
> builds + maintains, so the whole ecosystem compounds: each shared package
> makes the next product faster, and one identity makes the tools interoperate.
> Synthesized 2026-06-28 from two parallel ecosystem audits. Dollar savings are
> modest; the real prize is velocity + coherence. Feeds the strategist + invent.

## Ideal end-state
- **One shared infra layer** — one Supabase (schema-per-product), one auth/SSO, one telemetry sink (pulse), one billing account. Managed by **stack**.
- **One shared code layer** — `@ashlr/*` packages (core-efficiency exists; add mcp-kit, cost, auth, config, cli-common). DRY foundation every product builds on.
- **One agent surface** — a unified MCP gateway (workbench already aggregates; generalize).
- **One pane of glass** — pulse (telemetry + fleet dashboard), phantom (the one secret store).
- The **fleet** extends + maintains all of it, frontier-efficiently (core-efficiency applied to itself, best-of-N tuned to high-value items, M194 usage dashboard keeping spend visible).

## A. Infrastructure consolidation (cost + coherence)
| Move | Repos | Risk | Saves | Notes |
|---|---|---|---|---|
| **SendGrid → one account** | pulse, binshield, prompt-trackr, webfetch, plugin | LOW | ~$10–20/mo | Quick win. Per-product sender domains, one API key (in phantom). |
| **Supabase → shared project** | **binshield + prompt-trackr** | LOW | ~$25–50/mo | Both SaaS+subscriptions; schema-prefix (`binshield_*`, `prompt_trackr_*`) + RLS isolation. **Keep pulse/morphkit isolated** (distinct needs); stack is a provisioner, not a consumer. |
| **Stripe → one account** | binshield, prompt-trackr, morphkit, pulse, webfetch | MED | ~$50–100/mo | Central pricing-config ({product,tier}→price_id) + one webhook router (ashlr-hub) dispatching by product; webhook secrets stay per-repo in phantom. |
| **Auth → shared OIDC/SSO** | (Supabase repos already; plugin/webfetch opt-in) | LOW | ops | One identity across the suite — a *product* upgrade, not just savings. |
| **Hosting** | — | — | — | **Do NOT consolidate** — Vercel/Workers/Edge are specialized. |
First-pass: **~$85–170/mo, ~11–16 days, phased over 2–3 months.**

## B. Shared `@ashlr/*` packages (velocity — the bigger lever)
| Package | Replaces duplication in | Tier | Payoff |
|---|---|---|---|
| **@ashlr/mcp-kit** | plugin, hub, webfetch, prompt-trackr (MCP server boilerplate, tool registry, transports, error shapes) | 1 | ~40% boilerplate cut across 4 repos |
| **@ashlr/cost** | ashlrcode (254-line CostTracker), plugin (_pricing.ts), core-efficiency (tokens) — unify pricing for all providers | 1 | kills duplication + **cuts the fleet's own cost-tracking** |
| **@ashlr/auth** | plugin, ashlrcode, webfetch, hub (AES-GCM crypto, PKCE OAuth, session/Bearer middleware) | 2 | one auditable auth layer (mind master-key rotation) |
| **@ashlr/config** | plugin, hub, ashlrcode, stack (config loaders + phantom integration) | 2 | standard config + secrets; promote phantom adoption (ashlrcode stores tokens in plaintext today → should use phantom) |
| **@ashlr/cli-common** | ashlrcode, morphkit, hub, binshield (help/flags/spinners) | 3 | consistent CLI UX |
Existing **@ashlr/core-efficiency** should be adopted by **ashlrcode** (it reimplements token counting).

## Fleet-executable vs your-hands
- **Fleet can do autonomously (code/config/PRs):** extract the `@ashlr/*` packages, refactor repos to consume them, the pricing-config + webhook-router code, env/schema-prefix code changes, adoption of phantom/core-efficiency.
- **Needs your hands (account/billing/live-data):** the actual Supabase-project merge + data migration, Stripe account consolidation + billing, SendGrid account, DNS/sender domains. The fleet preps the code + a migration plan; you flip the account-level switches.

## Recommended order
1. **@ashlr/mcp-kit + @ashlr/cost** (Tier-1 shared packages — pure code, fleet-executable now, immediate velocity + cuts the fleet's own cost)
2. **SendGrid consolidation** (quick infra win)
3. **@ashlr/auth + @ashlr/config** (Tier-2 packages)
4. **Supabase (binshield+prompt-trackr) + Stripe** (infra; fleet preps, you migrate)
5. **@ashlr/cli-common + unified MCP gateway** (consistency)

This roadmap is itself high-value fleet work — the `@ashlr/*` extractions are exactly the substantive, compositional work the generative engine should propose + build. See [[ecosystem-map]] · docs/ECOSYSTEM-MAP.md.

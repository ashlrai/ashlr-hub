# Seams — local-first, cloud-ready (M30)

ashlr-hub is **local-first and self-hostable**. Every v2 store has a clean
**seam interface** so a future team/multi-machine backbone is a **drop-in** — but
that cloud/team backbone is **GATED**. There is **no config flag and no code
path** that activates a functional cloud backbone today. Nothing is public.

## The pattern

Each seam follows the canonical shape established by the M19 telemetry seam
(`src/core/observability/telemetry-sink.ts`):

1. **Interface** — the contract.
2. **LOCAL impl** (default) — a thin, behavior-preserving adapter that delegates
   1:1 to the existing module. Zero behavior change.
3. **GATED cloud stub** — every method throws the canonical gated error *before
   any I/O*. It can be referenced, but it never opens a socket, calls `fetch`,
   or touches disk. It only refuses.
4. **`selectX(cfg)` selector** — returns the LOCAL impl by default; returns the
   gated stub **only** when a cloud endpoint is explicitly configured for that
   seam — and that stub still refuses.

```ts
export function selectInboxStore(cfg: AshlrConfig): InboxStore {
  return seamEndpoint(cfg, 'inbox') ? new CloudInboxStore() : new LocalInboxStore();
}
```

## The seams

| Seam | Wraps | LOCAL behavior |
|------|-------|----------------|
| `RunSwarmStore` | `core/swarm/store.ts` | persist + list run/swarm records |
| `BacklogSource` | `core/portfolio/backlog.ts` | scored work backlog over enrolled repos |
| `InboxStore` | `core/inbox/store.ts` | approval-inbox proposals (the outward-action gate) |
| `DaemonCoordinator` | `core/daemon/state.ts` | single-machine daemon state; lease is a no-op |
| `GenomeSync` | `core/genome/store.ts` | append-only shared memory |
| `PortfolioSync` | `core/quality/store.ts` + `core/dashboard.ts` | health snapshots + dashboard |
| `IdentityProvider` | `core/integrations/identity.ts` | phantom-derived identity (values-free) |
| `TelemetrySink` *(reference)* | M19 telemetry seam | `LocalFileSink` + opt-in OTLP sink (cited, not rewritten) |

## The gate

The cloud/team implementations are **gated on Mason** — explicit opt-in, not
implemented. Selecting one (by configuring an endpoint) returns a stub whose
every method throws:

```
[ashlr seams] <Seam>.<method>: cloud/team backbone gated on Mason — not implemented (requires Mason's explicit opt-in)
```

There is intentionally no way for the autonomous loop or daemon to flip to a
cloud backbone.

## Inspecting the seams

```sh
ashlr seams            # table: each seam + active=local + cloud=gated
ashlr seams status     # alias for the above
ashlr seams --json     # machine-readable SeamRegistry
```

This diagnostic is **read-only**: it builds the registry from the in-memory
config and static descriptors — no I/O, no seam impl instantiation, no network.

## Safety invariants

1. **Interfaces + local only** — no functional cloud impl exists; cloud stubs
   throw.
2. **No activation path** — selectors return local by default; a configured
   endpoint only routes to a throwing stub.
3. **Non-regression** — wrapped stores are untouched; local adapters delegate
   1:1; `AshlrConfig` is unmodified.
4. **Nothing public / self-hostable** — no outward action, no phone-home.
5. **Bounded + no new deps** — read-only diagnostics; intra-repo imports only.

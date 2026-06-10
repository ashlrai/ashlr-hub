# CONTRACT-M30 — Cloud-Ready Seams v2 + Polish (capstone)

**Pillar:** Ashlr v2 — make the team/multi-machine future a DROP-IN later
without a rewrite, by defining clean SEAM INTERFACES for the v2 stores and
shipping ONLY the LOCAL side now.

**Mason's hard rule:** build the LOCAL + INTERFACE side only. Cloud/team
implementations are a **Mason GATE**. Every seam ships a working LOCAL impl
(wrapping existing behavior, zero behavior change) plus a GATED cloud stub that
THROWS a clear gated error if ever selected. There is **NO config flag or code
path** that can activate a functional cloud backbone. Local-first,
self-hostable, nothing public.

This generalizes the EXISTING v1 seam pattern in
`src/core/observability/telemetry-sink.ts` (interface `TelemetrySink` + default
`LocalFileSink` + opt-in `OtlpHttpSink` selected by config) across the v2 stores
WITHOUT destabilizing them.

---

## 1. Seam architecture (`src/core/seams/`)

One cohesive module per seam, plus a shared types module, a registry, and a
barrel. Each seam module exposes the canonical four-part shape:

1. **INTERFACE** — the seam contract (method signatures match the wrapped
   module's exported functions 1:1).
2. **LOCAL impl** — DEFAULT. A thin, behavior-preserving adapter that delegates
   to the existing exported functions. ZERO behavior change, identical
   signatures. Fully implemented (it only delegates).
3. **GATED cloud stub** — every method THROWS `cloudGatedError(seam, method)` as
   its FIRST statement, before any I/O. No `fetch`/http, no socket, no disk —
   it can be referenced but never does I/O. It only refuses.
4. **`selectX(cfg)` selector** — returns the LOCAL impl by DEFAULT; returns the
   GATED stub ONLY when a cloud endpoint is explicitly configured for that seam
   (and that stub still refuses). There is NO activation path.

### Seams defined

| Seam | Module | Wraps (existing) | LOCAL delegates to | Cloud |
|------|--------|------------------|--------------------|-------|
| `RunSwarmStore` | `seams/run-swarm.ts` | `core/swarm/store.ts` | `listSwarms` / `loadSwarm` / `saveSwarm` | gated |
| `BacklogSource` | `seams/backlog.ts` | `core/portfolio/backlog.ts` | `loadBacklog` / `buildBacklog` | gated |
| `InboxStore` | `seams/inbox.ts` | `core/inbox/store.ts` | `listProposals` / `createProposal` / `loadProposal` / `setStatus` / `pendingCount` | gated |
| `DaemonCoordinator` | `seams/daemon-coordinator.ts` | `core/daemon/state.ts` | `loadDaemonState` / `saveDaemonState` (LOCAL = single-machine; lease is a no-op) | gated (multi-machine lease/lock) |
| `GenomeSync` | `seams/genome.ts` | `core/genome/store.ts` | `loadGenome` / `appendHubEntry` / `genomeHubHealth` | gated |
| `PortfolioSync` | `seams/portfolio.ts` | `core/quality/store.ts` + `core/dashboard.ts` | `saveReport` / `listReports` / `loadPreviousReport` / `buildSnapshot` | gated |
| `IdentityProvider` | `seams/identity.ts` | `core/integrations/identity.ts` | `getIdentity` (LOCAL = phantom probe) | gated (team auth) |
| `TelemetrySink` | `core/observability/telemetry-sink.ts` (EXISTING) | — | `LocalFileSink` / opt-in `OtlpHttpSink` | **cited, not rewritten**; `cloud=false` |

> `TelemetrySink` is the CANONICAL reference seam (M19). It is CITED via the
> registry and NOT duplicated. Its opt-in `OtlpHttpSink` is a real
> local-network sink, not a gated team backbone — so the registry reports its
> `cloud` as `false`, distinct from the seven `gated` v2 seams.

### Types (`src/core/seams/types.ts`, single-sourced)

- `SeamId` — `'runSwarm' | 'backlog' | 'inbox' | 'daemonCoordinator' | 'genome' | 'portfolio' | 'identity' | 'telemetry'`.
- `SeamImpl` — `'local' | 'gated'` (active impl; always `'local'` by default).
- `SeamCloud` — `false | 'gated'` (cloud availability; NEVER `true` in M30).
- `SeamStatus` — read-only diagnostic row (`id`, `name`, `active`, `cloud`,
  `endpointConfigured`, `delegatesTo`, `summary`).
- `SeamRegistry` — `{ generatedAt, seams: SeamStatus[], allLocal, gatedConfigured }`.
- `SeamsConfig` — OPTIONAL per-seam `{ endpoint?: string }`; read **defensively**
  off `AshlrConfig` via `seamsConfig(cfg)` so `AshlrConfig` is **unmodified**
  (NON-REGRESSION). DEFAULT UNSET => local for every seam.
- `CLOUD_GATED_MESSAGE` + `cloudGatedError(seam, method)` — the single canonical
  gated error, centralised so it is identical across seams and trivially
  assertable by the verifier.

### Registry (`src/core/seams/registry.ts`) — READ-ONLY

A single place that lists every seam, its active impl (`'local'`), and whether a
cloud impl is available (`false | 'gated'`). `buildSeamRegistry(cfg)` derives
everything from the in-memory config + static descriptors: it triggers **NO
I/O**, instantiates **NO seam impl**, and never touches disk/network. Feeds the
`ashlr seams` diagnostic. Also exports:

- `seamsConfig(cfg)` — defensive optional-block accessor (no `AshlrConfig` edit).
- `seamEndpoint(cfg, id)` — the explicitly-configured endpoint for a gated seam,
  or `null`. A non-null result routes the selector to the GATED stub (throws);
  it NEVER enables a functional backbone.

---

## 2. CLI surface (`src/cli/seams.ts`)

- `ashlr seams` / `ashlr seams status` — list seams + `active=local` + `cloud=gated`.
- `ashlr seams --json` — emit the `SeamRegistry`.
- `ashlr seams --help` — usage.

READ-ONLY. Loads config, builds the registry, renders a table (or JSON).
Mutates nothing, makes no network connection, instantiates no seam impl. Exit
codes: `0` success, `1` runtime error, `2` bad usage. Mirrors `src/cli/health.ts`.

### Dispatcher wiring (integration — NOT this scaffold; explicitly flagged)

The M25 review caught dispatcher wiring being missed. During integration,
`src/cli/index.ts` MUST add — matching the EXACT `reflect`/`health`/`goals`/
`digest` pattern:

```ts
const loadSeamsCmd = lazyCmd(
  () => import('./seams.js'),
  (m) => m.cmdSeams as Cmd,
  'seams command requires src/cli/seams.ts (M30 module not yet built).',
);
```

a `case 'seams':` block in the dispatch switch, and a `cmdHelp` entry:

```
['seams',  'List the v2 cloud-ready seams: active impl (local) + cloud availability (gated). Read-only.'],
```

---

## 3. Polish scope

- **CI** — `.github/workflows/ci.yml` matrix extended to Node `["20", "22"]`,
  keeping typecheck / lint / build / test. Must stay green on both.
- **DOCS** — `docs/SEAMS.md` documents the local-first + cloud-ready seam
  architecture and the gate. `README.md` gets the full v2 command surface
  (`ask`, `knowledge`, `reflect`, `health`, `goals`, `digest`, `daemon`,
  `inbox`, `backlog`, `enroll`, `seams`), a one-paragraph "Autonomous
  Engineering Organization (v2)" section, and the activation runbook
  (enroll real repos → `ashlr daemon` → approve via `ashlr inbox`) clearly
  marked as the human's gate. `CHANGELOG.md` gets an M30 entry.
- **TESTS** — `test/m30.seams.test.ts` (hermetic; in-memory config; never the
  real `~/.ashlr`, never the real portfolio, never a remote call).

---

## 4. The 5 HARD SAFETY INVARIANTS (verbatim) + enforcement + verification

### Invariant 1 — INTERFACES + LOCAL ONLY

> Every seam ships a working LOCAL impl = the current behavior (thin adapter
> over the existing module). There is NO functional cloud/team/remote
> implementation. The cloud impl for each seam is a STUB whose every method
> THROWS a clear gated error. It can be referenced but never does I/O.

- **Enforced by:** each `LocalX` is a pure pass-through to the existing exported
  functions; each `CloudX` method calls `throw cloudGatedError(...)` as its
  FIRST statement. No cloud method contains `fetch`/http/disk before the throw.
- **Verified by:** `test/m30.seams.test.ts` asserts every `CloudX` method throws
  `CLOUD_GATED_MESSAGE`; grep-prove no `fetch(`/`http`/socket in `seams/*` cloud
  stubs (`grep -rn "fetch\|http\|net\." src/core/seams` returns no live call).

### Invariant 2 — NO ACTIVATION PATH

> `selectSeam()` / the registry returns the LOCAL impl ALWAYS by default. A
> cloud impl is only ever returned if a cloud endpoint is explicitly configured
> — and that impl REFUSES (throws gated). There is no way for the autonomous
> loop/daemon to flip to cloud. Grep-prove: no live non-localhost endpoint call
> exists in `src/core/seams/*`; the gated stubs contain no fetch/http to a
> remote backbone (they throw before any I/O).

- **Enforced by:** `selectX(cfg)` returns `LocalX` unless `seamEndpoint(cfg,id)`
  is a non-empty string; even then it returns the throwing `CloudX`. The
  endpoint lives in an OPTIONAL config block that DEFAULTS UNSET.
- **Verified by:** tests confirm every selector returns the `LocalX` on the
  default config and `seamEndpoint` is `null` for all seams; a configured
  endpoint returns the `CloudX` stub whose methods all throw. Grep for
  non-localhost calls in `src/core/seams/*` returns none.

### Invariant 3 — NON-REGRESSION

> Wrapping existing stores behind seam interfaces MUST NOT change their local
> behavior or signatures. ALL prior tests stay green. Prefer ADDITIVE adapters
> that call the existing exported functions; do NOT rewrite the stores.

- **Enforced by:** zero edits to any wrapped store; the seam config is read via
  a cast over an OPTIONAL property (no `AshlrConfig` type edit); local adapters
  delegate 1:1.
- **Verified by:** full suite green (104 files / 2917 tests, plus the 7 new M30
  tests); `git diff` shows no changes under the wrapped store modules.

### Invariant 4 — NOTHING PUBLIC / SELF-HOSTABLE

> No outward action, no registration/telemetry/phone-home, no public flip. Docs
> state local-first + self-hostable + cloud-gated. No push/PR/deploy from any
> M30 code.

- **Enforced by:** no outward call anywhere in `seams/*` or `cli/seams.ts`; the
  diagnostic is read-only; docs state the gate.
- **Verified by:** grep for `fetch`/`exec`/network in M30 surface returns only
  the (throwing-before-I/O) stub bodies; no CI/deploy/PR step is added by M30.

### Invariant 5 — BOUNDED + NO NEW DEPS

> No new runtime dependencies. No unbounded loops. Diagnostics are read-only.

- **Enforced by:** only intra-repo imports; the registry maps a fixed 8-element
  descriptor list; no loops over unbounded input.
- **Verified by:** `package.json` unchanged; typecheck + lint clean.

---

## 5. Deliverables checklist

- [x] `src/core/seams/types.ts` — `SeamId`/`SeamImpl`/`SeamCloud`/`SeamStatus`/
      `SeamRegistry`/`SeamsConfig` + `cloudGatedError`.
- [x] `src/core/seams/run-swarm.ts`, `backlog.ts`, `inbox.ts`,
      `daemon-coordinator.ts`, `genome.ts`, `portfolio.ts`, `identity.ts` —
      interface + LOCAL adapter + GATED stub + selector each.
- [x] `src/core/seams/registry.ts` — `buildSeamRegistry` / `seamEndpoint` /
      `seamsConfig`.
- [x] `src/core/seams/index.ts` — barrel.
- [x] `src/cli/seams.ts` — `cmdSeams` (`status` / `--json` / `--help`).
- [x] `test/m30.seams.test.ts` — hermetic invariant tests.
- [x] `.github/workflows/ci.yml` — Node `["20","22"]` matrix.
- [x] `docs/SEAMS.md`, `README.md` v2 surface + runbook, `CHANGELOG.md` M30 entry.
- [ ] **Integration (NOT this scaffold):** wire `loadSeamsCmd` + `case 'seams'`
      + `cmdHelp` entry into `src/cli/index.ts`.

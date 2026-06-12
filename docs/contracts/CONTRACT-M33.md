# CONTRACT-M33 — Ecosystem Layer: plugins, distribution, public API

**Pillar:** Ashlr v2.2 — make the hub extensible and distributable WITHOUT
weakening the safety posture. Third parties can contribute scanners /
templates / providers / commands; the package ships publicly as `@ashlr/hub`
with a tag-gated, provenance-signed release pipeline; other tools can build on
a curated programmatic API.

**Mason's hard rule:** plugins are DEFAULT-OFF and capability-scoped; nothing
publishes without an explicit human tag push; the public API never exports an
ungated outward-mutation primitive (`applyProposal` stays unexported).

---

## 1. Plugin system (`src/core/plugins/`)

- `types.ts` — `PLUGIN_API_VERSION` (semver'd host API), `PluginManifest`
  (name pattern `^[a-z][a-z0-9-]{0,39}$` AND name === dir basename; `entry`
  contained inside the plugin dir; `apiVersion` semver range; declared
  `capabilities`), capability-scoped `PluginHost` (frozen settings + frozen
  allowlisted config PROJECTION — never raw `AshlrConfig`, never secrets;
  `dataDir` = `~/.ashlr/plugin-data/<name>/` is the only sanctioned write
  location), `definePlugin()` typed-authoring helper.
- `manifest.ts` — `readManifest(dir)`: bounded read (≤64KB), shape validation,
  proto-pollution key rejection, entry containment, hand-rolled zero-dep
  semver-range matcher. Never throws.
- `integrity.ts` — sha256 entry pinning (`sha256:<64hex>`) recorded at
  `plugins enable` time; `verifyIntegrity` refuses on mismatch/missing pin.
- `registry.ts` — `discoverPlugins()` is manifest-only (**never imports plugin
  code**); `loadEnabledPlugins(cfg)` gate chain, each step audited:
  `ASHLR_NO_PLUGINS=1` → kill switch → name ∈ `cfg.plugins.enabled`
  (default `[]` ⇒ NOTHING loads) → manifest valid + apiVersion compatible →
  integrity pin verified → dynamic import → `activate()` with 5s timeout →
  capability filter (undeclared contributions dropped + audited). A failing
  plugin is skipped, never fatal.
- `wrappers.ts` — scanner: 15s timeout, never-throws, 100-item cap,
  value/effort clamped, score recomputed via the canonical `scoreItem`,
  title/detail secret-scrubbed, `source: 'plugin'` + namespaced ids forced;
  template: id prefixed, path-traversal/`.git/` rejection; command:
  builtin-shadow rejection + audited invocation.
- `host-api.ts` — frozen host construction; audit actor `plugin:<name>`.

### Extension-point wiring
- `portfolio/scanners.ts` → `getScanners(cfg)` (builtin `SCANNERS` + wrapped
  plugin scanners); `portfolio/backlog.ts` consumes it.
- `lifecycle/templates.ts` → `getTemplates(cfg)` / cfg-aware `getTemplate` /
  `listTemplates`; `cli/new.ts` consumes them.
- `providers.ts` probes plugin providers (bounded); `run/provider-client.ts`
  routes plugin clients **behind the same allowCloud + key gates**.
- `cli/index.ts`: `ashlr plugins …` + `ashlr x <name>` dispatch.
- `cli/plugins.ts`: list / info / enable (capabilities + trust warning,
  confirm-gated, records integrity) / disable. Doctor warns on broken pins.

### Trust model (documented verbatim in docs/PLUGINS.md)
In-process ESM = same OS privileges; the posture is gating + least-privilege
API + tamper evidence + audit — NOT OS sandboxing. No plugin API path reaches
inbox approval, `applyProposal`, enrollment writes, or config writes.

## 2. Distribution

- `package.json`: `@ashlr/hub`, public + provenance `publishConfig`,
  `prepublishOnly` (typecheck+lint+test), `prepack` (build), exports map
  (`.`, `./core`, `./types`, `./plugin`, `./package.json`).
- `.github/workflows/release.yml`: tag `v*` → **verify** (full CI gate) →
  **publish** (`check-version.mjs` tag==version gate, changelog-extract
  release notes — release FAILS without a changelog section,
  `npm publish --provenance`, `gh release create`).
- CI pack-smoke: tarball installed into a clean dir; `ashlr` bin +
  `@ashlr/hub/types` + `/core` entries exercised — a broken exports map can
  never ship.
- `ashlr update` channel awareness: `detectChannel()` (git checkout vs
  node_modules install); npm channel checks the registry (bounded, degrades
  offline) and installs ONLY with `--yes`.

## 3. Public API (`src/api/`)

Curated barrels: `index.ts` (core + types), `core.ts` (read-heavy surface +
`createProposal` as the only mutation — pending/human-gated), `types.ts`
(public type contract), `plugin.ts` (plugin authoring surface). Internals stay
unexported.

## HARD RULES + verification

1. **Zero behavior change when no plugin is enabled** — full prior suite green
   with `plugins.enabled: []`. → whole-suite regression.
2. **Discovery never executes plugin code.** → m33.plugin-registry (import
   sentinel fixture).
3. **Default-deny + integrity pin + kill switch + ASHLR_NO_PLUGINS.**
   → m33.plugin-registry.
4. **Capability declarations enforced; undeclared contributions dropped +
   audited.** → m33.plugin-registry.
5. **Host API carries no secrets / raw config; plugin output scrubbed,
   clamped, namespaced.** → m33.plugin-wrappers.
6. **Cloud-tier plugin providers sit behind the existing allowCloud + key
   gates.** → m33.plugin-providers.
7. **No publish without a human tag; tag==version==changelog enforced;
   provenance on.** → m33.release-meta.
8. **`applyProposal` is not exported from the public API.** → m33.release-meta
   / api-surface assertion.
9. **No new runtime dependencies.** → package.json unchanged deps.

## Deliverables checklist

- [x] `src/core/plugins/{types,manifest,integrity,registry,host-api,wrappers}.ts`
- [x] Config plumbing: `AshlrConfig.plugins` (optional), `defaultConfig()`,
      `schema/config.schema.json`, `WorkSource += 'plugin'`.
- [x] Extension-point wiring (scanners/templates/providers/commands).
- [x] `src/cli/plugins.ts` + `ashlr x` dispatch + doctor check.
- [x] `src/api/{index,core,types,plugin}.ts` + exports map.
- [x] `scripts/check-version.mjs`, `scripts/extract-changelog.mjs`,
      `.github/workflows/release.yml`, CI pack-smoke, update channels.
- [x] Tests: m33.plugin-manifest, m33.plugin-registry, m33.plugin-wrappers,
      m33.plugin-wiring, m33.update-channel, m33.release-meta.
- [x] Docs: docs/PLUGINS.md, docs/RELEASING.md, README, CHANGELOG.

## Non-goals (explicit)

OS-level plugin sandboxing · plugin marketplace / remote fetch / auto-update
of plugins · publishing without a human tag push.

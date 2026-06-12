# ashlr plugins — authoring guide + trust model

ashlr can be extended with plugins that contribute **backlog scanners**,
**project templates**, **model providers**, and **CLI commands** — without
forking the hub.

## The trust model (read this first)

**Honesty over theater:** an enabled plugin is in-process Node ESM. Once
loaded it runs with the same OS privileges as ashlr itself. ashlr does **not**
claim an OS-level sandbox. The safety posture is *gating + least-privilege
API + tamper evidence + auditability*, not containment:

1. **Default-deny.** `plugins.enabled` defaults to `[]`. Discovery
   (`ashlr plugins list`) reads `manifest.json` files only — **no plugin code
   executes** until you have explicitly enabled the name.
2. **Explicit, informed enablement.** `ashlr plugins enable <name>` shows the
   declared capabilities and a trust warning, requires confirmation, and pins
   the entry file's sha256 into your config.
3. **Tamper evidence.** Any later change to the entry file refuses to load
   (integrity mismatch, audited) until you re-run `enable`.
4. **Capability declarations enforced.** A plugin contributing something it
   did not declare in `manifest.capabilities` has that contribution dropped
   and audited — a "scanner" plugin cannot smuggle in a CLI command.
5. **No secrets in the host API.** Plugins receive a frozen, allowlisted
   config *projection* and their own `plugins.settings.<name>` block — never
   the raw `AshlrConfig`, never environment secrets, never Phantom values.
6. **Safety invariants preserved.** No plugin API path reaches inbox
   approval, `applyProposal`, enrollment writes, or config writes. The
   proposal-only mutation flow is unreachable from plugin code via the host.
7. **Kill switch + escape hatch.** The global kill switch (`~/.ashlr/KILL`)
   zeroes plugin loading; `ASHLR_NO_PLUGINS=1` recovers a session when a
   plugin breaks startup.
8. **Everything audited.** Load, refusal, activation, capability violations,
   and command runs all append to `~/.ashlr/audit/` (see `ashlr audit`).
9. **Failure isolation.** Every plugin interaction is try/caught and
   time-bounded (5s activate, 15s per scanner sweep). A broken plugin
   degrades to "skipped + warned" — builtin behavior never breaks.

**Only enable plugins whose source you have read or whose author you trust.**

## Quick start

```bash
ashlr plugins init my-scanner --capability scanner   # working skeleton, ready to edit
```

This scaffolds a proven-loadable plugin under `~/.ashlr/plugins/my-scanner/`
(every skeleton is integration-tested in test/m33.plugin-init.test.ts). Or by
hand:

```
~/.ashlr/plugins/my-scanner/
├── manifest.json
└── index.js
```

`manifest.json`:

```json
{
  "name": "my-scanner",
  "version": "0.1.0",
  "apiVersion": "^1.0.0",
  "description": "Finds FIXME(security) markers",
  "entry": "./index.js",
  "capabilities": ["scanner"]
}
```

`index.js` (plain ESM; for typed authoring `npm i -D @ashlr/hub` and import
from `@ashlr/hub/plugin`):

```js
export default {
  activate(host) {
    host.log('activated');
    return {
      scanners: [{
        id: 'fixme-security',
        async scan(repo) {
          // read files under `repo`, return WorkItem-shaped objects:
          return [{
            id: 'demo', repo, source: 'plugin',
            title: 'FIXME(security) found', detail: 'src/auth.ts:42',
            value: 4, effort: 2, score: 0, tags: [], ts: new Date().toISOString(),
          }];
        },
      }],
    };
  },
};
```

Then:

```bash
ashlr plugins list             # discovery — reads manifests only
ashlr plugins enable my-scanner   # confirm + integrity pin
ashlr backlog refresh          # plugin items appear tagged [plugin]
ashlr plugins disable my-scanner
```

## Host API surface

`activate(host)` receives:

| Field | What it is |
|---|---|
| `host.apiVersion` | The hub's `PLUGIN_API_VERSION` (`manifest.apiVersion` is matched against it) |
| `host.pluginName` | Your manifest name |
| `host.log(msg)` | stderr line prefixed `[plugin:<name>]` |
| `host.audit(action, summary)` | Append to the ashlr audit trail (secret-scrubbed) |
| `host.settings` | Frozen copy of `plugins.settings.<name>` from the user's config |
| `host.view` | Frozen allowlisted config projection (`editor`, `staleDays`) |
| `host.dataDir` | `~/.ashlr/plugin-data/<name>/` — the only sanctioned write location |

## Contribution kinds

- **scanner** — `{ id, scan(repo, { signal }) }` → `WorkItem[]`. Wrapped by the
  hub: 15s timeout, 100-item cap, value/effort clamped, score recomputed,
  titles/details secret-scrubbed, ids namespaced, `source: 'plugin'` forced.
- **template** — a `ProjectTemplate` for `ashlr new`. Id is prefixed
  `<plugin>:`; file paths must be relative, no `..`, never under `.git/`.
- **provider** — `{ id, tier, envKeys?, probe(), createClient() }`. A
  `tier: 'cloud'` provider sits behind the SAME local-first gates as builtin
  cloud providers (`--allow-cloud` + key present); env values are never read
  by the host — only key *presence* is checked.
- **command** — `{ name, description, run(args, host) }`, invoked as
  `ashlr x <name> [...]`. Cannot shadow builtin commands.

## Versioning

The plugin API is semver'd (`PLUGIN_API_VERSION`). Declare a range in
`manifest.apiVersion` (e.g. `"^1.0.0"`); incompatible plugins are skipped with
a clear reason in `ashlr plugins list`.

## Non-goals (deliberate)

- No OS-level sandboxing of plugin code.
- No plugin marketplace, remote fetch, or auto-update of plugins — you place
  the files under `~/.ashlr/plugins/` yourself.

# backlog-scanner — reference plugin

A minimal, dependency-free plugin that contributes one scanner capability.

## What it detects

`FIXME(<owner>):` ownership-tagged comment lines across source files in a repo.
Each unique (file, line) hit becomes one `WorkItem` in the ashlr backlog,
letting teams track named debt rather than anonymous TODOs.

```
// FIXME(alice): this needs a null check before release
# FIXME(platform-team): replace with the v2 API
```

## Authoring lessons

### `manifest.json` rules (enforced by `readManifest`)

| Field | Constraint |
|---|---|
| `name` | `^[a-z][a-z0-9-]{0,39}$` AND must equal the directory basename |
| `entry` | Relative path (`./index.js`), must resolve inside the plugin dir |
| `apiVersion` | Semver range against `PLUGIN_API_VERSION` (currently `1.0.0`) |
| `capabilities` | Non-empty array; only declared kinds are allowed contributions |

### What the hub wrapper does for you

Don't fight these — they happen unconditionally on every scanner result:

- **id namespacing**: `plugin:<name>:<scanner-id>:<your-id>`
- **source forced**: `source: 'plugin'`
- **tags augmented**: `['plugin', pluginName, scannerId, ...yourTags]`
- **value/effort clamped**: integers in `1..5`
- **score recomputed**: `scoreItem(value, effort)` — `value / effort`
- **secrets scrubbed**: title + detail pass through `scrubSecrets`
- **cap**: at most 100 items returned
- **timeout**: 15-second AbortSignal; respect `ctx.signal.aborted`

### TypeScript authoring

```ts
import { definePlugin } from '@ashlr/hub/plugin';
import type { AshlrPlugin } from '@ashlr/hub/plugin';

export default definePlugin({
  activate(host) {
    host.log('activated');
    return {
      scanners: [{ id: 'my-scan', async scan(repo, ctx) { return []; } }],
    };
  },
});
```

When developing inside the hub monorepo, import from the relative path:

```ts
import { definePlugin } from '../../../src/core/plugins/types.js';
```

### DX notes (feedback for the platform)

- `definePlugin()` is a clean identity helper — zero friction, full inference.
- The `PluginHost` type is well-specified; `host.log`, `host.settings`, and
  `host.dataDir` are the three fields a real scanner uses in practice.
- The `WorkItem` type (from `src/core/types.ts`) isn't re-exported via
  `@ashlr/hub/plugin` — plugin authors need to import it separately from
  `@ashlr/hub/types`. Worth adding to the plugin surface in v2.
- The `entry` in `manifest.json` points to `./index.js` (the compiled output),
  but in a monorepo test context you import the `.ts` source directly via vitest.
  This dual-file reality is slightly awkward — a note in PLUGINS.md would help.

## Installation (manual)

```bash
cp -r examples/plugins/backlog-scanner ~/.ashlr/plugins/backlog-scanner
ashlr plugins list               # discovers manifest, never imports code
ashlr plugins enable backlog-scanner   # confirm + integrity pin
ashlr backlog refresh            # items appear tagged [plugin]
```

## Test

```bash
npx vitest run test/m58.reference-plugin.test.ts
```

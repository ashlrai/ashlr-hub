# org-scaffold — reference template plugin

A minimal, dependency-free plugin that contributes one template capability.

## What it scaffolds

The `service-readme` template emits a five-file TypeScript micro-service layout:

| File | Purpose |
|---|---|
| `README.md` | Project overview (parameterised by name + category) |
| `package.json` | ESM package with `build` / `test` / `typecheck` / `start` scripts |
| `tsconfig.json` | Strict NodeNext config, `outDir: dist`, `rootDir: src` |
| `src/index.ts` | Stub service entry point |
| `src/index.test.ts` | Vitest placeholder |
| `.gitignore` | Ignores `node_modules/`, `dist/`, `*.tsbuildinfo` |

## Authoring lessons

### `manifest.json` rules (same as the scanner capability)

| Field | Constraint |
|---|---|
| `name` | `^[a-z][a-z0-9-]{0,39}$` AND must equal the directory basename |
| `entry` | Relative path (`./index.js`), must resolve inside the plugin dir |
| `apiVersion` | Semver range against `PLUGIN_API_VERSION` (currently `1.0.0`) |
| `capabilities` | Must include `"template"` |

### What the hub wrapper does for you (`validateTemplate`)

The wrapper from `src/core/plugins/wrappers.ts` runs on every template:

- **id prefixed**: `<pluginName>:<your-id>` — emit a bare id in your plugin.
- **path guard on probe**: calls `files({ name: '', category: '' })` once at
  load time; if any path is absolute, contains `..`, or starts with `.git/`,
  the entire template is **rejected** (returns `null`, audited).
- **path guard on every call**: the wrapped `files()` silently filters out any
  bad path injected after the probe (defence against closure-based smuggling).
- **never throws**: `validateTemplate` is belt-and-suspenders try/caught.

### TypeScript authoring

```ts
import { definePlugin } from '@ashlr/hub/plugin';
import type { ProjectTemplate, TemplateFile } from '@ashlr/hub/types';

const myTemplate: ProjectTemplate = {
  id: 'my-template',
  title: 'My Template',
  description: 'Does something useful.',
  files({ name, category }) {
    return [
      { path: 'README.md', content: `# ${name}\n` },
    ];
  },
};

export default definePlugin({
  activate(host) {
    host.log('activated');
    return { templates: [myTemplate] };
  },
});
```

When developing inside the hub monorepo, import from the relative path:

```ts
import { definePlugin } from '../../../src/core/plugins/types.js';
import type { ProjectTemplate, TemplateFile } from '../../../src/core/types.js';
```

### DX notes (feedback for the platform)

- `definePlugin()` is a clean identity helper — same experience as scanner.
- `ProjectTemplate` / `TemplateFile` are NOT re-exported via `@ashlr/hub/plugin`
  (the plugin surface only re-exports `WorkItem` / `WorkSource`). Template
  authors must add a second import from `@ashlr/hub/types`. Worth unifying in v2.
- The `files()` ctx (`{ name, category }`) is minimal. Real org scaffolding
  usually needs `owner`, `repo`, `license`, etc. — authors will need to pass
  those through `host.settings` or parameterise via a command plugin. A richer
  ctx shape would be a worthwhile v2 addition.
- The probe-with-empty-string approach (`files({ name: '', category: '' })`)
  can trip up templates that unconditionally interpolate `name` into a path
  (e.g. `src/${name}/index.ts` would produce `src//index.ts` on probe). The
  current plugin avoids this by using fixed paths only; authors should be warned
  in PLUGINS.md that `name` must not appear in file paths.
- There is no `PluginTemplateSpec` type alias — contributions use `ProjectTemplate`
  directly. The PLUGINS.md authoring guide refers to a "template spec" informally
  but the canonical type is `ProjectTemplate` from `src/core/types.ts`.

## Installation (manual)

```bash
cp -r examples/plugins/org-scaffold ~/.ashlr/plugins/org-scaffold
ashlr plugins list               # discovers manifest, never imports code
ashlr plugins enable org-scaffold   # confirm + integrity pin
ashlr new my-service             # pick "service-readme (org-scaffold)" from the menu
```

## Test

```bash
npx vitest run test/m60.reference-template-plugin.test.ts
```

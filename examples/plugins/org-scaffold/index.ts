/**
 * examples/plugins/org-scaffold/index.ts
 *
 * Reference plugin — M33 plugin system authoring example for the TEMPLATE
 * capability (counterpart to examples/plugins/backlog-scanner/ which exercises
 * the scanner capability).
 *
 * WHAT IT DOES:
 *   Contributes a single project template — "service-readme" — that scaffolds
 *   a minimal TypeScript micro-service layout:
 *
 *     README.md          — project overview (parameterised by name + category)
 *     package.json       — ESM package with build/test scripts
 *     tsconfig.json      — strict NodeNext config
 *     src/index.ts       — stub service entry point
 *     src/index.test.ts  — vitest placeholder
 *
 *   All emitted paths are relative, contain no ".." segments, and do not start
 *   with ".git/" — they pass the validateTemplate path guard unconditionally.
 *
 * AUTHORING NOTES:
 *   - Import types from '@ashlr/hub/plugin' in published plugins; use the
 *     relative src path when working inside the monorepo (vitest transpiles TS).
 *   - ProjectTemplate / TemplateFile are NOT re-exported via '@ashlr/hub/plugin'
 *     (only WorkItem/WorkSource are); import them from '@ashlr/hub/types' or the
 *     relative core path — see DX notes in README.md.
 *   - Use definePlugin() for full TypeScript checking on the module default export.
 *   - The validateTemplate wrapper (wrappers.ts) will prefix your template id
 *     with "<plugin-name>:" automatically — emit a bare id here.
 *   - files() must never throw; the wrapper treats a throwing probe as a
 *     rejection. Keep the function pure and synchronous.
 */

import type {
  AshlrPlugin,
  PluginHost,
  PluginContributions,
} from '../../../src/core/plugins/types.js';
import { definePlugin } from '../../../src/core/plugins/types.js';
import type { ProjectTemplate, TemplateFile } from '../../../src/core/types.js';

// ---------------------------------------------------------------------------
// Template: service-readme
// ---------------------------------------------------------------------------

const serviceReadmeTemplate: ProjectTemplate = {
  id: 'service-readme',
  title: 'TypeScript Service',
  description:
    'A minimal TypeScript micro-service scaffold: README, package.json, tsconfig, and a stub entry point with a vitest placeholder.',

  files({ name, category }: { name: string; category: string }): TemplateFile[] {
    return [
      // README
      {
        path: 'README.md',
        content: `# ${name}

> Category: \`${category}\` · Stack: \`ts-service\`

A minimal TypeScript service scaffolded with [ashlr](https://github.com/ashlrai/ashlr-hub).

## Quick Start

\`\`\`bash
npm install
npm run build
node dist/index.js
\`\`\`

## Scripts

| Script | Purpose |
|--------|---------|
| \`npm run build\` | Compile TypeScript to \`dist/\` |
| \`npm test\` | Run vitest suite |
| \`npm run typecheck\` | Type-check without emitting |

## Structure

\`\`\`
src/
  index.ts       — service entry point
  index.test.ts  — vitest placeholder
dist/            — compiled output (git-ignored)
\`\`\`
`,
      },

      // package.json
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name,
            version: '0.1.0',
            description: `${name} — a TypeScript service scaffolded with ashlr`,
            type: 'module',
            main: './dist/index.js',
            scripts: {
              build: 'tsc',
              test: 'vitest run',
              typecheck: 'tsc --noEmit',
              start: 'node dist/index.js',
            },
            devDependencies: {
              typescript: '^5.4.0',
              vitest: '^1.6.0',
            },
          },
          null,
          2,
        ) + '\n',
      },

      // tsconfig.json
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              outDir: './dist',
              rootDir: './src',
              strict: true,
              skipLibCheck: true,
              declaration: true,
              sourceMap: true,
            },
            include: ['src'],
            exclude: ['node_modules', 'dist'],
          },
          null,
          2,
        ) + '\n',
      },

      // src/index.ts — service entry
      {
        path: 'src/index.ts',
        content: `/**
 * ${name} — service entry point
 *
 * Scaffolded by org-scaffold (ashlr template plugin).
 * Replace this stub with your service logic.
 */

export function main(): void {
  console.log('[${name}] service started');
}

main();
`,
      },

      // src/index.test.ts — vitest placeholder
      {
        path: 'src/index.test.ts',
        content: `import { describe, it, expect } from 'vitest';

describe('${name}', () => {
  it('placeholder passes', () => {
    expect(true).toBe(true);
  });
});
`,
      },

      // .gitignore
      {
        path: '.gitignore',
        content: 'node_modules/\ndist/\n*.tsbuildinfo\n',
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Plugin definition — using definePlugin() for full TypeScript checking
// ---------------------------------------------------------------------------

const orgScaffoldPlugin: AshlrPlugin = definePlugin({
  activate(_host: PluginHost): PluginContributions {
    _host.log('org-scaffold activated');
    return {
      templates: [serviceReadmeTemplate],
    };
  },
});

export default orgScaffoldPlugin;

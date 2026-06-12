/**
 * M6: Project Lifecycle — Template Registry
 *
 * Four agentic-engineering starter templates for `ashlr new`.
 * Pure data module — no filesystem or network access.
 */

import type { ProjectTemplate, TemplateFile } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers — common files every template includes
// ---------------------------------------------------------------------------

function claudeMd(name: string, category: string, stack: string): TemplateFile {
  return {
    path: 'CLAUDE.md',
    content: `# ${name}

> Category: \`${category}\` · Stack: \`${stack}\`

## About This Project

This project was scaffolded with **ashlr** — a local-first agentic engineering hub.
All AI-assisted work on this repo is wired through the **ashlr gateway** (see \`.mcp.json\`).

## Agentic Engineering Conventions

- **local-first via ashlr**: prefer local models; cloud fallback only when needed.
- **genome stubs** live in \`.ashlrcode/genome/\` — update them as patterns emerge.
- One logical change per commit; keep commits small and descriptive.
- All new modules get a \`// M: <purpose>\` header comment.
- Prefer explicit types over inference at module boundaries.

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
\`\`\`

## Session Tracking

Sessions are captured automatically via \`entire\` on every commit.
Use \`entire resume <branch>\` when picking up prior work.
`,
  };
}

function mcpJson(): TemplateFile {
  return {
    path: '.mcp.json',
    content: JSON.stringify(
      {
        mcpServers: {
          ashlr: {
            command: 'ashlr',
            args: ['mcp'],
          },
        },
      },
      null,
      2,
    ) + '\n',
  };
}

function genomeGitkeep(): TemplateFile {
  return {
    path: '.ashlrcode/genome/.gitkeep',
    content: '',
  };
}

function gitignore(extras: string[] = []): TemplateFile {
  const lines = ['node_modules/', 'dist/', ...extras, ''];
  return {
    path: '.gitignore',
    content: lines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Template: minimal
// ---------------------------------------------------------------------------

const minimalTemplate: ProjectTemplate = {
  id: 'minimal',
  title: 'Minimal',
  description: 'README, .gitignore, and CLAUDE.md only — a blank agentic-engineering slate.',
  files({ name, category }): TemplateFile[] {
    return [
      {
        path: 'README.md',
        content: `# ${name}\n\n> Category: \`${category}\`\n\nA minimal project scaffolded with [ashlr](https://github.com/ashlrai/ashlr-hub).\n`,
      },
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name,
            version: '0.1.0',
            description: `${name} — a minimal project scaffolded with ashlr`,
            type: 'module',
            private: true,
          },
          null,
          2,
        ) + '\n',
      },
      gitignore(),
      claudeMd(name, category, 'minimal'),
      mcpJson(),
      genomeGitkeep(),
    ];
  },
};

// ---------------------------------------------------------------------------
// Template: node-cli
// ---------------------------------------------------------------------------

const nodeCliTemplate: ProjectTemplate = {
  id: 'node-cli',
  title: 'Node CLI',
  description: 'TypeScript ESM CLI with bin entry, tsconfig, vitest, and an ashlr-hub-lite layout.',
  files({ name, category }): TemplateFile[] {
    return [
      {
        path: 'README.md',
        content: `# ${name}

> Category: \`${category}\` · Stack: \`node-cli\`

A TypeScript ESM CLI scaffolded with [ashlr](https://github.com/ashlrai/ashlr-hub).

## Usage

\`\`\`bash
npm install
npm run build
node dist/index.js --help
\`\`\`

## Scripts

| Script | Purpose |
|--------|---------|
| \`npm run build\` | Compile TypeScript to \`dist/\` |
| \`npm test\` | Run vitest suite |
| \`npm run typecheck\` | Type-check without emitting |
| \`npm run lint\` | ESLint |
`,
      },
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name,
            version: '0.1.0',
            description: `${name} CLI`,
            type: 'module',
            bin: {
              [name]: './dist/index.js',
            },
            main: './dist/index.js',
            scripts: {
              build: 'tsc',
              test: 'vitest run',
              typecheck: 'tsc --noEmit',
              lint: 'eslint src',
            },
            devDependencies: {
              typescript: '^5.4.0',
              vitest: '^1.6.0',
              '@typescript-eslint/eslint-plugin': '^7.0.0',
              '@typescript-eslint/parser': '^7.0.0',
              eslint: '^8.57.0',
            },
          },
          null,
          2,
        ) + '\n',
      },
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
              declarationMap: true,
              sourceMap: true,
            },
            include: ['src'],
            exclude: ['node_modules', 'dist'],
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'src/index.ts',
        content: `#!/usr/bin/env node
/**
 * ${name} — entry point
 */

const [,, ...args] = process.argv;

if (args.includes('--help') || args.includes('-h')) {
  console.log(\`${name} — a CLI tool\\n\\nUsage: ${name} [options]\\n\\nOptions:\\n  --help, -h  Show this help\`);
  process.exit(0);
}

console.log(\`Hello from ${name}!\`);
`,
        mode: 0o755,
      },
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
      gitignore(['*.tsbuildinfo']),
      claudeMd(name, category, 'node-cli'),
      mcpJson(),
      genomeGitkeep(),
    ];
  },
};

// ---------------------------------------------------------------------------
// Template: mcp-server
// ---------------------------------------------------------------------------

const mcpServerTemplate: ProjectTemplate = {
  id: 'mcp-server',
  title: 'MCP Server',
  description: 'Minimal @modelcontextprotocol/sdk stdio server skeleton with TypeScript ESM.',
  files({ name, category }): TemplateFile[] {
    return [
      {
        path: 'README.md',
        content: `# ${name}

> Category: \`${category}\` · Stack: \`mcp-server\`

A minimal MCP (Model Context Protocol) stdio server scaffolded with [ashlr](https://github.com/ashlrai/ashlr-hub).

## Usage

\`\`\`bash
npm install
npm run build
node dist/server.js
\`\`\`

Wire into a Claude Code project via \`.mcp.json\`:

\`\`\`json
{
  "mcpServers": {
    "${name}": {
      "command": "node",
      "args": ["path/to/${name}/dist/server.js"]
    }
  }
}
\`\`\`

## Scripts

| Script | Purpose |
|--------|---------|
| \`npm run build\` | Compile TypeScript to \`dist/\` |
| \`npm test\` | Run vitest suite |
| \`npm run typecheck\` | Type-check without emitting |
`,
      },
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name,
            version: '0.1.0',
            description: `${name} MCP server`,
            type: 'module',
            main: './dist/server.js',
            scripts: {
              build: 'tsc',
              test: 'vitest run',
              typecheck: 'tsc --noEmit',
              start: 'node dist/server.js',
            },
            dependencies: {
              '@modelcontextprotocol/sdk': '^1.0.0',
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
      {
        path: 'src/server.ts',
        content: `/**
 * ${name} — MCP stdio server entry point
 *
 * Skeleton using @modelcontextprotocol/sdk.
 * Add your tools, resources, and prompts below.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: '${name}', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'hello',
      description: 'A starter tool — returns a greeting.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Name to greet' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: toolName, arguments: args } = request.params;

  if (toolName === 'hello') {
    const who = (args as { name?: string }).name ?? 'world';
    return {
      content: [{ type: 'text', text: \`Hello, \${who}! From ${name} MCP server.\` }],
    };
  }

  throw new Error(\`Unknown tool: \${toolName}\`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
`,
        mode: 0o755,
      },
      {
        path: 'src/server.test.ts',
        content: `import { describe, it, expect } from 'vitest';

describe('${name} server', () => {
  it('placeholder passes', () => {
    expect(true).toBe(true);
  });
});
`,
      },
      gitignore(['*.tsbuildinfo']),
      claudeMd(name, category, 'mcp-server'),
      mcpJson(),
      genomeGitkeep(),
    ];
  },
};

// ---------------------------------------------------------------------------
// Template: next-app
// ---------------------------------------------------------------------------

const nextAppTemplate: ProjectTemplate = {
  id: 'next-app',
  title: 'Next.js App',
  description: 'Minimal Next.js 14 App Router project with TypeScript and Tailwind CSS.',
  files({ name, category }): TemplateFile[] {
    return [
      {
        path: 'README.md',
        content: `# ${name}

> Category: \`${category}\` · Stack: \`next-app\`

A minimal Next.js 14 application scaffolded with [ashlr](https://github.com/ashlrai/ashlr-hub).

## Usage

\`\`\`bash
npm install
npm run dev
\`\`\`

Open [http://localhost:3000](http://localhost:3000).

## Scripts

| Script | Purpose |
|--------|---------|
| \`npm run dev\` | Start development server |
| \`npm run build\` | Production build |
| \`npm start\` | Start production server |
| \`npm run lint\` | ESLint |
`,
      },
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name,
            version: '0.1.0',
            description: `${name} Next.js app`,
            private: true,
            scripts: {
              dev: 'next dev',
              build: 'next build',
              start: 'next start',
              lint: 'next lint',
            },
            dependencies: {
              next: '^14.2.0',
              react: '^18.3.0',
              'react-dom': '^18.3.0',
            },
            devDependencies: {
              typescript: '^5.4.0',
              '@types/node': '^20.0.0',
              '@types/react': '^18.3.0',
              '@types/react-dom': '^18.3.0',
              tailwindcss: '^3.4.0',
              autoprefixer: '^10.4.0',
              postcss: '^8.4.0',
              eslint: '^8.57.0',
              'eslint-config-next': '^14.2.0',
            },
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2017',
              lib: ['dom', 'dom.iterable', 'esnext'],
              allowJs: true,
              skipLibCheck: true,
              strict: true,
              noEmit: true,
              esModuleInterop: true,
              module: 'esnext',
              moduleResolution: 'bundler',
              resolveJsonModule: true,
              isolatedModules: true,
              jsx: 'preserve',
              incremental: true,
              plugins: [{ name: 'next' }],
              paths: { '@/*': ['./src/*'] },
            },
            include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
            exclude: ['node_modules'],
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'next.config.ts',
        content: `import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Add your Next.js config here
};

export default nextConfig;
`,
      },
      {
        path: 'src/app/layout.tsx',
        content: `import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '${name}',
  description: '${name} — scaffolded with ashlr',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      },
      {
        path: 'src/app/page.tsx',
        content: `export default function Home() {
  return (
    <main>
      <h1>${name}</h1>
      <p>Scaffolded with <strong>ashlr</strong>. Start editing <code>src/app/page.tsx</code>.</p>
    </main>
  );
}
`,
      },
      {
        path: 'src/app/globals.css',
        content: `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
      },
      {
        path: 'tailwind.config.ts',
        content: `import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
`,
      },
      {
        path: 'postcss.config.js',
        content: `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`,
      },
      {
        path: '.eslintrc.json',
        content: JSON.stringify({ extends: 'next/core-web-vitals' }, null, 2) + '\n',
      },
      gitignore(['.next/', 'out/', '*.tsbuildinfo', '.env*.local']),
      claudeMd(name, category, 'next-app'),
      mcpJson(),
      genomeGitkeep(),
    ];
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TEMPLATES: ProjectTemplate[] = [
  nodeCliTemplate,
  mcpServerTemplate,
  nextAppTemplate,
  minimalTemplate,
];

/**
 * M33: builtin TEMPLATES + validated templates from enabled plugins.
 * Best-effort: a broken plugin layer yields the builtins only. Plugin
 * template ids arrive prefixed `<plugin>:<id>` (wrappers.validateTemplate).
 */
export async function getTemplates(cfg?: import('../types.js').AshlrConfig): Promise<ProjectTemplate[]> {
  let fromPlugins: ProjectTemplate[] = [];
  try {
    const { loadConfig } = await import('../config.js');
    const { getPluginTemplates } = await import('../plugins/registry.js');
    fromPlugins = await getPluginTemplates(cfg ?? loadConfig());
  } catch {
    fromPlugins = [];
  }
  return [...TEMPLATES, ...fromPlugins];
}

export function getTemplate(id: string): ProjectTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

export function listTemplates(): { id: string; title: string; description: string }[] {
  return TEMPLATES.map(({ id, title, description }) => ({ id, title, description }));
}

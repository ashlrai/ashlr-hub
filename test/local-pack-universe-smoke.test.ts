import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

// Keep the child program's native import() syntax out of Vite's SSR transform.
const { installedUniverseSmokeArgs } = createRequire(import.meta.url)('../scripts/run-local-pack-smoke.mjs');

const scratch: string[] = [];
afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const path of scratch.splice(0)) { writable(path); rmSync(path, { recursive: true, force: true }); }
});

/** Source-backed package wrappers test the exact smoke program without npm install. */
function fixture(options: { sdkOverride?: string; ignoreInvalidFlags?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pack-universe-')));
  scratch.push(root);
  const installed = join(root, 'install');
  const packageRoot = join(installed, 'node_modules', '@ashlr', 'hub');
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@ashlr/hub', type: 'module',
    exports: { './universe': './universe.mjs' } }));
  const sdk = pathToFileURL(resolve('src/core/universe/index.ts')).href;
  writeFileSync(join(packageRoot, 'universe.mjs'),
    `export * from ${JSON.stringify(sdk)};\n${options.sdkOverride ?? ''}\n`);
  const bin = join(packageRoot, 'ashlr');
  const cli = pathToFileURL(resolve('src/cli/universe.ts')).href;
  writeFileSync(bin, `#!/usr/bin/env node\nimport { cmdUniverse } from ${JSON.stringify(cli)};\n` +
    (options.ignoreInvalidFlags ? "if (process.argv.includes('--unexpected')) { console.log('{}'); process.exit(0); }\n" : '') +
    "if (process.argv[2] !== 'universe') throw new Error('Unexpected smoke command');\n" +
    'process.exitCode = await cmdUniverse(process.argv.slice(3));\n');
  chmodSync(bin, 0o755);
  const smokeRoot = join(root, 'smoke');
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const run = () => spawnSync(process.execPath, installedUniverseSmokeArgs(smokeRoot, bin), {
    cwd: installed, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${loader}`,
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  return { root, installed, smokeRoot, bin, run };
}

describe('installed Universe package smoke', () => {
  it('exercises SDK and CLI lifecycle without executing any candidate or evaluator', () => {
    const { smokeRoot, run } = fixture();
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('passed (no work executed)');
    expect(lstatSync(join(smokeRoot, 'store', 'universes', 'pack-universe', 'seed')).mode & 0o777).toBe(0o700);
    const campaign = JSON.parse(readFileSync(join(smokeRoot, 'campaign.json'), 'utf8'));
    expect(campaign.budget.maxModelRequests).toBe(0);
  });

  it.each(['runUniverseCampaign', 'deliverUniverseElite', 'readUniverseGraph', 'traverseUniverseGraph'])('rejects missing public SDK export %s before creating the smoke store', (name) => {
    const { smokeRoot, run } = fixture({ sdkOverride: `export const ${name} = undefined;` });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Universe SDK export missing: ${name}`);
    expect(existsSync(smokeRoot)).toBe(false);
  });

  it('detects a read path that unexpectedly creates its missing store', () => {
    const sdk = pathToFileURL(resolve('src/core/universe/index.ts')).href;
    const { run } = fixture({ sdkOverride:
      `import { readUniverseOverview as originalRead } from ${JSON.stringify(sdk)};\n` +
      "import { mkdirSync } from 'node:fs';\n" +
      'export function readUniverseOverview(options) { const result = originalRead(options); ' +
      'mkdirSync(options.root, { recursive: true, mode: 0o700 }); return result; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Status reads must not create a missing store');
  });

  it('rejects a CLI that treats invalid flags as success', () => {
    const { run } = fixture({ ignoreInvalidFlags: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installed Universe command failed');
    expect(result.stderr).toContain('--unexpected');
  });

  it('rejects a stopped campaign entrypoint that changes execution evidence', () => {
    const sdk = pathToFileURL(resolve('src/core/universe/index.ts')).href;
    const { run } = fixture({ sdkOverride:
      `import { readUniverseCampaign } from ${JSON.stringify(sdk)};\n` +
      'export async function runUniverseCampaign(id, options) { return { ...readUniverseCampaign(id, options), ' +
      'startedAt: new Date().toISOString() }; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('A stopped campaign must not begin work or change its evidence');
  });

  it('encodes fixture paths as data without shell interpolation', () => {
    const args = installedUniverseSmokeArgs('/private/smoke "quoted"', '/private/bin with spaces');
    expect(args.slice(0, 2)).toEqual(['--input-type=module', '-e']);
    expect(args[2]).toContain(JSON.stringify('/private/smoke "quoted"'));
    expect(args[2]).toContain(JSON.stringify('/private/bin with spaces'));
  });
});

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

// Keep the child program's native import() syntax out of Vite's SSR transform.
const { installedUniverseSmokeArgs } = createRequire(import.meta.url)('../scripts/run-local-pack-smoke.mjs');

// Transpile the current reachable graph once, preserving its file layout rather
// than bundling it: import.meta-relative paths and external ESM dependencies
// keep the same resolution behavior. Every smoke still runs in a fresh process
// against its own package wrapper, overrides, HOME and private store.
let compiledRoot: string | undefined;
beforeAll(async () => {
  const sourceRoot = resolve();
  compiledRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pack-universe-source-')));
  const entries = ['src/core/universe/index.ts', 'src/cli/universe.ts', 'src/cli/runtime.ts'];
  const graph = await build({ absWorkingDir: sourceRoot, entryPoints: entries, bundle: true,
    packages: 'external', platform: 'node', format: 'esm', write: false,
    outdir: join(compiledRoot, 'graph-only'), metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(graph.metafile!.inputs);
  for (const input of inputs) {
    const path = relative(sourceRoot, resolve(sourceRoot, input));
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
      throw new Error(`Smoke graph escaped current source: ${input}`);
    }
  }
  await build({ absWorkingDir: sourceRoot, entryPoints: inputs.filter(path => path.endsWith('.ts')),
    outbase: sourceRoot, outdir: compiledRoot, platform: 'node', target: 'node22',
    format: 'esm', bundle: false, logLevel: 'silent' });
  for (const input of inputs.filter(path => !path.endsWith('.ts'))) {
    const output = join(compiledRoot, input);
    mkdirSync(resolve(output, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(resolve(sourceRoot, input), output);
  }
  copyFileSync(join(sourceRoot, 'package.json'), join(compiledRoot, 'package.json'));
  symlinkSync(join(sourceRoot, 'node_modules'), join(compiledRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
});
afterAll(() => {
  if (compiledRoot) rmSync(compiledRoot, { recursive: true, force: true });
});

function sdkModuleUrl(sourceBacked = false): string {
  if (!sourceBacked && !compiledRoot) throw new Error('Current smoke graph was not compiled');
  return pathToFileURL(sourceBacked ? resolve('src/core/universe/index.ts')
    : join(compiledRoot!, 'src/core/universe/index.js')).href;
}

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
function fixture(options: { sdkOverride?: string; ignoreInvalidFlags?: boolean; ignorePortfolioInvalidFlags?: boolean; brokenRuntimeRead?: boolean;
  ignoreComparisonInvalidFlags?: boolean; sourceBacked?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pack-universe-')));
  scratch.push(root);
  const installed = join(root, 'install');
  const packageRoot = join(installed, 'node_modules', '@ashlr', 'hub');
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@ashlr/hub', type: 'module',
    exports: { './universe': './universe.mjs' } }));
  const sdk = sdkModuleUrl(options.sourceBacked);
  writeFileSync(join(packageRoot, 'universe.mjs'),
    `export * from ${JSON.stringify(sdk)};\n${options.sdkOverride ?? ''}\n`);
  const bin = join(packageRoot, 'ashlr');
  const cli = pathToFileURL(options.sourceBacked ? resolve('src/cli/universe.ts')
    : join(compiledRoot!, 'src/cli/universe.js')).href;
  const runtimeCli = pathToFileURL(options.sourceBacked ? resolve('src/cli/runtime.ts')
    : join(compiledRoot!, 'src/cli/runtime.js')).href;
  writeFileSync(bin, `#!/usr/bin/env node\nimport { cmdUniverse } from ${JSON.stringify(cli)};\n` +
    `import { cmdRuntime } from ${JSON.stringify(runtimeCli)};\n` +
    (options.brokenRuntimeRead ? "if (process.argv[2] === 'runtime' && process.argv[3] === 'status') { console.log('{}'); process.exit(1); }\n" : '') +
    "if (process.argv[2] === 'runtime') { process.exit(await cmdRuntime(process.argv.slice(3))); }\n" +
    (options.ignoreInvalidFlags ? "if (process.argv.includes('--unexpected')) { console.log('{}'); process.exit(0); }\n" : '') +
    (options.ignorePortfolioInvalidFlags ? "if (process.argv[3] === 'portfolio' && process.argv.includes('--unexpected')) { console.log('{}'); process.exit(0); }\n" : '') +
    (options.ignoreComparisonInvalidFlags ? "if (process.argv[3] === 'compare' && process.argv.includes('--unexpected')) { console.log('{}'); process.exit(0); }\n" : '') +
    "if (process.argv[2] !== 'universe') throw new Error('Unexpected smoke command');\n" +
    'process.exitCode = await cmdUniverse(process.argv.slice(3));\n');
  chmodSync(bin, 0o755);
  const smokeRoot = join(root, 'smoke');
  const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
  const childEnv = { ...process.env, HOME: root, USERPROFILE: root, ASHLR_HOME: join(root, '.ashlr'),
    NODE_OPTIONS: options.sourceBacked ? `${process.env['NODE_OPTIONS'] ?? ''} --import=${loader}`
      : process.env['NODE_OPTIONS'], GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = () => spawnSync(process.execPath, installedUniverseSmokeArgs(smokeRoot, bin), {
    cwd: installed, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024,
    env: childEnv,
  });
  return { root, installed, smokeRoot, bin, run, childEnv };
}

describe('installed Universe package smoke', () => {
  it('matches the direct TypeScript SDK and successful real CLI observations', () => {
    const compiled = fixture();
    const source = fixture({ sourceBacked: true });
    const observe = (subject: ReturnType<typeof fixture>, sourceBacked: boolean) => {
      const code = `const sdk = await import(${JSON.stringify(sdkModuleUrl(sourceBacked))});\n` +
        `console.log(JSON.stringify({ exports: Object.entries(sdk).map(([key, value]) => [key, typeof value]),\n` +
        `missing: sdk.readUniverseOverview({ root: ${JSON.stringify(join(subject.root, 'uncreated'))} }).sourceState,\n` +
        `portfolio: sdk.validateUniversePortfolioDefinition({schemaVersion:1,id:'parity',tasks:[{campaignId:'parity',dependsOn:[]}],maxParallel:1,maxDurationMs:1000}) }));`;
      const sdk = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: subject.installed, env: subject.childEnv, encoding: 'utf8', timeout: 30_000,
      });
      expect(sdk.error).toBeUndefined();
      expect(sdk.status, sdk.stderr).toBe(0);
      const cli = spawnSync(process.execPath, [subject.bin, 'universe', 'help'], {
        cwd: subject.installed, env: subject.childEnv, encoding: 'utf8', timeout: 30_000,
      });
      expect(cli.error).toBeUndefined();
      expect(cli.status, cli.stderr).toBe(0);
      const status = spawnSync(process.execPath,
        [subject.bin, 'universe', 'status', '--root', join(subject.root, 'uncreated'), '--json'], {
          cwd: subject.installed, env: subject.childEnv, encoding: 'utf8', timeout: 30_000,
        });
      expect(status.error).toBeUndefined();
      expect(status.status, status.stderr).toBe(0);
      const { sampledAt, ...overview } = JSON.parse(status.stdout);
      expect(typeof sampledAt).toBe('string');
      expect(overview.sourceState).toBe('missing');
      expect(existsSync(join(subject.root, 'uncreated'))).toBe(false);
      return { sdk: JSON.parse(sdk.stdout), cli: cli.stdout, cliStderr: cli.stderr, overview };
    };
    expect(observe(compiled, false)).toEqual(observe(source, true));
  });

  it('exercises SDK and CLI lifecycle without executing any candidate or evaluator', () => {
    const { smokeRoot, run } = fixture();
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('passed (no work executed)');
    expect(lstatSync(join(smokeRoot, 'store', 'universes', 'pack-universe', 'seed')).mode & 0o777).toBe(0o700);
    const campaign = JSON.parse(readFileSync(join(smokeRoot, 'campaign.json'), 'utf8'));
    expect(campaign.budget.maxModelRequests).toBe(0);
    const portfolio = JSON.parse(readFileSync(join(smokeRoot, 'portfolio.json'), 'utf8'));
    expect(portfolio.tasks).toEqual([{ campaignId: 'pack-sdk', dependsOn: [] }]);
    expect(existsSync(join(smokeRoot, 'missing-store'))).toBe(false);
    expect(existsSync(join(smokeRoot, 'missing-runtime-store'))).toBe(false);
  });

  it('rejects an installed runtime CLI that omits missing-store evidence', () => {
    const { run } = fixture({ brokenRuntimeRead: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing');
  });

  it.each(['runUniverseCampaign', 'deliverUniverseElite', 'readUniverseGraph', 'traverseUniverseGraph',
    'validateUniversePortfolioDefinition', 'readUniversePortfolioPlan', 'buildUniversePortfolioPlan', 'runUniversePortfolio',
    'buildUniverseSearchContext', 'validateUniverseSearchContext', 'searchContextReceipt',
    'buildUniverseFileOperationsContext', 'validateUniverseFileOperationsContext', 'fileOperationsContextDigest',
    'buildUniverseCampaignComparison', 'readUniverseCampaignComparison'])('rejects missing public SDK export %s before creating the smoke store', (name) => {
    const { smokeRoot, run } = fixture({ sdkOverride: `export const ${name} = undefined;` });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Universe SDK export missing: ${name}`);
    expect(existsSync(smokeRoot)).toBe(false);
  });

  it('detects a read path that unexpectedly creates its missing store', () => {
    const sdk = sdkModuleUrl();
    const { run } = fixture({ sdkOverride:
      `import { readUniverseOverview as originalRead } from ${JSON.stringify(sdk)};\n` +
      "import { mkdirSync } from 'node:fs';\n" +
      'export function readUniverseOverview(options) { const result = originalRead(options); ' +
      'mkdirSync(options.root, { recursive: true, mode: 0o700 }); return result; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Status reads must not create a missing store');
  });

  it('detects a file-state validator that silently accepts omitted paths', () => {
    const { run } = fixture({ sdkOverride:
      'export function validateUniverseFileOperationsContext(value) { return value; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing file state must not be silently interpreted as absence');
  });

  it('detects a manifest validator that silently removes file operations', () => {
    const sdk = sdkModuleUrl();
    const { run } = fixture({ sdkOverride:
      `import { validateUniverseManifest as originalValidate } from ${JSON.stringify(sdk)};\n` +
      'export function validateUniverseManifest(value) { const result = originalValidate(value); ' +
      'for (const variant of result.variants) if (variant.generation) delete variant.generation.fileOperations; return result; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fileOperations');
  });

  it('rejects a CLI that treats invalid flags as success', () => {
    const { run } = fixture({ ignoreInvalidFlags: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installed Universe command failed');
    expect(result.stderr).toContain('--unexpected');
  });

  it('detects portfolio planning that creates a missing store', () => {
    const sdk = sdkModuleUrl();
    const { run } = fixture({ sdkOverride:
      `import { readUniversePortfolioPlan as originalPlan } from ${JSON.stringify(sdk)};\n` +
      "import { mkdirSync } from 'node:fs';\n" +
      'export function readUniversePortfolioPlan(definition, options) { const result = originalPlan(definition, options); ' +
      'mkdirSync(options.root, { recursive: true, mode: 0o700 }); return result; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Status reads must not create a missing store');
  });

  it('rejects a portfolio CLI that treats invalid flags as success', () => {
    const { run } = fixture({ ignorePortfolioInvalidFlags: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installed Universe command failed');
    expect(result.stderr).toContain('portfolio plan');
    expect(result.stderr).toContain('--unexpected');
  });

  it('detects comparison observation that creates a missing store', () => {
    const sdk = sdkModuleUrl();
    const { run } = fixture({ sdkOverride:
      `import { readUniverseCampaignComparison as originalRead } from ${JSON.stringify(sdk)};\n` +
      "import { mkdirSync } from 'node:fs';\n" +
      'export function readUniverseCampaignComparison(baseline, challenger, options) { const result = originalRead(baseline, challenger, options); ' +
      'mkdirSync(options.root, { recursive: true, mode: 0o700 }); return result; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Status reads must not create a missing store');
  });

  it('rejects a comparison CLI that treats invalid flags as success', () => {
    const { run } = fixture({ ignoreComparisonInvalidFlags: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Installed Universe command failed');
    expect(result.stderr).toContain('compare pack-sdk pack-cli --unexpected');
  });

  it('rejects a portfolio entrypoint that claims dispatch of a stopped campaign', () => {
    const sdk = sdkModuleUrl();
    const { run } = fixture({ sdkOverride:
      `import { runUniversePortfolio as originalRun } from ${JSON.stringify(sdk)};\n` +
      'export async function runUniversePortfolio(definition, options) { const result = await originalRun(definition, options); ' +
      'return { ...result, outcomes: result.outcomes.map(outcome => ({ ...outcome, attempted: true })) }; }' });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Portfolio smoke must not dispatch a stopped campaign');
  });

  it('rejects a portfolio entrypoint that reports stopped work as complete', () => {
    const sdk = sdkModuleUrl();
    const { run } = fixture({ sdkOverride:
      `import { runUniversePortfolio as originalRun } from ${JSON.stringify(sdk)};\n` +
      'export async function runUniversePortfolio(definition, options) { return { ...await originalRun(definition, options), ' +
      "status: 'completed' }; }" });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('A stopped campaign must remain blocked in a portfolio');
  });

  it('rejects a stopped campaign entrypoint that changes execution evidence', () => {
    const sdk = sdkModuleUrl();
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

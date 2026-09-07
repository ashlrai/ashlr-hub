import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { create as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntimeReleaseDependencyInventory, RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH } from '../src/core/daemon/runtime-release-dependency-inventory.js';
import { buildUnsignedRuntimeReleaseManifest } from '../src/core/daemon/runtime-release-manifest.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { installLocalRuntime, readLocalRuntimeStatus, resolveLocalRuntime, rollbackLocalRuntime } from '../src/core/local-runtime/store.js';

const roots: string[] = [];
const VERSION = '3.4.0';
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
function temporary(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-local-runtime-store-')));
  roots.push(root);
  return root;
}
function write(path: string, value: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode });
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(root, entry.name)) : [join(root, entry.name)]).sort();
}
/** Real packaged bytes, but no dependencies, models, daemons, or evaluator calls. */
async function candidate(revision = 'a'.repeat(40)) {
  const root = temporary();
  const source = join(root, 'package');
  const pkg = { name: '@ashlr/hub', version: VERSION, type: 'module', bin: { ashlr: 'bin/ashlr' },
    dependencies: {}, bundledDependencies: [],
    exports: { './universe': './dist/core/universe/index.js' },
    files: ['bin', 'dist', 'schema', 'scripts/run-verify-command.mjs', 'scripts/scorecard-history-worker.mjs'] };
  write(join(source, 'package.json'), JSON.stringify(pkg));
  write(join(source, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: VERSION,
    lockfileVersion: 3, packages: { '': pkg } }));
  write(join(source, 'bin/ashlr'), '#!/usr/bin/env node\nawait import("../dist/cli/index.js");\n', 0o700);
  write(join(source, 'dist/cli/index.js'), 'console.log("inert Universe help");\n');
  write(join(source, 'dist/core/universe/index.js'), ['runUniverse', 'readUniverseOverview',
    'runUniverseCampaign', 'runUniversePortfolio', 'buildUniverseFileOperationsContext']
    .map((name) => `export function ${name}() { throw new Error('smoke must not execute work'); }`).join('\n'));
  write(join(source, 'dist/build-identity.json'), JSON.stringify({ schemaVersion: 1, packageVersion: VERSION,
    revision, dirty: false, provenance: 'git' }));
  write(join(source, 'schema/config.schema.json'), '{}\n');
  write(join(source, 'scripts/run-verify-command.mjs'), 'export const run = false;\n');
  write(join(source, 'scripts/scorecard-history-worker.mjs'), 'export const run = false;\n');
  mkdirSync(join(source, 'node_modules'), { mode: 0o700 });
  const inventory = buildRuntimeReleaseDependencyInventory(source);
  if (!inventory.ok) throw new Error(inventory.reason);
  write(join(source, RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH), inventory.canonicalJson);
  const checked = buildUnsignedRuntimeReleaseManifest({ packageRoot: source, dependencyRoot: join(source, 'node_modules'),
    declaredInterpreterPath: realpathSync(process.execPath), declaredInterpreterVersion: process.version,
    expectedRevision: revision });
  if (!checked.ok) throw new Error(`Invalid store fixture: ${checked.reason}`);
  const artifactPath = join(root, 'candidate.tgz');
  await createTar({ cwd: root, file: artifactPath, gzip: true, portable: true, noPax: true, noDirRecurse: true },
    files(source).filter((path) => !path.endsWith('/package-lock.json')).map((path) => relative(root, path)));
  return { root, source, artifactPath, sha256: digest(readFileSync(artifactPath)), revision, version: VERSION };
}
function change(path: string): void {
  chmodSync(path, 0o600);
  writeFileSync(path, 'changed after installation\n');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local managed runtime store', () => {
  it.each(['relative', '', '/'])('requires an explicit non-root absolute store: %j', (store) => {
    expect(() => readLocalRuntimeStatus(store)).toThrow(/absolute/);
    expect(() => resolveLocalRuntime(store)).toThrow();
    expect(() => rollbackLocalRuntime(store)).toThrow();
  });

  it('does not create any store path when archive validation rejects', async () => {
    const value = await candidate(); const store = join(value.root, 'absent');
    await expect(installLocalRuntime({ ...value, store, sha256: '0'.repeat(64) })).rejects.toThrow();
    expect(existsSync(store)).toBe(false);
  });

  it('reinstalling the exact selected artifact is idempotent and returns detached metadata', async () => {
    const value = await candidate(); const store = join(value.root, 'managed');
    const first = await installLocalRuntime({ ...value, store });
    const pointer = readFileSync(join(store, 'current.json'));
    const releases = readdirSync(join(store, 'releases'));
    const repeated = await installLocalRuntime({ ...value, store });
    expect(repeated).toEqual(first);
    expect(readFileSync(join(store, 'current.json'))).toEqual(pointer);
    expect(readdirSync(join(store, 'releases'))).toEqual(releases);
    repeated.current!.revision = 'f'.repeat(40);
    expect(readLocalRuntimeStatus(store).current!.revision).toBe(value.revision);
  });

  it('keeps a verified current executable usable when only the previous package is damaged', async () => {
    const first = await candidate(); const second = await candidate('b'.repeat(40));
    const store = join(first.root, 'managed');
    await installLocalRuntime({ ...first, store });
    const selected = await installLocalRuntime({ ...second, store });
    change(join(selected.previous!.packageRoot, 'dist/cli/index.js'));
    const observed = readLocalRuntimeStatus(store);
    expect(observed).toMatchObject({ sourceState: 'degraded', current: selected.current, previous: null });
    expect(observed.reasons).toEqual(['Previous local runtime installation did not verify']);
    expect(resolveLocalRuntime(store)).toEqual(selected.current);
    const before = readFileSync(join(store, 'current.json'));
    expect(() => rollbackLocalRuntime(store)).toThrow(/previous/);
    expect(readFileSync(join(store, 'current.json'))).toEqual(before);
  });

  it('rolls back from a damaged current to the independently verified previous package', async () => {
    const first = await candidate(); const second = await candidate('b'.repeat(40));
    const store = join(first.root, 'managed');
    const initial = await installLocalRuntime({ ...first, store });
    const selected = await installLocalRuntime({ ...second, store });
    change(join(selected.current!.packageRoot, 'dist/cli/index.js'));
    expect(readLocalRuntimeStatus(store)).toMatchObject({ sourceState: 'degraded', current: null, previous: initial.current });
    expect(() => resolveLocalRuntime(store)).toThrow();
    expect(rollbackLocalRuntime(store)).toMatchObject({ sourceState: 'healthy', current: initial.current, previous: null, reasons: [] });
    expect(resolveLocalRuntime(store)).toEqual(initial.current);
    expect(existsSync(selected.current!.packageRoot)).toBe(true);
  });

  it('does not claim a malformed or symlinked selection is missing', async () => {
    const value = await candidate(); const store = join(value.root, 'managed');
    await installLocalRuntime({ ...value, store });
    const pointer = join(store, 'current.json');
    change(pointer);
    expect(readLocalRuntimeStatus(store)).toMatchObject({ sourceState: 'degraded', current: null, previous: null });
    rmSync(pointer);
    symlinkSync(join(value.root, 'absent'), pointer);
    expect(readLocalRuntimeStatus(store).sourceState).toBe('degraded');
  });

  it('refuses an aliased or nonprivate store without securing or replacing it', async () => {
    const value = await candidate(); const target = join(value.root, 'target');
    mkdirSync(target, { mode: 0o755 });
    const alias = join(value.root, 'alias'); symlinkSync(target, alias);
    await expect(installLocalRuntime({ ...value, store: alias })).rejects.toThrow();
    await expect(installLocalRuntime({ ...value, store: target })).rejects.toThrow();
    expect(readdirSync(target)).toEqual([]);
  });

  it('refuses competing installation ownership without changing the pointer or launching another smoke', async () => {
    const value = await candidate(); const store = join(value.root, 'managed');
    await installLocalRuntime({ ...value, store });
    const lock = acquireLocalStoreLockWithOutcome(join(store, '.install.lock'), 0, { anchorPath: store, exactPrivateStorage: true });
    expect(lock.state).toBe('acquired');
    if (lock.state !== 'acquired') return;
    const before = readFileSync(join(store, 'current.json'));
    try {
      await expect(installLocalRuntime({ ...value, store })).rejects.toThrow(/owner/);
      expect(() => rollbackLocalRuntime(store)).toThrow(/owner/);
      expect(readFileSync(join(store, 'current.json'))).toEqual(before);
    } finally { releaseLocalStoreLock(lock.lock); }
  });
});

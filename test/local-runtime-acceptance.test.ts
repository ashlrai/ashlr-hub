import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { gunzipSync, gzipSync } from 'node:zlib';
import { create as createTar, Header } from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractPinnedRuntimeArchive,
  readPinnedRuntimeArchive,
} from '../src/core/local-runtime/archive.js';
import {
  installLocalRuntime,
  readLocalRuntimeStatus,
  resolveLocalRuntime,
  rollbackLocalRuntime,
} from '../src/core/local-runtime/store.js';
import {
  buildRuntimeReleaseDependencyInventory,
  RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH,
} from '../src/core/daemon/runtime-release-dependency-inventory.js';

const roots: string[] = [];
const VERSION = '3.4.0';
const REVISION = 'a'.repeat(40);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

function temporary(): string {
  const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ashlr-runtime-acceptance-')));
  roots.push(path);
  return path;
}

function write(path: string, value: string | Buffer, mode = 0o600): void {
  fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path, value, { mode });
}

function files(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

function snapshot(directory: string): Record<string, string> {
  return Object.fromEntries(files(directory).map((path) => [relative(directory, path), hash(fs.readFileSync(path))]));
}

/** Inert, self-contained package: importing its SDK never invokes a workflow. */
async function fixture(options: {
  revision?: string;
  dirty?: boolean;
  name?: string;
  failSmoke?: boolean;
  omitSdkExport?: boolean;
} = {}) {
  const base = temporary();
  const source = join(base, 'bootstrap', 'package');
  const marker = join(base, 'executed.json');
  const revision = options.revision ?? REVISION;
  const manifest = {
    name: options.name ?? '@ashlr/hub', version: VERSION, type: 'module',
    bin: { ashlr: 'bin/ashlr' },
    exports: { './universe': './dist/core/universe/index.js', './package.json': './package.json' },
    files: ['bin', 'dist', 'schema', 'scripts/run-verify-command.mjs', 'scripts/scorecard-history-worker.mjs'],
    dependencies: { 'fixture-dependency': '1.0.0' }, bundledDependencies: ['fixture-dependency'],
  };
  write(join(source, 'package.json'), JSON.stringify(manifest));
  write(join(source, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: VERSION,
    lockfileVersion: 3, packages: { '': manifest, 'node_modules/fixture-dependency': { version: '1.0.0' } } }));
  write(join(source, 'bin/ashlr'), '#!/usr/bin/env node\nawait import("../dist/cli/index.js");\n', 0o700);
  write(join(source, 'dist/cli/index.js'),
    "import {appendFileSync} from 'node:fs';\n" +
    `const proof = {revision:${JSON.stringify(revision)},argv:process.argv.slice(2),module:import.meta.url,node:process.execPath,cwd:process.cwd()};\n` +
    `appendFileSync(${JSON.stringify(marker)},JSON.stringify(proof)+'\\n');\n` +
    `if (${options.failSmoke === true} && process.argv[3] === 'help') process.exit(17);\n` +
    'console.log(JSON.stringify(proof));\n');
  const exports = ['runUniverse', 'readUniverseOverview', 'runUniverseCampaign', 'runUniversePortfolio',
    'buildUniverseFileOperationsContext'];
  write(join(source, 'dist/core/universe/index.js'), exports.filter((name) =>
    !options.omitSdkExport || name !== 'runUniverseCampaign').map((name) =>
    `export function ${name}() { throw new Error('Inert acceptance SDK must never execute work'); }`).join('\n'));
  write(join(source, 'dist/build-identity.json'), JSON.stringify({ schemaVersion: 1, packageVersion: VERSION,
    revision, dirty: options.dirty ?? false, provenance: 'git' }));
  write(join(source, 'schema/config.schema.json'), '{"type":"object"}\n');
  write(join(source, 'scripts/run-verify-command.mjs'), 'export const fixture = true;\n');
  write(join(source, 'scripts/scorecard-history-worker.mjs'), 'export const fixture = true;\n');
  write(join(source, 'node_modules/fixture-dependency/package.json'), '{"name":"fixture-dependency","version":"1.0.0"}\n');
  write(join(source, 'node_modules/fixture-dependency/index.js'), 'export const fixture = true;\n');
  const inventory = buildRuntimeReleaseDependencyInventory(source);
  if (!inventory.ok) throw new Error(`Acceptance fixture inventory: ${inventory.reason}`);
  write(join(source, RUNTIME_RELEASE_DEPENDENCY_INVENTORY_PATH), inventory.canonicalJson);
  const artifactPath = join(base, 'candidate.tgz');
  const archiveFiles = files(source).filter((path) => path !== join(source, 'package-lock.json'));
  await createTar({ cwd: dirname(source), file: artifactPath, gzip: true, portable: true,
    noDirRecurse: true, noPax: true }, archiveFiles.map((path) => relative(dirname(source), path)));
  const bytes = fs.readFileSync(artifactPath);
  return { base, source, marker, archiveFiles, pins: { artifactPath, sha256: hash(bytes), revision, version: VERSION } };
}

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  const writable = (path: string): void => {
    const entry = fs.lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) return;
    fs.chmodSync(path, 0o700);
    for (const name of fs.readdirSync(path)) writable(join(path, name));
  };
  for (const path of roots.splice(0)) { writable(path); fs.rmSync(path, { recursive: true, force: true }); }
});

describe('independent pinned local runtime archive acceptance', () => {
  it('verifies exact pins and copies exact package bytes without executing the package', async () => {
    const value = await fixture();
    const archive = await readPinnedRuntimeArchive(value.pins);
    const bytes = fs.readFileSync(value.pins.artifactPath);
    expect(archive.pins).toEqual({ sha256: hash(bytes),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      size: bytes.length, revision: REVISION, version: VERSION });
    const destination = join(value.base, 'extracted'); fs.mkdirSync(destination, { mode: 0o700 });
    extractPinnedRuntimeArchive(archive, destination);
    expect(snapshot(destination)).toEqual(Object.fromEntries(value.archiveFiles.map((path) =>
      [relative(value.source, path), hash(fs.readFileSync(path))])));
    expect(fs.existsSync(value.marker)).toBe(false);
    expect(fs.lstatSync(join(destination, 'bin/ashlr')).mode & 0o111).not.toBe(0);
  });

  it.each(['digest', 'revision', 'version', 'truncated'] as const)('rejects %s mismatch before extraction or execution', async (kind) => {
    const value = await fixture();
    const pins = { ...value.pins };
    if (kind === 'digest') pins.sha256 = '0'.repeat(64);
    if (kind === 'revision') pins.revision = 'b'.repeat(40);
    if (kind === 'version') pins.version = '3.4.1';
    if (kind === 'truncated') {
      const bytes = fs.readFileSync(pins.artifactPath).subarray(0, 32);
      fs.writeFileSync(pins.artifactPath, bytes); pins.sha256 = hash(bytes);
    }
    await expect(readPinnedRuntimeArchive(pins)).rejects.toThrow();
    expect(fs.existsSync(value.marker)).toBe(false);
  });

  it.each([{ dirty: true }, { name: '@fixture/not-hub' }])('rejects an unqualified package identity %j', async (options) => {
    const value = await fixture(options);
    await expect(readPinnedRuntimeArchive(value.pins)).rejects.toThrow();
    expect(fs.existsSync(value.marker)).toBe(false);
  });

  it('refuses extraction into an occupied destination without changing existing files', async () => {
    const value = await fixture();
    const archive = await readPinnedRuntimeArchive(value.pins);
    const destination = join(value.base, 'occupied'); write(join(destination, 'keep.txt'), 'retain exactly\n');
    const before = snapshot(destination);
    expect(() => extractPinnedRuntimeArchive(archive, destination)).toThrow();
    expect(snapshot(destination)).toEqual(before);
    expect(fs.existsSync(value.marker)).toBe(false);
  });

  it('rejects a changed admitted buffer before writing any extracted file', async () => {
    const value = await fixture();
    const archive = await readPinnedRuntimeArchive(value.pins);
    const destination = join(value.base, 'changed-observation'); fs.mkdirSync(destination, { mode: 0o700 });
    const entry = archive.entries.find((item) => item.path === 'dist/core/universe/index.js')!;
    entry.bytes[0] = entry.bytes[0]! ^ 1;
    expect(() => extractPinnedRuntimeArchive(archive, destination)).toThrow(/changed/i);
    expect(fs.readdirSync(destination)).toEqual([]);
    expect(fs.existsSync(value.marker)).toBe(false);
  });

  it('rejects an unverified archive-shaped object before extraction', async () => {
    const value = await fixture();
    const archive = await readPinnedRuntimeArchive(value.pins);
    const destination = join(value.base, 'unverified'); fs.mkdirSync(destination, { mode: 0o700 });
    expect(() => extractPinnedRuntimeArchive({ pins: archive.pins, entries: archive.entries }, destination)).toThrow(/admitted/i);
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it.each(['duplicate', 'case-prefix', 'missing-terminator', 'directory', 'oversized-entry'] as const)(
    'rejects inert malformed archive structure: %s', async (kind) => {
      const value = await fixture();
      const expanded = gunzipSync(fs.readFileSync(value.pins.artifactPath));
      const first = new Header(expanded.subarray(0, 512));
      const firstEnd = 512 + Math.ceil(first.size! / 512) * 512;
      let malformed: Buffer;
      if (kind === 'duplicate' || kind === 'case-prefix') {
        const repeated = Buffer.from(expanded.subarray(0, firstEnd));
        if (kind === 'case-prefix') {
          const header = new Header(repeated.subarray(0, 512));
          header.path = header.path!.replace('package/bin/', 'package/BIN/');
          expect(header.path).not.toBe(first.path);
          header.encode(repeated.subarray(0, 512));
        }
        malformed = Buffer.concat([repeated, expanded]);
      } else if (kind === 'missing-terminator') {
        let offset = 0;
        while (!expanded.subarray(offset, offset + 512).every((byte) => byte === 0)) {
          const header = new Header(expanded.subarray(offset, offset + 512));
          offset += 512 + Math.ceil(header.size! / 512) * 512;
        }
        malformed = expanded.subarray(0, offset);
      } else {
        malformed = Buffer.from(expanded);
        const header = new Header(malformed.subarray(0, 512));
        if (kind === 'directory') header.type = 'Directory';
        else header.size = 16 * 1024 * 1024 + 1;
        header.encode(malformed.subarray(0, 512));
      }
      const bytes = gzipSync(malformed); fs.writeFileSync(value.pins.artifactPath, bytes);
      await expect(readPinnedRuntimeArchive({ ...value.pins, sha256: hash(bytes) })).rejects.toThrow();
      expect(fs.existsSync(value.marker)).toBe(false);
    });
});

describe('independent managed local runtime transaction acceptance', () => {
  it('keeps a missing explicit store absent on inspection and refused resolution', () => {
    const store = join(temporary(), 'missing-store');
    expect(readLocalRuntimeStatus(store)).toMatchObject({ sourceState: 'missing', current: null, previous: null });
    expect(() => resolveLocalRuntime(store)).toThrow();
    expect(() => rollbackLocalRuntime(store)).toThrow();
    expect(fs.existsSync(store)).toBe(false);
  });

  it('installs independently of the bootstrap directory and runs with its recorded Node from an unrelated cwd', async () => {
    const value = await fixture(); const store = join(value.base, 'managed');
    const status = await installLocalRuntime({ store, ...value.pins });
    expect(status).toMatchObject({ sourceState: 'healthy', authority: 'local-candidate', previous: null });
    const installed = resolveLocalRuntime(store);
    expect(installed).toEqual(status.current);
    expect(installed.packageRoot.startsWith(`${store}/releases/`)).toBe(true);
    expect(fs.realpathSync(installed.binPath)).toBe(installed.binPath);
    expect(fs.realpathSync(installed.packageRoot)).toBe(installed.packageRoot);
    fs.renameSync(dirname(value.source), join(value.base, 'bootstrap-unavailable'));
    const unrelated = join(value.base, 'unrelated'); fs.mkdirSync(unrelated, { mode: 0o700 });
    const child = childProcess.spawnSync(installed.nodePath, [installed.binPath, 'universe', 'help'], {
      cwd: unrelated, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
      env: { PATH: dirname(installed.nodePath), LANG: 'C', LC_ALL: 'C' },
    });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    const proof = JSON.parse(child.stdout);
    expect(proof).toMatchObject({ revision: REVISION, cwd: unrelated, node: installed.nodePath,
      argv: ['universe', 'help'] });
    expect(proof.module).toContain(installed.packageRoot);
    expect(readLocalRuntimeStatus(store).current).toEqual(installed);
  });

  it.each(['wrong-pin', 'cli-smoke', 'sdk-smoke'] as const)('preserves the selected release when a replacement fails %s', async (failure) => {
    const current = await fixture(); const store = join(current.base, 'managed');
    await installLocalRuntime({ store, ...current.pins });
    const before = readLocalRuntimeStatus(store);
    const pointerBefore = fs.readFileSync(join(store, 'current.json'));
    const candidate = await fixture({ revision: 'b'.repeat(40), failSmoke: failure === 'cli-smoke',
      omitSdkExport: failure === 'sdk-smoke' });
    await expect(installLocalRuntime({ store, ...candidate.pins,
      ...(failure === 'wrong-pin' ? { sha256: '0'.repeat(64) } : {}) })).rejects.toThrow();
    expect(fs.readFileSync(join(store, 'current.json'))).toEqual(pointerBefore);
    expect(readLocalRuntimeStatus(store)).toEqual(before);
    expect(resolveLocalRuntime(store)).toEqual(before.current);
    if (failure === 'wrong-pin') expect(fs.existsSync(candidate.marker)).toBe(false);
  });

  it('promotes a second verified release and rolls back only to the retained verified predecessor', async () => {
    const first = await fixture(); const second = await fixture({ revision: 'b'.repeat(40) });
    const store = join(first.base, 'managed');
    const initial = await installLocalRuntime({ store, ...first.pins });
    const next = await installLocalRuntime({ store, ...second.pins });
    expect(next.current?.revision).toBe(second.pins.revision);
    expect(next.previous).toEqual(initial.current);
    const restored = rollbackLocalRuntime(store);
    expect(restored.current).toEqual(initial.current);
    expect(resolveLocalRuntime(store)).toEqual(initial.current);
    expect(fs.existsSync(next.current!.packageRoot)).toBe(true);
  });

  it('withholds a changed installed file and never executes it during status or resolution', async () => {
    const value = await fixture(); const store = join(value.base, 'managed');
    const installed = (await installLocalRuntime({ store, ...value.pins })).current!;
    const beforeMarker = fs.readFileSync(value.marker);
    const changed = join(installed.packageRoot, 'dist/cli/index.js'); fs.chmodSync(changed, 0o600);
    fs.appendFileSync(changed, '\n// Test-owned installed bytes changed after admission.\n');
    expect(readLocalRuntimeStatus(store)).toMatchObject({ sourceState: 'degraded' });
    expect(() => resolveLocalRuntime(store)).toThrow();
    expect(fs.readFileSync(value.marker)).toEqual(beforeMarker);
  });

  it.each(['publication', 'finalization'] as const)('restores the selected pointer after a one-shot %s failure', async (failure) => {
    const current = await fixture(); const candidate = await fixture({ revision: 'b'.repeat(40) });
    const store = join(current.base, 'managed');
    const initial = await installLocalRuntime({ store, ...current.pins });
    const before = fs.readFileSync(join(store, 'current.json'));
    let injected = false;
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    if (failure === 'publication') vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!injected && to === join(store, 'current.json')) { injected = true; throw new Error('Owned fixture publication failure'); }
      originalRename(from, to);
    });
    else vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      if (!injected && path === join(store, 'selection-pending.json')) { injected = true; throw new Error('Owned fixture finalization failure'); }
      originalUnlink(path);
    });
    syncBuiltinESMExports();
    await expect(installLocalRuntime({ store, ...candidate.pins })).rejects.toThrow();
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(injected).toBe(true);
    expect(fs.readFileSync(join(store, 'current.json'))).toEqual(before);
    expect(resolveLocalRuntime(store)).toEqual(initial.current);
  });

  it('rejects an operation whose shared deadline expires during smoke without changing selection', async () => {
    const current = await fixture(); const candidate = await fixture({ revision: 'b'.repeat(40) });
    const store = join(current.base, 'managed');
    const initial = await installLocalRuntime({ store, ...current.pins });
    const before = fs.readFileSync(join(store, 'current.json'));
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const original = childProcess.spawnSync;
    let smokeObserved = false;
    vi.spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: object) => {
      const result = original(command, args, options);
      if (args.includes('universe') && args.includes('help')) { clock = 120_001; smokeObserved = true; }
      return result;
    }) as typeof childProcess.spawnSync);
    syncBuiltinESMExports();
    await expect(installLocalRuntime({ store, ...candidate.pins })).rejects.toThrow(/deadline/i);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    expect(smokeObserved).toBe(true);
    expect(fs.readFileSync(join(store, 'current.json'))).toEqual(before);
    expect(resolveLocalRuntime(store)).toEqual(initial.current);
  });

  it('retains an explicit degraded marker when publication finalization and pointer restoration both fail', async () => {
    const current = await fixture(); const candidate = await fixture({ revision: 'b'.repeat(40) });
    const store = join(current.base, 'managed');
    const initial = (await installLocalRuntime({ store, ...current.pins })).current!;
    const selectedPath = join(store, 'current.json'); const pendingPath = join(store, 'selection-pending.json');
    const before = fs.readFileSync(selectedPath); const packageBefore = snapshot(initial.packageRoot);
    const originalUnlink = fs.unlinkSync; const originalRename = fs.renameSync;
    let finalizationFailed = false; let restorationFailed = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((path) => {
      originalUnlink(path);
      // Fail after the real marker removal, representing a finalization error
      // whose recovery must recreate the missing marker if restoration fails.
      if (!finalizationFailed && path === pendingPath && !fs.readFileSync(selectedPath).equals(before)) {
        finalizationFailed = true; throw new Error('Owned post-removal finalization failure');
      }
    });
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (finalizationFailed && !restorationFailed && to === selectedPath) {
        restorationFailed = true; throw new Error('Owned prior-pointer restoration failure');
      }
      originalRename(from, to);
    });
    syncBuiltinESMExports();
    await expect(installLocalRuntime({ store, ...candidate.pins })).rejects.toThrow(/restoration/i);
    vi.restoreAllMocks(); syncBuiltinESMExports();
    expect(finalizationFailed && restorationFailed).toBe(true);
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(readLocalRuntimeStatus(store)).toMatchObject({ sourceState: 'degraded', current: null, previous: null });
    expect(() => resolveLocalRuntime(store)).toThrow();
    expect(snapshot(initial.packageRoot)).toEqual(packageBefore);
  });
});

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
import * as durability from '../src/core/util/durability.js';
import {
  extractPinnedRuntimeArchive,
  extractPinnedRuntimeArchiveWithTiming,
  type RuntimeExtractionTiming,
  readPinnedRuntimeArchive,
  readCompatiblePinnedRuntimeArchive,
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
  emptyFile?: boolean;
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
  if (options.emptyFile) write(join(source, 'schema/empty.json'), '');
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
  it('timed extraction preserves exact bytes, modes and syscall order with one post-barrier summary', async () => {
    const value = await fixture({emptyFile: true}), archive = await readPinnedRuntimeArchive(value.pins);
    const roots = ['ordinary', 'traced'].map(name => { const path = join(value.base, name); fs.mkdirSync(path, {mode: 0o700}); return path; });
    const events: string[][] = [[], []]; let arm = 0;
    const handles = new Map<number, string>();
    const barrier = durability.fsyncDirectory;
    vi.spyOn(durability, 'fsyncDirectory').mockImplementation((path, options) => {
      events[arm]!.push(`directory-barrier:${relative(roots[arm]!, path)}`); return barrier(path, options);
    });
    const open = fs.openSync, write = fs.writeSync, chmod = fs.fchmodSync, sync = fs.fsyncSync, close = fs.closeSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((path: string, flags: number, mode: number) => {
      const fd = open(path, flags, mode); handles.set(fd, relative(roots[arm]!, String(path))); events[arm]!.push(`open:${handles.get(fd)}`); return fd;
    }) as typeof fs.openSync);
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, ...args: unknown[]) => {
      events[arm]!.push(`write:${handles.get(fd)}`); return Reflect.apply(write, fs, [fd, ...args]);
    }) as typeof fs.writeSync);
    vi.spyOn(fs, 'fchmodSync').mockImplementation((fd, mode) => {events[arm]!.push(`chmod:${handles.get(fd)}`); return chmod(fd, mode);});
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {events[arm]!.push(`sync:${handles.get(fd)}`); return sync(fd);});
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {events[arm]!.push(`close:${handles.get(fd)}`); const result = close(fd); handles.delete(fd); return result;});
    syncBuiltinESMExports();
    expect(extractPinnedRuntimeArchive(archive, roots[0]!)).toBeUndefined();
    arm = 1; const summaries: RuntimeExtractionTiming[] = []; let handlesAtEmission = -1;
    expect(extractPinnedRuntimeArchiveWithTiming(archive, roots[1]!, summary => {
      handlesAtEmission = handles.size; summaries.push(summary);
    })).toBeUndefined();
    expect(events[1]).toEqual(events[0]); expect(summaries).toHaveLength(1); expect(handlesAtEmission).toBe(0);
    const firstBarrier = events[1]!.findIndex(event => event.startsWith('directory-barrier:'));
    expect(firstBarrier).toBeGreaterThan(0);
    expect(events[1]!.slice(firstBarrier).every(event => event.startsWith('directory-barrier:'))).toBe(true);
    expect(snapshot(roots[1]!)).toEqual(snapshot(roots[0]!));
    expect(files(roots[1]!).map(path => fs.lstatSync(path).mode & 0o777)).toEqual(files(roots[0]!).map(path => fs.lstatSync(path).mode & 0o777));
    const summary = summaries[0]!;
    expect(summary.outcome).toBe('returned');
    expect(summary.buckets['entry-digests'].completed).toBe(archive.entries.length);
    for(const label of ['leaf-open', 'leaf-chmod', 'leaf-fsync', 'leaf-close'] as const) {
      expect(summary.buckets[label].attempted).toBe(archive.entries.length); expect(summary.buckets[label].completed).toBe(archive.entries.length);
    }
    expect(summary.buckets['leaf-write'].completed).toBe(archive.entries.filter(entry => entry.bytes.length > 0).length);
    expect(summary.writtenBytes).toBe(archive.entries.reduce((count, entry) => count + entry.bytes.length, 0));
    expect(summary.buckets['ancestor-validation'].completed).toBe(archive.entries.reduce((count, entry) => count + entry.path.split('/').length - 1, 0));
    const directories = new Set(archive.entries.flatMap(entry => {const parts = entry.path.split('/'); return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));}));
    expect(summary.buckets['directory-create'].completed).toBe(directories.size);
    expect(summary.buckets['directory-barrier'].completed).toBe(directories.size + 2);
    expect(Object.isFrozen(summary)).toBe(true); expect(Object.isFrozen(summary.buckets)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(value.base); expect(JSON.stringify(summary)).not.toContain('package.json');
    expect(summary.durationMs).toBeGreaterThanOrEqual(0); expect(summary.unattributedMs).toBeGreaterThanOrEqual(0);
  });

  it('does not call a sink before admitted buffers are consumed and keeps sink failures inert', async () => {
    const value = await fixture(), archive = await readPinnedRuntimeArchive(value.pins);
    const original = archive.entries[0]!.bytes[0]!;
    for(const asynchronous of [false, true]) {
      const destination = join(value.base, asynchronous ? 'rejecting-sink' : 'throwing-sink'); fs.mkdirSync(destination, {mode: 0o700});
      let calls = 0; let snapshotAtEmission: Record<string, string> | undefined;
      extractPinnedRuntimeArchiveWithTiming(archive, destination, () => {
        calls += 1; archive.entries[0]!.bytes[0] = original ^ 255;
        snapshotAtEmission = snapshot(destination);
        if (asynchronous) return Promise.reject(new Error('private sink rejection'));
        throw new Error('private sink failure');
      });
      expect(calls).toBe(1);
      expect(snapshotAtEmission).toEqual(Object.fromEntries(value.archiveFiles.map(path => [relative(value.source, path), hash(fs.readFileSync(path))])));
      archive.entries[0]!.bytes[0] = original;
      await Promise.resolve();
    }
  });

  it.each(['ordinary', 'traced'] as const)('preserves the exact file-sync failure and closes its descriptor in %s mode', async mode => {
    const value = await fixture(), archive = await readPinnedRuntimeArchive(value.pins), error = new Error('private file sync failure');
    const destination = join(value.base, mode); fs.mkdirSync(destination, {mode: 0o700});
    const close = vi.spyOn(fs, 'closeSync'), sync = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {throw error;}); syncBuiltinESMExports();
    const summaries: RuntimeExtractionTiming[] = [];
    let observed: unknown;
    try {
      if(mode === 'traced') extractPinnedRuntimeArchiveWithTiming(archive, destination, summary => {summaries.push(summary); throw new Error('private observer failure');});
      else extractPinnedRuntimeArchive(archive, destination);
    } catch (caught) {observed = caught;}
    expect(observed).toBe(error); expect(sync).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    if(mode === 'traced') {
      expect(summaries).toHaveLength(1); expect(summaries[0]!.outcome).toBe('threw');
      expect(summaries[0]!.buckets['leaf-fsync']).toMatchObject({attempted: 1, completed: 0});
      expect(summaries[0]!.buckets['leaf-close'].completed).toBe(1);
      expect(summaries[0]!.buckets['directory-barrier'].attempted).toBe(0);
    }
  });

  it.each(['mutated', 'unverified', 'occupied'] as const)('tracing retains %s archive refusal before writes', async kind => {
    const value = await fixture(), archive = await readPinnedRuntimeArchive(value.pins);
    const destination = join(value.base, 'refused'); fs.mkdirSync(destination, {mode: 0o700});
    if(kind === 'mutated') archive.entries[0]!.bytes[0] = archive.entries[0]!.bytes[0]! ^ 255;
    if(kind === 'occupied') fs.writeFileSync(join(destination, 'existing'), 'preserved');
    const before = snapshot(destination), summaries: RuntimeExtractionTiming[] = [];
    expect(() => extractPinnedRuntimeArchiveWithTiming(kind === 'unverified' ? {...archive} : archive, destination,
      summary => summaries.push(summary))).toThrow(kind === 'mutated' ? 'admitted bytes changed' : kind === 'unverified' ? 'not admitted' : 'not empty');
    expect(snapshot(destination)).toEqual(before); expect(summaries).toHaveLength(1);
    expect(summaries[0]!.outcome).toBe('threw'); expect(summaries[0]!.buckets['leaf-open'].attempted).toBe(0);
  });

  it('counts actual short writes and refuses zero progress without directory barriers', async () => {
    const value = await fixture(), archive = await readPinnedRuntimeArchive(value.pins);
    const write = fs.writeSync;
    vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      write(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position)) as typeof fs.writeSync); syncBuiltinESMExports();
    const destination = join(value.base, 'short-writes'); fs.mkdirSync(destination, {mode: 0o700});
    let summary: RuntimeExtractionTiming | undefined;
    extractPinnedRuntimeArchiveWithTiming(archive, destination, value => {summary = value;});
    expect(summary!.buckets['leaf-write'].completed).toBeGreaterThan(archive.entries.length);
    expect(summary!.writtenBytes).toBe(archive.entries.reduce((count, entry) => count + entry.bytes.length, 0));
    expect(snapshot(destination)).toEqual(Object.fromEntries(value.archiveFiles.map(path => [relative(value.source, path), hash(fs.readFileSync(path))])));
    vi.mocked(fs.writeSync).mockImplementation(() => 0); syncBuiltinESMExports();
    const zero = join(value.base, 'zero-write'); fs.mkdirSync(zero, {mode: 0o700});
    expect(() => extractPinnedRuntimeArchiveWithTiming(archive, zero, value => {summary = value;})).toThrow('write made no progress');
    expect(summary!.outcome).toBe('threw'); expect(summary!.writtenBytes).toBe(0);
    expect(summary!.buckets['leaf-close'].completed).toBe(1); expect(summary!.buckets['directory-barrier'].attempted).toBe(0);
  });

  it('requires an explicit canonical profile for actual canonical original archive bytes', async () => {
    const value = await fixture({name: '@ashlr/phantom'});
    await expect(readPinnedRuntimeArchive(value.pins)).rejects.toThrow('package name');
    const archive = await readPinnedRuntimeArchive({...value.pins, identityProfile: 'canonical-v2'});
    const destination = join(value.base, 'canonical-extracted');fs.mkdirSync(destination, {mode: 0o700});
    extractPinnedRuntimeArchive(archive, destination);
    expect(JSON.parse(fs.readFileSync(join(destination, 'package.json'),'utf8')).name).toBe('@ashlr/phantom');
    expect(snapshot(destination)).toEqual(Object.fromEntries(value.archiveFiles.map(path => [relative(value.source,path),hash(fs.readFileSync(path))])));
    expect(fs.existsSync(value.marker)).toBe(false);
    const legacy = await fixture();
    await expect(readPinnedRuntimeArchive({...legacy.pins, identityProfile: 'canonical-v2'})).rejects.toThrow('package name');
    await expect(readPinnedRuntimeArchive({...value.pins, identityProfile: 'foreign' as 'canonical-v2'})).rejects.toThrow('identity profile');
  });
  it.each(['@ashlr/hub', '@ashlr/phantom'])('selects only the pinned %s namespace in one archive read', async (name) => {
    const value = await fixture({name});
    const opened = vi.spyOn(fs, 'openSync'); syncBuiltinESMExports();
    const {archive, profile} = await readCompatiblePinnedRuntimeArchive(value.pins);
    expect(opened.mock.calls.filter(([path]) => path === value.pins.artifactPath)).toHaveLength(1);
    opened.mockRestore(); syncBuiltinESMExports();
    expect(profile.packageName).toBe(name); expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.keys(archive.pins).sort()).toEqual(['sha256', 'revision', 'version', 'integrity', 'size'].sort());
    const destination = join(value.base, 'compatible-extracted'); fs.mkdirSync(destination, {mode: 0o700});
    expect(() => extractPinnedRuntimeArchive({...archive}, destination)).toThrow('not admitted');
    expect(fs.readdirSync(destination)).toEqual([]);
    extractPinnedRuntimeArchive(archive, destination);
    expect(snapshot(destination)).toEqual(Object.fromEntries(value.archiveFiles.map(path => [relative(value.source, path), hash(fs.readFileSync(path))])));
    expect(fs.existsSync(value.marker)).toBe(false);
    await expect(readCompatiblePinnedRuntimeArchive({...value.pins, identityProfile: 'canonical-v2'} as Parameters<typeof readCompatiblePinnedRuntimeArchive>[0]))
      .rejects.toThrow('profile override');
  });

  it.each(['@ashlr/other', 'foreign-runtime'])('rejects unknown pinned namespace %s without initialization or execution', async (name) => {
    const value = await fixture({name}); const store = join(value.base, 'never-created');
    await expect(readCompatiblePinnedRuntimeArchive(value.pins)).rejects.toThrow('package identity');
    await expect(installLocalRuntime({...value.pins, store})).rejects.toThrow('package identity');
    expect(fs.existsSync(store)).toBe(false); expect(fs.existsSync(value.marker)).toBe(false);
  });

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

  it.each([20_000, 20_001])('enforces the finite entry boundary at %i inert regular files', async (entryCount) => {
    const value = await fixture();
    const initial = await readPinnedRuntimeArchive(value.pins);
    const expanded = gunzipSync(fs.readFileSync(value.pins.artifactPath));
    let end = 0;
    while (!expanded.subarray(end, end + 512).every((byte) => byte === 0)) {
      const header = new Header(expanded.subarray(end, end + 512));
      end += 512 + Math.ceil(header.size! / 512) * 512;
    }
    // Empty, unique regular files isolate the entry limit from byte/file limits.
    // No large file tree or package code is created or executed by this fixture.
    const extra = Array.from({ length: entryCount - initial.entries.length }, (_, index) => {
      const block = Buffer.alloc(512);
      const header = new Header(expanded.subarray(0, 512));
      header.path = `package/entry-count-fixture/${String(index).padStart(5, '0')}.bin`;
      header.size = 0;
      header.mode = 0o644;
      header.encode(block);
      return block;
    });
    const bytes = gzipSync(Buffer.concat([expanded.subarray(0, end), ...extra, Buffer.alloc(1024)]));
    fs.writeFileSync(value.pins.artifactPath, bytes);
    const pins = { ...value.pins, sha256: hash(bytes) };
    if (entryCount === 20_000) {
      const archive = await readPinnedRuntimeArchive(pins);
      expect(archive.entries).toHaveLength(entryCount);
      expect(archive.entries.slice(0, initial.entries.length)).toEqual(initial.entries);
      expect(archive.entries.slice(initial.entries.length).every((entry) => entry.bytes.length === 0)).toBe(true);
    } else {
      await expect(readPinnedRuntimeArchive(pins)).rejects.toThrow('entry count exceeds limit');
    }
    expect(fs.readFileSync(value.pins.artifactPath)).toEqual(bytes);
    expect(fs.existsSync(value.marker)).toBe(false);
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

  it.each(['@ashlr/hub', '@ashlr/phantom'])('installs %s independently and runs with its recorded Node from an unrelated cwd', async (name) => {
    const value = await fixture({name}); const store = join(value.base, 'managed');
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

  it.each(['packageName', 'identityProfile'])('retains strict schema1 receipt refusal for an extra %s field', async (field) => {
    const value = await fixture({name: '@ashlr/phantom'}); const store = join(value.base, 'managed');
    const installed = (await installLocalRuntime({...value.pins, store})).current!;
    const beforeMarker = fs.readFileSync(value.marker);
    const path = join(dirname(installed.packageRoot), 'receipt.json');
    const receipt = JSON.parse(fs.readFileSync(path, 'utf8')); receipt[field] = field === 'packageName' ? '@ashlr/phantom' : 'canonical-v2';
    fs.chmodSync(path, 0o600); fs.writeFileSync(path, JSON.stringify(receipt));
    expect(readLocalRuntimeStatus(store)).toMatchObject({sourceState: 'degraded', current: null});
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

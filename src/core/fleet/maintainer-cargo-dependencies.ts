/** Host-owned Cargo source preparation. Candidate build scripts never run here. */
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { runVerifySubprocessAsync } from '../run/verify-commands.js';
import type { VerifyCommand } from '../run/verify-commands.js';

const REGISTRY = 'registry+https://github.com/rust-lang/crates.io-index';
const INDEX = 'index.crates.io-1949cf8c6b5b557f';
const SHA = /^[a-f0-9]{64}$/;
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
function fail(reason: string): never { throw new Error(`maintainer Cargo dependencies: ${reason}`); }
interface Package { name: string; version: string; checksum: string }
export interface MaintainerCargoReceipt {
  v: 1;
  recipe: 'cargo-vendor-locked-v1';
  sourceTree: string;
  inputsSha256: string;
  lockSha256: string;
  toolchainSha256: string;
  vendorSha256: string;
  configSha256: string;
  packageCount: number;
  receiptSha256: string;
}
export interface MaintainerCargoAttachment {
  readonly receipt: MaintainerCargoReceipt;
  readonly cargoHome: string;
  readonly vendor: string;
  readonly toolchainBin: string;
  assertCurrent(worktree: string): void;
  close(): void;
}
const admitted = new WeakSet<MaintainerCargoAttachment>();
export function requireMaintainerCargoAttachment(value: MaintainerCargoAttachment): void {
  if (!admitted.has(value)) fail('attachment was not created by this host invocation');
}
export function needsMaintainerCargo(commands: readonly VerifyCommand[]): boolean {
  return commands.some((command) => command.cmd[0] === 'cargo');
}
function regularBytes(path: string, limit = 16 * 1024 * 1024): Buffer {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit) || realpathSync(path) !== resolve(path)) fail('unsafe or oversized input file');
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(after.size)) fail('input changed while reading');
  return bytes;
}
function tomlDocument(text: string): Record<string, unknown> {
  try { return parseToml(text, { unsafeKeyBehaviour: 'throw' }); }
  catch { return fail('invalid or unsafe TOML document'); }
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** Actual TOML semantics, including quoted/dotted keys and literal/multiline values. */
export function maintainerCargoPackages(text: string): Package[] {
  const doc = tomlDocument(text);
  if (![3, 4].includes(Number(doc['version'])) || Object.keys(doc).some((key) => !['version', 'package'].includes(key)) || !Array.isArray(doc['package'])) fail('unsupported lockfile schema');
  const result: Package[] = []; const keys = new Set<string>();
  for (const entry of doc['package']) {
    const pkg = object(entry);
    if (!pkg || typeof pkg['name'] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(pkg['name']) ||
        typeof pkg['version'] !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg['version'])) fail('invalid package identity');
    const key = `${pkg['name']}@${pkg['version']}`;
    if (keys.has(key)) fail('duplicate package identity'); keys.add(key);
    if (pkg['source'] === undefined) continue;
    if (pkg['source'] !== REGISTRY || typeof pkg['checksum'] !== 'string' || !SHA.test(pkg['checksum'])) fail('unsupported registry or missing checksum');
    result.push({ name: pkg['name'], version: pkg['version'], checksum: pkg['checksum'] });
  }
  if (!result.length || result.length > 2_000) fail('invalid registry package count');
  return result.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}
function admitManifest(text: string, manifest: string, worktree: string): void {
  const doc = tomlDocument(text);
  const pathInside = (value: unknown): void => {
    if (typeof value !== 'string' || value.includes('\0') || !value) fail('invalid manifest path');
    const hasGlob = [...value].some((character) => '?*[]{}'.includes(character));
    // Globstar may match zero components. Node path normalization cannot
    // establish containment after Cargo expands parent traversal with globs.
    if (hasGlob && value.split('/').includes('..')) fail('glob path contains parent traversal');
    const target = resolve(dirname(manifest), value);
    if (target !== worktree && !target.startsWith(worktree + '/')) fail('manifest path escapes the worktree');
    const parts = relative(worktree, target).split('/');
    if (parts.some((part) => ['.git', 'node_modules', 'target', '.next'].includes(part))) fail('manifest path references generated or excluded storage');
    // Cargo expands workspace globs. Every concrete ancestor before the first
    // glob must remain canonical; the source walk separately rejects symlinks
    // anywhere in the admitted tree, including every possible glob match.
    let current = worktree;
    for (const part of parts) {
      if ([...part].some((character) => '?*[]{}'.includes(character))) break;
      current = join(current, part);
      if (existsSync(current) && (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)) fail('manifest path traverses a symlink');
    }
  };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const table = object(value); if (!table) return;
    for (const [key, field] of Object.entries(table)) {
      if (['git', 'registry', 'registry-index', 'patch', 'replace', 'source', 'replace-with'].includes(key)) fail('Git, patches or custom sources/registries are unsupported');
      if (key === 'path' || key === 'workspace' && typeof field === 'string') pathInside(field);
      if (['readme', 'license-file', 'build'].includes(key) && typeof field === 'string') pathInside(field);
      if (['members', 'default-members', 'exclude'].includes(key)) {
        if (!Array.isArray(field)) fail('invalid workspace member list'); field.forEach(pathInside);
      }
      visit(field);
    }
  };
  visit(doc);
}
function rejectCargoConfigs(worktree: string): void {
  for (let path = worktree; ; path = dirname(path)) {
    if (existsSync(join(path, '.cargo', 'config')) || existsSync(join(path, '.cargo', 'config.toml'))) fail('repository or ancestor Cargo config is unsupported');
    if (dirname(path) === path) break;
  }
}
function sourceInputs(worktree: string): { digest: string; lock: Buffer; packages: Package[] } {
  rejectCargoConfigs(worktree);
  const paths = ['Cargo.lock', 'rust-toolchain.toml'];
  let visited = 0;
  const walk = (path: string): void => {
    if (++visited > 20_000) fail('manifest scan limit exceeded');
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'target', '.next'].includes(entry.name)) continue;
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) fail('source contains a symlink');
      if (entry.name === '.cargo' && entry.isDirectory() && (existsSync(join(file, 'config')) || existsSync(join(file, 'config.toml')))) fail('nested Cargo config is unsupported');
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'Cargo.toml') paths.push(relative(worktree, file));
    }
  };
  walk(worktree);
  if (!paths.includes('Cargo.toml')) fail('workspace manifest is missing');
  const bindings = paths.sort().map((path) => {
    const bytes = regularBytes(join(worktree, path));
    if (path.endsWith('Cargo.toml')) admitManifest(bytes.toString('utf8'), join(worktree, path), worktree);
    return [path, digest(bytes)];
  });
  const lock = regularBytes(join(worktree, 'Cargo.lock'));
  return { digest: digest(JSON.stringify(bindings)), lock, packages: maintainerCargoPackages(lock.toString('utf8')) };
}
function fileIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory() || realpathSync(path) !== resolve(path)) fail('attachment path is unsafe');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}
function treeIdentities(path: string): string {
  const entries: [string, string][] = [];
  const walk = (dir: string): void => {
    entries.push([relative(path, dir), fileIdentity(dir)]);
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name); const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file); else entries.push([relative(path, file), fileIdentity(file)]);
      if (entries.length > 200_000) fail('vendor inventory limit exceeded');
    }
  };
  walk(path); return digest(JSON.stringify(entries));
}
function treeDigest(path: string): string {
  const entries: [string, string][] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink()) fail('vendored source contains a symlink');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) entries.push([relative(path, file), digest(regularBytes(file, 64 * 1024 * 1024))]);
      else fail('vendored source contains a special file');
      if (entries.length > 200_000) fail('vendor inventory limit exceeded');
    }
  };
  walk(path);
  return digest(JSON.stringify(entries));
}
function indexKey(name: string): string {
  const lower = name.toLowerCase();
  return lower.length === 1 ? `1/${lower}` : lower.length === 2 ? `2/${lower}` : lower.length === 3 ? `3/${lower[0]}/${lower}` : `${lower.slice(0, 2)}/${lower.slice(2, 4)}/${lower}`;
}
function toolchain(worktree: string): { bin: string; digest: string; identity: string } {
  const text = regularBytes(join(worktree, 'rust-toolchain.toml')).toString('utf8');
  const channel = object(tomlDocument(text)['toolchain'])?.['channel'];
  if (typeof channel !== 'string' || !/^\d+\.\d+\.\d+$/.test(channel) || process.platform !== 'darwin' && process.platform !== 'linux') fail('unsupported pinned toolchain/platform');
  const host = `${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : fail('unsupported architecture')}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-gnu'}`;
  const bin = join(homedir(), '.rustup', 'toolchains', `${channel}-${host}`, 'bin');
  if (realpathSync(bin) !== bin) fail('toolchain path is not canonical');
  const names = ['cargo', 'rustc', 'rustdoc', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver'];
  return { bin, digest: digest(JSON.stringify(names.map((name) => [name, digest(regularBytes(join(bin, name), 256 * 1024 * 1024))]))), identity: digest(JSON.stringify(names.map((name) => [name, fileIdentity(join(bin, name))]))) };
}

/** No public CLI injection seam. All paths below are derived from the owned scratch. */
export async function prepareMaintainerCargoDependencies(input: { worktree: string; sourceTree: string; signal?: AbortSignal; assertAuthorized(): void | Promise<void> }): Promise<MaintainerCargoAttachment> {
  await input.assertAuthorized();
  if (!/^[a-f0-9]{40}$/.test(input.sourceTree)) fail('invalid source tree');
  if (input.signal?.aborted) fail('preparation cancelled');
  const worktree = realpathSync(input.worktree);
  const initial = sourceInputs(worktree); const tools = toolchain(worktree);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-maintainer-cargo-')));
  const preparationHome = join(root, 'prepare'); const cargoHome = join(root, 'cargo-home'); const vendor = join(root, 'vendor');
  for (const path of [preparationHome, cargoHome]) mkdirSync(path, { mode: 0o700 });
  let closed = false;
  const close = (): void => { if (!closed) { rmSync(root, { recursive: true, force: true }); closed = true; } };
  try {
    const cache = join(preparationHome, 'registry', 'cache', INDEX); mkdirSync(cache, { recursive: true, mode: 0o700 });
    const index = join(preparationHome, 'registry', 'index', INDEX); mkdirSync(index, { recursive: true, mode: 0o700 });
    writeFileSync(join(index, 'config.json'), JSON.stringify({ dl: 'https://static.crates.io/crates', api: 'https://crates.io' }), { mode: 0o600 });
    // Read only exact lock-selected public index/cache files, never Cargo credentials/config.
    for (const pkg of initial.packages) {
      await input.assertAuthorized(); if (input.signal?.aborted) fail('preparation cancelled');
      const archive = `${pkg.name}-${pkg.version}.crate`; const hostArchive = join(homedir(), '.cargo', 'registry', 'cache', INDEX, archive);
      if (existsSync(hostArchive)) {
        const bytes = regularBytes(hostArchive, 64 * 1024 * 1024);
        if (digest(bytes) !== pkg.checksum) fail('cached archive checksum mismatch');
        writeFileSync(join(cache, archive), bytes, { mode: 0o600 });
      }
      const key = indexKey(pkg.name); const hostIndex = join(homedir(), '.cargo', 'registry', 'index', INDEX, '.cache', key);
      if (existsSync(hostIndex)) {
        const bytes = regularBytes(hostIndex); const target = join(index, '.cache', key); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, bytes, { mode: 0o600 });
      }
    }
    // Official Cargo vendor fetches only the validated crates.io/workspace recipe.
    // No candidate hooks/build scripts execute; no host config or credentials survive.
    const produced = await runVerifySubprocessAsync([join(tools.bin, 'cargo'), 'vendor', '--locked', '--versioned-dirs', vendor], {
      cwd: worktree, env: { HOME: preparationHome, CARGO_HOME: preparationHome, PATH: `${tools.bin}:/usr/bin:/bin`, RUSTC: join(tools.bin, 'rustc'), RUSTDOC: join(tools.bin, 'rustdoc'), LANG: 'en_US.UTF-8', CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse' },
      timeoutMs: 300_000, signal: input.signal, requireProcessGroupExit: true,
    });
    await input.assertAuthorized();
    if (produced.exitCode !== 0 || produced.error || produced.cancelled || produced.timedOut || produced.processGroupSettlement !== 'group-exit-confirmed') fail('official vendor preparation failed or did not settle');
    if (sourceInputs(worktree).digest !== initial.digest) fail('source changed during preparation');
    const expected = new Map(initial.packages.map((pkg) => [`${pkg.name}-${pkg.version}`, pkg]));
    const actual = readdirSync(vendor).sort();
    if (actual.length !== expected.size) fail('vendor package inventory differs from lock');
    for (const name of actual) {
      await input.assertAuthorized(); if (input.signal?.aborted) fail('preparation cancelled');
      const pkg = expected.get(name); if (!pkg) fail('unexpected vendor package');
      const archive = regularBytes(join(cache, `${pkg.name}-${pkg.version}.crate`), 64 * 1024 * 1024);
      if (digest(archive) !== pkg.checksum) fail('fetched archive checksum differs from lock');
      const checksum = JSON.parse(regularBytes(join(vendor, name, '.cargo-checksum.json')).toString('utf8')) as { package?: string; files?: Record<string, string> };
      if (checksum.package !== pkg.checksum || !checksum.files || typeof checksum.files !== 'object') fail('vendor checksum metadata differs from lock');
      for (const [file, hash] of Object.entries(checksum.files)) {
        if (!SHA.test(hash) || file.split(/[\\/]/).some((part) => !part || part === '..' || part === '.') || digest(regularBytes(join(vendor, name, file), 64 * 1024 * 1024)) !== hash) fail('vendor file checksum is invalid');
      }
    }
    const config = `[source.crates-io]\nreplace-with = "maintainer-vendor"\n[source.maintainer-vendor]\ndirectory = ${JSON.stringify(vendor)}\n[net]\noffline = true\n`;
    writeFileSync(join(cargoHome, 'config.toml'), config, { mode: 0o600 });
    const payload = { v: 1 as const, recipe: 'cargo-vendor-locked-v1' as const, sourceTree: input.sourceTree, inputsSha256: initial.digest, lockSha256: digest(initial.lock), toolchainSha256: tools.digest, vendorSha256: treeDigest(vendor), configSha256: digest(config), packageCount: initial.packages.length };
    const receipt = Object.freeze({ ...payload, receiptSha256: digest(JSON.stringify(payload)) });
    const vendorIdentity = treeIdentities(vendor);
    const configIdentity = treeIdentities(cargoHome);
    const toolIdentity = (): string => digest(JSON.stringify(['cargo', 'rustc', 'rustdoc', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver'].map((name) => [name, fileIdentity(join(tools.bin, name))])));
    rmSync(preparationHome, { recursive: true, force: true });
    const attachment: MaintainerCargoAttachment = Object.freeze({ receipt, cargoHome, vendor, toolchainBin: tools.bin,
      assertCurrent(currentWorktree: string): void {
        if (closed || realpathSync(currentWorktree) !== worktree || sourceInputs(worktree).digest !== initial.digest || toolIdentity() !== tools.identity ||
            treeIdentities(cargoHome) !== configIdentity || treeIdentities(vendor) !== vendorIdentity) fail('dependency attachment or source changed');
      }, close });
    await input.assertAuthorized(); if (input.signal?.aborted) fail('preparation cancelled');
    admitted.add(attachment); attachment.assertCurrent(worktree); return attachment;
  } catch (error) { close(); throw error; }
}

import { createHash } from 'node:crypto';
import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maintainerCargoPackages, prepareMaintainerCargoDependencies, requireMaintainerCargoAttachment } from '../src/core/fleet/maintainer-cargo-dependencies.js';
import { openStandingVerificationConfinement } from '../src/core/inbox/merge.js';

vi.mock('../src/core/sandbox/audit.js', () => ({ audit: vi.fn() }));
// Admission only: the actual sandbox, official Cargo vendor and compiler run.
vi.mock('../src/core/authority/effective-config.js', async (original) => ({
  ...(await original<typeof import('../src/core/authority/effective-config.js')>()), currentStandingPolicy: () => ({}),
}));
const roots: string[] = [];
const sourceTree = 'a'.repeat(40);
const lock = (source = 'registry+https://github.com/rust-lang/crates.io-index', checksum = 'b'.repeat(64)): string => `version = 4\n[[package]]\nname = "demo"\nversion = "1.0.0"\ndependencies = ["libc"]\n[[package]]\nname = "libc"\nversion = "0.2.185"\nsource = "${source}"\nchecksum = "${checksum}"\n`;
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'maintainer-cargo-test-'))); roots.push(root);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="demo"\nversion="1.0.0"\nedition="2021"\n[dependencies]\nlibc="=0.2.185"\n');
  writeFileSync(join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "1.95.0"\n');
  writeFileSync(join(root, 'Cargo.lock'), lock());
  writeFileSync(join(root, 'src/main.rs'), 'fn main() { println!("{}", libc::EXIT_SUCCESS); }\n');
  return root;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('locked Cargo preparation admission', () => {
  it('selects exact crates.io checksums and excludes workspace packages', () => {
    expect(maintainerCargoPackages(lock())).toEqual([{ name: 'libc', version: '0.2.185', checksum: 'b'.repeat(64) }]);
  });
  it.each([
    ['Git', lock('git+https://example.test/repo')],
    ['missing checksum', lock().replace(/^checksum.*\n/m, '')],
    ['single-quoted source', lock().replace(/^source = .*$/m, "source = 'git+https://example.test/repo'")],
    ['unknown table', lock() + '[metadata]\nsource = "registry+https://example.test"\n'],
    ['duplicate package', lock() + '[[package]]' + lock().split('[[package]]')[2]],
  ])('refuses %s before host materialization', (_label, value) => { expect(() => maintainerCargoPackages(value)).toThrow(); });
  it('refuses a caller-made attachment without reading a supplied path', () => {
    expect(() => requireMaintainerCargoAttachment({ cargoHome: '/not-an-admitted-path' } as never)).toThrow('host invocation');
  });
  it('refuses repository config, escaping paths and symlinks before Cargo can run', async () => {
    const worktree = fixture(); const input = { worktree, sourceTree, assertAuthorized: vi.fn() };
    mkdirSync(join(worktree, '.cargo')); writeFileSync(join(worktree, '.cargo/config.toml'), '[source.crates-io]\nreplace-with="evil"\n');
    await expect(prepareMaintainerCargoDependencies(input)).rejects.toThrow('Cargo config');
    rmSync(join(worktree, '.cargo'), { recursive: true });
    writeFileSync(join(worktree, 'Cargo.toml'), '[package]\nname="demo"\nversion="1.0.0"\n[lib]\npath="../../outside.rs"\n');
    await expect(prepareMaintainerCargoDependencies(input)).rejects.toThrow('escapes');
    writeFileSync(join(worktree, 'Cargo.toml'), '[package]\nname="demo"\nversion="1.0.0"\n');
    symlinkSync('/outside', join(worktree, 'planted'));
    await expect(prepareMaintainerCargoDependencies(input)).rejects.toThrow('symlink');
  });
  it('honors cancellation before creating an attachment', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepareMaintainerCargoDependencies({ worktree: fixture(), sourceTree, signal: controller.signal, assertAuthorized: vi.fn() })).rejects.toThrow('cancelled');
  });
  it.each([
    ['literal path', "[lib]\npath = '../../outside.rs'\n", 'escapes'],
    ['multiline literal path', "[lib]\npath = '''../../outside.rs'''\n", 'escapes'],
    ['multiline basic path', '[lib]\npath = """../../outside.rs"""\n', 'escapes'],
    ['quoted dotted path', '"lib"."path" = "../../outside.rs"\n', 'escapes'],
    ['literal workspace member', "[workspace]\nmembers = ['../outside']\n", 'escapes'],
    ['multiline workspace member', '[workspace]\nmembers = ["""../outside"""]\n', 'escapes'],
    ['quoted source table', '["source"."crates-io"]\nreplace-with="evil"\n', 'custom sources'],
    ['dotted registry', 'dependencies.demo.registry = "evil"\n', 'custom sources'],
    ['literal Git', "[dependencies.demo]\ngit = 'https://example.test/repo'\n", 'custom sources'],
    ['multiline Git', '[dependencies.demo]\ngit = """https://example.test/repo"""\n', 'custom sources'],
    ['ignored target path', '[lib]\npath="target/planted/lib.rs"\n', 'excluded storage'],
    ['ignored cache glob', '[workspace]\nmembers=["node_modules/*"]\n', 'excluded storage'],
    ['globstar parent traversal', '[workspace]\nmembers=["crates/**/../../external"]\n', 'parent traversal'],
  ])('refuses parsed %s before any host Cargo invocation', async (_label, manifest, reason) => {
    const worktree = fixture(); writeFileSync(join(worktree, 'Cargo.toml'), manifest);
    await expect(prepareMaintainerCargoDependencies({ worktree, sourceTree, assertAuthorized: vi.fn() })).rejects.toThrow(reason);
  });
});

// Read only public installed toolchain/cache inputs; never relocate HOME back
// to the real account. The actual runner resolves exclusively into worker HOME.
const publicHome = process.env['ASHLR_VITEST_REAL_HOME'] ?? homedir();
const publicToolchain = join(publicHome, '.rustup/toolchains/1.95.0-aarch64-apple-darwin');
const publicArchive = join(publicHome, '.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/libc-0.2.185.crate');
describe.runIf(process.platform === 'darwin' && existsSync(join(publicToolchain, 'bin/cargo')) && existsSync(publicArchive))('actual official vendor and kernel confinement', () => {
  it('compiles offline with immutable sources/config and rejects writes, config drift and a removed attachment', async () => {
    // macOS test HOME may use /var's symlink spelling. Keep the same isolated
    // inode, expressed canonically, as required by attachment path admission.
    vi.stubEnv('HOME', realpathSync(homedir()));
    const worktree = fixture();
    mkdirSync(join(worktree, 'crates/demo/src'), { recursive: true });
    writeFileSync(join(worktree, 'crates/demo/Cargo.toml'), readFileSync(join(worktree, 'Cargo.toml')));
    writeFileSync(join(worktree, 'crates/demo/src/main.rs'), readFileSync(join(worktree, 'src/main.rs')));
    writeFileSync(join(worktree, 'Cargo.toml'), '[workspace]\nresolver="2"\nmembers=["crates/*"]\n');
    const toolchain = join(homedir(), '.rustup/toolchains/1.95.0-aarch64-apple-darwin');
    mkdirSync(join(homedir(), '.rustup/toolchains'), { recursive: true });
    cpSync(publicToolchain, toolchain, { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
    const libcArchive = join(homedir(), '.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f/libc-0.2.185.crate');
    mkdirSync(join(homedir(), '.cargo/registry/cache/index.crates.io-1949cf8c6b5b557f'), { recursive: true });
    copyFileSync(publicArchive, libcArchive);
    const metadata = 'registry/index/index.crates.io-1949cf8c6b5b557f/.cache/li/bc/libc';
    const index = join(homedir(), '.cargo', metadata);
    mkdirSync(join(homedir(), '.cargo/registry/index/index.crates.io-1949cf8c6b5b557f/.cache/li/bc'), { recursive: true });
    copyFileSync(join(publicHome, '.cargo', metadata), index);
    const checksum = createHash('sha256').update(readFileSync(libcArchive)).digest('hex');
    writeFileSync(join(worktree, 'Cargo.lock'), lock(undefined, checksum));
    const attachment = await prepareMaintainerCargoDependencies({ worktree, sourceTree, assertAuthorized: vi.fn() });
    const confined = await openStandingVerificationConfinement(worktree, { cargoAttachment: attachment });
    try {
      expect(confined).not.toBeNull();
      const env = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', CARGO_HOME: '/invalid', CARGO_NET_OFFLINE: 'false', RUSTC_WRAPPER: '/invalid' };
      const built = await confined!.runSubprocess(['cargo', 'build', '--locked', '--offline'], { cwd: worktree, env, timeoutMs: 60_000 });
      expect(built, built.stderr).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false });
      const binary = await confined!.runSubprocess([join(worktree, 'target/debug/demo')], { cwd: worktree, env, timeoutMs: 10_000 });
      expect(binary).toMatchObject({ exitCode: 0, stdout: '0\n' });
      const network = await confined!.runSubprocess([process.execPath, '-e',
        'require("node:net").connect({host:"192.0.2.1",port:1}).on("error",e=>{console.log(e.code);process.exit(["EPERM","EACCES"].includes(e.code)?0:1)})'],
      { cwd: worktree, env, timeoutMs: 10_000 });
      expect(network).toMatchObject({ exitCode: 0, timedOut: false });
      expect(network.stdout.trim()).toMatch(/^(EPERM|EACCES)$/);
      for (const file of [join(attachment.cargoHome, 'config.toml'), join(attachment.vendor, 'libc-0.2.185/Cargo.toml')]) {
        const before = readFileSync(file);
        const changed = await confined!.runSubprocess(['/bin/sh', '-c', 'echo altered > "$1"', 'probe', file], { cwd: worktree, env, timeoutMs: 10_000 });
        expect(changed.exitCode).not.toBe(0); expect(readFileSync(file)).toEqual(before);
      }
      attachment.assertCurrent(worktree);
      mkdirSync(join(worktree, '.cargo')); writeFileSync(join(worktree, '.cargo/config.toml'), '[net]\noffline=false\n');
      expect(() => attachment.assertCurrent(worktree)).toThrow('Cargo config');
      rmSync(join(worktree, '.cargo'), { recursive: true });
      expect(attachment.receipt).toMatchObject({ v: 1, recipe: 'cargo-vendor-locked-v1', packageCount: 1, sourceTree });
      process.stdout.write(JSON.stringify({ kind: 'maintainer-cargo-kernel-integration', workspaceGlob: 'crates/*',
        homeIsolated: homedir() !== publicHome, signedLiveAuthority: false, appPosted: false,
        commands: ['cargo vendor --locked --versioned-dirs', 'cargo build --locked --offline', 'target/debug/demo'],
        buildExit: built.exitCode, binaryExit: binary.exitCode, networkDenialCode: network.stdout.trim(),
        receipt: attachment.receipt }) + '\n');
    } finally { confined?.close(); attachment.close(); }
    expect(existsSync(attachment.vendor)).toBe(false);
    expect(() => attachment.assertCurrent(worktree)).toThrow('changed');
  }, 120_000);
});

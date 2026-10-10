import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';
import { installCompanionArtifact, type CompanionInstallationOptions } from '../src/core/companion-installation.js';
import { planCompanionProvisioning, type CompanionArtifactManifest } from '../src/core/companion-provisioning.js';
import { cmdCompanions } from '../src/cli/companions.js';

const roots: string[] = [];
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const python = existsSync('/usr/bin/python3') ? realpathSync('/usr/bin/python3') : '/usr/bin/python3';
const native = ['darwin', 'linux'].includes(process.platform) && existsSync(python);
const payload = '#!/bin/sh\nprintf executed > companion-was-executed\n';
function fixture(): { root: string; artifact: string; destination: string; target: string;
  record: CompanionArtifactManifest; options: CompanionInstallationOptions; repin: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-companion-install-'))); roots.push(root);
  const artifact = join(root, 'artifact'); const destination = join(root, 'destination');
  mkdirSync(join(artifact, 'bin'), { recursive: true }); mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(artifact, 'bin', 'locus'), payload, { mode: 0o755 });
  writeFileSync(join(artifact, 'NOTICE'), 'synthetic fixture, no release qualification\n', { mode: 0o644 });
  chmodSync(join(artifact, 'bin', 'locus'), 0o755); chmodSync(join(artifact, 'NOTICE'), 0o644);
  const release = COMPANION_RELEASES.find(item => item.id === 'locus')!;
  const record: CompanionArtifactManifest = { schemaVersion: 1, tool: 'locus', version: release.version,
    sourceCommit: release.sourceCommit, releaseUrl: release.releaseUrl, platform: `${process.platform}-${process.arch}`,
    format: 'expanded-file-set', qualification: 'qualified', entrypoint: 'bin/locus', files: [
      { path: 'bin/locus', sha256: hash(payload), bytes: Buffer.byteLength(payload), mode: 0o755 },
      { path: 'NOTICE', sha256: hash('synthetic fixture, no release qualification\n'),
        bytes: Buffer.byteLength('synthetic fixture, no release qualification\n'), mode: 0o644 },
    ] };
  const options: CompanionInstallationOptions = { artifactRoot: artifact, destinationRoot: destination,
    manifestPath: 'manifest.json', trustedManifestSha256: '', pythonPath: python };
  const repin = (): void => {
    const bytes = JSON.stringify(record); writeFileSync(join(artifact, 'manifest.json'), bytes);
    options.trustedManifestSha256 = hash(bytes);
  };
  repin();
  return { root, artifact, destination, record, options, repin,
    target: join(destination, `locus-${release.version}-${record.platform}`) };
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    for (const entry of ['destination', 'outside']) {
      try { chmodSync(join(root, entry), 0o700); } catch { /* Fixture may not have that directory. */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(!native)('fd-relative offline companion installation', () => {
  it('installs exact bytes/modes into a fresh version slot without running payloads or consulting user state', async () => {
    const f = fixture();
    vi.stubEnv('HOME', join(f.root, 'private-home'));
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-do-not-forward');
    vi.stubEnv('LEXICON_PATH', '/synthetic/private-vocabulary');
    const result = await installCompanionArtifact(f.options);
    expect(result).toMatchObject({ status: 'installed', installed: true, runtimeCapability: 'not-inspected',
      blockers: [], destination: f.target, entrypoint: join(f.target, 'bin', 'locus'),
      manifestSha256: f.options.trustedManifestSha256,
      anchor: { device: lstatSync(f.destination).dev, inode: lstatSync(f.destination).ino } });
    expect(readFileSync(join(f.target, 'bin', 'locus'), 'utf8')).toBe(payload);
    expect(lstatSync(join(f.target, 'bin', 'locus')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(f.target, 'NOTICE')).mode & 0o777).toBe(0o644);
    expect(lstatSync(f.target).mode & 0o777).toBe(0o700);
    expect(readdirSync(f.destination)).toEqual([f.target.split('/').at(-1)]);
    expect(existsSync(join(f.root, 'private-home'))).toBe(false);
    expect(existsSync(join(f.target, 'companion-was-executed'))).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/synthetic-do-not-forward|private-vocabulary/u);
  });

  it('refuses repeat installation, including matching bytes, and never overlays changed content', async () => {
    const f = fixture(); expect((await installCompanionArtifact(f.options)).installed).toBe(true);
    const target = join(f.target, 'bin', 'locus'); writeFileSync(target, 'owner-edited');
    const result = await installCompanionArtifact(f.options);
    expect(result).toMatchObject({ status: 'blocked', installed: false, effects: [], blockers: ['destination-already-exists'] });
    expect(readFileSync(target, 'utf8')).toBe('owner-edited');
  });

  it('performs exactly one publication under competing real subprocesses', async () => {
    const f = fixture();
    const results = await Promise.all([installCompanionArtifact(f.options), installCompanionArtifact(f.options)]);
    expect(results.filter(result => result.installed)).toHaveLength(1);
    const rejected = results.find(result => !result.installed)!;
    expect(rejected.status).toBe('blocked');
    expect(rejected.blockers).toEqual(['destination-already-exists']);
    expect(readdirSync(f.destination)).toEqual([f.target.split('/').at(-1)]);
    expect(readFileSync(join(f.target, 'bin', 'locus'), 'utf8')).toBe(payload);
  });

  it('refuses private-root permission expansion without changing mode or creating files', async () => {
    const f = fixture(); chmodSync(f.destination, 0o755);
    expect(await installCompanionArtifact(f.options)).toMatchObject({ status: 'blocked', effects: [],
      blockers: ['destination-must-be-owned-and-private'] });
    expect(lstatSync(f.destination).mode & 0o777).toBe(0o755);
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses group-writable roots without chmod repair', async () => {
    const f = fixture(); chmodSync(f.destination, 0o770);
    expect((await installCompanionArtifact(f.options)).blockers).toEqual(['destination-must-be-owned-and-private']);
    expect(lstatSync(f.destination).mode & 0o777).toBe(0o770);
  });

  it('requires source mode to match the pinned record before any staging effect', async () => {
    const f = fixture(); chmodSync(join(f.artifact, 'NOTICE'), 0o600);
    expect(planCompanionProvisioning(f.options).status).toBe('verified-plan');
    expect(await installCompanionArtifact(f.options)).toMatchObject({ status: 'blocked', effects: [],
      blockers: ['source-mode-mismatch'] });
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses tampered bytes and digest pins before native installation', async () => {
    const f = fixture(); writeFileSync(join(f.artifact, 'NOTICE'), 'tampered');
    expect((await installCompanionArtifact(f.options)).blockers).toEqual(['artifact-digest-mismatch']);
    expect(readdirSync(f.destination)).toEqual([]);
    f.options.trustedManifestSha256 = '0'.repeat(64);
    expect((await installCompanionArtifact(f.options)).blockers).toEqual(['manifest-digest-mismatch']);
  });

  it('refuses a manifest replacement between planning and the native copy boundary', async () => {
    const f = fixture(); const pending = installCompanionArtifact(f.options);
    // spawn is asynchronous; mutate immediately while the isolated interpreter starts.
    writeFileSync(join(f.artifact, 'manifest.json'), '{}');
    expect(await pending).toMatchObject({ status: 'blocked', installed: false, effects: [],
      blockers: ['artifact-digest-mismatch'] });
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses source leaf symlinks and hardlinks without touching their outside inode', async () => {
    const f = fixture(); const outside = join(f.root, 'outside-file'); writeFileSync(outside, payload);
    const source = join(f.artifact, 'bin', 'locus'); rmSync(source); symlinkSync(outside, source);
    expect((await installCompanionArtifact(f.options)).installed).toBe(false);
    rmSync(source); linkSync(outside, source);
    expect((await installCompanionArtifact(f.options)).installed).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe(payload); expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses destination ancestor symlink redirection without creating external files', async () => {
    const f = fixture(); const outside = join(f.root, 'outside'); mkdirSync(outside, { mode: 0o700 });
    rmSync(f.destination, { recursive: true }); symlinkSync(outside, f.destination);
    expect((await installCompanionArtifact(f.options)).blockers).toEqual(['unsafe-directory-component']);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('refuses a planted version-slot symlink and leaves its target unchanged', async () => {
    const f = fixture(); const outside = join(f.root, 'outside'); mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, 'owner'), 'preserve'); symlinkSync(outside, f.target);
    expect((await installCompanionArtifact(f.options)).installed).toBe(false);
    expect(readFileSync(join(outside, 'owner'), 'utf8')).toBe('preserve');
    expect(readdirSync(outside)).toEqual(['owner']);
  });

  it('does not autodiscover, install or execute an unsafe runtime', async () => {
    const f = fixture();
    for (const pythonPath of ['', 'python3', join(f.root, 'missing')]) {
      expect((await installCompanionArtifact({ ...f.options, pythonPath })).blockers)
        .toEqual(['reviewed-absolute-python-runtime-required']);
    }
    const alias = join(f.root, 'python-alias'); symlinkSync(python, alias);
    expect((await installCompanionArtifact({ ...f.options, pythonPath: alias })).blockers)
      .toEqual(['reviewed-absolute-python-runtime-required']);
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses a runtime replaceable by another principal through its parent directory', async () => {
    const f = fixture(); const directory = join(f.root, 'unsafe-runtime-parent'); mkdirSync(directory, { mode: 0o700 });
    const runtime = join(directory, 'python'); writeFileSync(runtime, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(directory, 0o770);
    expect((await installCompanionArtifact({ ...f.options, pythonPath: runtime })).blockers)
      .toEqual(['reviewed-absolute-python-runtime-required']);
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('blocks unsupported release qualification rather than treating a local pin as publication evidence', async () => {
    const f = fixture(); f.record.qualification = 'unqualified'; f.repin();
    expect((await installCompanionArtifact(f.options)).blockers).toEqual(['artifact-not-qualified']);
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('cleans a real partial staging write failure without publishing or deleting outside the anchor', async () => {
    const f = fixture();
    const large = 'x'.repeat(2048); writeFileSync(join(f.artifact, 'NOTICE'), large);
    f.record.files[1] = { path: 'NOTICE', sha256: hash(large), bytes: large.length, mode: 0o644 }; f.repin();
    // Reviewed disposable runtime launcher gives its genuine isolated Python child a small file-
    // size quota. Ignore SIGXFSZ so the native write returns EFBIG and exercises cleanup after
    // the first payload and part of the second payload have actually been written.
    const launcher = join(f.root, 'quota-python');
    writeFileSync(launcher, `#!${python}\nimport os, resource, signal, sys\n` +
      'resource.setrlimit(resource.RLIMIT_FSIZE, (512, 512))\n' +
      'signal.signal(signal.SIGXFSZ, signal.SIG_IGN)\n' +
      `os.execv(${JSON.stringify(python)}, [${JSON.stringify(python)}] + sys.argv[1:])\n`, { mode: 0o700 });
    const outside = join(f.root, 'outside'); mkdirSync(outside, { mode: 0o700 });
    writeFileSync(join(outside, 'preserve'), 'owner-data');
    const result = await installCompanionArtifact({ ...f.options, pythonPath: launcher });
    expect(result).toMatchObject({ status: 'blocked', installed: false,
      blockers: ['native-filesystem-operation-failed'],
      effects: ['temporary-staging-created', 'temporary-staging-removed'] });
    expect(readdirSync(f.destination)).toEqual([]);
    expect(readFileSync(join(outside, 'preserve'), 'utf8')).toBe('owner-data');
  });

  it('exposes actual install success and collision through the CLI without claiming a handshake', async () => {
    const f = fixture();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const args = ['install', '--artifacts', f.artifact, '--manifest', 'manifest.json', '--sha256',
      f.options.trustedManifestSha256, '--root', f.destination, '--python', python, '--json'];
    expect(await cmdCompanions(args)).toBe(0);
    const receipt = JSON.parse(String(out.mock.calls.at(-1)![0])) as Record<string, unknown>;
    expect(receipt).toMatchObject({ status: 'installed', installed: true, runtimeCapability: 'not-inspected' });
    expect(await cmdCompanions(args)).toBe(1);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0]))).toMatchObject({ status: 'blocked', installed: false });
    expect(existsSync(join(f.target, 'companion-was-executed'))).toBe(false);
  });

  it('keeps CLI help inert and rejects ambiguous or missing explicit install authority', async () => {
    const f = fixture();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdCompanions(['install', '--help'])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toMatch(/--python.*absolute-reviewed-python-runtime/u);
    expect(await cmdCompanions(['install', '--apply'])).toBe(2);
    const args = ['install', '--artifacts', f.artifact, '--manifest', 'manifest.json', '--sha256',
      f.options.trustedManifestSha256, '--root', f.destination, '--python', python];
    expect(await cmdCompanions([...args, '--root', f.destination])).toBe(2);
    expect(await cmdCompanions(args.slice(0, -2))).toBe(2);
    expect(readdirSync(f.destination)).toEqual([]);
  });
});

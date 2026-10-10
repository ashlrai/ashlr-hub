import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';
import { planCompanionProvisioning, type CompanionArtifactManifest,
  type CompanionProvisioningOptions } from '../src/core/companion-provisioning.js';

const roots: string[] = [];
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const payload = '#!/synthetic/unavailable/interpreter\nnever execute this fixture\n';
function fixture(): { root: string; artifact: string; destination: string; record: CompanionArtifactManifest;
  options: CompanionProvisioningOptions; target: string; rewrite: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-companion-plan-')));
  roots.push(root);
  const artifact = join(root, 'artifact'); const destination = join(root, 'destination');
  mkdirSync(join(artifact, 'bin'), { recursive: true }); mkdirSync(destination);
  writeFileSync(join(artifact, 'bin', 'locus'), payload);
  const release = COMPANION_RELEASES.find(item => item.id === 'locus')!;
  const record: CompanionArtifactManifest = { schemaVersion: 1, tool: 'locus', version: release.version,
    sourceCommit: release.sourceCommit, releaseUrl: release.releaseUrl, platform: 'darwin-arm64',
    format: 'expanded-file-set', qualification: 'qualified', entrypoint: 'bin/locus',
    files: [{ path: 'bin/locus', sha256: hash(payload), bytes: Buffer.byteLength(payload), mode: 0o755 }] };
  const options: CompanionProvisioningOptions = { artifactRoot: artifact, destinationRoot: destination,
    manifestPath: 'manifest.json', trustedManifestSha256: '', platform: 'darwin-arm64' };
  const rewrite = (): void => {
    const bytes = JSON.stringify(record);
    writeFileSync(join(artifact, 'manifest.json'), bytes);
    options.trustedManifestSha256 = hash(bytes);
  };
  rewrite();
  return { root, artifact, destination, record, options, target: join(destination, 'locus-0.5.0-darwin-arm64'), rewrite };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline companion provisioning plans', () => {
  it('accepts independently pinned local bytes without creating a target or executing the payload', () => {
    const f = fixture();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-provider-secret');
    vi.stubEnv('LEXICON_PATH', '/synthetic/private/project.yaml');
    const manifestBefore = readFileSync(join(f.artifact, 'manifest.json'));
    const artifactBefore = readFileSync(join(f.artifact, 'bin', 'locus'));
    const plan = planCompanionProvisioning(f.options);
    expect(plan).toMatchObject({ status: 'verified-plan', installed: false, runtimeCapability: 'not-inspected',
      effects: [], blockers: [], requiresRevalidationBeforeApply: true,
      artifact: { tool: 'locus', version: '0.5.0', platform: 'darwin-arm64', entrypoint: 'bin/locus' } });
    expect(plan.files[0]).toMatchObject({ action: 'create', sha256: hash(payload), beforeImage: { state: 'absent' } });
    expect(existsSync(f.target)).toBe(false);
    expect(readFileSync(join(f.artifact, 'manifest.json'))).toEqual(manifestBefore);
    expect(readFileSync(join(f.artifact, 'bin', 'locus'))).toEqual(artifactBefore);
    expect(JSON.stringify(plan)).not.toMatch(/synthetic-provider-secret|private\/project|never execute/u);
  });

  it('describes replacements while preserving actual before-image bytes and modes', () => {
    const f = fixture(); mkdirSync(join(f.target, 'bin'), { recursive: true });
    const target = join(f.target, 'bin', 'locus');
    writeFileSync(target, 'existing synthetic executable'); chmodSync(target, 0o644);
    const plan = planCompanionProvisioning(f.options);
    expect(plan.files[0]).toMatchObject({ action: 'replace', beforeImage: { state: 'present',
      sha256: hash('existing synthetic executable'), bytes: 29, mode: 0o644 } });
    expect(plan.effects).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe('existing synthetic executable');
  });

  it.skipIf(process.platform === 'win32')('retains exactly matching existing bytes and mode without effects', () => {
    const f = fixture(); mkdirSync(join(f.target, 'bin'), { recursive: true });
    const target = join(f.target, 'bin', 'locus'); writeFileSync(target, payload); chmodSync(target, 0o755);
    expect(planCompanionProvisioning(f.options).files[0]!.action).toBe('retain');
  });

  it('refuses a manifest digest taken from anything other than the exact trusted bytes', () => {
    const f = fixture(); f.record.sourceCommit = '0'.repeat(40);
    writeFileSync(join(f.artifact, 'manifest.json'), JSON.stringify(f.record));
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['manifest-digest-mismatch']);
    expect(existsSync(f.target)).toBe(false);
    f.options.trustedManifestSha256 = '';
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['trusted-manifest-digest-required']);
  });

  it.each(['version', 'sourceCommit', 'releaseUrl', 'tool'] as const)('refuses unreviewed %s even with a pinned manifest', field => {
    const f = fixture(); (f.record as unknown as Record<string, unknown>)[field] = 'unreviewed'; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unreviewed-release-identity']);
  });

  it.each(['unqualified', 'unsupported'] as const)('does not manufacture hashes or install readiness for %s artifacts', status => {
    const f = fixture(); f.record.qualification = status; f.rewrite();
    const plan = planCompanionProvisioning(f.options);
    expect(plan).toMatchObject({ status: 'blocked', installed: false, effects: [], files: [],
      blockers: ['artifact-not-qualified'] });
  });

  it('refuses target mismatches and unsupported architectures', () => {
    const f = fixture(); f.options.platform = 'linux-x64';
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsupported-platform']);
    f.options.platform = 'linux-riscv64'; f.record.platform = 'linux-riscv64'; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsupported-platform']);
  });

  it.each(['../outside', '/outside', 'bin/../../outside', 'bin\\locus', 'bin//locus', 'bin/CON.exe',
    'bin/locus:stream', 'bin/locus.'])('refuses escaped or nonportable manifest paths: %s', path => {
    const f = fixture(); f.record.files[0]!.path = path; f.record.entrypoint = path; f.rewrite();
    expect(planCompanionProvisioning(f.options).status).toBe('blocked');
    expect(existsSync(f.target)).toBe(false);
  });

  it('refuses duplicate/case-colliding paths and file-directory overlays', () => {
    const f = fixture(); f.record.files.push({ ...f.record.files[0]!, path: 'BIN/LOCUS' }); f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['duplicate-file-path']);
    f.record.files[1]!.path = 'bin'; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['file-directory-conflict']);
  });

  it('refuses unknown schema fields, unsupported archive formats and nonexecutable entrypoints', () => {
    const f = fixture(); const record = f.record as unknown as Record<string, unknown>;
    record.installScript = 'do not execute'; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['invalid-manifest-schema']);
    delete record.installScript; record.format = 'tar.gz'; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['invalid-manifest-schema']);
    record.format = 'expanded-file-set'; f.record.files[0]!.mode = 0o644; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['invalid-entrypoint']);
  });

  it('rejects changed bytes and missing payloads without destination effects', () => {
    const f = fixture(); writeFileSync(join(f.artifact, 'bin', 'locus'), 'bad');
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['artifact-digest-mismatch']);
    rmSync(join(f.artifact, 'bin', 'locus'));
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['artifact-digest-mismatch']);
    expect(existsSync(f.target)).toBe(false);
  });

  it('rejects oversized declared and actual data before accepting a plan', () => {
    const f = fixture(); f.record.files[0]!.bytes = 512 * 1024 * 1024 + 1; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['artifact-size-limit']);
    f.record.files[0]!.bytes = 1; f.rewrite();
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['artifact-size-limit']);
    writeFileSync(join(f.artifact, 'manifest.json'), ' '.repeat(256 * 1024 + 1));
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['artifact-size-limit']);
  });

  it('refuses unexpected destination files and preserves them unchanged', () => {
    const f = fixture(); mkdirSync(f.target); writeFileSync(join(f.target, 'unexpected.js'), 'existing');
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unexpected-destination-content']);
    expect(readFileSync(join(f.target, 'unexpected.js'), 'utf8')).toBe('existing');
  });

  it.skipIf(process.platform === 'win32')('refuses source leaf symlinks and hard links', () => {
    const f = fixture(); const source = join(f.artifact, 'bin', 'locus'); const outside = join(f.root, 'outside');
    writeFileSync(outside, payload); rmSync(source); symlinkSync(outside, source);
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsafe-file']);
    rmSync(source); linkSync(outside, source);
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsafe-file']);
  });

  it.skipIf(process.platform === 'win32')('refuses symlink directories in either source or destination ancestry', () => {
    const f = fixture(); const bin = join(f.artifact, 'bin'); const outside = join(f.root, 'outside');
    mkdirSync(outside); writeFileSync(join(outside, 'locus'), payload); rmSync(bin, { recursive: true });
    symlinkSync(outside, bin);
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsafe-directory-component']);
    rmSync(bin); mkdirSync(bin); writeFileSync(join(bin, 'locus'), payload);
    symlinkSync(outside, f.target);
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsafe-directory-component']);
    expect(readFileSync(join(outside, 'locus'), 'utf8')).toBe(payload);
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink root and a destination leaf symlink', () => {
    const f = fixture(); const alias = join(f.root, 'alias'); symlinkSync(f.artifact, alias);
    expect(planCompanionProvisioning({ ...f.options, artifactRoot: alias }).blockers).toEqual(['unsafe-directory-component']);
    mkdirSync(join(f.target, 'bin'), { recursive: true });
    symlinkSync(join(f.artifact, 'bin', 'locus'), join(f.target, 'bin', 'locus'));
    expect(planCompanionProvisioning(f.options).blockers).toEqual(['unsafe-file']);
  });

  it('rejects missing and relative roots or escaped manifest paths', () => {
    const f = fixture();
    expect(planCompanionProvisioning({ ...f.options, artifactRoot: '.' }).blockers).toEqual(['roots-must-be-canonical-absolute']);
    expect(planCompanionProvisioning({ ...f.options, destinationRoot: join(f.root, 'missing') }).blockers).toEqual(['root-directory-missing']);
    expect(planCompanionProvisioning({ ...f.options, manifestPath: '../manifest.json' }).blockers).toEqual(['unsafe-manifest-path']);
  });

  it('revalidates on each plan and does not reuse earlier accepted bytes', () => {
    const f = fixture(); expect(planCompanionProvisioning(f.options).status).toBe('verified-plan');
    writeFileSync(join(f.artifact, 'bin', 'locus'), 'tampered after plan');
    expect(planCompanionProvisioning(f.options).status).toBe('blocked');
    expect(existsSync(f.target)).toBe(false);
  });
});

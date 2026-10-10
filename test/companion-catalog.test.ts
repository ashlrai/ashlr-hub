import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdCompanions } from '../src/cli/companions.js';
import * as catalog from '../src/core/companion-catalog.js';
import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';
import * as provisioning from '../src/core/companion-provisioning.js';
import * as installation from '../src/core/companion-installation.js';

const roots: string[] = [];
const ids = ['secrets-native', 'lexicon-mcp'] as const;
const pins = ['77d1de8c724b0953bb9cef68c96c0d9adafd1665022e6f378633db3c9118bc57',
  'fe721ab714729ef741662544b83c96aca18b49773b212450780189112e5bae2b'];
function selected(id: string): catalog.CompanionCatalogEntry {
  const result = catalog.resolveCompanionCatalog(id, 'darwin-arm64');
  if (result.status !== 'selected') throw new Error('missing reviewed test catalog entry');
  return result.entry;
}
function capture(): { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []; const stderr: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk)); return true; });
  return { stdout, stderr };
}
function fixture(): { root: string; artifacts: string; destination: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-catalog-'))); roots.push(root);
  const artifacts = join(root, 'artifacts'); const destination = join(root, 'destination');
  mkdirSync(artifacts); mkdirSync(destination, { mode: 0o700 });
  return { root, artifacts, destination };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('shipped companion catalog review pins', () => {
  it.each(ids)('pins exact reviewed serialized manifest bytes and source catalog identity for %s', id => {
    const entry = selected(id);
    const bytes = JSON.stringify(entry.manifest, null, 2) + '\n';
    expect(entry.manifestText).toBe(bytes);
    expect(JSON.parse(entry.manifestText)).toEqual(entry.manifest);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.manifestSha256);
    expect(entry.manifestSha256).toBe(pins[ids.indexOf(id)]);
    const release = COMPANION_RELEASES.find(record => record.id === entry.manifest.tool)!;
    expect(entry.manifest).toMatchObject({ version: release.version, sourceCommit: release.sourceCommit,
      releaseUrl: release.releaseUrl, platform: 'darwin-arm64' });
    expect(entry.manifest.files.length).toBeLessThanOrEqual(256);
    expect(entry.manifest.files.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThanOrEqual(512 * 1024 * 1024);
    expect(entry.bundled).toBe(false);
    expect(entry.artifactBinariesBundled).toBe(false);
    expect(entry.evidence).toMatchObject({ credentialsCreatedOrRead: false, providerInference: false,
      toolCalls: 0, productionAcceptance: false, officialSignedBuildProvenanceVerified: false });
  });

  it('pins distinct full native and narrow bundled MCP components with honest qualification', () => {
    const secrets = selected('secrets-native'); const lexicon = selected('lexicon-mcp');
    expect(secrets.manifest.files.map(file => file.path)).toEqual(['bin/phantom', 'bin/phantom-mcp']);
    expect(secrets.archive).toMatchObject({ sha256: '0c30d0404f3cb809ad95d2e8bfbe346348929e54e40e4574153107c5e7cad38a', releaseImmutable: true });
    expect(lexicon.manifest.files.map(file => file.path)).toEqual(['bin/lexicon-mcp', 'package.json', 'LICENSE']);
    expect(lexicon.archive).toMatchObject({ sha256: 'bea5b2d3fbc8db620805ebdbd0c1f24021965c7dd96ae7f0bf921de69ee69d46',
      releaseImmutable: false, npm: { name: '@ashlr/lexicon', version: '0.5.4', integrity: 'sha512-AeLC+rUYk5Buj1xPYrwV67hLsgpche+msXc9arv/FSvAbiEvCJIYP0gbxwXrh0EC8VALmkXrKN/SV25CkPamUw==' } });
    expect(lexicon.component).toContain('full Lexicon CLI');
    expect(lexicon.expandedMapping).toEqual([
      { archivePath: 'package/plugin/mcp-server.mjs', expandedPath: 'bin/lexicon-mcp', bytesEdited: false },
      { archivePath: 'package/package.json', expandedPath: 'package.json', bytesEdited: false },
      { archivePath: 'package/LICENSE', expandedPath: 'LICENSE', bytesEdited: false },
    ]);
    expect(secrets.expandedMapping.map(mapping => mapping.archivePath)).toEqual(['phantom', 'phantom-mcp']);
    for (const entry of [secrets, lexicon]) expect(entry.qualification.uninspected).toContain('Signed build provenance');
  });

  it('isolates caller mutation of selected manifests, file pins, npm metadata and qualification', () => {
    const entry = selected('lexicon-mcp');
    entry.manifest.files[0]!.sha256 = '0'.repeat(64);
    entry.manifest.files.pop(); entry.archive.npm!.integrity = 'changed'; entry.qualification.accepted.push('false claim');
    const fresh = selected('lexicon-mcp');
    expect(fresh.manifest.files).toHaveLength(3);
    expect(fresh.manifest.files[0]!.sha256).not.toBe('0'.repeat(64));
    expect(fresh.archive.npm!.integrity).toMatch(/^sha512-/u);
    expect(fresh.qualification.accepted).not.toContain('false claim');
    const inspection = catalog.inspectCompanionCatalog('darwin-arm64');
    inspection.entries[0]!.manifest.version = 'changed';
    expect(selected('secrets-native').manifest.version).toBe('0.7.9');
  });

  it.each(['linux-x64', 'darwin-x64', 'linux-arm64', 'win32-arm64', 'win32-x64', 'unknown'])('refuses unqualified host %s without fallback', platform => {
    for (const id of ids) expect(catalog.resolveCompanionCatalog(id, platform)).toEqual({ status: 'blocked', blockers: ['catalog-platform-unavailable'] });
    const report = catalog.inspectCompanionCatalog(platform);
    expect(report.entries.every(entry => entry.availability === 'unsupported-platform')).toBe(true);
    expect(report).toMatchObject({ effects: [], installed: false, runtimeCapability: 'not-inspected', bundled: false });
  });

  it.each(['locus', 'locus-native', 'latest', '__proto__', ' lexicon-mcp'])('refuses unreviewed catalog selector %s', id => {
    expect(catalog.resolveCompanionCatalog(id, 'darwin-arm64')).toEqual({ status: 'blocked', blockers: ['unknown-catalog-id'] });
    expect(catalog.inspectCompanionCatalog('darwin-arm64').unavailable).toEqual([
      { tool: 'locus', version: '0.5.0', status: 'unqualified', reason: expect.any(String) },
    ]);
  });
});

describe('phm companions catalog selection', () => {
  it('reports shipped metadata only without discovering or calling artifact planners/installers', async () => {
    const plan = vi.spyOn(provisioning, 'planCompanionProvisioning');
    const install = vi.spyOn(installation, 'installCompanionArtifact');
    const output = capture(); expect(await cmdCompanions(['catalog', '--json'])).toBe(0);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({ effects: [], installed: false,
      bundled: false, runtimeCapability: 'not-inspected', unavailable: [{ tool: 'locus', status: 'unqualified' }] });
    expect(plan).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled(); expect(output.stderr).toEqual([]);
  });

  it('describes platform and narrow component boundaries in human output', async () => {
    const output = capture(); expect(await cmdCompanions(['catalog'])).toBe(0);
    expect(output.stdout.join('')).toContain('runtime: not inspected; bundled: no');
    expect(output.stdout.join('')).toContain('secrets-native');
    expect(output.stdout.join('')).toContain('full Lexicon CLI and native app excluded');
    expect(output.stdout.join('')).toContain('locus: unqualified');
  });

  it.each([['catalog', '--write'], ['catalog', '--json', '--json'], ['catalog', '--platform', 'darwin-arm64']])(
    'rejects effectful or host-spoofing catalog usage %j', async args => {
      const output = capture(); expect(await cmdCompanions(args)).toBe(2); expect(output.stdout).toEqual([]);
    });

  it.each(['plan', 'install'])('rejects digest/catalog conflicts for %s before file/native access', async command => {
    const f = fixture(); const plan = vi.spyOn(provisioning, 'planCompanionProvisioning');
    const install = vi.spyOn(installation, 'installCompanionArtifact'); const output = capture();
    const args = [command, '--artifacts', f.artifacts, '--root', f.destination, '--catalog', 'lexicon-mcp', '--sha256', pins[1]!];
    if (command === 'install') args.push('--python', join(f.root, 'must-not-run'));
    expect(await cmdCompanions(args)).toBe(2);
    expect(output.stderr.join('')).toContain('mutually exclusive');
    expect(plan).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled(); expect(readdirSync(f.destination)).toEqual([]);
  });

  it.each([
    ['--catalog'], ['--catalog', 'lexicon-mcp', '--catalog', 'lexicon-mcp'],
    ['--catalog', 'lexicon-mcp', '--manifest', '/outside/manifest.json'],
    ['--sha256', pins[1]!], ['--manifest', 'manifest.json'],
  ])('rejects invalid manifest selector grammar %j without effects', async options => {
    const f = fixture(); const output = capture(); const plan = vi.spyOn(provisioning, 'planCompanionProvisioning');
    expect(await cmdCompanions(['plan', '--artifacts', f.artifacts, '--root', f.destination, ...options])).toBe(2);
    expect(plan).not.toHaveBeenCalled(); expect(output.stdout).toEqual([]); expect(readdirSync(f.destination)).toEqual([]);
  });

  it.each(['plan', 'install'])('refuses unavailable catalog host for %s without fallback or effects', async command => {
    const f = fixture(); const output = capture();
    vi.spyOn(catalog, 'resolveCompanionCatalog').mockReturnValue({ status: 'blocked', blockers: ['catalog-platform-unavailable'] });
    const plan = vi.spyOn(provisioning, 'planCompanionProvisioning'); const install = vi.spyOn(installation, 'installCompanionArtifact');
    const args = [command, '--artifacts', f.artifacts, '--root', f.destination, '--catalog', 'lexicon-mcp', '--json'];
    if (command === 'install') args.push('--python', join(f.root, 'must-not-run'));
    expect(await cmdCompanions(args)).toBe(1);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({ status: 'blocked', installed: false,
      effects: [], blockers: ['catalog-platform-unavailable'] });
    expect(plan).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled(); expect(readdirSync(f.destination)).toEqual([]);
  });

  it.each(['plan', 'install'])('rejects unknown catalog for %s without inspecting local files', async command => {
    const f = fixture(); const output = capture(); const args = [command, '--artifacts', f.artifacts,
      '--root', f.destination, '--catalog', 'locus-native'];
    if (command === 'install') args.push('--python', join(f.root, 'must-not-run'));
    expect(await cmdCompanions(args)).toBe(2); expect(output.stderr.join('')).toContain('Unknown companion catalog');
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it.each(['plan', 'install'])('pins default manifest.json and refuses a changed supplied manifest for %s', async command => {
    const f = fixture(); const entry = selected('lexicon-mcp');
    vi.spyOn(catalog, 'resolveCompanionCatalog').mockReturnValue({ status: 'selected', entry });
    writeFileSync(join(f.artifacts, 'manifest.json'), JSON.stringify({ ...entry.manifest, entrypoint: 'bin/hostile' }, null, 2) + '\n');
    const output = capture(); const args = [command, '--artifacts', f.artifacts, '--root', f.destination,
      '--catalog', 'lexicon-mcp', '--json'];
    if (command === 'install') args.push('--python', join(f.root, 'must-not-run'));
    expect(await cmdCompanions(args)).toBe(1);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({ status: 'blocked', installed: false, effects: [], blockers: ['manifest-digest-mismatch'] });
    expect(readdirSync(f.destination)).toEqual([]); expect(readdirSync(f.artifacts)).toEqual(['manifest.json']);
  });

  it('does not generate a missing default manifest from installed or artifact bytes', async () => {
    const f = fixture(); vi.spyOn(catalog, 'resolveCompanionCatalog').mockReturnValue({ status: 'selected', entry: selected('lexicon-mcp') });
    const output = capture(); expect(await cmdCompanions(['plan', '--artifacts', f.artifacts,
      '--root', f.destination, '--catalog', 'lexicon-mcp', '--json'])).toBe(1);
    expect(JSON.parse(output.stdout.join('')).blockers).toEqual(['manifest-missing']);
    expect(readdirSync(f.artifacts)).toEqual([]); expect(readdirSync(f.destination)).toEqual([]);
  });

  it('supports an explicitly named relative manifest while retaining the exact catalog pin', async () => {
    const f = fixture(); const entry = selected('lexicon-mcp');
    vi.spyOn(catalog, 'resolveCompanionCatalog').mockReturnValue({ status: 'selected', entry });
    writeFileSync(join(f.artifacts, 'reviewed.json'), '{}'); const output = capture();
    expect(await cmdCompanions(['plan', '--artifacts', f.artifacts, '--root', f.destination,
      '--manifest', 'reviewed.json', '--catalog', 'lexicon-mcp', '--json'])).toBe(1);
    expect(JSON.parse(output.stdout.join('')).blockers).toEqual(['manifest-digest-mismatch']);
    expect(existsSync(join(f.artifacts, 'manifest.json'))).toBe(false);
  });
});

// Optional local qualification consumes already verified public bytes; CI never downloads packages.
describe.skipIf(!process.env.PHM_COMPANION_PUBLIC_FIXTURE_ROOT || `${process.platform}-${process.arch}` !== 'darwin-arm64')('reviewed public catalog artifacts', () => {
  it.each(ids)('revalidates actual public bytes, then refuses tampering with %s without installation effects', async id => {
    const f = fixture(); const entry = selected(id);
    const source = join(process.env.PHM_COMPANION_PUBLIC_FIXTURE_ROOT!, `${entry.manifest.tool}-darwin-arm64-expanded`);
    const manifest = readFileSync(join(source, 'manifest.json'));
    expect(createHash('sha256').update(manifest).digest('hex')).toBe(entry.manifestSha256);
    writeFileSync(join(f.artifacts, 'manifest.json'), manifest);
    for (const file of entry.manifest.files) {
      const target = join(f.artifacts, file.path); mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, readFileSync(join(source, file.path))); chmodSync(target, file.mode);
    }
    const output = capture(); const args = ['plan', '--artifacts', f.artifacts, '--root', f.destination, '--catalog', id, '--json'];
    expect(await cmdCompanions(args)).toBe(0);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({ status: 'verified-plan', installed: false, effects: [] });
    output.stdout.length = 0; writeFileSync(join(f.artifacts, entry.manifest.files[0]!.path), 'tampered');
    expect(await cmdCompanions(args)).toBe(1);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({ status: 'blocked', installed: false, effects: [], blockers: ['artifact-digest-mismatch'] });
    expect(readdirSync(f.destination)).toEqual([]);
  });
});

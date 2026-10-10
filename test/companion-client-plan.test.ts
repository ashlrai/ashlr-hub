/** Real disposable filesystem tests against fixed synthetic catalog pins; no artifact process is started. */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planCompanionClient, type CompanionClientPlanOptions } from '../src/core/companion-client-plan.js';
import { verifyInstalledCompanionSnapshot, type CompanionArtifactManifest } from '../src/core/companion-provisioning.js';
import { COMPANION_RELEASES } from '../src/core/companion-inventory.js';
import * as companionInventory from '../src/core/companion-inventory.js';

const catalog = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock('../src/core/companion-catalog.js', () => ({ resolveCompanionCatalog: catalog.select }));
const roots: string[] = [];
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
// These pins originate in fixture constants, independently of installed state.
const payloads: Record<string, string> = { 'bin/lexicon-mcp': '#!/synthetic/unavailable/node\nthis artifact must never execute\n',
  'package.json': '{"name":"synthetic-lexicon-mcp-fixture"}\n', LICENSE: 'synthetic fixture public data\n' };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-client-plan-'))); roots.push(root);
  const installation = join(root, 'installation'); mkdirSync(installation, { mode: 0o700 });
  const project = join(root, 'project'); mkdirSync(project); mkdirSync(join(project, '.git'));
  const release = COMPANION_RELEASES.find(record => record.id === 'lexicon')!;
  const manifest: CompanionArtifactManifest = { schemaVersion: 1, tool: 'lexicon', version: release.version,
    sourceCommit: release.sourceCommit, releaseUrl: release.releaseUrl, platform: `${process.platform}-${process.arch}`,
    format: 'expanded-file-set', qualification: 'qualified', entrypoint: 'bin/lexicon-mcp',
    files: Object.entries(payloads).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes),
      mode: path.startsWith('bin/') ? 0o755 : 0o644 })) };
  const manifestSha256 = hash(JSON.stringify(manifest, null, 2) + '\n');
  catalog.select.mockReturnValue({ status: 'selected', entry: { id: 'lexicon-mcp', manifest, manifestSha256 } });
  const slot = join(installation, `lexicon-${release.version}-${manifest.platform}`); mkdirSync(slot, { mode: 0o700 });
  mkdirSync(join(slot, 'bin'), { mode: 0o700 });
  for (const file of manifest.files) writeFileSync(join(slot, file.path), payloads[file.path]!, { mode: file.mode });
  const options: CompanionClientPlanOptions = { installationRoot: installation, projectRoot: project, client: 'claude-test',
    registryPath: join(project, '.phantom-mcp.json'), clientConfigPath: join(project, 'client.mcp.json'),
    packageBinPath: realpathSync(fileURLToPath(new URL('../bin/ashlr', import.meta.url))), nodePath: realpathSync(process.execPath) };
  return { root, installation, project, manifest, manifestSha256, slot, options,
    snapshot: () => verifyInstalledCompanionSnapshot({ installationRoot: slot, trustedManifest: manifest, trustedManifestSha256: manifestSha256 }) };
}
afterEach(() => { catalog.select.mockReset(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('verified inert companion client plans', () => {
  it('plans precisely one direct registry entry and one scoped gateway entry without writes or execution', () => {
    const f = fixture(); vi.stubEnv('OPENAI_API_KEY', 'synthetic-private-do-not-print'); vi.stubEnv('LEXICON_TRUST_ALL', '1');
    const plan = planCompanionClient(f.options);
    expect(catalog.select).toHaveBeenCalledWith('lexicon-mcp');
    expect(plan).toMatchObject({ status: 'verified-client-plan', effects: [], wiringApplied: false, bundled: false,
      runtimeCapability: 'not-inspected', vocabularyTrust: 'not-inspected', providerAcceptance: 'not-inspected', requiresRevalidationBeforeExecution: true });
    expect(plan.patches).toHaveLength(2);
    expect(plan.patches[0]).toMatchObject({ path: f.options.registryPath, serverName: 'lexicon', action: 'create-config',
      entry: { command: join(f.slot, 'bin/lexicon-mcp'), args: [], env: { LEXICON_CWD: f.project,
        LEXICON_PATH: join(f.project, '.phantom', 'lexicon', f.options.client, 'lexicon.yaml') } } });
    expect(plan.patches[1]!.entry).toEqual({ command: f.options.nodePath, args: [f.options.packageBinPath, 'mcp',
      '--project', f.project, '--client', f.options.client, '--config', f.options.registryPath],
      env: { PATH: [join(f.slot, 'bin'), dirname(f.options.nodePath!)].join(delimiter), ASHLR_NO_HEAL: '1' } });
    expect(existsSync(f.options.registryPath)).toBe(false); expect(existsSync(f.options.clientConfigPath)).toBe(false);
    expect(existsSync(join(f.project, '.phantom'))).toBe(false); expect(existsSync(join(f.slot, 'manifest.json'))).toBe(false);
    expect(JSON.stringify(plan)).not.toContain('synthetic-private-do-not-print'); expect(JSON.stringify(plan)).not.toContain('LEXICON_TRUST_ALL');
    expect(readFileSync(join(f.slot, 'bin/lexicon-mcp'), 'utf8')).toBe(payloads['bin/lexicon-mcp']);
  });
  it.each(['bin/lexicon-mcp', 'package.json', 'LICENSE'])('freshly rejects changed %s rather than deriving new pins', file => {
    const f = fixture(); writeFileSync(join(f.slot, file), 'altered');
    expect(planCompanionClient(f.options)).toMatchObject({ status: 'blocked', patches: [], blockers: ['artifact-digest-mismatch'] });
  });
  it('rejects extra and missing files, including an installed local manifest', () => {
    const f = fixture(); writeFileSync(join(f.slot, 'manifest.json'), JSON.stringify(f.manifest));
    expect(f.snapshot().blockers).toEqual(['unexpected-destination-content']);
    rmSync(join(f.slot, 'manifest.json')); rmSync(join(f.slot, 'LICENSE'));
    expect(planCompanionClient(f.options).blockers).toEqual(['artifact-digest-mismatch']);
  });
  it.each([0o644, 0o777])('rejects executable mode %o', mode => {
    const f = fixture(); chmodSync(join(f.slot, 'bin/lexicon-mcp'), mode);
    expect(planCompanionClient(f.options).blockers).toEqual(['installed-mode-mismatch']);
  });
  it('rejects special executable permission bits when the filesystem permits retaining them', context => {
    const f = fixture(); const executable = join(f.slot, 'bin/lexicon-mcp'); chmodSync(executable, 0o4755);
    if (!(statSync(executable).mode & 0o4000)) context.skip();
    expect(planCompanionClient(f.options).blockers).toEqual(['installed-mode-mismatch']);
  });
  it('rejects payload links, linked directories and multiply linked files', () => {
    const f = fixture(); const payload = join(f.slot, 'LICENSE'); const other = join(f.root, 'other');
    writeFileSync(other, payloads.LICENSE); rmSync(payload); symlinkSync(other, payload);
    expect(planCompanionClient(f.options).status).toBe('blocked'); rmSync(payload); linkSync(other, payload);
    expect(planCompanionClient(f.options).status).toBe('blocked'); rmSync(payload); writeFileSync(payload, payloads.LICENSE);
    const moved = join(f.root, 'moved-bin'); mkdirSync(moved); rmSync(join(f.slot, 'bin'), { recursive: true }); symlinkSync(moved, join(f.slot, 'bin'));
    expect(planCompanionClient(f.options).status).toBe('blocked');
  });
  it('rejects unsafe installation root and slot permissions', () => {
    const f = fixture(); chmodSync(f.installation, 0o755);
    expect(planCompanionClient(f.options).blockers).toEqual(['installation-parent-must-be-owned-and-private']);
    chmodSync(f.installation, 0o700); chmodSync(f.slot, 0o755);
    expect(planCompanionClient(f.options).blockers).toEqual(['installation-must-be-owned-and-private']);
  });
  it('requires project Git boundary and safe client identifier', () => {
    const f = fixture(); expect(planCompanionClient({ ...f.options, client: '../other' }).status).toBe('blocked');
    rmSync(join(f.project, '.git'), { recursive: true });
    expect(planCompanionClient(f.options).blockers).toEqual(['project-root-git-marker-required']);
  });
  it('refuses redirected client state and project vocabulary without reading their values', () => {
    const f = fixture(); const target = join(f.root, 'private-state'); writeFileSync(target, 'synthetic-private-state');
    symlinkSync(target, join(f.project, '.lexicon.yaml'));
    const plan = planCompanionClient(f.options); expect(plan.status).toBe('blocked'); expect(JSON.stringify(plan)).not.toContain('synthetic-private-state');
    rmSync(join(f.project, '.lexicon.yaml')); const state = join(f.project, '.phantom', 'lexicon'); mkdirSync(state, { recursive: true });
    mkdirSync(join(state, 'other-client')); symlinkSync(join(state, 'other-client'), join(state, f.options.client));
    expect(planCompanionClient(f.options).status).toBe('blocked');
  });
  it.each(['same', 'outside', 'client-state', 'git-state', 'nonjson'])('rejects %s config path collisions', variant => {
    const f = fixture(); const options = { ...f.options };
    if (variant === 'same') options.clientConfigPath = options.registryPath;
    if (variant === 'outside') options.clientConfigPath = join(f.root, 'outside.json');
    if (variant === 'client-state') options.registryPath = join(f.project, '.phantom', 'lexicon', 'claude-test', 'trust.json');
    if (variant === 'git-state') options.registryPath = join(f.project, '.git', 'other.json');
    if (variant === 'nonjson') options.registryPath = join(f.project, '.lexicon.yaml');
    expect(planCompanionClient(options)).toMatchObject({ status: 'blocked', patches: [], effects: [] });
  });
  it('refuses malformed and mismatched existing bindings while keeping all bytes unchanged', () => {
    const f = fixture(); const raw = '{"private":"do-not-print",'; writeFileSync(f.options.clientConfigPath, raw);
    const malformed = planCompanionClient(f.options); expect(malformed.blockers).toEqual(['invalid-client-config']);
    expect(JSON.stringify(malformed)).not.toContain('do-not-print'); expect(readFileSync(f.options.clientConfigPath, 'utf8')).toBe(raw);
    const mismatch = JSON.stringify({ mcpServers: { ashlr: { command: '/other', args: [], env: {} } } });
    writeFileSync(f.options.clientConfigPath, mismatch);
    expect(planCompanionClient(f.options).blockers).toEqual(['existing-client-binding-mismatch']);
    expect(readFileSync(f.options.clientConfigPath, 'utf8')).toBe(mismatch); expect(existsSync(f.options.registryPath)).toBe(false);
  });
  it('refuses case aliases for fresh configs and duplicate direct Lexicon in the client', () => {
    const f = fixture();
    expect(planCompanionClient({ ...f.options, clientConfigPath: join(f.project, '.PHANTOM-MCP.json') }).blockers)
      .toEqual(['distinct-client-and-registry-configs-required']);
    const raw = JSON.stringify({ mcpServers: { lexicon: { command: '/do-not-start', args: [] } } });
    writeFileSync(f.options.clientConfigPath, raw);
    expect(planCompanionClient(f.options).blockers).toEqual(['client-already-has-direct-lexicon-entry']);
    expect(readFileSync(f.options.clientConfigPath, 'utf8')).toBe(raw);
  });
  it('rejects actual macOS protected-state aliases and conservatively refuses them on case-sensitive hosts', () => {
    const f = fixture(); const state = join(f.project, '.phantom', 'lexicon', f.options.client); mkdirSync(state, { recursive: true });
    const trust = join(state, 'trust.json'); const bytes = '{"synthetic":"do not read or replace"}'; writeFileSync(trust, bytes);
    const alias = join(f.project, '.PHANTOM', 'LEXICON', f.options.client, 'trust.json');
    if (existsSync(alias)) expect(statSync(alias).ino).toBe(statSync(trust).ino);
    expect(planCompanionClient({ ...f.options, registryPath: alias })).toMatchObject({ status: 'blocked',
      blockers: ['config-state-path-collision'], effects: [], patches: [] });
    expect(readFileSync(trust, 'utf8')).toBe(bytes);
  });
  it('rejects case-folded Git state, installation state and config ancestor collisions', () => {
    const f = fixture();
    expect(planCompanionClient({ ...f.options, registryPath: join(f.project, '.GIT', 'other.json') }).blockers)
      .toEqual(['config-state-path-collision']);
    mkdirSync(join(f.project, 'INSTALLATION'), { mode: 0o700 });
    const nested = join(f.project, 'INSTALLATION'); const nestedSlot = join(nested, f.slot.slice(f.installation.length + 1));
    mkdirSync(nestedSlot, { mode: 0o700 }); mkdirSync(join(nestedSlot, 'bin'), { mode: 0o700 });
    for (const file of f.manifest.files) writeFileSync(join(nestedSlot, file.path), payloads[file.path]!, { mode: file.mode });
    expect(planCompanionClient({ ...f.options, installationRoot: nested, registryPath: join(f.project, 'installation', 'other.json') }).blockers)
      .toEqual(['config-installation-path-collision']);
    expect(planCompanionClient({ ...f.options, registryPath: join(f.project, 'PARENT.json'), clientConfigPath: join(f.project, 'parent.json', 'nested.json') }).blockers)
      .toEqual(['distinct-client-and-registry-configs-required']);
  });
  it('refuses NFC-equivalent fresh config aliases without creating their parents', () => {
    const f = fixture();
    expect(planCompanionClient({ ...f.options, registryPath: join(f.project, '\u00e9.json'), clientConfigPath: join(f.project, 'e\u0301.json') }).blockers)
      .toEqual(['distinct-client-and-registry-configs-required']);
    expect(existsSync(join(f.project, '\u00e9.json'))).toBe(false);
  });
  it('preflights the exact emitted PATH and refuses an additional physical MCP candidate without execution', () => {
    const f = fixture(); const extra = join(f.root, 'second-lexicon-mcp'); writeFileSync(extra, payloads['bin/lexicon-mcp']!, { mode: 0o755 });
    const selected = join(f.slot, 'bin/lexicon-mcp');
    const discovery = vi.spyOn(companionInventory, 'companionExecutableCandidates').mockReturnValue([selected, extra]);
    expect(planCompanionClient(f.options)).toMatchObject({ status: 'blocked', blockers: ['client-path-ambiguous'], patches: [], effects: [] });
    expect(discovery).toHaveBeenCalledWith('lexicon-mcp', [join(f.slot, 'bin'), dirname(f.options.nodePath!)]);
    expect(existsSync(f.options.registryPath)).toBe(false);
  });
  it('returns only patches, retaining exact bindings without exposing unrelated existing config', () => {
    const f = fixture(); const initial = planCompanionClient(f.options);
    for (const patch of initial.patches) writeFileSync(patch.path, JSON.stringify({ private: 'synthetic-private-value',
      mcpServers: { unrelated: { command: '/unused', env: { KEY: 'synthetic-private-env' } }, [patch.serverName]: patch.entry } }));
    const unchanged = planCompanionClient(f.options);
    expect(unchanged.patches.map(patch => patch.action)).toEqual(['retain-entry', 'retain-entry']);
    expect(JSON.stringify(unchanged)).not.toMatch(/synthetic-private-value|synthetic-private-env|\/unused/u);
    expect(unchanged.patches.every(patch => patch.preserveUnrelatedFieldsAndEntries)).toBe(true);
  });
  it('refuses symlink/hardlink config aliases and oversized selected configs', () => {
    const f = fixture(); writeFileSync(f.options.registryPath, '{}'); linkSync(f.options.registryPath, f.options.clientConfigPath);
    expect(planCompanionClient(f.options).blockers).toEqual(['unsafe-file']); rmSync(f.options.clientConfigPath);
    symlinkSync(f.options.registryPath, f.options.clientConfigPath); expect(planCompanionClient(f.options).status).toBe('blocked');
    rmSync(f.options.clientConfigPath); writeFileSync(f.options.clientConfigPath, ' '.repeat(256 * 1024 + 1));
    expect(planCompanionClient(f.options).blockers).toEqual(['client-config-size-limit']);
  });
  it('rejects arbitrary runtime/package entries and accepts only actual current Node host', () => {
    const f = fixture(); const fake = join(f.project, 'fake-node'); writeFileSync(fake, '#!/bin/sh\nexit 0', { mode: 0o755 });
    expect(planCompanionClient({ ...f.options, nodePath: fake }).blockers).toEqual(['current-node-host-required']);
    expect(planCompanionClient({ ...f.options, packageBinPath: fake }).blockers).toEqual(['current-package-bin-required']);
    const defaultNode = planCompanionClient({ ...f.options, nodePath: undefined, packageBinPath: undefined });
    expect(defaultNode.patches[1]!.entry.command).toBe(realpathSync(process.execPath));
    expect(defaultNode.patches[1]!.entry.args[0]).toBe(f.options.packageBinPath);
  });
  it('blocks unavailable shipped host records and independently modified reviewed record hashes', () => {
    const f = fixture(); catalog.select.mockReturnValueOnce({ status: 'blocked', blockers: ['catalog-platform-unavailable'] });
    expect(planCompanionClient(f.options).blockers).toEqual(['catalog-platform-unavailable']);
    expect(verifyInstalledCompanionSnapshot({ installationRoot: f.slot, trustedManifest: f.manifest,
      trustedManifestSha256: '0'.repeat(64) }).blockers).toEqual(['manifest-digest-mismatch']);
  });
});

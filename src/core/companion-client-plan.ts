/** Inert client wiring plans. Supplied installed bytes can satisfy pins, never create them. */
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCompanionCatalog } from './companion-catalog.js';
import { verifyInstalledCompanionSnapshot } from './companion-provisioning.js';
import { lexiconServerSpec, pathWithinProject } from './integrations/lexicon-mcp.js';
import { companionExecutableCandidates, companionExecutableKind } from './companion-inventory.js';

export interface CompanionClientPlanOptions {
  installationRoot: string;
  projectRoot: string;
  client: string;
  registryPath: string;
  clientConfigPath: string;
  packageBinPath?: string;
  /** Current actual Node host only. No runtime discovery or installation. */
  nodePath?: string;
}
type Entry = { command: string; args: string[]; env: Record<string, string> };
export interface CompanionClientPatch {
  path: string;
  serverName: 'lexicon' | 'ashlr';
  entry: Entry;
  action: 'create-config' | 'add-entry' | 'retain-entry';
  beforeImage: { state: 'absent' } | { state: 'present'; sha256: string; bytes: number };
  preserveUnrelatedFieldsAndEntries: true;
}
export interface CompanionClientPlan {
  schemaVersion: 1;
  status: 'verified-client-plan' | 'blocked';
  effects: [];
  wiringApplied: false;
  bundled: false;
  runtimeCapability: 'not-inspected';
  vocabularyTrust: 'not-inspected';
  providerAcceptance: 'not-inspected';
  nativeGatewayToolsAvailable: true;
  requiresRevalidationBeforeExecution: true;
  blockers: string[];
  component: { id: 'lexicon-mcp'; version: string; platform: string; manifestSha256: string; slot: string } | null;
  patches: CompanionClientPatch[];
  instructions: string[];
}
class Blocked extends Error {}
function refuse(reason: string): never { throw new Blocked(reason); }
function stat(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; refuse('filesystem-inspection-failed'); }
}
function absolute(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\r\n\0]/.test(path)) refuse('canonical-absolute-paths-required');
}
// Conservative on case-sensitive hosts too: a reviewable plan must remain
// distinct on macOS filesystems that equate case and Unicode normalization.
function folded(path: string): string { return path.normalize('NFC').toLowerCase(); }
function within(root: string, candidate: string): boolean { return pathWithinProject(folded(root), folded(candidate)); }
function samePath(a: string, b: string): boolean { return folded(a) === folded(b); }
function directory(path: string, allowMissing = false): void {
  absolute(path);
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part); const metadata = stat(current);
    if (!metadata) { if (allowMissing) return; refuse('directory-missing'); }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) refuse('unsafe-directory');
  }
}
function fileMetadata(path: string, allowMissing = false): Stats | null {
  absolute(path); directory(dirname(path), allowMissing);
  const metadata = stat(path);
  if (!metadata) { if (allowMissing) return null; refuse('file-missing'); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) refuse('unsafe-file');
  return metadata;
}
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode &&
    a.nlink === b.nlink && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function matches(value: unknown, entry: Entry): boolean {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'args,command,env' || !object(value['env'])) return false;
  return value['command'] === entry.command && JSON.stringify(value['args']) === JSON.stringify(entry.args) &&
    Object.keys(value['env']).sort().join('\0') === Object.keys(entry.env).sort().join('\0') &&
    Object.entries(entry.env).every(([key, expected]) => (value['env'] as Record<string, unknown>)[key] === expected);
}
function patch(path: string, serverName: CompanionClientPatch['serverName'], entry: Entry): CompanionClientPatch {
  const metadata = fileMetadata(path, true);
  const result: CompanionClientPatch = { path, serverName, entry, action: 'create-config',
    beforeImage: { state: 'absent' }, preserveUnrelatedFieldsAndEntries: true };
  if (!metadata) return result;
  const limit = 256 * 1024;
  if (metadata.size > limit) refuse('client-config-size-limit');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: Buffer;
  try {
    if (!same(metadata, fstatSync(descriptor))) refuse('client-config-changed');
    const chunks: Buffer[] = []; let bytes = 0; const buffer = Buffer.alloc(16 * 1024);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, limit + 1 - bytes), null);
      if (!count) break; bytes += count; if (bytes > limit) refuse('client-config-size-limit');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = stat(path);
    if (!after || !same(metadata, after) || !same(metadata, fstatSync(descriptor)) || bytes !== metadata.size) refuse('client-config-changed');
    raw = Buffer.concat(chunks);
  } finally { closeSync(descriptor); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { refuse('invalid-client-config'); }
  if (!object(parsed) || (parsed['mcpServers'] !== undefined && !object(parsed['mcpServers']))) refuse('invalid-client-config');
  const servers = parsed['mcpServers'] as Record<string, unknown> | undefined;
  if (servers && Object.values(servers).some(value => !object(value))) refuse('invalid-client-config');
  if (serverName === 'ashlr' && servers && Object.hasOwn(servers, 'lexicon')) refuse('client-already-has-direct-lexicon-entry');
  if (servers && Object.hasOwn(servers, serverName)) {
    if (!matches(servers[serverName], entry)) refuse('existing-client-binding-mismatch');
    result.action = 'retain-entry';
  } else result.action = 'add-entry';
  result.beforeImage = { state: 'present', bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex') };
  return result;
}

/** Selects only a shipped host catalog record; plans two entries without writing or starting anything. */
export function planCompanionClient(options: CompanionClientPlanOptions): CompanionClientPlan {
  const plan: CompanionClientPlan = { schemaVersion: 1, status: 'blocked', effects: [], wiringApplied: false,
    bundled: false, runtimeCapability: 'not-inspected', vocabularyTrust: 'not-inspected', providerAcceptance: 'not-inspected',
    nativeGatewayToolsAvailable: true, requiresRevalidationBeforeExecution: true, blockers: [], component: null, patches: [],
    instructions: ['Merge only each listed entry into its indicated JSON config; preserve every unrelated field and server.',
      'Revalidate the complete installed component and configs immediately before applying or executing.',
      'The external MCP client environment is not sandboxed. Native Phantom gateway tools remain available; no project authority or vocabulary trust is granted.'] };
  try {
    const selected = resolveCompanionCatalog('lexicon-mcp');
    if (selected.status !== 'selected') refuse(selected.blockers[0] ?? 'catalog-unavailable');
    const record = selected.entry;
    directory(options.installationRoot);
    const parent = stat(options.installationRoot)!;
    if ((parent.mode & 0o077) !== 0 || (process.geteuid && parent.uid !== process.geteuid())) refuse('installation-parent-must-be-owned-and-private');
    const slot = join(options.installationRoot, `${record.manifest.tool}-${record.manifest.version}-${record.manifest.platform}`);
    const verified = verifyInstalledCompanionSnapshot({ installationRoot: slot, trustedManifest: record.manifest,
      trustedManifestSha256: record.manifestSha256 });
    if (verified.status !== 'verified-snapshot') refuse(verified.blockers[0] ?? 'installed-component-unverified');
    directory(options.projectRoot);
    const git = stat(join(options.projectRoot, '.git'));
    if (!git || (!git.isFile() && !git.isDirectory()) || git.isSymbolicLink()) refuse('project-root-git-marker-required');
    const command = join(slot, record.manifest.entrypoint);
    const lexicon = lexiconServerSpec({ projectRoot: options.projectRoot, client: options.client, command, launch: 'stdio' });
    const state = dirname(lexicon.env['LEXICON_PATH']!);
    for (const path of [join(options.projectRoot, '.lexicon.yaml'), join(state, 'lexicon.yaml'), join(state, 'trust.json'), join(state, 'hits.json')]) {
      for (const candidate of [path, `${path}.bak`, `${path}.1.bak`, `${path}.lock`]) fileMetadata(candidate, true);
    }
    for (const path of [options.registryPath, options.clientConfigPath]) {
      absolute(path);
      if (!pathWithinProject(options.projectRoot, path) || !path.endsWith('.json')) refuse('project-local-json-config-required');
      if (samePath(path, options.installationRoot) || within(options.installationRoot, path)
          || within(path, options.installationRoot)) refuse('config-installation-path-collision');
      for (const reserved of [join(options.projectRoot, '.git'), join(options.projectRoot, '.phantom', 'lexicon')]) {
        if (samePath(path, reserved) || within(reserved, path) || within(path, reserved)) refuse('config-state-path-collision');
      }
    }
    if (samePath(options.registryPath, options.clientConfigPath) || within(options.registryPath, options.clientConfigPath)
        || within(options.clientConfigPath, options.registryPath)) refuse('distinct-client-and-registry-configs-required');
    if (process.release.name !== 'node' || !process.versions.node || (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun) refuse('actual-node-host-required');
    const node = options.nodePath ?? realpathSync(process.execPath);
    fileMetadata(node); accessSync(node, constants.X_OK);
    if (node !== realpathSync(process.execPath)) refuse('current-node-host-required');
    const expectedBin = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'ashlr'));
    const packageBin = options.packageBinPath ?? expectedBin;
    fileMetadata(packageBin); accessSync(packageBin, constants.X_OK);
    if (packageBin !== expectedBin) refuse('current-package-bin-required');
    const searchPaths = [join(slot, 'bin'), dirname(node)];
    const candidates = companionExecutableCandidates('lexicon-mcp', searchPaths);
    if (candidates.length !== 1) refuse(candidates.length > 1 ? 'client-path-ambiguous' : 'client-path-component-missing');
    if (candidates[0] !== command) refuse('client-path-component-mismatch');
    const kind = companionExecutableKind(candidates[0]);
    if (kind !== 'native' && kind !== 'script') refuse('client-path-unsupported-launcher');
    const gateway: Entry = { command: node, args: [packageBin, 'mcp', '--project', options.projectRoot,
      '--client', options.client, '--config', options.registryPath], env: { PATH: searchPaths.join(delimiter), ASHLR_NO_HEAL: '1' } };
    const patches = [patch(options.registryPath, 'lexicon', lexicon), patch(options.clientConfigPath, 'ashlr', gateway)];
    plan.component = { id: 'lexicon-mcp', version: record.manifest.version, platform: record.manifest.platform,
      manifestSha256: record.manifestSha256, slot };
    plan.patches = patches;
    plan.status = 'verified-client-plan';
  } catch (error) { plan.blockers = [error instanceof Blocked ? error.message : 'filesystem-inspection-failed']; }
  return plan;
}

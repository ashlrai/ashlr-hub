/** Paired release bytes, not an operator grant or a saved CI capability. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from '../authority/canonical-json.js';

export const MAX_UPDATE_MANIFEST_BYTES = 64 * 1024;
export interface UpdateTrust {
  publicKey: string;
  repository: {
    fullName: 'ashlrai/ashlr-hub' | 'ashlrai/phantom';
    repositoryId: number;
    repositoryNodeId: string;
    ownerLogin: 'ashlrai';
    ownerId: number;
    ownerNodeId: string;
  };
  channel: 'stable';
  platform: 'darwin-aarch64';
}
export interface UpdateArtifact {
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Tauri's base64-wrapped Minisign text, not a signature file path. */
  signature: string;
}
export interface UpdateManifest {
  schemaVersion: 1;
  kind: 'phantom-paired-release';
  channel: 'stable';
  platform: 'darwin-aarch64';
  version: string;
  repository: { nameWithOwner: string; repositoryId: number; repositoryNodeId: string; ownerId: number; ownerLogin: 'ashlrai'; defaultBranch: 'master' };
  source: { revision: string; tree: string };
  authoritySurfaceDigest: string;
  app: UpdateArtifact & { bundleIdentifier: 'ai.ashlr.desktop'; executable: 'ashlr-desktop'; inventorySha256: string; signer: string };
  cli: UpdateArtifact & { packageName: '@ashlr/hub'; binName: 'ashlr' };
  qualification: {
    manifestSha256: string; archiveSha256: string; packageSha256: string; qualificationSha256: string;
    producer: { runId: number; runAttempt: number; eventSha: string };
    attestor: { revision: string; runId: number; runAttempt: number };
    audit: { revision: string; runId: number; runAttempt: number };
  };
}
export interface UpdateEnvelope { manifestText: string; signature: string }
export interface VerifiedUpdateManifest { manifest: UpdateManifest; digest: string }
export type DesktopUpdateProfileName = 'legacy-v1' | 'canonical-v2';
export interface DesktopUpdateProfile {
  readonly name: DesktopUpdateProfileName;
  readonly schemaVersion: 1 | 2;
  readonly repository: UpdateTrust['repository']['fullName'];
  readonly packageName: '@ashlr/hub' | '@ashlr/phantom';
  readonly archivePrefix: 'ashlr-hub' | 'ashlr-phantom';
  readonly binName: 'ashlr';
}
const profiles: Readonly<Record<DesktopUpdateProfileName, DesktopUpdateProfile>> = Object.freeze({
  'legacy-v1': Object.freeze({name: 'legacy-v1', schemaVersion: 1, repository: 'ashlrai/ashlr-hub', packageName: '@ashlr/hub', archivePrefix: 'ashlr-hub', binName: 'ashlr'}),
  'canonical-v2': Object.freeze({name: 'canonical-v2', schemaVersion: 2, repository: 'ashlrai/phantom', packageName: '@ashlr/phantom', archivePrefix: 'ashlr-phantom', binName: 'ashlr'}),
});
/** Closed identity data, never an authority grant or a caller-selected namespace. */
export function getDesktopUpdateProfile(name: DesktopUpdateProfileName): DesktopUpdateProfile {
  requireValue(name === 'legacy-v1' || name === 'canonical-v2', 'identity profile');
  return profiles[name];
}
/** Publishers must independently bind the returned profile to their fresh exact repository. */
export function desktopUpdateProfileForPackage(packageName: unknown): DesktopUpdateProfile {
  requireValue(packageName === '@ashlr/hub' || packageName === '@ashlr/phantom', 'package identity');
  return profiles[packageName === '@ashlr/hub' ? 'legacy-v1' : 'canonical-v2'];
}
export type CanonicalUpdateManifest = Omit<UpdateManifest, 'schemaVersion' | 'cli'> & {
  schemaVersion: 2;
  cli: UpdateArtifact & {packageName: '@ashlr/phantom'; binName: 'ashlr'};
};
export type CompatibleUpdateManifest = UpdateManifest | CanonicalUpdateManifest;
export interface VerifiedCompatibleUpdateManifest {manifest: CompatibleUpdateManifest; digest: string}
export interface UpdateBundleRecord {
  schemaVersion: 1;
  version: string;
  source: {revision: string; tree: string};
  authoritySurfaceDigest: string;
  packageSha256: string;
}

function requireValue(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Update held: invalid ${label}`);
}
function base64(text: string, maximum: number): Buffer {
  requireValue(typeof text === 'string' && text.length > 0 && text.length <= maximum && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text), 'base64');
  const bytes = Buffer.from(text, 'base64');
  requireValue(bytes.toString('base64') === text, 'base64 encoding');
  return bytes;
}
function lines(encoded: string, count: number): string[] {
  const bytes = base64(encoded, 8192);
  const text = bytes.toString('utf8');
  requireValue(Buffer.from(text).equals(bytes), 'signature UTF-8');
  const result = text.replace(/\n$/, '').split('\n');
  requireValue(result.length === count && result.every(line => !line.includes('\r')), 'signature lines');
  return result;
}
/** Compatible with pinned Tauri2.11.4/minisign-verify0.2.5, including global comment authentication. */
export function verifyMinisign(data: Uint8Array, signature: string, publicKey: string, options: { allowLegacy?: boolean } = {}): void {
  const keyLines = lines(publicKey, 2);
  const signatureLines = lines(signature, 4);
  requireValue(keyLines[0]!.startsWith('untrusted comment: ') && signatureLines[0]!.startsWith('untrusted comment: ') && signatureLines[2]!.startsWith('trusted comment: '), 'signature comments');
  const key = base64(keyLines[1]!, 128), packet = base64(signatureLines[1]!, 128), global = base64(signatureLines[3]!, 128);
  requireValue(key.length === 42 && packet.length === 74 && global.length === 64, 'signature lengths');
  requireValue(['Ed', 'ED'].includes(key.subarray(0, 2).toString()), 'key algorithm');
  const algorithm = packet.subarray(0, 2).toString();
  requireValue(algorithm === 'ED' || (algorithm === 'Ed' && options.allowLegacy === true), 'signature algorithm');
  requireValue(key.subarray(2, 10).equals(packet.subarray(2, 10)), 'signature key identity');
  const ed25519 = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  requireValue(verify(null, payload, ed25519, packet.subarray(10)), 'payload signature');
  const comment = Buffer.from(signatureLines[2]!.slice('trusted comment: '.length));
  requireValue(verify(null, Buffer.concat([packet.subarray(10), comment]), ed25519, global), 'trusted comment signature');
}

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), label);
  const record = value as Record<string, unknown>;
  requireValue(Object.keys(record).sort().join('\0') === keys.sort().join('\0'), `${label} fields`);
  return record;
}
function hash(value: unknown): void { requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'digest'); }
function revision(value: unknown): void { requireValue(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), 'revision'); }
function id(value: unknown): void { requireValue(Number.isSafeInteger(value) && (value as number) > 0, 'positive integer'); }
function run(value: unknown, revisionKey: 'revision' | 'eventSha'): void {
  const r = object(value, ['runId', 'runAttempt', revisionKey], 'workflow'); id(r.runId); id(r.runAttempt); revision(r[revisionKey]);
}
function artifact(value: unknown, extra: string[], filename: string, version: string, trust: UpdateTrust, maximum: number): Record<string, unknown> {
  const a = object(value, ['filename', 'url', 'bytes', 'sha256', 'signature', ...extra], 'artifact');
  requireValue(a.filename === filename && a.url === `https://github.com/${trust.repository.fullName}/releases/download/v${version}/${filename}`, 'release URL');
  id(a.bytes); requireValue((a.bytes as number) <= maximum, 'artifact size'); hash(a.sha256);
  // Decode structure now; actual downloaded bytes are independently signature-verified by the consumer.
  requireValue(typeof a.signature === 'string', 'artifact signature'); lines(a.signature, 4);
  return a;
}
/** This pure parser is not signed admission. Call verifyUpdateManifest for untrusted metadata. */
export function parseUpdateManifest(manifestText: string, trust: UpdateTrust): UpdateManifest {
  requireValue(typeof manifestText === 'string' && Buffer.byteLength(manifestText) <= MAX_UPDATE_MANIFEST_BYTES && Buffer.from(manifestText).toString() === manifestText, 'manifest UTF-8/size');
  const m = object(JSON.parse(manifestText), ['schemaVersion', 'kind', 'channel', 'platform', 'version', 'repository', 'source', 'authoritySurfaceDigest', 'app', 'cli', 'qualification'], 'manifest');
  requireValue(m.schemaVersion === 1 && m.kind === 'phantom-paired-release' && m.channel === trust.channel && trust.channel === 'stable' && m.platform === trust.platform && trust.platform === 'darwin-aarch64', 'release scope');
  requireValue(typeof m.version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.version) && m.version.length <= 32, 'stable version');
  requireValue(m.version.split('.').every(part => Number.isSafeInteger(Number(part))), 'version integer');
  const r = object(m.repository, ['nameWithOwner', 'repositoryId', 'repositoryNodeId', 'ownerId', 'ownerLogin', 'defaultBranch'], 'repository');
  const repository = trust.repository;
  requireValue(['ashlrai/ashlr-hub', 'ashlrai/phantom'].includes(repository.fullName) && repository.repositoryId === 1263526319 && repository.repositoryNodeId === 'R_kgDOS0_hrw' && repository.ownerId === 258113726 && repository.ownerNodeId === 'O_kgDOD2KAvg' && repository.ownerLogin === 'ashlrai', 'commissioned repository');
  requireValue(r.nameWithOwner === repository.fullName && r.repositoryId === repository.repositoryId && r.repositoryNodeId === repository.repositoryNodeId && r.ownerId === repository.ownerId && r.ownerLogin === repository.ownerLogin && r.defaultBranch === 'master', 'repository identity');
  const s = object(m.source, ['revision', 'tree'], 'source'); revision(s.revision); revision(s.tree); hash(m.authoritySurfaceDigest);
  const a = artifact(m.app, ['bundleIdentifier', 'executable', 'inventorySha256', 'signer'], `Phantom_${m.version}_aarch64.app.tar.gz`, m.version, trust, 512 * 1024 * 1024);
  requireValue(a.bundleIdentifier === 'ai.ashlr.desktop' && a.executable === 'ashlr-desktop' && typeof a.signer === 'string' && /^[A-F0-9]{40}$/.test(a.signer), 'app identity'); hash(a.inventorySha256);
  const c = artifact(m.cli, ['packageName', 'binName'], `ashlr-hub-${m.version}.tgz`, m.version, trust, 64 * 1024 * 1024);
  requireValue(c.packageName === '@ashlr/hub' && c.binName === 'ashlr', 'CLI identity');
  const q = object(m.qualification, ['manifestSha256', 'archiveSha256', 'packageSha256', 'qualificationSha256', 'producer', 'attestor', 'audit'], 'qualification');
  for (const key of ['manifestSha256', 'archiveSha256', 'packageSha256', 'qualificationSha256']) hash(q[key]);
  requireValue(q.packageSha256 === c.sha256, 'original package binding');
  run(q.producer, 'eventSha'); run(q.attestor, 'revision'); run(q.audit, 'revision');
  requireValue((q.audit as Record<string, unknown>).revision === s.revision, 'Audit source');
  // One shared authority encoding also rejects duplicate keys and alternate numeric/string encodings.
  requireValue(canonicalJson(m) === manifestText, 'canonical manifest');
  return m as unknown as UpdateManifest;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export function verifyUpdateManifest(envelope: UpdateEnvelope, trust: UpdateTrust): VerifiedUpdateManifest {
  object(envelope, ['manifestText', 'signature'], 'envelope');
  requireValue(typeof envelope.manifestText === 'string' && Buffer.byteLength(envelope.manifestText) <= MAX_UPDATE_MANIFEST_BYTES, 'manifest size');
  verifyMinisign(Buffer.from(envelope.manifestText), envelope.signature, trust.publicKey);
  const manifest = parseUpdateManifest(envelope.manifestText, trust);
  return freeze({ manifest, digest: createHash('sha256').update(envelope.manifestText).digest('hex') });
}
/** Keep the original V1 parser intact; the new production lane accepts only two whole tuples. */
export function parseCompatibleUpdateManifest(manifestText: string, trust: UpdateTrust): CompatibleUpdateManifest {
  requireValue(typeof manifestText === 'string' && Buffer.byteLength(manifestText) <= MAX_UPDATE_MANIFEST_BYTES && Buffer.from(manifestText).toString() === manifestText, 'manifest UTF-8/size');
  const value = JSON.parse(manifestText) as Record<string, unknown>;
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'manifest');
  requireValue(value.schemaVersion === 1 || value.schemaVersion === 2, 'release schema');
  const profile = profiles[value.schemaVersion === 1 ? 'legacy-v1' : 'canonical-v2'];
  const repository = object(value.repository, ['nameWithOwner', 'repositoryId', 'repositoryNodeId', 'ownerId', 'ownerLogin', 'defaultBranch'], 'repository');
  const cli = object(value.cli, ['filename', 'url', 'bytes', 'sha256', 'signature', 'packageName', 'binName'], 'artifact');
  requireValue(repository.nameWithOwner === profile.repository && cli.packageName === profile.packageName && cli.filename === `${profile.archivePrefix}-${String(value.version)}.tgz`, 'identity profile tuple');
  requireValue(canonicalJson(value) === manifestText, 'canonical manifest');
  requireValue(trust.repository.fullName === 'ashlrai/ashlr-hub' || trust.repository.fullName === 'ashlrai/phantom', 'commissioned repository');
  const profileTrust: UpdateTrust = {...trust, repository: {...trust.repository, fullName: profile.repository}};
  if (value.schemaVersion === 1) return parseUpdateManifest(manifestText, profileTrust);
  // Reuse every V1 field/bound/source validation on a private validation view.
  // Only the original V2 bytes are authenticated, returned and digested.
  const legacyFilename = `ashlr-hub-${String(value.version)}.tgz`;
  const canonicalUrl = `https://github.com/${profile.repository}/releases/download/v${String(value.version)}/${String(cli.filename)}`;
  requireValue(cli.url === canonicalUrl, 'release URL');
  const validationView = {...value, schemaVersion: 1, cli: {...cli, packageName: '@ashlr/hub', filename: legacyFilename,
    url: `https://github.com/${profile.repository}/releases/download/v${String(value.version)}/${legacyFilename}`}};
  parseUpdateManifest(canonicalJson(validationView), profileTrust);
  return value as unknown as CanonicalUpdateManifest;
}
export function verifyCompatibleUpdateManifest(envelope: UpdateEnvelope, trust: UpdateTrust): VerifiedCompatibleUpdateManifest {
  object(envelope, ['manifestText', 'signature'], 'envelope');
  requireValue(typeof envelope.manifestText === 'string' && Buffer.byteLength(envelope.manifestText) <= MAX_UPDATE_MANIFEST_BYTES, 'manifest size');
  verifyMinisign(Buffer.from(envelope.manifestText), envelope.signature, trust.publicKey);
  const manifest = parseCompatibleUpdateManifest(envelope.manifestText, trust);
  return freeze({manifest, digest: createHash('sha256').update(envelope.manifestText).digest('hex')});
}
/** Read only after Apple code identity/inventory verification. This record is not an independent signature. */
export function verifyUpdateBundleRecord(text: string, manifest: CompatibleUpdateManifest): void {
  requireValue(typeof text === 'string' && Buffer.byteLength(text) <= 4096 && Buffer.from(text).toString() === text, 'bundle record UTF-8/size');
  const expected: UpdateBundleRecord = {schemaVersion: 1, version: manifest.version, source: manifest.source,
    authoritySurfaceDigest: manifest.authoritySurfaceDigest, packageSha256: manifest.cli.sha256};
  requireValue(text === canonicalJson(expected), 'signed bundle release record');
}

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { parseUpdateManifest, verifyMinisign, verifyUpdateManifest, verifyCompatibleUpdateManifest, verifyUpdateBundleRecord, type UpdateManifest, type UpdateTrust } from '../src/core/desktop/update-manifest.js';

// In-memory test-only keys are never the commissioned publisher key.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyId = Buffer.from('0123456789abcdef', 'hex');
const encodedKey = Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({format: 'der', type: 'spki'}).subarray(-32)]).toString('base64');
const key = Buffer.from(`untrusted comment: disposable test key\n${encodedKey}\n`).toString('base64');
function signature(data: Uint8Array, algorithm = 'ED', comment = 'test-only signature'): string {
  const payload = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const signed = sign(null, payload, privateKey);
  const global = sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey);
  return Buffer.from(`untrusted comment: test only\n${Buffer.concat([Buffer.from(algorithm), keyId, signed]).toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
}
const trust: UpdateTrust = {publicKey: key, repository: {fullName: 'ashlrai/ashlr-hub', repositoryId: 1263526319, repositoryNodeId: 'R_kgDOS0_hrw', ownerLogin: 'ashlrai', ownerId: 258113726, ownerNodeId: 'O_kgDOD2KAvg'}, channel: 'stable', platform: 'darwin-aarch64'};
function manifest(): UpdateManifest {
  const bytes = Buffer.from('test-only artifact');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const artifact = {bytes: bytes.length, sha256: hash, signature: signature(bytes)};
  const version = '3.25.1';
  const appName = `Phantom_${version}_aarch64.app.tar.gz`, cliName = `ashlr-hub-${version}.tgz`;
  const url = (name: string) => `https://github.com/ashlrai/ashlr-hub/releases/download/v${version}/${name}`;
  return {schemaVersion: 1, kind: 'phantom-paired-release', channel: 'stable', platform: 'darwin-aarch64', version,
    repository: {nameWithOwner: trust.repository.fullName, repositoryId: trust.repository.repositoryId, repositoryNodeId: trust.repository.repositoryNodeId, ownerId: trust.repository.ownerId, ownerLogin: 'ashlrai', defaultBranch: 'master'},
    source: {revision: 'a'.repeat(40), tree: 'b'.repeat(40)}, authoritySurfaceDigest: 'c'.repeat(64),
    app: {...artifact, filename: appName, url: url(appName), bundleIdentifier: 'ai.ashlr.desktop', executable: 'ashlr-desktop', inventorySha256: 'd'.repeat(64), signer: 'E'.repeat(40)},
    cli: {...artifact, filename: cliName, url: url(cliName), packageName: '@ashlr/hub', binName: 'ashlr'},
    qualification: {manifestSha256: 'e'.repeat(64), archiveSha256: 'f'.repeat(64), packageSha256: hash, qualificationSha256: '1'.repeat(64), producer: {runId: 10, runAttempt: 1, eventSha: 'f'.repeat(40)}, attestor: {revision: 'c'.repeat(40), runId: 11, runAttempt: 1}, audit: {revision: 'a'.repeat(40), runId: 12, runAttempt: 1}}};
}
const verifyText = (manifestText: string, currentTrust = trust) => verifyUpdateManifest({manifestText, signature: signature(Buffer.from(manifestText))}, currentTrust);
describe('paired desktop update signatures', () => {
  it('verifies a real pinned Tauri2.11.4 signature with a destroyed disposable key', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/desktop-update-tauri.json', import.meta.url), 'utf8'));
    expect(fixture.signerVersion).toBe('2.11.4');
    expect(fixture.provenance).toContain('Disposable test-only');
    expect(() => verifyMinisign(Buffer.from(fixture.data), fixture.signature, fixture.publicKey)).not.toThrow();
    expect(() => verifyMinisign(Buffer.from(`${fixture.data}changed`), fixture.signature, fixture.publicKey)).toThrow('payload signature');
  });
  it('accepts the paired real Tauri fixture across manifest and both exact payload signatures', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/desktop-update-paired-tauri.json', import.meta.url), 'utf8'));
    const checked = verifyUpdateManifest(fixture.envelope, {...trust, publicKey: fixture.publicKey});
    for (const [name, encoded] of [['app', fixture.appBase64], ['cli', fixture.cliBase64]] as const) {
      const data = Buffer.from(encoded, 'base64'), artifact = checked.manifest[name];
      expect(data.length).toBe(artifact.bytes); expect(createHash('sha256').update(data).digest('hex')).toBe(artifact.sha256);
      expect(() => verifyMinisign(data, artifact.signature, fixture.publicKey)).not.toThrow();
    }
  });
  it('verifies prehashed payload and authenticated trusted comment', () => {
    const data = Buffer.from('actual artifact');
    const good = signature(data);
    expect(() => verifyMinisign(data, good, key)).not.toThrow();
    const changed = Buffer.from(good, 'base64').toString().replace('trusted comment: test-only signature', 'trusted comment: forged comment');
    expect(() => verifyMinisign(data, Buffer.from(changed).toString('base64'), key)).toThrow('trusted comment signature');
  });
  it('refuses legacy signatures unless explicitly requested', () => {
    const data = Buffer.from('legacy fixture'), legacy = signature(data, 'Ed');
    expect(() => verifyMinisign(data, legacy, key)).toThrow('algorithm');
    expect(() => verifyMinisign(data, legacy, key, {allowLegacy: true})).not.toThrow();
  });
  it('refuses another key identity, malformed base64 and unsupported algorithms', () => {
    const data = Buffer.from('actual artifact'), sig = signature(data);
    const decoded = Buffer.from(sig, 'base64').toString().split('\n');
    const packet = Buffer.from(decoded[1]!, 'base64'); packet[2] ^= 1; decoded[1] = packet.toString('base64');
    expect(() => verifyMinisign(data, Buffer.from(decoded.join('\n')).toString('base64'), key)).toThrow('key identity');
    expect(() => verifyMinisign(data, `${sig} `, key)).toThrow('base64');
    expect(() => verifyMinisign(data, signature(data, 'XX'), key)).toThrow('algorithm');
  });
});
describe('paired desktop update manifest', () => {
  it('binds raw bytes and returns deeply frozen verified metadata', () => {
    const text = canonicalJson(manifest()); const checked = verifyText(text);
    expect(checked.manifest).toEqual(manifest());
    expect(checked.digest).toBe(createHash('sha256').update(text).digest('hex'));
    expect(Object.isFrozen(checked.manifest.app)).toBe(true);
    expect(Object.isFrozen(checked.manifest.qualification.producer)).toBe(true);
  });
  it('checks the signature before malformed JSON parsing', () => {
    expect(() => verifyUpdateManifest({manifestText: '{not-json', signature: signature(Buffer.from('other'))}, trust)).toThrow('payload signature');
  });
  it.each(['duplicate', 'escaped-key', 'whitespace', 'newline'])('refuses %s alternate signed encoding', kind => {
    const text = canonicalJson(manifest());
    const alternate = kind === 'duplicate' ? text.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1') :
      kind === 'escaped-key' ? text.replace('"version":', '"\\u0076ersion":') : kind === 'whitespace' ? ` ${text}` : `${text}\n`;
    expect(() => verifyText(alternate)).toThrow('canonical');
  });
  it.each([
    ['schema', (m: UpdateManifest) => { (m as unknown as {schemaVersion: number}).schemaVersion = 2; }],
    ['platform', (m: UpdateManifest) => { (m as unknown as {platform: string}).platform = 'linux-x64'; }],
    ['version', (m: UpdateManifest) => { m.version = '3.25.1-rc.1'; }],
    ['unsafe version integer', (m: UpdateManifest) => { m.version = '9007199254740992.1.1'; }],
    ['namespace', (m: UpdateManifest) => { m.repository.nameWithOwner = 'ashlrai/phantom'; }],
    ['numeric repo', (m: UpdateManifest) => { m.repository.repositoryId++; }],
    ['owner', (m: UpdateManifest) => { m.repository.ownerId++; }],
    ['tree', (m: UpdateManifest) => { m.source.tree = 'b'.repeat(64); }],
    ['surface', (m: UpdateManifest) => { m.authoritySurfaceDigest = 'unknown'; }],
    ['app identity', (m: UpdateManifest) => { (m.app as {executable: string}).executable = 'other'; }],
    ['signer', (m: UpdateManifest) => { m.app.signer = 'e'.repeat(40); }],
    ['package', (m: UpdateManifest) => { (m.cli as {packageName: string}).packageName = '@ashlr/phantom'; }],
    ['size', (m: UpdateManifest) => { m.cli.bytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['package pairing', (m: UpdateManifest) => { m.qualification.packageSha256 = '0'.repeat(64); }],
    ['Audit source', (m: UpdateManifest) => { m.qualification.audit.revision = 'b'.repeat(40); }],
    ['unknown field', (m: UpdateManifest) => { Object.assign(m.app, {command: 'execute'}); }],
    ['redirect URL', (m: UpdateManifest) => { m.app.url += '?redirect=other'; }],
  ])('refuses validly signed wrong %s', (_kind, mutate) => {
    const value = manifest(); mutate(value); expect(() => verifyText(canonicalJson(value))).toThrow();
  });
  it('refuses oversized, non-UTF8 and uncommissioned trust without artifact contact', () => {
    expect(() => verifyText(' '.repeat(65537))).toThrow('size');
    expect(() => parseUpdateManifest('\ud800', trust)).toThrow('UTF-8');
    expect(() => verifyText(canonicalJson(manifest()), {...trust, publicKey: 'PLACEHOLDER'})).toThrow();
  });
  it('requires the literal renamed namespace only when the compiled trust is renamed', () => {
    const value = manifest(); value.repository.nameWithOwner = 'ashlrai/phantom';
    value.app.url = value.app.url.replace('ashlr-hub/', 'phantom/'); value.cli.url = value.cli.url.replace('ashlr-hub/', 'phantom/');
    expect(() => verifyText(canonicalJson(value), {...trust, repository: {...trust.repository, fullName: 'ashlrai/phantom'}})).not.toThrow();
    expect(() => verifyText(canonicalJson(value))).toThrow('identity');
  });
  it('binds the signed app resource to source, surface and original npm without executing it', () => {
    const value = manifest();
    const record = {schemaVersion: 1, version: value.version, source: value.source, authoritySurfaceDigest: value.authoritySurfaceDigest, packageSha256: value.cli.sha256};
    expect(() => verifyUpdateBundleRecord(canonicalJson(record), value)).not.toThrow();
    for (const changed of [{...record, packageSha256: '0'.repeat(64)}, {...record, source: {...record.source, revision: '0'.repeat(40)}}, {...record, authoritySurfaceDigest: '0'.repeat(64)}, {...record, unknown: true}]) {
      expect(() => verifyUpdateBundleRecord(canonicalJson(changed), value)).toThrow('release record');
    }
    expect(() => verifyUpdateBundleRecord(`${canonicalJson(record)}\n`, value)).toThrow('release record');
  });
});


describe('closed compatibility profiles', () => {
  it('verifies the shared genuine signed V2 fixture without changing original bytes or the V1 reader', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/desktop-update-paired-phantom-tauri.json', import.meta.url), 'utf8'));
    const currentTrust = {...trust, publicKey: fixture.publicKey};
    const checked = verifyCompatibleUpdateManifest(fixture.envelope, currentTrust);
    expect(checked.manifest).toEqual(JSON.parse(fixture.envelope.manifestText));
    expect(checked.digest).toBe(createHash('sha256').update(fixture.envelope.manifestText).digest('hex'));
    expect(Object.isFrozen(checked.manifest.cli)).toBe(true);
    expect(() => verifyUpdateManifest(fixture.envelope, currentTrust)).toThrow('release scope');
    for (const [name, encoded] of [['app', fixture.appBase64], ['cli', fixture.cliBase64]] as const) {
      const bytes = Buffer.from(encoded, 'base64');
      expect(bytes.length).toBe(checked.manifest[name].bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(checked.manifest[name].sha256);
      expect(() => verifyMinisign(bytes, checked.manifest[name].signature, fixture.publicKey)).not.toThrow();
    }
  });
  it('keeps the original signed V1 result and exact historical explicit-trust behavior', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/desktop-update-paired-tauri.json', import.meta.url), 'utf8'));
    const currentTrust = {...trust, publicKey: fixture.publicKey};
    expect(verifyCompatibleUpdateManifest(fixture.envelope, currentTrust)).toEqual(verifyUpdateManifest(fixture.envelope, currentTrust));
    const legacy = manifest();legacy.repository.nameWithOwner = 'ashlrai/phantom';
    legacy.app.url = legacy.app.url.replace('ashlr-hub/', 'phantom/');legacy.cli.url = legacy.cli.url.replace('ashlr-hub/', 'phantom/');
    const envelope = {manifestText: canonicalJson(legacy), signature: signature(Buffer.from(canonicalJson(legacy)))};
    const renamedTrust = {...trust, repository: {...trust.repository, fullName: 'ashlrai/phantom' as const}};
    expect(() => verifyUpdateManifest(envelope, renamedTrust)).not.toThrow();
    expect(() => verifyCompatibleUpdateManifest(envelope, renamedTrust)).toThrow('profile tuple');
  });
  const tuples = [1,2].flatMap(schema => ['ashlrai/ashlr-hub','ashlrai/phantom'].flatMap(repo => ['@ashlr/hub','@ashlr/phantom'].flatMap(pkg => ['ashlr-hub','ashlr-phantom'].map(prefix => ({schema,repo,pkg,prefix})))));
  it.each(tuples)('admits only the whole schema$schema/$repo/$pkg/$prefix tuple', ({schema,repo,pkg,prefix}) => {
    const value = manifest() as unknown as Record<string, unknown>;
    const original = manifest();
    value.schemaVersion = schema;
    value.repository = {...original.repository, nameWithOwner: repo};
    value.app = {...original.app, url: `https://github.com/${repo}/releases/download/v${original.version}/${original.app.filename}`};
    const filename = `${prefix}-${original.version}.tgz`;
    value.cli = {...original.cli, packageName: pkg, filename, url: `https://github.com/${repo}/releases/download/v${original.version}/${filename}`};
    const text = canonicalJson(value), envelope = {manifestText: text, signature: signature(Buffer.from(text))};
    const accepted = schema === 1 ? repo === 'ashlrai/ashlr-hub' && pkg === '@ashlr/hub' && prefix === 'ashlr-hub' : repo === 'ashlrai/phantom' && pkg === '@ashlr/phantom' && prefix === 'ashlr-phantom';
    if (accepted) expect(verifyCompatibleUpdateManifest(envelope, trust).manifest).toEqual(value);
    else expect(() => verifyCompatibleUpdateManifest(envelope, trust)).toThrow('profile tuple');
  });
  it('authenticates raw bytes before selecting a profile and preserves original V2 canonical encoding', () => {
    expect(() => verifyCompatibleUpdateManifest({manifestText: '{not-json', signature: signature(Buffer.from('other'))}, trust)).toThrow('payload signature');
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/desktop-update-paired-phantom-tauri.json', import.meta.url), 'utf8'));
    for (const alternate of [fixture.envelope.manifestText + '\n', fixture.envelope.manifestText.replace('"schemaVersion":2','"schemaVersion":2,"schemaVersion":2')]) {
      expect(() => verifyCompatibleUpdateManifest({manifestText: alternate, signature: signature(Buffer.from(alternate))}, trust)).toThrow('canonical');
    }
    const value = JSON.parse(fixture.envelope.manifestText);value.repository.repositoryId++;
    const text = canonicalJson(value);
    expect(() => verifyCompatibleUpdateManifest({manifestText: text, signature: signature(Buffer.from(text))}, trust)).toThrow('repository identity');
  });
});

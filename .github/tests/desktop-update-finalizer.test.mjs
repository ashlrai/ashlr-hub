/* global Buffer */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir, userInfo} from 'node:os';
import {pathToFileURL, URL} from 'node:url';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import ts from 'typescript';
import {gunzipSync} from 'node:zlib';
import {desktopPublisherGithub, finalizeDesktopUpdate, packDesktopAppArchive, parseFinalizeArguments, prepareDesktopAppIdentity, verifyUpdateAudit} from '../../scripts/finalize-desktop-update.mjs';
import {inspectTar} from '../../scripts/hosted-build-artifact.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const repository = {fullName: 'ashlrai/ashlr-hub', repositoryId: 1263526319, repositoryNodeId: 'R_kgDOS0_hrw', ownerLogin: 'ashlrai', ownerId: 258113726, ownerNodeId: 'O_kgDOD2KAvg'};
const metadata = {full_name: repository.fullName, id: repository.repositoryId, node_id: repository.repositoryNodeId, owner: {id: repository.ownerId, login: repository.ownerLogin}, default_branch: 'master', private: false, visibility: 'public'};
async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phantom-update-finalizer-test-'))); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const name of ['desktop/update-manifest', 'authority/canonical-json']) {
    const out = join(dir, 'core', `${name}.js`); fs.mkdirSync(join(out, '..'), {recursive: true});
    fs.writeFileSync(out, ts.transpileModule(fs.readFileSync(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8'), {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022}}).outputText);
  }
  const module = await import(pathToFileURL(join(dir, 'core/desktop/update-manifest.js')));
  const {canonicalJson} = await import(pathToFileURL(join(dir, 'core/authority/canonical-json.js')));
  const {publicKey, privateKey} = generateKeyPairSync('ed25519'); const id = Buffer.from('0102030405060708', 'hex');
  const publicPacket = Buffer.concat([Buffer.from('Ed'), id, publicKey.export({format: 'der', type: 'spki'}).subarray(-32)]);
  const trusted = Buffer.from(`untrusted comment: test-only key\n${publicPacket.toString('base64')}\n`).toString('base64');
  const sig = data => {const signed = sign(null, createHash('blake2b512').update(data).digest(), privateKey); const comment = 'test-only finalizer'; return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('ED'), id, signed]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([signed, Buffer.from(comment)]), privateKey).toString('base64')}\n`).toString('base64');};
  const bundle = join(dir, 'bundle'), outputParent = join(dir, 'output'); fs.mkdirSync(bundle); fs.mkdirSync(outputParent, {mode: 0o700});
  const revision = 'a'.repeat(40), source = {revision, tree: 'b'.repeat(40)}, version = '3.25.1', packageBytes = Buffer.from('test-only original package');
  const packageSha256 = hash(packageBytes), packageName = `ashlr-hub-${version}.tgz`;
  fs.writeFileSync(join(bundle, packageName), packageBytes);
  const hosted = {producer: {repository: repository.fullName}, source, package: {filename: packageName, sha256: packageSha256}, buildIdentity: {revision, dirty: false, packageVersion: version}};
  fs.writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(hosted));
  const receipt = {source, manifestSha256: hash(Buffer.from(JSON.stringify(hosted))), packageSha256, archiveSha256: 'c'.repeat(64), qualificationSha256: 'd'.repeat(64), official: {runId: 10, runAttempt: 1, eventSha: 'e'.repeat(40)}, attestor: {revision: 'f'.repeat(40), runId: 11, runAttempt: 1}};
  const calls = [], input = {root: dir, revision, bundle, outputParent, policy: {runId: 10, runAttempt: 1, attestorSha: 'f'.repeat(40), attestorRun: 11, attestorAttempt: 1}, audit: {runId: 12, runAttempt: 1}};
  const defaults = async () => ({...module, canonicalJson, trust: {publicKey: trusted, repository, platform: 'darwin-aarch64', channel: 'stable'}, toolchain: {}, surface: (_root, _target, options) => {assert.equal(options.fresh, true); return {ok: true, digest: '1'.repeat(64)};}, readArchive: async options => {calls.push('archive'); assert.equal(options.sha256, packageSha256); assert.equal(options.revision, revision);}});
  const dependencies = {defaults, source: () => source, verify: () => {calls.push('verify'); return receipt;}, adopt: () => {calls.push('adopt');}, validate: () => {calls.push('validate');}, validateTools: () => null,
    audit: () => {calls.push('audit'); return {revision, ...input.audit};}, read: () => metadata,
    build: async () => {calls.push('build'); return {bytes: Buffer.from('test-only built app'), inventorySha256: '2'.repeat(64), signer: 'A'.repeat(40)};},
    sign: (path, _tools, verify, publicKey) => {calls.push('sign'); const result = sig(fs.readFileSync(path)); fs.writeFileSync(`${path}.sig`, result); verify(fs.readFileSync(path), result, publicKey); return result;}};
  return {dir, input, dependencies, module, canonicalJson, calls, receipt, sig, metadata};
}
test('producer signs paired exact bytes only after fresh gates and exports no publication claim', async t => {
  const f = await fixture(t), result = await finalizeDesktopUpdate(f.input, f.dependencies);
  assert.equal(result.published, false); assert.deepEqual(f.calls.slice(0, 6), ['verify', 'audit', 'adopt', 'archive', 'build', 'verify']);
  assert.equal(f.calls.filter(c => c === 'verify').length, 3); assert.equal(f.calls.filter(c => c === 'audit').length, 3);
  const latest = JSON.parse(fs.readFileSync(join(result.output, 'latest.json')));
  const checked = f.module.verifyUpdateManifest(latest.phantom, (await f.dependencies.defaults()).trust);
  assert.equal(checked.digest, result.manifestDigest); assert.equal(latest.platforms['darwin-aarch64'].url, checked.manifest.app.url);
  assert.equal(fs.readFileSync(join(result.output, checked.manifest.cli.filename)).toString(), 'test-only original package');
  f.module.verifyMinisign(fs.readFileSync(join(result.output, checked.manifest.app.filename)), checked.manifest.app.signature, (await f.dependencies.defaults()).trust.publicKey);
});
test('existing dist requires live capability validation and never unchecked replacement', async t => {
  const f = await fixture(t); fs.mkdirSync(join(f.dir, 'dist'));
  await finalizeDesktopUpdate(f.input, f.dependencies);
  assert.equal(f.calls.includes('adopt'), false); assert.deepEqual(f.calls.slice(0, 3), ['verify', 'audit', 'validate']);
  f.dependencies.validate = () => {throw new Error('existing dist differs');}; f.calls.length = 0;
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies), /existing dist differs/);
  assert.equal(f.calls.includes('build'), false); assert.equal(f.calls.includes('sign'), false);
});
test('hosted manifest replacement after admission is refused before compiled imports or native build', async t => {
  const f = await fixture(t);
  f.dependencies.verify = () => {fs.writeFileSync(join(f.input.bundle, 'manifest.json'), JSON.stringify({producer: {repository: 'untrusted/other'}})); return f.receipt;};
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies));
  assert.equal(f.calls.includes('adopt'), false); assert.equal(f.calls.includes('build'), false); assert.equal(f.calls.includes('sign'), false);
  assert.deepEqual(fs.readdirSync(f.input.outputParent), []);
});
for (const guard of ['verify', 'audit', 'surface', 'archive', 'build']) test(`producer holds ${guard} failure without signatures/feed`, async t => {
  const f = await fixture(t), dependencies = {...f.dependencies};
  if (guard === 'surface' || guard === 'archive') dependencies.defaults = async () => ({...await f.dependencies.defaults(), [guard === 'archive' ? 'readArchive' : guard]: () => {throw new Error('controlled refusal');}});
  else dependencies[guard] = () => {throw new Error('controlled refusal');};
  await assert.rejects(finalizeDesktopUpdate(f.input, dependencies)); assert.equal(f.calls.includes('sign'), false);
  for (const directory of fs.readdirSync(f.input.outputParent)) assert.equal(fs.existsSync(join(f.input.outputParent, directory, 'latest.json')), false);
});
test('compiler result cannot substitute a different package or source after await', async t => {
  const f = await fixture(t); f.dependencies.build = async () => {fs.writeFileSync(join(f.input.bundle, 'ashlr-hub-3.25.1.tgz'), 'repacked'); return {bytes: Buffer.from('test app'), inventorySha256: '2'.repeat(64), signer: 'A'.repeat(40)};};
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies)); assert.equal(f.calls.includes('sign'), false);
});
test('final fresh proof refusal never exports latest even after signatures exist', async t => {
  const f = await fixture(t); let reads = 0; f.dependencies.verify = () => {if (++reads === 3) throw new Error('source changed'); return f.receipt;};
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies), /source changed/);
  assert.equal(f.calls.filter(call => call === 'sign').length, 3);
  const [directory] = fs.readdirSync(f.input.outputParent); assert.equal(fs.existsSync(join(f.input.outputParent, directory, 'latest.json')), false);
});
test('signing callback cannot mutate app bytes under an unchanged signed manifest', async t => {
  const f = await fixture(t), normal = f.dependencies.sign;
  f.dependencies.sign = (path, ...rest) => {const result = normal(path, ...rest); if (path.endsWith('manifest.json')) fs.writeFileSync(join(dirname(path), 'Phantom_3.25.1_aarch64.app.tar.gz'), 'replacement'); return result;};
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies), /Expected values to be strictly equal/);
  assert.equal(f.calls.filter(call => call === 'sign').length, 3);
});
for (const filename of ['Phantom_3.25.1_aarch64.app.tar.gz', 'ashlr-hub-3.25.1.tgz', 'manifest.json', 'manifest.json.sig']) test(`final Audit read cannot replace ${filename} before feed export`, async t => {
  const f = await fixture(t), audit = f.dependencies.audit; let count = 0;
  f.dependencies.audit = input => {
    const result = audit(input);
    if (++count === 3) {const [directory] = fs.readdirSync(f.input.outputParent); fs.writeFileSync(join(f.input.outputParent, directory, filename), 'replacement');}
    return result;
  };
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies));
  assert.equal(count, 3); assert.equal(f.calls.filter(call => call === 'sign').length, 3);
  const [directory] = fs.readdirSync(f.input.outputParent); assert.equal(fs.existsSync(join(f.input.outputParent, directory, 'latest.json')), false);
});
test('tool revalidation after native compilation refuses replacement before signing', async t => {
  const f = await fixture(t); let count = 0;
  f.dependencies.validateTools = () => {if (++count === 2) throw new Error('trusted tool bytes changed'); return null;};
  await assert.rejects(finalizeDesktopUpdate(f.input, f.dependencies), /trusted tool bytes changed/);
  assert.equal(f.calls.includes('build'), true); assert.equal(f.calls.includes('sign'), false);
});
test('GitHub API and attestation use the fixed executable with only normal profile environment', () => {
  const calls = [], root = '/private/test-source', gh = '/private/pinned/gh', home = userInfo().homedir;
  const transport = desktopPublisherGithub(root, {gh, home}, (bin, args, cwd, env) => {calls.push({bin, args, cwd, env}); return '{}';});
  assert.deepEqual(transport.read('repos/ashlrai/ashlr-hub'), {});
  assert.equal(transport.attestRun('gh', ['attestation', 'verify', '/private/subject']), '{}');
  assert.throws(() => transport.attestRun('/untrusted/gh', [])); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.bin, gh); assert.equal(call.cwd, root);
    assert.deepEqual(call.env, {HOME: home, GH_CONFIG_DIR: join(home, '.config/gh'), GH_HOST: 'github.com', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'});
  }
  assert.deepEqual(calls[0].args, ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', 'repos/ashlrai/ashlr-hub']);
  assert.deepEqual(calls[1].args, ['attestation', 'verify', '/private/subject']);
});
test('public CLI accepts only complete exact identity and has no tool/key/publication override', () => {
  const args = ['--revision', 'a'.repeat(40), '--bundle', '/private/bundle', '--run', '10', '--attempt', '1', '--attestor-sha', 'b'.repeat(40), '--attestor-run', '11', '--attestor-attempt', '1', '--audit-run', '12', '--audit-attempt', '1', '--output-parent', '/private/output'];
  assert.equal(parseFinalizeArguments(args).policy.runId, 10);
  for (const extra of ['--force', '--tool', '--private-key', '--receipt', '--publish']) assert.throws(() => parseFinalizeArguments([...args, extra, 'yes']));
  assert.throws(() => parseFinalizeArguments([...args, '--run', '10'])); assert.throws(() => parseFinalizeArguments(args.slice(2)));
});
test('publisher prepares both signed display keys and refuses either mismatched native version', () => {
  const app = '/private/test/Phantom.app', root = '/private/test-source', env = {PATH: '/usr/bin:/bin'};
  const values = {CFBundleName: 'Old name', CFBundleShortVersionString: '3.25.2', CFBundleVersion: '3.25.2'};
  const execute = (bin, args, cwd, actualEnv) => {
    assert.equal(bin, '/usr/bin/plutil'); assert.equal(cwd, root); assert.equal(actualEnv, env);
    assert.equal(args.at(-1), join(app, 'Contents/Info.plist'));
    if (args[0] === '-replace') {assert.deepEqual(args.slice(2, 4), ['-string', 'Phantom']); values[args[1]] = args[3]; return '';}
    assert.deepEqual(args.slice(2, 5), ['raw', '-o', '-']); return `${values[args[1]] ?? ''}\n`;
  };
  prepareDesktopAppIdentity(app, '3.25.2', root, env, execute);
  assert.equal(values.CFBundleName, 'Phantom'); assert.equal(values.CFBundleDisplayName, 'Phantom');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    values[key] = '3.25.1'; assert.throws(() => prepareDesktopAppIdentity(app, '3.25.2', root, env, execute)); values[key] = '3.25.2';
  }
});
test('real private app archive uses exact canonical paths, bytes and modes including long USTAR prefix', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phantom-app-pack-test-'))); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = join(root, 'Phantom.app'), nested = join(app, 'Contents', 'Resources', 'public', 'long-safe-directory'.repeat(4)); fs.mkdirSync(nested, {recursive: true});
  const file = join(nested, 'asset.js'); fs.writeFileSync(file, 'actual private fixture bytes', {mode: 0o644});
  const packed = packDesktopAppArchive(app), entries = inspectTar(gunzipSync(packed.bytes));
  assert.equal(entries[0].path, 'Phantom.app'); const member = entries.find(entry => entry.type === 'file');
  assert.equal(member.sha256, hash(Buffer.from('actual private fixture bytes'))); assert.equal(member.mode, 0o644);
  assert.deepEqual(packDesktopAppArchive(app), packed);
  fs.symlinkSync(file, join(nested, 'untrusted-link')); assert.throws(() => packDesktopAppArchive(app), /unsafe app/); fs.unlinkSync(join(nested, 'untrusted-link'));
  fs.linkSync(file, join(nested, 'hard-link')); assert.throws(() => packDesktopAppArchive(app), /unsafe release file/); fs.unlinkSync(join(nested, 'hard-link'));
  fs.chmodSync(file, 0o666); assert.throws(() => packDesktopAppArchive(app), /unsafe app/);
});
test('independent Audit observes actual source/run/runner/all required steps', t => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'phantom-update-audit-test-'))); t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(join(root, '.github/workflows'), {recursive: true}); const raw = fs.readFileSync(new URL('../workflows/dependency-audit.yml', import.meta.url)); fs.writeFileSync(join(root, '.github/workflows/dependency-audit.yml'), raw);
  const revision = 'a'.repeat(40), runId = 20, runAttempt = 1;
  const names = raw.toString().matchAll(/ {6}- name: (.*)/g); const steps = [...names].map(m => ({name: m[1], status: 'completed', conclusion: 'success'}));
  const run = {id: runId, run_attempt: 1, head_sha: revision, repository: {full_name: repository.fullName, id: repository.repositoryId, node_id: repository.repositoryNodeId, owner: {id: repository.ownerId, login: repository.ownerLogin}}, path: '.github/workflows/dependency-audit.yml', status: 'completed', conclusion: 'success', event: 'pull_request'};
  const job = {run_id: runId, head_sha: revision, name: 'Dependency audit (root + Raycast)', labels: ['ubuntu-latest'], status: 'completed', conclusion: 'success', steps};
  const read = endpoint => endpoint.endsWith('/jobs?per_page=100&page=1') ? {total_count: 1, jobs: [job]} : endpoint.endsWith('/attempts/1') ? run : metadata;
  const input = {root, repository: repository.fullName, revision, runId, runAttempt, read}; assert.deepEqual(verifyUpdateAudit(input), {revision, runId, runAttempt});
  for (const [object, key, value] of [[run, 'head_sha', 'b'.repeat(40)], [run, 'path', '.github/workflows/other.yml'], [job, 'labels', ['self-hosted']], [job.steps.at(-1), 'conclusion', 'skipped']]) {
    const before = object[key]; object[key] = value; assert.throws(() => verifyUpdateAudit(input)); object[key] = before;
  }
});

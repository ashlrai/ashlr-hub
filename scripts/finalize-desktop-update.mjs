#!/usr/bin/env node
// Trusted local producer only. This never publishes, installs, reauthorizes,
// clears Stop, or accepts a saved native/CI PASS receipt as admission.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { verifyArtifact, adoptArtifact, validateAdoptedArtifact, sourceBinding, inspectTar } from './hosted-build-artifact.mjs';
import { inspectLocalApp } from './local-app-transaction.mjs';
import { codesignArgv } from './ship-local.mjs';
import { requireRepositoryMetadata, requireRepositoryReference } from '../.github/scripts/github-repository-binding.mjs';
import { getDesktopReleaseToolchain, DESKTOP_RELEASE_TOOL_PINS } from './desktop-release-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(k => a[k] === b[k]);
function bytes(path, max = 512 * 1024 * 1024) {
  assert.equal(fs.realpathSync(path), resolve(path), 'noncanonical release path');
  const before = fs.lstatSync(path); assert.ok(before.isFile() && before.nlink === 1 && before.size <= max, 'unsafe release file');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { assert.ok(same(before, fs.fstatSync(fd))); const data = fs.readFileSync(fd); assert.ok(same(before, fs.fstatSync(fd)) && same(before, fs.lstatSync(path)) && data.length === before.size, 'release file changed'); return data; }
  finally { fs.closeSync(fd); }
}
function ownerDirectory(path) {
  assert.equal(fs.realpathSync(path), resolve(path)); const st = fs.lstatSync(path);
  assert.ok(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0, 'private release directory required'); return st;
}
function run(bin, argv, cwd, env, timeout = 120_000) {
  try { return execFileSync(bin, argv, {cwd, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}); }
  catch { throw new Error('Desktop update finalization held: trusted tool failed'); }
}
const githubEnvironment = home => ({HOME: home, GH_CONFIG_DIR: join(home, '.config/gh'), GH_HOST: 'github.com', PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'});
// The executable/runner seam is for hermetic transport tests, never CLI arguments.
export function desktopPublisherGithub(root, tools = getDesktopReleaseToolchain(), execute = run) {
  const env = githubEnvironment(tools.home);
  return {
    read: endpoint => JSON.parse(execute(tools.gh, ['api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', endpoint], root, env)),
    attestRun: (bin, args) => {assert.equal(bin, 'gh'); return execute(tools.gh, args, root, env);},
  };
}
const AUDIT_STEPS = ['Verify root dependency graph installs', 'Verify Raycast dependency graph installs', 'Audit root dependencies', 'Audit root production dependencies', 'Audit Raycast dependencies', 'Audit Raycast production dependencies', 'Audit desktop Cargo dependencies'];
/** The hosted archive verifier covers CI; this independent workflow is an additional gate. */
export function verifyUpdateAudit({root, repository, revision, runId, runAttempt, read}) {
  read ??= desktopPublisherGithub(root).read;
  assert.ok(Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0);
  const workflow = bytes(join(root, '.github/workflows/dependency-audit.yml'), 128 * 1024).toString('utf8');
  for (const name of AUDIT_STEPS) assert.ok(workflow.includes(`name: ${name}\n`), 'Audit source policy changed');
  const base = `repos/${repository}`; requireRepositoryMetadata(repository, read(base));
  const observed = read(`${base}/actions/runs/${runId}/attempts/${runAttempt}`);
  requireRepositoryReference(repository, observed.repository);
  assert.equal(observed.id, runId); assert.equal(observed.run_attempt, runAttempt); assert.equal(observed.head_sha, revision);
  assert.equal(observed.path, '.github/workflows/dependency-audit.yml'); assert.equal(observed.status, 'completed'); assert.equal(observed.conclusion, 'success');
  assert.ok(['push', 'pull_request', 'workflow_dispatch'].includes(observed.event), 'unexpected Audit event');
  const response = read(`${base}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100&page=1`);
  assert.equal(response.total_count, 1); assert.equal(response.jobs?.length, 1);
  const job = response.jobs[0]; assert.equal(job.run_id, runId); assert.equal(job.head_sha, revision);
  assert.equal(job.name, 'Dependency audit (root + Raycast)'); assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.ok(job.labels?.includes('ubuntu-latest') && !job.labels.includes('self-hosted'), 'unexpected Audit runner');
  for (const name of AUDIT_STEPS) { const steps = job.steps.filter(step => step.name === name); assert.equal(steps.length, 1); assert.equal(steps[0].status, 'completed'); assert.equal(steps[0].conclusion, 'success'); }
  return {revision, runId, runAttempt};
}
function inventory(root) {
  const entries = [], hash = createHash('sha256'); let total = 0;
  function visit(path, depth) {
    assert.ok(depth <= 48 && entries.length < 100_000); const before = fs.lstatSync(path);
    assert.ok(!before.isSymbolicLink() && (before.isFile() || before.isDirectory()) && (before.mode & 0o7022) === 0, 'unsafe app entry');
    const name = relative(root, path).split(sep).join('/'), type = before.isDirectory() ? 'directory' : 'file';
    hash.update(JSON.stringify([name, before.mode & 0o777, type]));
    let data; if (type === 'file') { data = bytes(path); total += data.length; assert.ok(total <= 512 * 1024 * 1024); hash.update(data); }
    entries.push({path: name ? `Phantom.app/${name}` : 'Phantom.app', type, mode: before.mode & 0o777, ...(data ? {bytes: data.length, sha256: digest(data), data} : {})});
    if (type === 'directory') for (const name of fs.readdirSync(path).sort()) visit(join(path, name), depth + 1);
    assert.ok(same(before, fs.lstatSync(path)), 'app changed during inventory');
  }
  visit(root, 0); return {sha256: hash.digest('hex'), entries};
}
export function packDesktopAppArchive(app) {
  const captured = inventory(app), blocks = [];
  for (const e of captured.entries) {
    const h = Buffer.alloc(512); let name = e.path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const at = [...e.path.matchAll(/\//g)].map(m => m.index).reverse().find(i => Buffer.byteLength(e.path.slice(0, i)) <= 155 && Buffer.byteLength(e.path.slice(i + 1)) <= 100);
      assert.ok(at !== undefined, 'app archive path exceeds canonical header'); prefix = e.path.slice(0, at); name = e.path.slice(at + 1);
    }
    h.write(name); h.write(prefix, 345); h.write(`${e.mode.toString(8).padStart(7, '0')}\0`, 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${(e.bytes ?? 0).toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h[156] = e.type === 'file' ? 48 : 53;
    h.write('ustar\0', 257); h.write('00', 263); h.write(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h); if (e.data) blocks.push(e.data, Buffer.alloc((512 - e.data.length % 512) % 512));
  }
  const raw = Buffer.concat([...blocks, Buffer.alloc(1024)]);
  inspectTar(raw, captured.entries.map(entry => ({path: entry.path, type: entry.type, mode: entry.mode, ...(entry.type === 'file' ? {bytes: entry.bytes, sha256: entry.sha256} : {})})));
  assert.equal(inventory(app).sha256, captured.sha256); return {bytes: gzipSync(raw), inventorySha256: captured.sha256};
}
async function defaults(root) {
  const manifest = await import(pathToFileURL(join(root, 'dist/core/desktop/update-manifest.js')).href);
  const trust = await import(pathToFileURL(join(root, 'dist/core/desktop/update-trust.js')).href);
  const surface = await import(pathToFileURL(join(root, 'dist/core/authority/surface.js')).href);
  const archive = await import(pathToFileURL(join(root, 'dist/core/local-runtime/archive.js')).href);
  const {canonicalJson} = await import(pathToFileURL(join(root, 'dist/core/authority/canonical-json.js')).href);
  // Source-owned host policy; neither the public CLI nor candidate JSON selects executables/keys.
  const configured = getDesktopReleaseToolchain();
  const toolchain = {...configured, cargoHome: join(configured.root, 'cargo-home'), rustupHome: join(configured.root, 'rustup'), rustupToolchain: '1.97.1-aarch64-apple-darwin'};
  for (const [name, pin] of Object.entries(DESKTOP_RELEASE_TOOL_PINS)) toolchain[name] = {path: configured[name], sha256: pin.sha256, version: pin.version};
  return {...manifest, canonicalJson, trust: trust.getDesktopUpdateTrust(), surface: surface.verifyAuthoritySurfaceAt, readArchive: archive.readPinnedRuntimeArchive, toolchain};
}
function validateTools(tools, root) {
  assert.equal(process.platform, 'darwin'); assert.equal(process.arch, 'arm64');
  for (const name of ['node', 'npm', 'bun', 'cargo', 'rustc', 'tauri', 'gh']) {
    const tool = tools[name]; assert.ok(tool && typeof tool.path === 'string' && typeof tool.version === 'string' && /^[a-f0-9]{64}$/.test(tool.sha256));
    assert.equal(fs.realpathSync(tool.path), resolve(tool.path)); assert.ok(relative(root, tool.path).startsWith(`..${sep}`), 'compiler must be outside source checkout');
    const st = fs.lstatSync(tool.path); assert.ok(st.uid === 0 || st.uid === process.getuid()); assert.equal(st.mode & 0o022, 0);
    assert.equal(digest(bytes(tool.path)), tool.sha256, 'trusted tool bytes changed');
  }
  assert.equal(tools.node.path, fs.realpathSync(process.execPath), 'run finalizer with the pinned Node executable');
  const plain = {PATH: '/usr/bin:/bin', HOME: tools.home, LANG: 'C', LC_ALL: 'C'};
  for (const name of ['node', 'bun', 'cargo', 'rustc', 'tauri', 'gh']) {
    const actual = run(tools[name].path, ['--version'], root, plain).trim();
    assert.equal(name === 'gh' ? actual.split('\n')[0].match(/^gh version ([^ ]+)/)?.[1] : actual, tools[name].version);
  }
  assert.equal(run(tools.node.path, [tools.npm.path, '--version'], root, plain).trim(), tools.npm.version);
  assert.match(tools.tauri.version, /^tauri-cli 2\.11\.4$/);
  const key = fs.lstatSync(tools.signingKeyPath); assert.ok(key.isFile() && key.nlink === 1 && key.uid === process.getuid() && (key.mode & 0o777) === 0o600);
  assert.equal(fs.realpathSync(tools.signingKeyPath), resolve(tools.signingKeyPath)); ownerDirectory(dirname(tools.signingKeyPath));
  assert.ok(relative(root, tools.signingKeyPath).startsWith(`..${sep}`), 'publishing key must be outside checkout');
  assert.match(tools.appleSigner, /^[A-F0-9]{40}$/); return key;
}
/** Complete the same signed display/version identity the installed consumer requires. */
export function prepareDesktopAppIdentity(app, version, root, env, execute = run) {
  const plist = join(app, 'Contents/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    execute('/usr/bin/plutil', ['-replace', key, '-string', 'Phantom', plist], root, env);
    assert.equal(execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], root, env).trim(), 'Phantom');
  }
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) assert.equal(execute('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist], root, env).trim(), version);
}
/** Preserve the qualified local signer and Bun JIT policy, including the existing entitlements. */
export function desktopNativeBundleConfiguration(signer) {
  assert.match(signer, /^[A-F0-9]{40}$/);
  return {bundle: {createUpdaterArtifacts: false, macOS: {signingIdentity: signer, hardenedRuntime: false}}};
}
/** Restore only the fixed freshly built SEA before re-signing the private bundle. */
export function restoreFreshDesktopSidecar(root, afterOpen = () => {}) {
  const source = join(root, 'dist-bin/ashlr');
  const destination = join(root, 'desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Phantom.app/Contents/MacOS/ashlr');
  const ownedExecutable = stat => stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o022) === 0 && (stat.mode & 0o111) !== 0;
  const original = fs.lstatSync(source); assert.ok(ownedExecutable(original), 'fresh SEA is not an owned executable');
  const fresh = bytes(source); assert.ok(fresh.length > 0 && same(original, fs.lstatSync(source)), 'fresh SEA changed');
  const parentPath = dirname(destination);
  assert.equal(fs.realpathSync(parentPath), parentPath, 'private sidecar parent is not canonical');
  const parent = fs.lstatSync(parentPath); assert.ok(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o022) === 0, 'private sidecar parent is unsafe');
  const named = fs.lstatSync(destination); assert.ok(ownedExecutable(named), 'private sidecar is not an owned executable');
  const fd = fs.openSync(destination, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    assert.ok(same(named, fs.fstatSync(fd)), 'private sidecar changed');
    // Hermetic race hook only; the fixed producer call never supplies one.
    afterOpen();
    assert.ok(same(named, fs.fstatSync(fd)) && same(named, fs.lstatSync(destination)) && same(parent, fs.lstatSync(parentPath)), 'private sidecar changed before copy');
    assert.ok(same(original, fs.lstatSync(source)), 'fresh SEA changed before copy');
    fs.ftruncateSync(fd, 0);
    let at = 0;
    while (at < fresh.length) { const written = fs.writeSync(fd, fresh, at, fresh.length - at, at); assert.ok(written > 0); at += written; }
    fs.fchmodSync(fd, original.mode & 0o777); fs.fsyncSync(fd);
    const copied = fs.fstatSync(fd);
    assert.ok(ownedExecutable(copied) && copied.dev === named.dev && copied.ino === named.ino && same(copied, fs.lstatSync(destination)), 'private sidecar changed during copy');
    assert.equal(copied.mode & 0o777, original.mode & 0o777);
    assert.ok(fs.readFileSync(fd).equals(fresh) && bytes(source).equals(fresh) && same(original, fs.lstatSync(source)), 'fresh SEA copy differs');
    assert.ok(same(copied, fs.fstatSync(fd)) && same(copied, fs.lstatSync(destination)) && same(parent, fs.lstatSync(parentPath)), 'private sidecar changed after copy');
  } finally { fs.closeSync(fd); }
}
export function signAndAcceptDesktopSea({app, version, root, output, signer, env}, execute = run) {
  const entitlements = join(root, 'desktop/src-tauri/Entitlements.plist');
  const entitlementDigest = digest(bytes(entitlements));
  // The supported local transaction signs without hardened runtime; adding it
  // here would break the bundled Bun SEA despite otherwise valid signatures.
  execute('/usr/bin/codesign', codesignArgv(signer, entitlements, app).slice(1), root, env);
  execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], root, env);
  const sidecar = join(app, 'Contents/MacOS/ashlr');
  const signedDigest = digest(bytes(sidecar));
  const sterile = fs.mkdtempSync(join(output, 'sea-acceptance-'));
  const temp = join(sterile, 'tmp');
  const closed = {HOME: sterile, TMPDIR: temp, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1'};
  try {
    fs.chmodSync(sterile, 0o700); fs.mkdirSync(temp, {mode: 0o700});
    const help = execute(sidecar, ['--help'], sterile, closed, 10_000);
    assert.ok(help.includes('Phantom') && /\bphm\b/u.test(help), 'signed SEA help is unavailable');
    assert.equal(execute(sidecar, ['--version'], sterile, closed, 10_000).trim(), version, 'signed SEA version differs');
    assert.equal(digest(bytes(sidecar)), signedDigest, 'signed SEA changed during acceptance');
    assert.equal(digest(bytes(entitlements)), entitlementDigest, 'app entitlements changed');
  } finally { fs.rmSync(sterile, {recursive: true, force: true}); }
}
async function buildNative({root, bundle, policy, source, version, surfaceDigest, packageSha256, output, tools}) {
  const bin = join(output, 'tools'); fs.mkdirSync(bin, {mode: 0o700});
  for (const name of ['node', 'bun', 'cargo', 'rustc', 'gh']) fs.symlinkSync(tools[name].path, join(bin, name));
  // npm's shebang is resolved through the pinned node in this exclusive bin directory.
  fs.symlinkSync(tools.npm.path, join(bin, 'npm'));
  const env = {PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: tools.home, GH_CONFIG_DIR: join(tools.home, '.config/gh'), GH_HOST: 'github.com', LANG: 'C', LC_ALL: 'C', ASHLR_BUN_PATH: tools.bun.path,
    CARGO_HOME: tools.cargoHome, RUSTUP_HOME: tools.rustupHome, RUSTUP_TOOLCHAIN: tools.rustupToolchain};
  const hosted = ['--hosted-bundle', bundle, '--run', String(policy.runId), '--attempt', String(policy.runAttempt), '--attestor-sha', policy.attestorSha, '--attestor-run', String(policy.attestorRun), '--attestor-attempt', String(policy.attestorAttempt)];
  run(tools.node.path, ['scripts/build-sea.mjs', ...hosted], root, env, 20 * 60_000);
  run(tools.node.path, ['desktop/scripts/prepare-sidecar.mjs'], root, env);
  run(tools.tauri.path, ['icon', 'src-tauri/icons/icon.svg'], join(root, 'desktop'), env);
  // The private publishing key is absent from every compiler/build-script environment.
  run(tools.tauri.path, ['build', '--bundles', 'app', '--ci', '--target', 'aarch64-apple-darwin', '--config', JSON.stringify(desktopNativeBundleConfiguration(tools.appleSigner))], join(root, 'desktop'), env, 30 * 60_000);
  const app = join(root, 'desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Phantom.app');
  // Tauri's legitimate signature changes Mach-O bytes. Replace only this fixed
  // private sidecar with the fresh SEA, then sign and smoke-test the whole app.
  restoreFreshDesktopSidecar(root);
  const publicApp = inventory(join(app, 'Contents/Resources/public')), publicBuild = inventory(join(root, 'dist-bin/public'));
  assert.equal(publicApp.sha256, publicBuild.sha256, 'app public assets differ from fresh source');
  prepareDesktopAppIdentity(app, version, root, env);
  const marker = {schemaVersion: 1, version, source: {revision: source.revision, tree: source.tree}, authoritySurfaceDigest: surfaceDigest, packageSha256};
  const {canonicalJson} = await import(pathToFileURL(join(root, 'dist/core/authority/canonical-json.js')).href);
  fs.writeFileSync(join(app, 'Contents/Resources/phantom-release.json'), canonicalJson(marker), {flag: 'wx', mode: 0o644});
  signAndAcceptDesktopSea({app, version, root, output, signer: tools.appleSigner, env});
  const io = {lstat: path => {const st = fs.lstatSync(path); return {isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), dev: st.dev, ino: st.ino};}, appInventory: path => inventory(path).sha256, exec: (bin, argv) => {try {return {status: 0, stdout: run(bin, argv, root, env)};} catch {return {status: 1, stdout: ''};}}};
  inspectLocalApp(app, tools.appleSigner, io);
  for (const [key, expected] of [['CFBundleName', 'Phantom'], ['CFBundleDisplayName', 'Phantom'], ['CFBundleShortVersionString', version], ['CFBundleVersion', version]]) assert.equal(run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents/Info.plist')], root, env).trim(), expected);
  return {...packDesktopAppArchive(app), signer: tools.appleSigner};
}
function signFile(path, tools, verify, publicKey) {
  run(tools.tauri.path, ['signer', 'sign', path], dirname(path), {PATH: '/usr/bin:/bin', HOME: tools.home, LANG: 'C', LC_ALL: 'C', TAURI_SIGNING_PRIVATE_KEY_PATH: tools.signingKeyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ''});
  const signature = bytes(`${path}.sig`, 8192).toString('utf8'); verify(bytes(path), signature, publicKey); return signature;
}
/** Programmatic seams are hermetic tests only; the CLI never imports saved proof or custom callbacks. */
export async function finalizeDesktopUpdate(input, dependencies = {}) {
  const root = input.root ?? ROOT;
  const hooks = {verify: verifyArtifact, adopt: adoptArtifact, validate: validateAdoptedArtifact, source: sourceBinding, audit: verifyUpdateAudit, validateTools, build: buildNative, sign: signFile, ...dependencies};
  const source = hooks.source(root, input.revision);
  if (!hooks.read) Object.assign(hooks, desktopPublisherGithub(root));
  const verifyInput = {root, revision: input.revision, bundle: input.bundle, policy: input.policy, githubRead: hooks.read, ...(hooks.attestRun ? {attestRun: hooks.attestRun} : {})};
  const observed = hooks.verify(verifyInput);
  const hostedBytes = bytes(join(input.bundle, 'manifest.json'), 32 * 1024 * 1024);
  assert.equal(digest(hostedBytes), observed.manifestSha256);
  const hosted = JSON.parse(hostedBytes);
  const auditInput = {root, repository: hosted.producer.repository, revision: input.revision, ...input.audit, read: hooks.read};
  const audit = hooks.audit(auditInput);
  // Import executable compiled helpers only after the fresh signed archive was admitted.
  if (fs.existsSync(join(root, 'dist'))) hooks.validate(observed);
  else hooks.adopt(observed);
  const d = {...await (dependencies.defaults ?? defaults)(root), ...hooks}; const trust = d.trust;
  assert.equal(hosted.producer.repository, trust.repository.fullName); assert.equal(hosted.package.sha256, observed.packageSha256);
  assert.equal(hosted.source.tree, source.tree); assert.equal(hosted.buildIdentity.revision, input.revision); assert.equal(hosted.buildIdentity.dirty, false);
  const version = hosted.buildIdentity.packageVersion; const keyBefore = d.validateTools(d.toolchain, root);
  ownerDirectory(input.outputParent); const output = fs.mkdtempSync(join(input.outputParent, 'phantom-paired-release-'));
  // Nothing externally discovers this private directory until all final checks succeed.
  const surface = d.surface(root, 'running', {fresh: true}); assert.equal(surface.ok, true, 'candidate surface is not verified');
  await d.readArchive({artifactPath: join(input.bundle, hosted.package.filename), sha256: observed.packageSha256, revision: input.revision, version});
  const native = await d.build({root, bundle: input.bundle, policy: input.policy, source, version, surfaceDigest: surface.digest, packageSha256: observed.packageSha256, output, tools: d.toolchain});
  const appName = `Phantom_${version}_aarch64.app.tar.gz`, cliName = `ashlr-hub-${version}.tgz`;
  assert.equal(hosted.package.filename, cliName);
  fs.writeFileSync(join(output, appName), native.bytes, {flag: 'wx', mode: 0o600});
  const cliBytes = bytes(join(input.bundle, cliName), 128 * 1024 * 1024); assert.equal(digest(cliBytes), observed.packageSha256);
  fs.writeFileSync(join(output, cliName), cliBytes, {flag: 'wx', mode: 0o600});
  const fresh = d.verify(verifyInput); d.validate(fresh);
  assert.deepEqual(fresh, observed); assert.deepEqual(d.audit(auditInput), audit); assert.deepEqual(d.source(root, input.revision), source);
  const keyAfterBuild = d.validateTools(d.toolchain, root);
  if (keyBefore) assert.ok(same(keyBefore, keyAfterBuild), 'publishing key changed before signing');
  const appSignature = d.sign(join(output, appName), d.toolchain, d.verifyMinisign, trust.publicKey);
  const cliSignature = d.sign(join(output, cliName), d.toolchain, d.verifyMinisign, trust.publicKey);
  const url = name => `https://github.com/${trust.repository.fullName}/releases/download/v${version}/${name}`;
  const manifest = {schemaVersion: 1, kind: 'phantom-paired-release', channel: trust.channel, platform: trust.platform, version,
    repository: requireRepositoryMetadata(trust.repository.fullName, d.read(`repos/${trust.repository.fullName}`)), source: {revision: source.revision, tree: source.tree}, authoritySurfaceDigest: surface.digest,
    app: {filename: appName, url: url(appName), bytes: native.bytes.length, sha256: digest(native.bytes), signature: appSignature, bundleIdentifier: 'ai.ashlr.desktop', executable: 'ashlr-desktop', inventorySha256: native.inventorySha256, signer: native.signer},
    cli: {filename: cliName, url: url(cliName), bytes: cliBytes.length, sha256: observed.packageSha256, signature: cliSignature, packageName: '@ashlr/hub', binName: 'ashlr'},
    qualification: {manifestSha256: observed.manifestSha256, archiveSha256: observed.archiveSha256, packageSha256: observed.packageSha256, qualificationSha256: observed.qualificationSha256,
      producer: {runId: observed.official.runId, runAttempt: observed.official.runAttempt, eventSha: observed.official.eventSha}, attestor: observed.attestor, audit}};
  const manifestText = d.canonicalJson(manifest); d.parseUpdateManifest(manifestText, trust);
  const manifestPath = join(output, 'manifest.json'); fs.writeFileSync(manifestPath, manifestText, {flag: 'wx', mode: 0o600});
  const signature = d.sign(manifestPath, d.toolchain, d.verifyMinisign, trust.publicKey);
  const checked = d.verifyUpdateManifest({manifestText, signature}, trust);
  // Signing subprocesses cannot replace any bytes/policy between proof and the exported feed.
  assert.deepEqual(d.verify(verifyInput), observed); assert.deepEqual(d.audit(auditInput), audit); assert.deepEqual(d.source(root, input.revision), source);
  const finalApp = bytes(join(output, appName)), finalCli = bytes(join(output, cliName));
  assert.equal(digest(finalApp), manifest.app.sha256); assert.equal(digest(finalCli), manifest.cli.sha256);
  assert.equal(bytes(manifestPath).toString(), manifestText);
  for (const [path, value] of [[join(output, appName), appSignature], [join(output, cliName), cliSignature], [manifestPath, signature]]) assert.equal(bytes(`${path}.sig`, 8192).toString(), value, 'signature changed after verification');
  d.verifyMinisign(finalApp, appSignature, trust.publicKey); d.verifyMinisign(finalCli, cliSignature, trust.publicKey); d.verifyMinisign(Buffer.from(manifestText), signature, trust.publicKey);
  const keyFinal = d.validateTools(d.toolchain, root);
  if (keyBefore) assert.ok(same(keyBefore, keyFinal), 'publishing key changed');
  const latest = {version, platforms: {'darwin-aarch64': {url: manifest.app.url, signature: appSignature}}, phantom: {manifestText, signature}};
  fs.writeFileSync(join(output, 'latest.json'), d.canonicalJson(latest), {flag: 'wx', mode: 0o600});
  return {output, version, revision: source.revision, tree: source.tree, manifestDigest: checked.digest, published: false};
}
export function parseFinalizeArguments(args) {
  const allowed = ['--revision', '--bundle', '--run', '--attempt', '--attestor-sha', '--attestor-run', '--attestor-attempt', '--audit-run', '--audit-attempt', '--output-parent'];
  const flags = {};
  for (let i = 0; i < args.length; i += 2) { assert.ok(allowed.includes(args[i]) && typeof args[i + 1] === 'string' && !Object.hasOwn(flags, args[i])); flags[args[i]] = args[i + 1]; }
  assert.equal(Object.keys(flags).length, allowed.length); assert.match(flags['--revision'], /^[a-f0-9]{40}$/); assert.match(flags['--attestor-sha'], /^[a-f0-9]{40}$/);
  for (const key of ['--run', '--attempt', '--attestor-run', '--attestor-attempt', '--audit-run', '--audit-attempt']) assert.ok(/^[1-9]\d*$/.test(flags[key]) && Number.isSafeInteger(Number(flags[key])));
  for (const key of ['--bundle', '--output-parent']) assert.equal(resolve(flags[key]), flags[key]);
  return {revision: flags['--revision'], bundle: flags['--bundle'], outputParent: flags['--output-parent'], policy: {runId: Number(flags['--run']), runAttempt: Number(flags['--attempt']), attestorSha: flags['--attestor-sha'], attestorRun: Number(flags['--attestor-run']), attestorAttempt: Number(flags['--attestor-attempt'])}, audit: {runId: Number(flags['--audit-run']), runAttempt: Number(flags['--audit-attempt'])}};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await finalizeDesktopUpdate(parseFinalizeArguments(process.argv.slice(2))))); }
  catch { console.error('Desktop update finalization held; no feed was published. Inspect qualified source and private evidence.'); process.exitCode = 1; }
}

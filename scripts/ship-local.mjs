#!/usr/bin/env node
/**
 * Build and install a local Phantom release. All installation effects are injected.
 * Native maintenance requires an existing stable signer, prior Stop/drain and closed app.
 * It stages a full signed bundle, verifies rollback bytes, and coordinates Phantom.app,
 * the current CLI release and missing phm/ashlr links before owned launch acceptance.
 * It never stops work, creates a signer, resumes authority or restarts the resident.
 * Published legacy Ashlr.app and technical signing/data identities remain compatible.
 * --dry-run prints only; --native updates the prebuilt native executable/version;
 * --allow-dirty keeps local dirty output distinct from a committed release.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PHANTOM_APP_PATH, inspectLocalApp, selectLocalApp, requireLocalQuiescence, installLocalApp, launchedAppIsOwned, exclusiveRenameAvailable, renamePathExclusive, inspectCurrentPointer, switchLocalCurrentPointer, inspectLocalAliases, createLocalAliases, removeCreatedAliases } from './local-app-transaction.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const APP_PATH = PHANTOM_APP_PATH;
export const APP_BUNDLE_BUILD = 'desktop/src-tauri/target/release/bundle/macos/Phantom.app';
export const VERSE_URL = 'http://127.0.0.1:7777/verse/';
export const LAUNCH_AGENTS = Object.freeze(['ai.ashlr.anthropic-proxy', 'ai.ashlr.serve']);
export const KEEP_BACKUPS = 3;
export const NATIVE_BUILD = 'desktop/src-tauri/target/release/ashlr-desktop';
/** The Dock/Finder icon, generated from icons/icon.svg by `cargo tauri icon`. */
export const APP_ICON_BUILD = 'desktop/src-tauri/icons/icon.icns';

/**
 * Code signing. macOS keys the microphone grant (TCC) to the app's signature: an
 * ad-hoc signature (`--sign -`) changes with every build, so every ship:local made
 * macOS forget that Ashlr may use the mic. A self-signed identity that never changes
 * keeps the grant. It lives in the login keychain, is created (and trusted for code
 * signing — macOS asks for the login password once) by ensureSigningIdentity, and is
 * only ever used to sign this app on this Mac.
 */
export const SIGNING_IDENTITY = 'Ashlr Local';
export const ENTITLEMENTS = 'desktop/src-tauri/Entitlements.plist';
/** Must match desktop/src-tauri/Info.plist (a Rust test pins that file's copy). */
export const MIC_USAGE = 'Phantom transcribes your voice on this Mac when you hold the dictation key.';
/** The native WebView loads the loopback Verse server over HTTP. Keep ATS scoped to local traffic. */
export const LOCAL_NETWORK_ATS = JSON.stringify({ NSAllowsLocalNetworking: true });

/** The app-bundle files ship:local replaces, each backed up as <path>.prev-<short sha>. */
export const BUNDLE_TARGETS = Object.freeze({
  sidecar: { dir: 'Contents/MacOS', name: 'ashlr', source: 'dist-bin/ashlr' },
  public: { dir: 'Contents/Resources', name: 'public', source: 'dist-bin/public' },
  native: { dir: 'Contents/MacOS', name: 'ashlr-desktop', source: NATIVE_BUILD },
  icon: { dir: 'Contents/Resources', name: 'icon.icns', source: APP_ICON_BUILD },
});

const USAGE = 'usage: node scripts/ship-local.mjs [--dry-run] [--native] [--allow-dirty]';

export class Refusal extends Error {}

export function parseArgs(argv) {
  const out = { dryRun: false, native: false, allowDirty: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--native') out.native = true;
    else if (arg === '--allow-dirty') out.allowDirty = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Refusal(`unknown argument ${arg}\n${USAGE}`);
  }
  return out;
}

/** `20260925-031502` — sortable, filename-safe, local time. */
export function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Pure: the name the current file is moved aside to. `<name>.prev-<short>`, or with a time
 * suffix when that name is taken (shipping the same commit twice never overwrites a backup).
 */
export function backupName(name, shortSha, takenNames, now) {
  const plain = `${name}.prev-${shortSha}`;
  return takenNames.includes(plain) ? `${plain}-${stamp(now)}` : plain;
}

/**
 * Pure: which existing backups of `name` to move to the trash so that only `keep` remain,
 * counting the one about to be created when `creating` is true. `existing` is every entry
 * in the directory as `{ name, mtimeMs }`; entries that are not `<name>.prev-*` are ignored.
 * Newest first by mtime (a backup's mtime is when it was installed, which is what "newest"
 * should mean; the short sha in the name carries no order).
 */
export function rotateBackups(name, existing, { creating, keep = KEEP_BACKUPS }) {
  const prefix = `${name}.prev-`;
  const backups = existing
    .filter((entry) => entry.name.startsWith(prefix))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const survivors = Math.max(0, creating ? keep - 1 : keep);
  return { keep: backups.slice(0, survivors).map((e) => e.name), trash: backups.slice(survivors).map((e) => e.name) };
}

/**
 * Read-only facts about the machine and the repo. `io` supplies exec (returns
 * `{ status, stdout }`), exists, list (dir → [{ name, mtimeMs }]), mtime (path → ms | null).
 */
export function gatherContext(args, io) {
  const status = io.exec('git', ['status', '--porcelain'], { cwd: io.repoRoot });
  const sha = io.exec('git', ['rev-parse', 'HEAD'], { cwd: io.repoRoot }).stdout.trim();
  const pkg = JSON.parse(io.readFile(join(io.repoRoot, 'package.json')));
  const signing = args.native || io.exists(APP_PATH) || io.exists('/Applications/Ashlr.app') ? findSigningIdentity(io) : null;
  const selectedApp = selectLocalApp(signing?.valid ? signing.hash : null, io);
  const appExists = selectedApp !== null;
  const installedAppPath = selectedApp?.path ?? APP_PATH;
  const sourceApp = !appExists && args.native ? inspectPrebuiltApp(io, signing, pkg.version) : null;
  const installedPlistVersion = (key) => {
    if (!appExists || !args.native) return null;
    const result = io.exec('plutil', ['-extract', key, 'raw', '-o', '-', join(installedAppPath, 'Contents', 'Info.plist')]);
    return result.status === 0 ? result.stdout.trim() || null : null;
  };
  const listing = {};
  if (appExists) {
    for (const dir of new Set(Object.values(BUNDLE_TARGETS).map((t) => t.dir))) listing[dir] = io.list(join(installedAppPath, dir));
  }
  const loadedAgents = LAUNCH_AGENTS.filter(
    (label) => io.exec('launchctl', ['print', `gui/${io.uid}/${label}`]).status === 0,
  );
  return {
    platform: io.platform,
    home: io.home,
    tmp: io.tmp,
    uid: io.uid,
    now: io.now,
    repoRoot: io.repoRoot,
    sha,
    version: pkg.version,
    packageName: pkg.name,
    dirty: status.status !== 0 || status.stdout.trim().length > 0,
    appExists,
    selectedApp,
    sourceApp,
    listing,
    signing,
    loadedAgents,
    nativeBuildMtime: io.mtime(join(io.repoRoot, NATIVE_BUILD)),
    installedNativeMtime: appExists ? io.mtime(join(installedAppPath, BUNDLE_TARGETS.native.dir, BUNDLE_TARGETS.native.name)) : null,
    installedNativeShortVersion: installedPlistVersion('CFBundleShortVersionString'),
    installedNativeBundleVersion: installedPlistVersion('CFBundleVersion'),
    iconBuildMtime: io.mtime(join(io.repoRoot, APP_ICON_BUILD)),
    installedIconMtime: appExists ? io.mtime(join(installedAppPath, BUNDLE_TARGETS.icon.dir, BUNDLE_TARGETS.icon.name)) : null,
    ...args,
  };
}

/**
 * Pure: `security find-identity -p codesigning` output → [{ hash, name, valid }].
 * Without `-v` the listing includes untrusted identities, marked `(CSSMERR_…)`.
 */
export function parseIdentities(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"(.*)$/.exec(line);
    if (m) out.push({ hash: m[1], name: m[2], valid: !/CSSMERR_|REVOKED|EXPIRED/i.test(m[3]) });
  }
  return out;
}

/** The "Ashlr Local" identity as the keychain reports it, or null. */
export function findSigningIdentity(io) {
  const res = io.exec('security', ['find-identity', '-p', 'codesigning']);
  if (res.status !== 0) return null;
  const all = parseIdentities(res.stdout).filter((i) => i.name === SIGNING_IDENTITY);
  return all.find((i) => i.valid) ?? all[0] ?? null;
}

/** Pure: the codesign argv for an identity hash, or ad-hoc (`-`) when there is none. */
export function codesignArgv(identity, entitlements, app = APP_PATH) {
  return identity
    ? ['codesign', '--force', '--deep', '--sign', identity, '--entitlements', entitlements, app]
    : ['codesign', '--force', '--deep', '--sign', '-', '--entitlements', entitlements, app];
}

/** An X.509 v3 config for a leaf code-signing certificate (LibreSSL and OpenSSL 3). */
const OPENSSL_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = ${SIGNING_IDENTITY}
O = Ashlr (this Mac only)
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
`;

/**
 * Make sure a VALID "Ashlr Local" code-signing identity exists in the login keychain;
 * returns its SHA-1 hash, or null (the caller falls back to ad-hoc and says why).
 *
 *   missing → /usr/bin/openssl makes a self-signed codeSigning cert (10 years),
 *             `security import` puts cert + key in the login keychain (codesign allowed)
 *   untrusted → `security add-trusted-cert -r trustRoot -p codeSign` trusts it for code
 *             signing only, for this user only (macOS asks for the login password)
 *
 * The private key only ever exists in a 0700 temp dir that is removed afterwards, and in
 * the keychain. Idempotent: an existing valid identity is returned untouched.
 */
export function ensureSigningIdentity(io) {
  let identity = findSigningIdentity(io);
  if (identity?.valid) return identity.hash;
  const keychain = join(io.home, 'Library', 'Keychains', 'login.keychain-db');
  const dir = io.mkdtemp('ashlr-sign-');
  try {
    const cert = join(dir, 'cert.pem');
    if (!identity) {
      const key = join(dir, 'key.pem');
      const p12 = join(dir, 'identity.p12');
      const cfg = join(dir, 'openssl.cnf');
      const pass = randomBytes(16).toString('hex');
      io.writeFile(cfg, OPENSSL_CONFIG);
      const steps = [
        ['/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '3650', '-config', cfg, '-extensions', 'ext']],
        ['/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-out', p12, '-name', SIGNING_IDENTITY, '-passout', `pass:${pass}`]],
        ['security', ['import', p12, '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign']],
      ];
      for (const [cmd, argv] of steps) {
        if (io.exec(cmd, argv).status !== 0) {
          io.log(`ship:local: could not create the "${SIGNING_IDENTITY}" signing identity (${cmd} ${argv[0]} failed).`);
          return null;
        }
      }
    } else {
      const pem = io.exec('security', ['find-certificate', '-c', SIGNING_IDENTITY, '-p', keychain]);
      if (pem.status !== 0 || !pem.stdout.includes('BEGIN CERTIFICATE')) return null;
      io.writeFile(cert, pem.stdout);
    }
    io.log(`      trusting "${SIGNING_IDENTITY}" for code signing — macOS will ask for your login password (once)`);
    if (io.exec('security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, cert], { stdio: 'inherit' }).status !== 0) {
      io.log(`ship:local: "${SIGNING_IDENTITY}" exists but is not trusted for code signing (the prompt was cancelled or unavailable).`);
      return null;
    }
    identity = findSigningIdentity(io);
    return identity?.valid ? identity.hash : null;
  } finally {
    io.removeDir(dir);
  }
}

/** `@ashlr/hub` + `3.11.0` → `ashlr-hub-3.11.0.tgz`, npm pack's naming. */
export function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

function inspectPrebuiltApp(io, signing, version) {
  const path = join(io.repoRoot, APP_BUNDLE_BUILD);
  const source = inspectLocalApp(path, signing?.valid ? signing.hash : null, io);
  const read = (key) => io.exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(path, 'Contents', 'Info.plist')]);
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const result = read(key);
    if (result.status !== 0 || result.stdout.trim() !== version) throw new Refusal('prebuilt Phantom.app must match this source version');
  }
  return source;
}

/**
 * Pure: the ordered step list. Throws Refusal for a non-mac or a dirty tree.
 * Each step is `{ id, title, argv? , wait? }`: argv steps are commands; wait steps are
 * `{ kind: 'app-quit' | 'http-200', ... }`, performed by runSteps.
 */
export function planShip(ctx) {
  if (ctx.platform !== 'darwin') {
    throw new Refusal(
      `ship:local installs into /Applications and restarts launchd agents, so it only runs on macOS (this is ${ctx.platform}).\n` +
      'Elsewhere: `npm pack` and the manual install in docs/RELEASING-LOCALLY.md.',
    );
  }
  if (ctx.dirty && !ctx.allowDirty) {
    throw new Refusal(
      'the working tree has uncommitted changes, so releases/<sha> would not be that commit.\n' +
      'Commit or stash them, or pass --allow-dirty (installs as releases/<sha>-dirty-<time>).',
    );
  }
  const short = ctx.sha.slice(0, 8);
  const shareDir = join(ctx.home, '.local', 'share', 'ashlr');
  const releaseId = ctx.dirty ? `${ctx.sha}-dirty-${stamp(ctx.now)}` : ctx.sha;
  const dest = join(shareDir, 'releases', releaseId);
  const packDir = join(ctx.tmp, `ashlr-ship-${short}`);
  const tarball = join(packDir, tarballName(ctx.packageName, ctx.version));
  const repo = (rel) => join(ctx.repoRoot, rel);

  const steps = [
    {id: 'aliases-preflight', title: 'refuse conflicting Workbench links; preserve Phantom Secrets', aliasesPreflight: true},
    ...(ctx.appExists || ctx.sourceApp ? [{ id: 'entitlements-preflight', title: 'prove codesign accepts the app entitlements before touching the release', argv: ['node', repo('scripts/check-macos-entitlements.mjs')] }] : []),
    { id: 'clean-dist', title: 'remove the repo\'s dist/ so the build is clean', argv: ['rm', '-rf', repo('dist')] },
    { id: 'build', title: 'npm run build', argv: ['npm', 'run', 'build'] },
    ...(ctx.appExists || ctx.sourceApp ? [{ id: 'native-quiescence', title: 'require Stop, drained leases and closed native app', quiescence: true }] : []),
    { id: 'pack-dir', title: `pack destination ${packDir}`, argv: ['mkdir', '-p', packDir] },
    { id: 'pack', title: `npm pack → ${tarball}`, argv: ['npm', 'pack', '--ignore-scripts', '--pack-destination', packDir] },
    { id: 'release-dir', title: `release dir ${dest}`, argv: ['mkdir', '-p', dest] },
    { id: 'extract', title: 'extract the tarball into the release dir', argv: ['tar', '-xzf', tarball, '-C', dest, '--strip-components=1'] },
    { id: 'build-binary', title: 'npm run build:binary (dist-bin/ashlr + dist-bin/public)', argv: ['npm', 'run', 'build:binary'] },
  ];

  if (ctx.appExists || ctx.sourceApp) {
    if (!ctx.selectedApp && !ctx.sourceApp) throw new Refusal('native install identity is missing');
    if (!ctx.signing?.valid) throw new Refusal('native updates require the existing valid Ashlr Local signer');
    const appSteps = [];
    const targets = [BUNDLE_TARGETS.sidecar, BUNDLE_TARGETS.public];
    const nativeNewer = ctx.native && ctx.nativeBuildMtime != null &&
      (ctx.installedNativeMtime == null || ctx.nativeBuildMtime > ctx.installedNativeMtime ||
        ctx.installedNativeShortVersion !== ctx.version || ctx.installedNativeBundleVersion !== ctx.version);
    if (nativeNewer) targets.push(BUNDLE_TARGETS.native);
    // --native also refreshes the Dock/Finder icon when a newer one was generated.
    const iconNewer = ctx.native && ctx.iconBuildMtime != null &&
      (ctx.installedIconMtime == null || ctx.iconBuildMtime > ctx.installedIconMtime);
    if (iconNewer) targets.push(BUNDLE_TARGETS.icon);

    // Every following app file update is applied to a private staging copy.

    const trashDir = join(ctx.home, '.Trash', `ashlr-app-backups-${stamp(ctx.now)}`);
    const trashMoves = [];
    for (const target of targets) {
      const dir = join(APP_PATH, target.dir);
      const entries = ctx.listing[target.dir] ?? [];
      const taken = entries.map((e) => e.name);
      const aside = backupName(target.name, short, taken, ctx.now);
      const creating = taken.includes(target.name);
      if (creating) {
        appSteps.push({ id: `backup-${target.name}`, title: `move ${target.dir}/${target.name} aside to ${aside}`, argv: ['mv', join(dir, target.name), join(dir, aside)] });
      }
      appSteps.push({ id: `install-${target.name}`, title: `copy ${target.source} into ${target.dir}/${target.name}`, argv: ['cp', '-R', repo(target.source), join(dir, target.name)] });
      for (const old of rotateBackups(target.name, entries, { creating }).trash) trashMoves.push(join(dir, old));
    }
    if (ctx.native && !nativeNewer) {
      appSteps.push({ id: 'native-skip', title: `--native: ${NATIVE_BUILD} is ${ctx.nativeBuildMtime == null ? 'missing' : 'not newer than the installed one'}; keeping the installed ashlr-desktop` });
    }
    if (trashMoves.length > 0) {
      appSteps.push({ id: 'trash-dir', title: `trash folder ${trashDir}`, argv: ['mkdir', '-p', trashDir] });
      appSteps.push({ id: 'rotate-backups', title: `keep ${KEEP_BACKUPS} newest backups; move ${trashMoves.length} older to the Trash`, argv: ['mv', ...trashMoves, trashDir] });
    }
    // The native binary and its Info.plist version must advance together. A sidecar-only
    // update leaves the native binary in place, so it must not claim the new package version.
    if (nativeNewer) {
      const plist = join(APP_PATH, 'Contents', 'Info.plist');
      appSteps.push({ id: 'plist-short-version', title: 'Info.plist: CFBundleShortVersionString', argv: ['plutil', '-replace', 'CFBundleShortVersionString', '-string', ctx.version, plist] });
      appSteps.push({ id: 'plist-bundle-version', title: 'Info.plist: CFBundleVersion', argv: ['plutil', '-replace', 'CFBundleVersion', '-string', ctx.version, plist] });
    }
    // Dictation: macOS kills an app that touches the mic without this key, and ship:local
    // patches an installed bundle rather than rebuilding it, so write it every time.
    appSteps.push({ id: 'plist-mic', title: 'Info.plist: NSMicrophoneUsageDescription', argv: ['plutil', '-replace', 'NSMicrophoneUsageDescription', '-string', MIC_USAGE, join(APP_PATH, 'Contents', 'Info.plist')] });
    appSteps.push({ id: 'plist-local-network', title: 'Info.plist: allow local Verse networking', argv: ['plutil', '-replace', 'NSAppTransportSecurity', '-json', LOCAL_NETWORK_ATS, join(APP_PATH, 'Contents', 'Info.plist')] });
    const valid = ctx.signing.hash;
    appSteps.push({
      id: 'codesign',
      title: valid ? `codesign the bundle as "${SIGNING_IDENTITY}"` : `codesign the bundle as "${SIGNING_IDENTITY}" (ad-hoc if the identity is unavailable)`,
      argv: codesignArgv(valid ?? SIGNING_IDENTITY, repo(ENTITLEMENTS)),
      sign: { identity: valid, entitlements: repo(ENTITLEMENTS) },
    });
    // Finder and the Dock cache the icon until the bundle's mtime changes.
    if (iconNewer) appSteps.push({ id: 'touch-app', title: 'touch the bundle so the Dock picks up the new icon', argv: ['touch', APP_PATH] });
    appSteps.push({ id: 'codesign-verify', title: 'verify the signature', argv: ['codesign', '--verify', '--deep', '--strict', APP_PATH] });

    steps.push({ id: 'native-transaction', title: 'stage, verify and switch the single Phantom installation', app: { selected: ctx.selectedApp, source: ctx.selectedApp?.path ?? ctx.sourceApp.path, sourceProof: ctx.selectedApp ?? ctx.sourceApp, signer: ctx.signing.hash, version: ctx.version, native: ctx.native, entitlements: repo(ENTITLEMENTS), current: join(shareDir, 'current'), dest, steps: appSteps } });
  } else {
    steps.push({ id: 'app-absent', title: `${APP_PATH} not installed; skipping the app bundle` });
  }

  if (!(ctx.appExists || ctx.sourceApp)) steps.push({ id: 'current', title: `point ${join(shareDir, 'current')} at ${releaseId}`, links: {current: join(shareDir, 'current'), dest} });
  for (const label of LAUNCH_AGENTS) {
    steps.push(!(ctx.appExists || ctx.sourceApp) && ctx.loadedAgents.includes(label)
      ? { id: `kickstart-${label}`, title: `restart ${label}`, argv: ['launchctl', 'kickstart', '-k', `gui/${ctx.uid}/${label}`] }
      : { id: `kickstart-${label}`, title: `${label}: native maintenance does not restart services; otherwise leave unloaded services alone` });
  }
  steps.push({ id: 'verse-up', title: `wait for ${VERSE_URL} → 200`, wait: { kind: 'http-200', url: VERSE_URL, timeoutMs: 90_000 } });
  steps.push({ id: 'versions', title: 'print versions', versions: {
    package: ctx.version,
    sha: ctx.sha,
    tarball,
    current: join(shareDir, 'current', 'bin', 'ashlr'),
    app: ctx.appExists || ctx.sourceApp ? join(APP_PATH, 'Contents', 'MacOS', 'ashlr') : null,
  } });
  return steps;
}

export function describeStep(step, index) {
  const cmd = step.argv ? `\n      $ ${step.argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')}` : '';
  return `${String(index + 1).padStart(2)}. ${step.title}${cmd}`;
}

/**
 * Execute (or, with dryRun, only print) the steps. `io` supplies exec, sleep, fetchStatus
 * (url → status | null), log. Returns 0 or 1.
 */
export async function runSteps(steps, io, { dryRun }) {
  let identity = null;
  let aliases = null;
  for (const [index, step] of steps.entries()) {
    io.log(describeStep(step, index));
    if (dryRun) continue;
    if (step.aliasesPreflight) {
      try { aliases = inspectLocalAliases(io); } catch (error) { io.log(String(error.message)); return 1; }
      continue;
    }
    if (step.links) {
      const previous = io.readCurrentPointer(step.links.current);
      let switched = null;
      try {
        switched = io.switchCurrentPointer(step.links.current, previous, step.links.dest);
        createLocalAliases(aliases, io);
      } catch (error) {
        if (switched) io.restoreCurrentPointer(step.links.current, previous, switched); io.log(String(error.message)); return 1;
      }
      continue;
    }
    if (step.quiescence) {
      try { await requireLocalQuiescence(io); } catch (error) { io.log(String(error.message)); return 1; }
      continue;
    }
    if (step.app) {
      try {
        const previousPointer = io.readCurrentPointer(step.app.current);
        let createdAliases = [];
        let switchedPointer = null;
        await installLocalApp({ ...step.app, previousCurrent: previousPointer,
          commitPointer: async () => {
            switchedPointer = io.switchCurrentPointer(step.app.current, previousPointer, step.app.dest);
            createdAliases = createLocalAliases(aliases, io);
          },
          rollbackPointer: async () => { removeCreatedAliases(createdAliases, io); if (switchedPointer) io.restoreCurrentPointer(step.app.current, previousPointer, switchedPointer); },
          prepare: async (staged) => {
            const rewrite = (value) => typeof value === 'string' && value.startsWith(APP_PATH) ? staged + value.slice(APP_PATH.length) : value;
            const inner = step.app.steps.map((item) => ({ ...item, argv: item.argv?.map(rewrite), sign: item.sign && { ...item.sign, app: staged } }));
            if (await runSteps(inner, io, { dryRun: false }) !== 0) throw new Error('staged bundle preparation failed');
          },
          health: async () => {
            const deadline = io.clock() + 90_000;
            while (io.clock() <= deadline) { if (launchedAppIsOwned(io) && await io.fetchStatus(VERSE_URL) === 200) return true; await io.sleep(1_000); }
            return false;
          },
        }, io);
      } catch (error) { io.log(String(error.message)); return 1; }
      continue;
    }
    if (step.identity) {
      identity = ensureSigningIdentity(io);
      continue;
    }
    if (step.sign) {
      const hash = step.sign.identity ?? identity;
      if (!hash) {
        io.log(`ship:local: WARNING — signing ad-hoc. macOS forgets Ashlr's microphone permission on every ad-hoc rebuild;`);
        io.log(`           rerun ship:local in a terminal to create/trust the "${SIGNING_IDENTITY}" identity (docs/RELEASING-LOCALLY.md).`);
      }
      const argv = codesignArgv(hash, step.sign.entitlements, step.sign.app);
      const res = io.exec(argv[0], argv.slice(1), { cwd: io.repoRoot, stdio: 'inherit' });
      if (res.status !== 0) {
        io.log(`ship:local: step "${step.id}" failed (exit ${res.status}). Nothing after it ran.`);
        return 1;
      }
      continue;
    }
    if (step.argv) {
      const res = io.exec(step.argv[0], step.argv.slice(1), { cwd: io.repoRoot, stdio: 'inherit' });
      if (res.status !== 0) {
        io.log(`ship:local: step "${step.id}" failed (exit ${res.status}). Nothing after it ran.`);
        return 1;
      }
    } else if (step.wait?.kind === 'app-quit') {
      const deadline = io.clock() + step.wait.timeoutMs;
      while (io.exec('pgrep', ['-f', step.wait.pattern]).status === 0) {
        if (io.clock() > deadline) {
          io.log(`ship:local: Ashlr is still running after ${step.wait.timeoutMs / 1000}s; quit it and rerun.`);
          return 1;
        }
        await io.sleep(500);
      }
    } else if (step.wait?.kind === 'http-200') {
      const deadline = io.clock() + step.wait.timeoutMs;
      let status = await io.fetchStatus(step.wait.url);
      while (status !== 200) {
        if (io.clock() > deadline) {
          io.log(`ship:local: ${step.wait.url} answered ${status ?? 'nothing'} for ${step.wait.timeoutMs / 1000}s. The install is done; check the app and launchd logs.`);
          return 1;
        }
        await io.sleep(1_000);
        status = await io.fetchStatus(step.wait.url);
      }
      io.log(`      ${step.wait.url} → 200`);
    } else if (step.versions) {
      const v = step.versions;
      const version = (bin) => {
        if (!bin) return 'not installed';
        const res = io.exec(bin, ['--version']);
        return res.status === 0 ? res.stdout.trim() : `unavailable (exit ${res.status})`;
      };
      io.log(`      package   ${v.package} @ ${v.sha.slice(0, 8)}`);
      io.log(`      current   ${version(v.current)}`);
      io.log(`      app       ${version(v.app)}`);
      io.log(`      tarball   ${v.tarball}  (npm publish this; docs/RELEASING-LOCALLY.md)`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Real io
// ---------------------------------------------------------------------------

function realIo() {
  const stages = new Map();
  const lstatExists = (path) => { try {lstatSync(path); return true;} catch (error) {if (error.code === 'ENOENT') return false; throw error;} };
  const safeFile = (path, max = Infinity) => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > max) throw new Refusal('unsafe or oversized file');
      const bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Refusal('file changed during read');
      return bytes;
    } finally { closeSync(fd); }
  };
  const stageOwned = (owner) => {
    const expected = stages.get(owner); const actual = lstatSync(owner);
    if (!expected || actual.isSymbolicLink() || !actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Refusal('installation stage identity changed');
  };
  const safeParents = (path) => {
    for (let parent = dirname(path); parent !== homedir(); parent = dirname(parent)) {
      if (parent === dirname(parent) || !parent.startsWith(homedir() + '/')) throw new Refusal('unsupported local installation path');
      try {const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refusal('unsafe local installation directory');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
  };
  const fileStat = (path) => { try { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() }; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const currentTarget = (path) => inspectCurrentPointer(path, {home: homedir(), repoRoot, validateLocalPath: safeParents, lstat: fileStat, readLink: readlinkSync, readBoundedFile: (file, max) => safeFile(file, max).toString('utf8')});

  return {
    platform: process.platform,
    home: homedir(),
    tmp: tmpdir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    now: new Date(),
    repoRoot,
    clock: () => Date.now(),
    log: (line) => console.log(line),
    sleep: (ms) => delay(ms),
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, text) => writeFileSync(path, text, { mode: 0o600 }),
    mkdtemp: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
    removeDir: (dir) => {
      // Only the signing scratch dir ensureSigningIdentity made (it held a private key).
      if (!dir.startsWith(join(tmpdir(), 'ashlr-sign-'))) throw new Error(`refusing to remove ${dir}`);
      rmSync(dir, { recursive: true, force: true });
    },
    lstat: fileStat,
    readBoundedFile: (path, max) => safeFile(path, max).toString('utf8'),
    exclusiveRenamePreflight: exclusiveRenameAvailable,
    renameExclusive: renamePathExclusive,
    readCurrentPointer: currentTarget,
    validateLocalPath: safeParents,
    readLink: (path) => {safeParents(path); return readlinkSync(path);},
    linkTargetExists: (path) => { try { return statSync(path).isFile(); } catch {return false;} },
    createAlias: (path, target) => { safeParents(path); mkdirSync(dirname(path), {recursive: true}); safeParents(path); symlinkSync(target, path); },
    removeAlias: (path) => {safeParents(path); unlinkSync(path);},
    switchCurrentPointer: (path, before, target) => switchLocalCurrentPointer(path, before, target, `${path}.phantom-${randomBytes(8).toString('hex')}`, {readCurrentPointer: currentTarget, createLink: symlinkSync, rename: renameSync, exists: lstatExists, unlink: unlinkSync}),
    restoreCurrentPointer: (path, before, expected) => {
      if (JSON.stringify(currentTarget(path)) !== JSON.stringify(expected)) throw new Refusal('current release changed; rollback held');
      if (before === null) rmSync(path);
      else { const temporary = `${path}.phantom-${randomBytes(8).toString('hex')}`; symlinkSync(before.target, temporary); try {renameSync(temporary, path);} finally { if (lstatExists(temporary)) unlinkSync(temporary); } }
    },
    appInventory: (path) => {
      const hash = createHash('sha256');
      const visit = (file) => {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Refusal('unsafe app inventory entry');
        hash.update(JSON.stringify([relative(path, file), stat.mode & 0o777, stat.isDirectory() ? 'directory' : 'file']));
        if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(join(file, name));
        else hash.update(safeFile(file));
        const after = lstatSync(file);
        if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Refusal('app changed during inventory');
      };
      visit(path); return hash.digest('hex');
    },
    makeInstallStage: () => { const dir = mkdtempSync('/Applications/.phantom-install-'); stages.set(dir, lstatSync(dir)); return dir; },
    writeInstallJournal: (owner, value) => {
      stageOwned(owner);
      const fd = openSync(join(owner, 'transaction.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    },
    removeInstallTree: (path, owner) => {
      stageOwned(owner);
      if (!owner.startsWith('/Applications/.phantom-install-') || dirname(path) !== owner || !['archive-check', 'retired-bundle'].includes(path.slice(owner.length + 1))) throw new Refusal('unsafe installation cleanup');
      rmSync(path, { recursive: true, force: true });
    },
    executionLeaseCensus: async () => {
      const module = await import(pathToFileURL(join(repoRoot, 'dist/core/sandbox/execution-leases.js')).href);
      return module.censusExecutionLeases();
    },
    exists: (path) => { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    mtime: (path) => { try { return statSync(path).mtimeMs; } catch { return null; } },
    list: (dir) => {
      try {
        return readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
      } catch {
        return [];
      }
    },
    exec: (cmd, argv, opts = {}) => {
      if (cmd === 'rm') {
        // The only removal ship:local performs, and only of the repo's own build output.
        const target = argv.at(-1);
        if (target !== join(repoRoot, 'dist')) throw new Error(`refusing to remove ${target}`);
        rmSync(target, { recursive: true, force: true });
        return { status: 0, stdout: '' };
      }
      const res = spawnSync(cmd, argv, { cwd: opts.cwd ?? repoRoot, encoding: 'utf8', stdio: opts.stdio === 'inherit' ? 'inherit' : 'pipe' });
      return { status: res.error ? 127 : res.status, stdout: res.stdout ?? '' };
    },
    fetchStatus: async (url) => {
      try {
        const res = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(3_000) });
        return res.status;
      } catch {
        return null;
      }
    },
  };
}

async function main() {
  const io = realIo();
  let steps;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    // Refuse before touching anything: gatherContext would call launchctl.
    if (io.platform !== 'darwin') planShip({ platform: io.platform });
    steps = planShip(gatherContext(args, io));
  } catch (err) {
    if (err instanceof Refusal) {
      console.error(`ship:local: ${err.message}`);
      return 2;
    }
    throw err;
  }
  console.log(args.dryRun ? 'ship:local --dry-run: nothing below is executed.\n' : 'ship:local:\n');
  return runSteps(steps, io, { dryRun: args.dryRun });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}

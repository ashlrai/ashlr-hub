#!/usr/bin/env node
/**
 * scripts/ship-local.mjs — put the freshly built Verse on this Mac (`npm run ship:local`).
 *
 *   npm run ship:local                     build, pack, install, rebuild the app binary, restart
 *   npm run ship:local -- --dry-run        print every step; change nothing
 *   npm run ship:local -- --native         also install desktop/src-tauri/target/release/ashlr-desktop
 *                                          when it is newer than the one in the app
 *   npm run ship:local -- --allow-dirty    ship uncommitted work (installed as <sha>-dirty-<time>)
 *
 * Steps, in order (docs/RELEASING-LOCALLY.md):
 *   1. `npm run build` on a clean dist/.
 *   2. `npm pack --ignore-scripts` into OS temp (the tarball you then `npm publish`).
 *   3. Extract into ~/.local/share/ashlr/releases/<sha>; `ln -sfn` it to ~/.local/share/ashlr/current.
 *   4. `npm run build:binary` (dist-bin/ashlr + dist-bin/public).
 *   5. If /Applications/Ashlr.app exists: quit it, move Contents/MacOS/ashlr and
 *      Contents/Resources/public aside to *.prev-<short sha> (never deleted), copy the new
 *      ones in (and, with --native, ashlr-desktop), ad-hoc codesign, verify, relaunch.
 *      Only the 3 newest *.prev-* of each kind stay in the bundle; older ones are moved into a
 *      dated folder under ~/.Trash.
 *   6. `launchctl kickstart -k` ai.ashlr.anthropic-proxy and ai.ashlr.serve, if loaded.
 *   7. Wait for http://127.0.0.1:7777/verse/ to answer 200 and print versions.
 *
 * Nothing here deletes a user file: the only removal is the repo's own dist/ before the build.
 * Everything that touches the machine goes through the injected `io`, so the planning logic
 * is unit-tested without ~/.local, /Applications or launchd (test/ship-local.test.ts).
 *
 * Exit: 0 shipped (or dry-run printed), 1 a step failed, 2 refused (platform, dirty tree, usage).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const APP_PATH = '/Applications/Ashlr.app';
export const VERSE_URL = 'http://127.0.0.1:7777/verse/';
export const LAUNCH_AGENTS = Object.freeze(['ai.ashlr.anthropic-proxy', 'ai.ashlr.serve']);
export const KEEP_BACKUPS = 3;
export const NATIVE_BUILD = 'desktop/src-tauri/target/release/ashlr-desktop';
/** The Dock/Finder icon, generated from icons/icon.svg by `cargo tauri icon`. */
export const APP_ICON_BUILD = 'desktop/src-tauri/icons/icon.icns';

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
  const appExists = io.exists(APP_PATH);
  const listing = {};
  if (appExists) {
    for (const dir of new Set(Object.values(BUNDLE_TARGETS).map((t) => t.dir))) listing[dir] = io.list(join(APP_PATH, dir));
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
    listing,
    loadedAgents,
    nativeBuildMtime: io.mtime(join(io.repoRoot, NATIVE_BUILD)),
    installedNativeMtime: appExists ? io.mtime(join(APP_PATH, BUNDLE_TARGETS.native.dir, BUNDLE_TARGETS.native.name)) : null,
    iconBuildMtime: io.mtime(join(io.repoRoot, APP_ICON_BUILD)),
    installedIconMtime: appExists ? io.mtime(join(APP_PATH, BUNDLE_TARGETS.icon.dir, BUNDLE_TARGETS.icon.name)) : null,
    ...args,
  };
}

/** `@ashlr/hub` + `3.11.0` → `ashlr-hub-3.11.0.tgz`, npm pack's naming. */
export function tarballName(packageName, version) {
  return `${packageName.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
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
    { id: 'clean-dist', title: 'remove the repo\'s dist/ so the build is clean', argv: ['rm', '-rf', repo('dist')] },
    { id: 'build', title: 'npm run build', argv: ['npm', 'run', 'build'] },
    { id: 'pack-dir', title: `pack destination ${packDir}`, argv: ['mkdir', '-p', packDir] },
    { id: 'pack', title: `npm pack → ${tarball}`, argv: ['npm', 'pack', '--ignore-scripts', '--pack-destination', packDir] },
    { id: 'release-dir', title: `release dir ${dest}`, argv: ['mkdir', '-p', dest] },
    { id: 'extract', title: 'extract the tarball into the release dir', argv: ['tar', '-xzf', tarball, '-C', dest, '--strip-components=1'] },
    { id: 'current', title: `point ${join(shareDir, 'current')} at ${releaseId}`, argv: ['ln', '-sfn', dest, join(shareDir, 'current')] },
    { id: 'build-binary', title: 'npm run build:binary (dist-bin/ashlr + dist-bin/public)', argv: ['npm', 'run', 'build:binary'] },
  ];

  if (ctx.appExists) {
    const targets = [BUNDLE_TARGETS.sidecar, BUNDLE_TARGETS.public];
    const nativeNewer = ctx.native && ctx.nativeBuildMtime != null &&
      (ctx.installedNativeMtime == null || ctx.nativeBuildMtime > ctx.installedNativeMtime);
    if (nativeNewer) targets.push(BUNDLE_TARGETS.native);
    // --native also refreshes the Dock/Finder icon when a newer one was generated.
    const iconNewer = ctx.native && ctx.iconBuildMtime != null &&
      (ctx.installedIconMtime == null || ctx.iconBuildMtime > ctx.installedIconMtime);
    if (iconNewer) targets.push(BUNDLE_TARGETS.icon);

    steps.push({ id: 'app-quit', title: 'quit Ashlr', argv: ['osascript', '-e', 'quit app "Ashlr"'] });
    // Waits on the main process only: a sidecar that outlives it is reclaimed by the relaunched
    // app's own orphan sweep (desktop/src-tauri/src/sidecar_supervisor.rs), and renaming a
    // running binary aside is safe.
    steps.push({ id: 'app-wait-quit', title: 'wait for Ashlr to exit', wait: { kind: 'app-quit', pattern: `${APP_PATH}/Contents/MacOS/ashlr-desktop`, timeoutMs: 20_000 } });

    const trashDir = join(ctx.home, '.Trash', `ashlr-app-backups-${stamp(ctx.now)}`);
    const trashMoves = [];
    for (const target of targets) {
      const dir = join(APP_PATH, target.dir);
      const entries = ctx.listing[target.dir] ?? [];
      const taken = entries.map((e) => e.name);
      const aside = backupName(target.name, short, taken, ctx.now);
      const creating = taken.includes(target.name);
      if (creating) {
        steps.push({ id: `backup-${target.name}`, title: `move ${target.dir}/${target.name} aside to ${aside}`, argv: ['mv', join(dir, target.name), join(dir, aside)] });
      }
      steps.push({ id: `install-${target.name}`, title: `copy ${target.source} into ${target.dir}/${target.name}`, argv: ['cp', '-R', repo(target.source), join(dir, target.name)] });
      for (const old of rotateBackups(target.name, entries, { creating }).trash) trashMoves.push(join(dir, old));
    }
    if (ctx.native && !nativeNewer) {
      steps.push({ id: 'native-skip', title: `--native: ${NATIVE_BUILD} is ${ctx.nativeBuildMtime == null ? 'missing' : 'not newer than the installed one'}; keeping the installed ashlr-desktop` });
    }
    if (trashMoves.length > 0) {
      steps.push({ id: 'trash-dir', title: `trash folder ${trashDir}`, argv: ['mkdir', '-p', trashDir] });
      steps.push({ id: 'rotate-backups', title: `keep ${KEEP_BACKUPS} newest backups; move ${trashMoves.length} older to the Trash`, argv: ['mv', ...trashMoves, trashDir] });
    }
    steps.push({ id: 'codesign', title: 'ad-hoc codesign the bundle', argv: ['codesign', '--force', '--deep', '--sign', '-', APP_PATH] });
    // Finder and the Dock cache the icon until the bundle's mtime changes.
    if (iconNewer) steps.push({ id: 'touch-app', title: 'touch the bundle so the Dock picks up the new icon', argv: ['touch', APP_PATH] });
    steps.push({ id: 'codesign-verify', title: 'verify the signature', argv: ['codesign', '--verify', '--deep', '--strict', APP_PATH] });
    steps.push({ id: 'app-launch', title: 'relaunch Ashlr', argv: ['open', APP_PATH] });
  } else {
    steps.push({ id: 'app-absent', title: `${APP_PATH} not installed; skipping the app bundle` });
  }

  for (const label of LAUNCH_AGENTS) {
    steps.push(ctx.loadedAgents.includes(label)
      ? { id: `kickstart-${label}`, title: `restart ${label}`, argv: ['launchctl', 'kickstart', '-k', `gui/${ctx.uid}/${label}`] }
      : { id: `kickstart-${label}`, title: `${label} is not loaded; leaving it alone` });
  }
  steps.push({ id: 'verse-up', title: `wait for ${VERSE_URL} → 200`, wait: { kind: 'http-200', url: VERSE_URL, timeoutMs: 90_000 } });
  steps.push({ id: 'versions', title: 'print versions', versions: {
    package: ctx.version,
    sha: ctx.sha,
    tarball,
    current: join(shareDir, 'current', 'bin', 'ashlr'),
    app: ctx.appExists ? join(APP_PATH, 'Contents', 'MacOS', 'ashlr') : null,
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
  for (const [index, step] of steps.entries()) {
    io.log(describeStep(step, index));
    if (dryRun) continue;
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
    exists: (path) => existsSync(path),
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

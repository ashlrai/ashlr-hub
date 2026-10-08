/** Identity-bound local app migration. All effects are injected; never selects an app by display name. */
import { basename, dirname, join, relative } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

export const PHANTOM_APP_PATH = '/Applications/Phantom.app';
export const LEGACY_APP_PATH = '/Applications/Ashlr.app';
export const NATIVE_BUNDLE_ID = 'ai.ashlr.desktop';
export const NATIVE_EXECUTABLE = 'ashlr-desktop';

const paths = [PHANTOM_APP_PATH, LEGACY_APP_PATH];
const fail = (message) => { throw new Error(`Native installation held: ${message}`); };
const call = (io, cmd, argv) => {
  const result = io.exec(cmd, argv);
  if (result.status !== 0) fail(`${cmd} ${argv[0]} failed; no unverified app will be installed`);
  return result.stdout;
};

/** A successful rename with an unreadable result cannot be treated as an unchanged pointer. */
export function switchLocalCurrentPointer(path, before, target, temporary, io) {
  if (JSON.stringify(io.readCurrentPointer(path)) !== JSON.stringify(before)) fail('current release changed during staging');
  let renamed = false;
  try {
    io.createLink(target, temporary);
    try {
      if (JSON.stringify(io.readCurrentPointer(path)) !== JSON.stringify(before)) fail('current release changed before atomic switch');
      io.rename(temporary, path);
      renamed = true;
      const after = io.readCurrentPointer(path);
      if (!after || after.target !== target) fail('the switched pointer is missing or changed');
      return after;
    } finally { if (io.exists(temporary)) io.unlink(temporary); }
  } catch (error) {
    if (renamed) throw Object.assign(new Error('Native installation held: current pointer switched but ownership is unknown; rollback held'), {currentPointerUncertain: true});
    throw error;
  }
}

// Public macOS API, matching native_launchd_broker's RENAME_EXCL semantics.
// Isolated system Python has no site/PYTHONPATH startup and loads only libSystem.
const EXCLUSIVE_RENAME_SCRIPT = `import ctypes, os, sys
lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
fn = lib.renameatx_np
fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
fn.restype = ctypes.c_int
if sys.argv[1] == 'check': sys.exit(0)
source, target, dev, ino = sys.argv[1:]
fds = []
try:
 for path in [source, target]: fds.append(os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
 before = os.stat(os.path.basename(source), dir_fd=fds[0], follow_symlinks=False)
 if (before.st_dev, before.st_ino) != (int(dev), int(ino)): sys.exit(2)
 if fn(fds[0], os.fsencode(os.path.basename(source)), fds[1], os.fsencode(os.path.basename(target)), 4) != 0: sys.exit(3)
 after = os.stat(os.path.basename(target), dir_fd=fds[1], follow_symlinks=False)
 if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino): sys.exit(4)
finally:
 for fd in fds: os.close(fd)
`;
export function exclusiveRenameAvailable() {
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', EXCLUSIVE_RENAME_SCRIPT, 'check'], {encoding: 'utf8', timeout: 5000, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}});
  if (result.status !== 0 || result.error) fail('isolated system Python/macOS exclusive rename is unavailable; no fallback moves are allowed');
}
export function renamePathExclusive(source, target, expected) {
  if (!expected || !Number.isSafeInteger(expected.dev) || !Number.isSafeInteger(expected.ino)) fail('exclusive move source identity is missing');
  const result = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', EXCLUSIVE_RENAME_SCRIPT, source, target, String(expected.dev), String(expected.ino)], {encoding: 'utf8', timeout: 5000, env: {PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C'}});
  if (result.status !== 0 || result.error) fail('exclusive move refused; source/destination evidence is preserved for recovery');
}

/** Strict code identity plus filesystem inventory, freshly re-read before the switch. */
export function inspectLocalApp(path, signer, io) {
  if (!/^[0-9A-F]{40}$/.test(signer ?? '')) fail('a valid existing Ashlr Local signing identity is required');
  const stat = io.lstat(path);
  if (!stat?.isDirectory || stat.isSymbolicLink) fail(`${path} is not a regular app directory`);
  const inventory = io.appInventory(path);
  if (!inventory || !/^[0-9a-f]{64}$/.test(inventory)) fail(`${path} could not be inventoried without symlinks or unreadable files`);
  const plist = join(path, 'Contents', 'Info.plist');
  for (const [key, expected] of [['CFBundleIdentifier', NATIVE_BUNDLE_ID], ['CFBundleExecutable', NATIVE_EXECUTABLE]]) {
    if (call(io, '/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim() !== expected) fail(`${path} has an unsupported ${key}`);
  }
  call(io, '/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=identifier "${NATIVE_BUNDLE_ID}" and certificate leaf = H"${signer}"`, path]);
  if (io.appInventory(path) !== inventory) fail('the app changed during signature verification');

  return { path, signer, inventory, dev: stat.dev, ino: stat.ino };
}

export function selectLocalApp(signer, io) {
  const present = paths.filter((path) => io.exists(path));
  if (present.length > 1) fail('both Ashlr.app and Phantom.app exist; resolve the conflicting installations explicitly');
  return present.length ? inspectLocalApp(present[0], signer, io) : null;
}

function sameApp(expected, io) {
  const actual = inspectLocalApp(expected.path, expected.signer, io);
  if (actual.inventory !== expected.inventory || actual.dev !== expected.dev || actual.ino !== expected.ino) fail('the selected app changed after inspection; retry from a fresh plan');
}

/** Existing Stop intent, strict lease census and exact native/sidecar process evidence. No work is killed. */
export async function requireLocalQuiescence(io) {
  const kill = io.lstat(join(io.home, '.ashlr', 'KILL'));
  if (!kill?.isFile || kill.isSymbolicLink) fail('Stop must already be engaged; drain work with `ashlr authority stop` first');
  const census = await io.executionLeaseCensus();
  if (!census || census.unknown !== 0 || !Array.isArray(census.leases) || census.leases.length) fail('execution leases are active or unknown; finish the supported drain before installation');
  if (census.reaped) io.log(`      reaped ${census.reaped} proven-dead execution leases`);
  const processes = readProcesses(io);
  for (const {args} of processes.values()) if (paths.some((path) => args.startsWith(`${path}/Contents/MacOS/`))) fail('close Phantom normally before installation; a native app or owned sidecar is still running');
  const record = readSidecarRecord(io);
  if (record && (processes.has(record.desktopPid) || processes.has(record.sidecarPid))) fail('recorded native/sidecar process identity is still live or uncertain; close the app and use normal recovery first');
}

function readProcesses(io) {
  const result = io.exec('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,args=']);
  if (result.status !== 0) fail('process liveness is unreadable');
  const processes = new Map();
  for (const line of result.stdout.split('\n').filter((line) => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(?:\S+\s+){5}(.+)$/.exec(line);
    if (!match) fail('process liveness contains an unrecognized record');
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid < 1 || processes.has(pid)) fail('process identity is ambiguous');
    processes.set(pid, {ppid: Number(match[2]), args: match[3]});
  }
  return processes;
}

function readSidecarRecord(io) {
  const recordPath = join(io.home, '.ashlr', '.desktop-sidecar.json');
  if (io.exists(recordPath)) {
    const stat = io.lstat(recordPath);
    if (!stat?.isFile || stat.isSymbolicLink || stat.size > 16_384) fail('the desktop ownership record is unreadable or unsafe');
    let record;
    try { record = JSON.parse(io.readBoundedFile(recordPath, 16_384)); } catch { fail('the desktop ownership record is invalid'); }
    if (!record || Object.keys(record).sort().join(',') !== 'desktopPid,port,sidecarPath,sidecarPid' ||
        ![record.desktopPid, record.sidecarPid].every((pid) => Number.isSafeInteger(pid) && pid > 1) ||
        !Number.isInteger(record.port) || record.port < 1 || record.port > 65535 ||
        typeof record.sidecarPath !== 'string' || !record.sidecarPath.startsWith('/')) fail('the desktop ownership record is invalid');
    return record;
  }
  return null;
}

/** A healthy unrelated local server is not acceptance of this exact launched app. */
export function launchedAppIsOwned(io) {
  const record = readSidecarRecord(io);
  if (!record || record.port !== 7777 || record.sidecarPath !== join(PHANTOM_APP_PATH, 'Contents/MacOS/ashlr')) return false;
  const processes = readProcesses(io);
  const desktop = processes.get(record.desktopPid);
  const sidecar = processes.get(record.sidecarPid);
  const baseArgs = `${record.sidecarPath} verse --port 7777 --no-open --json`;
  // Match only the two exact Verse forms emitted by native sidecar_args;
  // remote startup requires its fixed home config and private token handoff.
  const remoteArgs = `${baseArgs} --remote-config ${join(io.home, '.ashlr', 'verse-remote.json')} --desktop-token-handoff`;
  if (!desktop || desktop.args !== join(PHANTOM_APP_PATH, 'Contents/MacOS', NATIVE_EXECUTABLE) ||
      !sidecar || sidecar.ppid !== record.desktopPid || (sidecar.args !== baseArgs && sidecar.args !== remoteArgs)) return false;
  const listener = io.exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(record.sidecarPid), '-iTCP:7777', '-sTCP:LISTEN', '-Fp']);
  // lsof -Fp emits the selected process followed by its listening file records.
  const fields = listener.stdout.split('\n');
  if (fields.at(-1) === '') fields.pop();
  return listener.status === 0 && fields[0] === `p${record.sidecarPid}` && fields.length > 1 &&
    fields.slice(1).every((field) => /^f[0-9]+$/u.test(field));
}

/** Existing local release layout; this is compatibility/ownership, not new launch authority. */
export function ownedReleaseTarget(home, target) {
  const prefix = join(home, '.local/share/ashlr/releases') + '/';
  if (typeof target !== 'string' || !target.startsWith(prefix) || !/^[0-9a-f]{40}(?:-dirty-\d{8}-\d{6})?$/.test(target.slice(prefix.length))) fail('current does not point to a supported owned local release');
  return target;
}

/** Only initial absence is absent; a present-but-incomplete pointer must hold. */
export function inspectCurrentPointer(path, io) {
  io.validateLocalPath(path);
  const stat = io.lstat(path);
  if (stat === null) return null;
  try {
    if (!stat.isSymbolicLink) fail('current release is not a symlink');
    const target = ownedReleaseTarget(io.home, io.readLink(path));
    const launcher = join(target, 'bin/ashlr'); io.validateLocalPath(launcher);
    const pkg = JSON.parse(io.readBoundedFile(join(target, 'package.json'), 65536));
    const actual = Buffer.from(io.readBoundedFile(launcher, 65536));
    const expected = Buffer.from(io.readBoundedFile(join(io.repoRoot, 'bin/ashlr'), 65536));
    if (!['@ashlr/hub', '@ashlr/phantom'].includes(pkg.name) || typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(pkg.version) || !actual.equals(expected)) fail('current release package/canonical launcher identity is unsupported');
    const after = io.lstat(path);
    if (!after?.isSymbolicLink || stat.dev !== after.dev || stat.ino !== after.ino || stat.ctimeMs !== after.ctimeMs) fail('current release changed while reading');
    return {target, dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs};
  } catch { fail('the present current release is incomplete, unsafe or changed; preserve it for explicit recovery'); }
}

/** Refuse alias collisions before either the app or current release is changed. */
export function inspectLocalAliases(io) {
  const target = join(io.home, '.local/share/ashlr/current/bin/ashlr');
  return ['phm', 'ashlr'].map((name) => {
    const path = join(io.home, '.local/bin', name);
    io.validateLocalPath(path);
    const stat = io.lstat(path);
    if (stat && (!stat.isSymbolicLink || io.readLink(path) !== target || !io.linkTargetExists(path))) fail(`${name} is not the existing owned, reachable Workbench link; resolve it explicitly`);
    return {path, target, identity: stat ? [stat.dev, stat.ino, stat.ctimeMs, stat.birthtimeMs] : null};
  });
}

export function createLocalAliases(aliases, io) {
  const created = [];
  try {
    for (const alias of aliases) {
      const stat = io.lstat(alias.path);
      if (alias.identity) {
        if (!stat?.isSymbolicLink || [stat.dev, stat.ino, stat.ctimeMs, stat.birthtimeMs].some((value, index) => value !== alias.identity[index]) || io.readLink(alias.path) !== alias.target || !io.linkTargetExists(alias.path)) fail('an existing CLI alias changed after preflight');
      } else {
        if (stat) fail('a CLI alias appeared after preflight');
        io.createAlias(alias.path, alias.target); // exclusive symlink creation, never ln -s directory semantics
        const owned = io.lstat(alias.path);
        created.push({...alias, identity: [owned.dev, owned.ino, owned.ctimeMs, owned.birthtimeMs]});
      }
    }
    return created;
  } catch (error) { removeCreatedAliases(created, io); throw error; }
}

export function removeCreatedAliases(created, io) {
  for (const alias of created) {
    const stat = io.lstat(alias.path);
    if (!stat?.isSymbolicLink || [stat.dev, stat.ino, stat.ctimeMs, stat.birthtimeMs].some((value, index) => value !== alias.identity[index]) || io.readLink(alias.path) !== alias.target) fail('a newly created alias changed; rollback held');
    io.removeAlias(alias.path);
  }
}

/** Stage and verify a complete bundle before changing the one active installation. */
export async function installLocalApp(input, io) {
  const { selected, source, signer, version, prepare, health } = input;
  if (typeof source !== 'string' || !input.sourceProof || input.sourceProof.path !== source) fail('the source bundle proof/path is missing');
  io.exclusiveRenamePreflight();
  if (selected) sameApp(selected, io);
  else if (paths.some((path) => io.exists(path))) fail('an app appeared after the install plan');
  await requireLocalQuiescence(io);
  const dir = io.makeInstallStage();
  const staged = join(dir, 'Phantom.app');
  const retired = join(dir, 'retired-bundle'); // no .app name: never another registered installation
  const archive = join(dir, 'previous-app.zip');
  let moved = false;
  let installed = false;
  let pointerChanged = false;
  let verified;
  const journal = (phase) => io.writeInstallJournal(dir, {schema: 'phantom-local-app-transaction/v1', phase, previousCurrent: input.previousCurrent ?? null, previousApp: selected?.path ?? null, previousInventory: selected?.inventory ?? null, app: PHANTOM_APP_PATH, archive: selected ? archive : null, version});
  journal('staging');
  try {
    if (input.sourceProof) sameApp(input.sourceProof, io);
    call(io, '/usr/bin/ditto', [source, staged]);
    if (input.sourceProof && io.appInventory(staged) !== input.sourceProof.inventory) fail('the copied source changed before staged preparation');
    if (input.preserveSigned === true) {
      // A publisher-authenticated update keeps the exact original app bytes.
      // Local build installation retains its existing preparation/signing path.
      for (const key of ['CFBundleName', 'CFBundleDisplayName']) if (call(io, '/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(staged, 'Contents', 'Info.plist')]).trim() !== 'Phantom') fail('the signed app display identity is unsupported');
      if (io.appInventory(staged) !== input.sourceProof.inventory) fail('the signed staged app changed');
    } else {
      await prepare(staged);
      call(io, '/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'Phantom', join(staged, 'Contents', 'Info.plist')]);
      call(io, '/usr/bin/plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Phantom', join(staged, 'Contents', 'Info.plist')]);
      call(io, '/usr/bin/codesign', ['--force', '--deep', '--sign', signer, '--entitlements', input.entitlements, staged]);
    }
    verified = inspectLocalApp(staged, signer, io);
    if (input.native) for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) if (call(io, '/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(staged, 'Contents', 'Info.plist')]).trim() !== version) fail('the staged native version does not match the source');
    if (selected) {
      sameApp(selected, io);
      call(io, '/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', selected.path, archive]);
      const check = join(dir, 'archive-check');
      call(io, '/usr/bin/ditto', ['-x', '-k', archive, check]);
      if (io.appInventory(join(check, basename(selected.path))) !== selected.inventory) fail('the full rollback archive does not match the selected app');
    }
    if (selected) {
      const current = selectLocalApp(signer, io);
      if (!current || current.path !== selected.path) fail('the selected installation changed before the switch');
      sameApp(selected, io);
    } else if (paths.some((path) => io.exists(path))) fail('an app appeared before installation');
    if (io.appInventory(staged) !== verified.inventory) fail('the verified staged app changed before installation');
    await requireLocalQuiescence(io); // last-contact guard after the potentially slow inventories
    if (input.beforeSwitch) await input.beforeSwitch(); // fresh caller admission after slow inventories
    journal('verified');
    if (selected) { io.renameExclusive(selected.path, retired, selected); moved = true; }
    io.renameExclusive(staged, PHANTOM_APP_PATH, verified); installed = true;
    const active = inspectLocalApp(PHANTOM_APP_PATH, signer, io);
    if (active.inventory !== verified.inventory) fail('the installed app does not match the staged verification');
    journal('switched');
    if (input.commitPointer) { pointerChanged = true; await input.commitPointer(); }
    // No resident restart or Stop release: the user owns resuming authority.
    call(io, '/usr/bin/open', [PHANTOM_APP_PATH]);
    if (!await health()) fail('the migrated app did not pass its owned launch/health check');
    if (io.appInventory(PHANTOM_APP_PATH) !== verified.inventory) fail('the launched app changed after verification');
    journal('accepted');
    if (selected) io.log(`      full non-launchable rollback archive: ${archive}`);
    // Keep the archive/journal, remove only temporary directory trees this transaction created.
    io.removeInstallTree(join(dir, 'archive-check'), dir);
    if (moved) io.removeInstallTree(retired, dir);
    return { app: PHANTOM_APP_PATH, rollbackArchive: selected ? archive : null };
  } catch (error) {
    if (error.currentPointerUncertain === true) {
      journal('rollback-held');
      io.log('ship:local: rollback held: verify the switched current pointer before recovering either app; Stop remains engaged');
      throw error;
    }
    try {
      if (installed) {
        // Never move a live replacement aside on a failed launch/health check.
        try { await requireLocalQuiescence(io); } catch {
          journal('rollback-held');
          io.log(`ship:local: rollback held: close the replacement app normally; original preserved at ${retired}; archive ${archive}`);
          throw error;
        }
        const actual = inspectLocalApp(PHANTOM_APP_PATH, signer, io);
        if (actual.dev !== verified.dev || actual.ino !== verified.ino || actual.inventory !== verified.inventory) fail('replacement identity changed; rollback held without moving it');
        io.renameExclusive(PHANTOM_APP_PATH, join(dir, 'failed-bundle'), actual);
      }
      if (pointerChanged) await input.rollbackPointer();
      if (moved) {
        const original = inspectLocalApp(retired, signer, io);
        if (original.dev !== selected.dev || original.ino !== selected.ino || original.inventory !== selected.inventory) fail('retired original changed; rollback held');
        io.renameExclusive(retired, selected.path, original);
        sameApp(selected, io);
        io.log(`      restored ${selected.path}; Stop remains engaged`);
      }
    } catch (recoveryError) {
      journal('rollback-held');
      throw recoveryError;
    }
    journal('rolled-back');
    throw error;
  }
}


export function createLocalAppTransactionIo({packageRoot, home = homedir(), Refusal = Error}) {
  const repoRoot = packageRoot;
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
    for (let parent = dirname(path); parent !== home; parent = dirname(parent)) {
      if (parent === dirname(parent) || !parent.startsWith(home + '/')) throw new Refusal('unsupported local installation path');
      try {const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refusal('unsafe local installation directory');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
  };
  const fileStat = (path) => { try { const stat = lstatSync(path); return { dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs, size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() }; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  const currentTarget = (path) => inspectCurrentPointer(path, {home: home, repoRoot, validateLocalPath: safeParents, lstat: fileStat, readLink: readlinkSync, readBoundedFile: (file, max) => safeFile(file, max).toString('utf8')});

  return {
    platform: process.platform,
    home: home,
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

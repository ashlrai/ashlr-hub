import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuntimeReleaseDependencyInventory } from '../dist/core/daemon/runtime-release-dependency-inventory.js';
import { assurePrivateStoragePath } from '../dist/core/util/private-storage.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(repositoryRoot, 'dist', 'release-dependency-inventory.json');

const MAX_NPM_CLI_BYTES = 4 * 1024 * 1024;
const MAX_NPM_PACKAGE_BYTES = 1024 * 1024;
const MAX_NPM_RUNTIME_FILE_BYTES = 128 * 1024 * 1024;
const MAX_NPM_RUNTIME_FILES = 20_000;
const MAX_NPM_RUNTIME_DIRECTORIES = 10_000;
const MAX_NPM_RUNTIME_ENTRIES = 40_000;
const MAX_NPM_RUNTIME_ENTRIES_PER_DIRECTORY = 10_000;
const MAX_NPM_RUNTIME_BYTES = 512 * 1024 * 1024;
const MAX_NPM_RUNTIME_DEPTH = 48;
const MAX_NPM_RUNTIME_SCAN_MS = 30_000;
const MAX_NPM_CLI_TIMEOUT_MS = 180_000;
const MAX_NPM_SNAPSHOT_CLEANUP_MS = 30_000;
const NPM_CLI_BOOTSTRAP = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const Module = require('node:module');",
  "const { fileURLToPath } = require('node:url');",
  'const filename = process.argv[1];',
  "const snapshotRoot = fs.realpathSync(process.env.ASHLR_NPM_SNAPSHOT_ROOT);",
  'delete process.env.ASHLR_NPM_SNAPSHOT_ROOT;',
  'const insideSnapshot = (candidate) => {',
  '  const nested = path.relative(snapshotRoot, candidate);',
  "  return nested === '' || (nested !== '..' && !nested.startsWith(`..${path.sep}`) && !path.isAbsolute(nested));",
  '};',
  "if (typeof Module.registerHooks !== 'function') throw new Error('Node 22.15 or newer is required');",
  'const confineModuleUrl = (url) => {',
  "  if (typeof url !== 'string') throw new Error('npm module escaped snapshot');",
  '  let candidate;',
  "  try { candidate = fileURLToPath(url); } catch { throw new Error('npm module escaped snapshot'); }",
  '  const canonical = fs.realpathSync(candidate);',
  "  if (canonical !== candidate || !insideSnapshot(canonical)) throw new Error('npm module escaped snapshot');",
  '};',
  'Module.registerHooks({',
  '  resolve(specifier, context, nextResolve) {',
  '    const resolved = nextResolve(specifier, context);',
  '    if (!Module.isBuiltin(specifier)) confineModuleUrl(resolved.url);',
  '    return resolved;',
  '  },',
  '});',
  "const source = fs.readFileSync(0, 'utf8');",
  'const npmCli = new Module(filename);',
  'npmCli.filename = filename;',
  'npmCli.paths = Module._nodeModulePaths(path.dirname(filename)).filter(insideSnapshot);',
  'npmCli._compile(source, filename);',
].join('\n');

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function fileIdentity(stat) {
  return {
    ctimeMs: stat.ctimeMs,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
    size: stat.size,
  };
}

function openStableRegularFile(path, label, maxBytes) {
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      before.size > maxBytes) {
      throw new Error(`${label} is not a bounded canonical regular file`);
    }
    const pathIdentity = lstatSync(path);
    const bytes = Buffer.alloc(before.size);
    const bytesRead = readSync(descriptor, bytes, 0, bytes.length, 0);
    const after = fstatSync(descriptor);
    if (!sameFileIdentity(before, pathIdentity) || !sameFileIdentity(before, after) ||
      bytesRead !== after.size) {
      throw new Error(`${label} changed during validation`);
    }
    return { bytes, descriptor, identity: before, label, path };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function assertOpenFileIsCurrent(opened) {
  let canonicalPath;
  try {
    canonicalPath = realpathSync(opened.path);
  } catch {
    throw new Error(`${opened.label} changed during execution`);
  }
  const current = lstatSync(opened.path);
  const descriptor = fstatSync(opened.descriptor);
  if (canonicalPath !== opened.path || !sameFileIdentity(opened.identity, current) ||
    !sameFileIdentity(opened.identity, descriptor)) {
    throw new Error(`${opened.label} changed during execution`);
  }
}

function observeNpmRuntimeClosure(npmRoot, snapshotRoot) {
  const records = [];
  const deadline = process.hrtime.bigint() + BigInt(MAX_NPM_RUNTIME_SCAN_MS) * 1_000_000n;
  let directoryCount = 0;
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  const checkDeadline = () => {
    if (process.hrtime.bigint() > deadline) {
      throw new Error('npm runtime closure scan exceeded deadline');
    }
  };

  const visit = (directory, depth) => {
    checkDeadline();
    if (depth > MAX_NPM_RUNTIME_DEPTH) {
      throw new Error('npm runtime closure exceeds traversal depth');
    }
    directoryCount += 1;
    if (directoryCount > MAX_NPM_RUNTIME_DIRECTORIES) {
      throw new Error('npm runtime closure exceeds directory limit');
    }
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory) {
      throw new Error('npm runtime closure contains an unsafe directory');
    }
    const logicalDirectory = relative(npmRoot, directory);
    const snapshotDirectory = snapshotRoot === undefined
      ? undefined
      : logicalDirectory === ''
        ? snapshotRoot
        : join(snapshotRoot, logicalDirectory);
    if (snapshotDirectory !== undefined && logicalDirectory !== '') {
      mkdirSync(snapshotDirectory, { mode: 0o700 });
    }
    const entries = [];
    const handle = opendirSync(directory);
    try {
      for (;;) {
        checkDeadline();
        const entry = handle.readSync();
        if (entry === null) break;
        entries.push(entry);
        entryCount += 1;
        if (entries.length > MAX_NPM_RUNTIME_ENTRIES_PER_DIRECTORY ||
          entryCount > MAX_NPM_RUNTIME_ENTRIES) {
          throw new Error('npm runtime closure exceeds entry limit');
        }
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      checkDeadline();
      const path = join(directory, entry.name);
      const logicalPath = relative(npmRoot, path).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        throw new Error('npm runtime closure contains a symbolic link');
      }
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error('npm runtime closure contains a non-file entry');
      const opened = openStableRegularFile(path, 'npm runtime file', MAX_NPM_RUNTIME_FILE_BYTES);
      try {
        fileCount += 1;
        totalBytes += opened.bytes.length;
        if (fileCount > MAX_NPM_RUNTIME_FILES || totalBytes > MAX_NPM_RUNTIME_BYTES) {
          throw new Error('npm runtime closure exceeds resource limits');
        }
        records.push({
          identity: fileIdentity(opened.identity),
          path: logicalPath,
          sha256: createHash('sha256').update(opened.bytes).digest('hex'),
          size: opened.bytes.length,
          type: 'file',
        });
        if (snapshotDirectory !== undefined) {
          writeFileSync(join(snapshotDirectory, entry.name), opened.bytes, {
            flag: 'wx',
            mode: (opened.identity.mode & 0o111) === 0 ? 0o400 : 0o500,
          });
        }
      } finally {
        closeSync(opened.descriptor);
      }
    }
    const after = lstatSync(directory);
    if (!sameFileIdentity(before, after) || realpathSync(directory) !== directory) {
      throw new Error('npm runtime closure changed during validation');
    }
    records.push({
      identity: fileIdentity(after),
      path: relative(npmRoot, directory).split(sep).join('/') || '.',
      type: 'directory',
    });
    if (snapshotDirectory !== undefined) chmodSync(snapshotDirectory, 0o500);
  };

  visit(npmRoot, 0);
  return createHash('sha256')
    .update('ashlr:npm-runtime-closure:v1\n', 'utf8')
    .update(JSON.stringify(records), 'utf8')
    .digest('hex');
}

function prepareNpmRuntimeSnapshot(launch, snapshotContainer) {
  const snapshotRoot = join(snapshotContainer, 'runtime');
  mkdirSync(snapshotRoot, { mode: 0o700 });
  try {
    const copiedDigest = observeNpmRuntimeClosure(launch.npmRoot, snapshotRoot);
    if (copiedDigest !== launch.npmRuntimeClosureSha256) {
      throw new Error('npm runtime closure changed before snapshot');
    }
    if (JSON.stringify(observeNpmRuntimeAncestors(launch.npmRoot, launch.toolchainRoot)) !==
      JSON.stringify(launch.npmRuntimeAncestors)) {
      throw new Error('npm runtime ancestor changed before snapshot');
    }
    const snapshotClosureSha256 = observeNpmRuntimeClosure(snapshotRoot);
    return {
      npmCliPath: join(snapshotRoot, 'bin', 'npm-cli.js'),
      cleanupRoot: snapshotContainer,
      root: snapshotRoot,
      rootIdentity: lstatSync(snapshotRoot),
      snapshotClosureSha256,
    };
  } catch (error) {
    removeNpmRuntimeSnapshot(snapshotContainer);
    throw error;
  }
}

function removeNpmRuntimeSnapshot(snapshotRoot) {
  if (!existsSync(snapshotRoot)) return;
  const deadline = process.hrtime.bigint() + BigInt(MAX_NPM_SNAPSHOT_CLEANUP_MS) * 1_000_000n;
  let directoryCount = 0;
  let entryCount = 0;
  const checkDeadline = () => {
    if (process.hrtime.bigint() > deadline) throw new Error('npm snapshot cleanup exceeded deadline');
  };
  const retryRemoval = (operation) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      checkDeadline();
      try {
        operation();
        return;
      } catch (error) {
        const code = error && typeof error === 'object' ? error.code : undefined;
        if (attempt === 3 || !['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code)) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
      }
    }
  };
  const removeEntry = (path, depth) => {
    checkDeadline();
    if (depth > MAX_NPM_RUNTIME_DEPTH) throw new Error('npm snapshot cleanup exceeds traversal depth');
    const before = lstatSync(path);
    if (before.isSymbolicLink()) throw new Error('npm snapshot cleanup contains a reparse entry');
    if (before.isFile()) {
      if (before.nlink !== 1) throw new Error('npm snapshot cleanup contains a hard-linked file');
      if (process.platform === 'win32') {
        chmodSync(path, 0o600);
        const afterChmod = lstatSync(path);
        if (!afterChmod.isFile() || afterChmod.isSymbolicLink() || afterChmod.nlink !== 1 ||
          afterChmod.dev !== before.dev || afterChmod.ino !== before.ino) {
          throw new Error('npm snapshot cleanup file changed during removal');
        }
      }
      retryRemoval(() => unlinkSync(path));
      return;
    }
    if (!before.isDirectory() || realpathSync(path) !== path) {
      throw new Error('npm snapshot cleanup contains an unsafe directory');
    }
    directoryCount += 1;
    if (directoryCount > MAX_NPM_RUNTIME_DIRECTORIES) {
      throw new Error('npm snapshot cleanup exceeds directory limit');
    }
    chmodSync(path, 0o700);
    const entries = [];
    const handle = opendirSync(path);
    try {
      for (;;) {
        checkDeadline();
        const entry = handle.readSync();
        if (entry === null) break;
        entries.push(entry);
        entryCount += 1;
        if (entries.length > MAX_NPM_RUNTIME_ENTRIES_PER_DIRECTORY ||
          entryCount > MAX_NPM_RUNTIME_ENTRIES) {
          throw new Error('npm snapshot cleanup exceeds entry limit');
        }
      }
    } finally {
      handle.closeSync();
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) removeEntry(join(path, entry.name), depth + 1);
    const after = lstatSync(path);
    if (!after.isDirectory() || after.isSymbolicLink() ||
      after.dev !== before.dev || after.ino !== before.ino || realpathSync(path) !== path) {
      throw new Error('npm snapshot cleanup directory changed during traversal');
    }
    retryRemoval(() => rmdirSync(path));
  };
  removeEntry(snapshotRoot, 0);
}

function assertNpmSnapshotDirectory(path, identity, anchorPath) {
  const assurance = assurePrivateStoragePath(path, 'directory', 'inspect-existing', { anchorPath });
  if (!assurance.ok) throw new Error(`npm snapshot storage changed: ${assurance.reason}`);
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() ||
    current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(path) !== path) {
    throw new Error('npm snapshot storage changed during execution');
  }
}

function assertNpmSnapshotDirectoryIdentity(path, identity) {
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() ||
    current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(path) !== path) {
    throw new Error('npm snapshot storage changed during execution');
  }
}

function removeExactEmptySnapshotContainer(path, identity) {
  const current = lstatSync(path);
  if (!current.isDirectory() || current.isSymbolicLink() ||
    current.dev !== identity.dev || current.ino !== identity.ino || realpathSync(path) !== path) {
    throw new Error('unauthoritative npm snapshot container changed before refusal');
  }
  const handle = opendirSync(path);
  let entry;
  try {
    entry = handle.readSync();
  } finally {
    handle.closeSync();
  }
  if (entry !== null) throw new Error('unauthoritative npm snapshot container is not empty');
  chmodSync(path, 0o700);
  const after = lstatSync(path);
  if (!after.isDirectory() || after.isSymbolicLink() ||
    after.dev !== identity.dev || after.ino !== identity.ino || realpathSync(path) !== path) {
    throw new Error('unauthoritative npm snapshot container changed during refusal');
  }
  rmdirSync(path);
}

function createNpmRuntimeSnapshotContainer() {
  const parent = realpathSync(process.platform === 'win32' ? homedir() : tmpdir());
  const snapshotRoot = realpathSync(mkdtempSync(join(parent, '.ashlr-npm-runtime-')));
  const before = lstatSync(snapshotRoot);
  let authorityEstablished = false;
  try {
    chmodSync(snapshotRoot, 0o700);
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(snapshotRoot) !== snapshotRoot) {
      throw new Error('npm snapshot container is unsafe');
    }
    const assurance = assurePrivateStoragePath(snapshotRoot, 'directory', 'secure-created', {
      anchorPath: parent,
    });
    if (!assurance.ok) throw new Error(`npm snapshot container is unsafe: ${assurance.reason}`);
    const after = lstatSync(snapshotRoot);
    if (!after.isDirectory() || after.isSymbolicLink() ||
      after.dev !== before.dev || after.ino !== before.ino || realpathSync(snapshotRoot) !== snapshotRoot) {
      throw new Error('npm snapshot container changed during storage assurance');
    }
    authorityEstablished = true;
    return snapshotRoot;
  } catch (error) {
    if (authorityEstablished) removeNpmRuntimeSnapshot(snapshotRoot);
    else removeExactEmptySnapshotContainer(snapshotRoot, before);
    throw error;
  }
}

function observeNpmRuntimeAncestors(npmRoot, toolchainRoot) {
  const ancestors = [];
  let current = npmRoot;
  for (;;) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(current) !== current) {
      throw new Error('npm runtime ancestor is not a canonical directory');
    }
    ancestors.push({ identity: fileIdentity(stat), path: current });
    if (current === toolchainRoot) break;
    const parent = dirname(current);
    if (parent === current) throw new Error('npm runtime is outside the Node toolchain root');
    current = parent;
  }
  return ancestors;
}

function trustedNodeToolchainRoot(execPath, platform) {
  const executableDirectory = dirname(realpathSync(execPath));
  return platform === 'win32' ? executableDirectory : dirname(executableDirectory);
}

function trustedNpmCliPath(execPath, platform) {
  const canonicalExecPath = realpathSync(execPath);
  const executableDirectory = dirname(canonicalExecPath);
  return platform === 'win32'
    ? join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

export function resolveNpmCliLaunch(environment = process.env, runtime = {}) {
  const command = runtime.command ?? process.execPath;
  const platform = runtime.platform ?? process.platform;
  const execPath = runtime.execPath ?? process.execPath;
  const trustedCli = trustedNpmCliPath(execPath, platform);
  const toolchainRoot = trustedNodeToolchainRoot(execPath, platform);
  const canonicalCli = realpathSync(trustedCli);
  if (canonicalCli !== trustedCli || basename(canonicalCli) !== 'npm-cli.js' ||
    basename(dirname(canonicalCli)) !== 'bin') {
    throw new Error('trusted Node toolchain npm CLI path is invalid');
  }
  const npmExecPath = environment.npm_execpath;
  if (npmExecPath !== undefined) {
    if (typeof npmExecPath !== 'string' || npmExecPath.length === 0 || npmExecPath.length > 4096 ||
      /[\0\r\n]/u.test(npmExecPath) || !isAbsolute(npmExecPath) ||
      realpathSync(npmExecPath) !== canonicalCli) {
      throw new Error('npm_execpath does not match the trusted Node toolchain');
    }
  }
  const npmRoot = dirname(dirname(canonicalCli));
  if (basename(npmRoot) !== 'npm' || realpathSync(npmRoot) !== npmRoot) {
    throw new Error('trusted Node toolchain npm CLI is not rooted in an npm package');
  }
  const packageJsonPath = join(npmRoot, 'package.json');
  if (realpathSync(packageJsonPath) !== packageJsonPath) {
    throw new Error('npm package identity path is not canonical');
  }
  const npmCli = openStableRegularFile(canonicalCli, 'npm CLI', MAX_NPM_CLI_BYTES);
  let packageJson;
  try {
    packageJson = openStableRegularFile(
      packageJsonPath,
      'npm package identity',
      MAX_NPM_PACKAGE_BYTES,
    );
  } catch (error) {
    closeSync(npmCli.descriptor);
    throw error;
  }
  let packageIdentity;
  try {
    packageIdentity = JSON.parse(packageJson.bytes.toString('utf8'));
  } catch {
    closeSync(npmCli.descriptor);
    closeSync(packageJson.descriptor);
    throw new Error('npm package identity is invalid');
  }
  if (packageIdentity === null || typeof packageIdentity !== 'object' ||
    packageIdentity.name !== 'npm' || typeof packageIdentity.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageIdentity.version)) {
    closeSync(npmCli.descriptor);
    closeSync(packageJson.descriptor);
    throw new Error('npm package identity is invalid');
  }
  let npmRuntimeClosureSha256;
  let npmRuntimeAncestors;
  try {
    npmRuntimeAncestors = observeNpmRuntimeAncestors(npmRoot, toolchainRoot);
    npmRuntimeClosureSha256 = observeNpmRuntimeClosure(npmRoot);
  } catch (error) {
    closeSync(npmCli.descriptor);
    closeSync(packageJson.descriptor);
    throw error;
  }
  return {
    command,
    npmCli,
    npmCliPath: canonicalCli,
    npmRoot,
    npmRuntimeAncestors,
    npmRuntimeClosureSha256,
    packageJson,
    toolchainRoot,
  };
}

export function runTrustedNpmCli(args, options = {}, runtime = {}) {
  const {
    environment: launchEnvironment = process.env,
    env: requestedEnvironment = {},
    ...spawnOptions
  } = options;
  const timeout = spawnOptions.timeout ?? MAX_NPM_CLI_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_NPM_CLI_TIMEOUT_MS) {
    throw new Error('npm CLI timeout is invalid');
  }
  const snapshotContainer = createNpmRuntimeSnapshotContainer();
  const snapshotContainerIdentity = lstatSync(snapshotContainer);
  const childTemporaryRoot = join(snapshotContainer, 'tmp');
  mkdirSync(childTemporaryRoot, { mode: 0o700 });
  const childTemporaryIdentity = lstatSync(childTemporaryRoot);
  let launch;
  let snapshot;
  try {
    launch = resolveNpmCliLaunch(launchEnvironment, runtime);
    snapshot = prepareNpmRuntimeSnapshot(launch, snapshotContainer);
    runtime.beforeSpawn?.(launch, snapshot);
    assertNpmSnapshotDirectory(snapshotContainer, snapshotContainerIdentity, dirname(snapshotContainer));
    assertNpmSnapshotDirectoryIdentity(snapshot.root, snapshot.rootIdentity);
    assertNpmSnapshotDirectoryIdentity(childTemporaryRoot, childTemporaryIdentity);
    if (observeNpmRuntimeClosure(snapshot.root) !== snapshot.snapshotClosureSha256) {
      throw new Error('npm snapshot changed before execution');
    }
    const environment = { ...process.env, ...requestedEnvironment };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    environment.ASHLR_NPM_SNAPSHOT_ROOT = snapshot.root;
    environment.TEMP = childTemporaryRoot;
    environment.TMP = childTemporaryRoot;
    environment.TMPDIR = childTemporaryRoot;
    environment.npm_execpath = snapshot.npmCliPath;
    environment.npm_node_execpath = launch.command;
    environment.npm_config_ignore_scripts = 'true';
    const result = spawnSync(
      launch.command,
      ['--eval', NPM_CLI_BOOTSTRAP, snapshot.npmCliPath, ...args],
      {
        ...spawnOptions,
        encoding: spawnOptions.encoding ?? 'utf8',
        env: environment,
        input: launch.npmCli.bytes,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
      },
    );
    if (observeNpmRuntimeClosure(snapshot.root) !== snapshot.snapshotClosureSha256) {
      throw new Error('npm snapshot changed during execution');
    }
    assertOpenFileIsCurrent(launch.npmCli);
    assertOpenFileIsCurrent(launch.packageJson);
    if (observeNpmRuntimeClosure(launch.npmRoot) !== launch.npmRuntimeClosureSha256) {
      throw new Error('npm runtime closure changed during execution');
    }
    if (JSON.stringify(observeNpmRuntimeAncestors(launch.npmRoot, launch.toolchainRoot)) !==
      JSON.stringify(launch.npmRuntimeAncestors)) {
      throw new Error('npm runtime ancestor changed during execution');
    }
    return result;
  } finally {
    try {
      if (launch !== undefined) {
        closeSync(launch.npmCli.descriptor);
        closeSync(launch.packageJson.descriptor);
      }
    } finally {
      if (snapshot !== undefined) removeNpmRuntimeSnapshot(snapshot.cleanupRoot);
      else if (launch === undefined) removeNpmRuntimeSnapshot(snapshotContainer);
    }
  }
}

export function buildReleaseDependencyInventory() {
  const packed = runTrustedNpmCli(
    ['pack', '--dry-run', '--ignore-scripts', '--json'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (packed.status !== 0) {
    throw new Error(`release dependency inventory npm pack: ${packed.stderr.trim()}`);
  }
  const report = JSON.parse(packed.stdout);
  const packagedFiles = report[0]?.files;
  if (!Array.isArray(packagedFiles)) throw new Error('npm pack file report is missing');
  const built = buildRuntimeReleaseDependencyInventory(repositoryRoot, { packagedFiles });
  if (!built.ok) throw new Error(`release dependency inventory: ${built.reason}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, built.canonicalJson, { encoding: 'utf8', mode: 0o644 });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    buildReleaseDependencyInventory();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

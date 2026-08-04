import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuntimeReleaseDependencyInventory } from '../dist/core/daemon/runtime-release-dependency-inventory.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(repositoryRoot, 'dist', 'release-dependency-inventory.json');

const MAX_NPM_CLI_BYTES = 4 * 1024 * 1024;
const MAX_NPM_PACKAGE_BYTES = 1024 * 1024;
const NPM_CLI_BOOTSTRAP = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const Module = require('node:module');",
  'const filename = process.argv[1];',
  "const source = fs.readFileSync(0, 'utf8');",
  'const npmCli = new Module(filename);',
  'npmCli.filename = filename;',
  'npmCli.paths = Module._nodeModulePaths(path.dirname(filename));',
  'npmCli._compile(source, filename);',
].join('\n');

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
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
  const trustedCli = trustedNpmCliPath(runtime.execPath ?? process.execPath, platform);
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
  return { command, npmCli, npmCliPath: canonicalCli, packageJson };
}

export function runTrustedNpmCli(args, options = {}, runtime = {}) {
  const {
    environment: launchEnvironment = process.env,
    env: requestedEnvironment = {},
    ...spawnOptions
  } = options;
  const launch = resolveNpmCliLaunch(launchEnvironment, runtime);
  try {
    runtime.beforeSpawn?.(launch);
    const environment = { ...process.env, ...requestedEnvironment };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    environment.npm_execpath = launch.npmCliPath;
    environment.npm_node_execpath = launch.command;
    environment.npm_config_ignore_scripts = 'true';
    const result = spawnSync(
      launch.command,
      ['--eval', NPM_CLI_BOOTSTRAP, launch.npmCliPath, ...args],
      {
        ...spawnOptions,
        encoding: spawnOptions.encoding ?? 'utf8',
        env: environment,
        input: launch.npmCli.bytes,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    assertOpenFileIsCurrent(launch.npmCli);
    assertOpenFileIsCurrent(launch.packageJson);
    return result;
  } finally {
    closeSync(launch.npmCli.descriptor);
    closeSync(launch.packageJson.descriptor);
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

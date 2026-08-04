import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuntimeReleaseDependencyInventory } from '../dist/core/daemon/runtime-release-dependency-inventory.js';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(repositoryRoot, 'dist', 'release-dependency-inventory.json');

const MAX_NPM_CLI_BYTES = 4 * 1024 * 1024;
const MAX_NPM_PACKAGE_BYTES = 1024 * 1024;

function stableRegularFile(path, label, maxBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`${label} is not a bounded canonical regular file`);
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
    before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
    throw new Error(`${label} changed during validation`);
  }
  return bytes;
}

export function resolveNpmCliLaunch(environment = process.env) {
  const npmExecPath = environment.npm_execpath;
  if (typeof npmExecPath !== 'string' || npmExecPath.length === 0 || npmExecPath.length > 4096 ||
    /[\0\r\n]/u.test(npmExecPath) || !isAbsolute(npmExecPath) || resolve(npmExecPath) !== npmExecPath) {
    throw new Error('npm_execpath is missing or invalid');
  }
  const canonicalCli = realpathSync(npmExecPath);
  if (canonicalCli !== npmExecPath || basename(canonicalCli) !== 'npm-cli.js' ||
    basename(dirname(canonicalCli)) !== 'bin') {
    throw new Error('npm_execpath is not a canonical npm CLI path');
  }
  stableRegularFile(canonicalCli, 'npm CLI', MAX_NPM_CLI_BYTES);
  const npmRoot = dirname(dirname(canonicalCli));
  if (basename(npmRoot) !== 'npm' || realpathSync(npmRoot) !== npmRoot) {
    throw new Error('npm_execpath is not rooted in an npm package');
  }
  const packageJsonPath = join(npmRoot, 'package.json');
  if (realpathSync(packageJsonPath) !== packageJsonPath) {
    throw new Error('npm package identity path is not canonical');
  }
  let packageIdentity;
  try {
    packageIdentity = JSON.parse(
      stableRegularFile(packageJsonPath, 'npm package identity', MAX_NPM_PACKAGE_BYTES)
        .toString('utf8'),
    );
  } catch {
    throw new Error('npm package identity is invalid');
  }
  if (packageIdentity === null || typeof packageIdentity !== 'object' ||
    packageIdentity.name !== 'npm' || typeof packageIdentity.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageIdentity.version)) {
    throw new Error('npm package identity is invalid');
  }
  return { command: process.execPath, npmCliPath: canonicalCli };
}

export function buildReleaseDependencyInventory() {
  const launch = resolveNpmCliLaunch();
  const packed = spawnSync(
    launch.command,
    [launch.npmCliPath, 'pack', '--dry-run', '--ignore-scripts', '--json'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
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

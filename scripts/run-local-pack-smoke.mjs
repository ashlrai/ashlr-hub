#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`local pack smoke: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited ${result.status ?? 'without a status'}`);
}

function runNpm(args, options) {
  const npmCli = process.env.ASHLR_NPM_CLI;
  if (npmCli) return run(process.execPath, [npmCli, ...args], options);
  return run('npm', args, options);
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--repo', '--work-dir', '--output'].includes(flag) || value === undefined
      || options[flag] !== undefined) {
      fail(`invalid or duplicate option ${flag ?? '<missing>'}`);
    }
    options[flag] = value;
  }
  if (!options['--repo'] || !options['--work-dir'] || !options['--output']) {
    fail('usage: run-local-pack-smoke.mjs --repo <path> --work-dir <path> --output <path>');
  }
  const repo = resolve(options['--repo']);
  const workDir = resolve(options['--work-dir']);
  const output = options['--output'];
  if (!isAbsolute(output)) fail('--output must be absolute');
  return { repo, workDir, output: resolve(output) };
}

export function tarballEvidence(bytes) {
  return Object.freeze({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    size: bytes.length,
  });
}

export function runLocalPackSmoke({ repo, workDir, output }) {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  if (pkg.name !== '@ashlr/hub' || typeof pkg.version !== 'string') fail('unexpected package identity');
  const tarballName = `ashlr-hub-${pkg.version}.tgz`;
  const packDir = join(workDir, 'pack');
  const installDir = join(workDir, 'install');
  mkdirSync(packDir, { recursive: true, mode: 0o700 });
  mkdirSync(installDir, { recursive: true, mode: 0o700 });
  runNpm(['pack', '--silent', '--ignore-scripts', '--pack-destination', packDir], { cwd: repo });
  const tarballPath = join(packDir, tarballName);
  const tarball = statSync(tarballPath);
  if (!tarball.isFile() || tarball.size < 1 || tarball.size > 64 * 1024 * 1024) {
    fail('packed tarball must be a regular file between 1 byte and 64 MiB');
  }
  const bytes = readFileSync(tarballPath);
  if (bytes.length < 1) fail('packed tarball is empty');

  runNpm(['init', '-y'], { cwd: installDir });
  runNpm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], { cwd: installDir });
  const bin = process.platform === 'win32'
    ? join(installDir, 'node_modules', '.bin', 'ashlr.cmd')
    : join(installDir, 'node_modules', '.bin', 'ashlr');
  if (process.platform !== 'win32') chmodSync(bin, 0o755);
  run(bin, ['help'], { cwd: installDir });
  run(process.execPath, ['--input-type=module', '-e',
    "const types = await import('@ashlr/hub/types'); if (!types) throw new Error('types surface broken');"],
  { cwd: installDir });
  run(process.execPath, ['--input-type=module', '-e',
    "const core = await import('@ashlr/hub/core'); if (typeof core.loadConfig !== 'function') throw new Error('core surface broken');"],
  { cwd: installDir });

  const evidence = Object.freeze({
    schemaVersion: 1,
    name: pkg.name,
    version: pkg.version,
    tarballName,
    ...tarballEvidence(bytes),
  });
  const fd = openSync(output, 'wx', 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(evidence)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  return evidence;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invoked) {
  try {
    runLocalPackSmoke(parseCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

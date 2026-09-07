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

// This self-contained function runs in the clean install directory, so package
// exports and CLI imports resolve from the tarball, never the source checkout.
async function verifyInstalledUniverse(fixtureRoot, bin) {
  const { default: assert } = await import('node:assert/strict');
  const { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const sdk = await import('@ashlr/hub/universe');
  for (const name of ['defaultUniverseRoot', 'ensureUniverseRoot', 'validateUniverseManifest',
    'initUniverse', 'readUniverseOverview', 'runUniverse', 'validateUniverseCampaignDefinition',
    'initUniverseCampaign', 'readUniverseCampaign', 'readUniverseCampaigns',
    'requestUniverseCampaignControl', 'runUniverseCampaign', 'deliverUniverseElite',
    'readUniverseDeliveries', 'validUniverseDeliveryBranch', 'buildUniverseGraph',
    'readUniverseGraph', 'traverseUniverseGraph']) {
    assert.equal(typeof sdk[name], 'function', `Universe SDK export missing: ${name}`);
  }
  mkdirSync(fixtureRoot, { mode: 0o700 });
  const execute = (command, args, cwd, expectedStatus = 0) => {
    const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, expectedStatus,
      `Installed Universe command failed (${args.join(' ')}): ${result.stderr}`);
    return result.stdout;
  };
  const cli = (args, expectedStatus = 0) => execute(bin, ['universe', ...args], fixtureRoot, expectedStatus);
  const json = (args, expectedStatus = 0) => JSON.parse(cli([...args, '--json'], expectedStatus));
  const missing = join(fixtureRoot, 'missing-store');
  assert.equal(sdk.readUniverseOverview({ root: missing }).sourceState, 'missing');
  assert.equal(sdk.readUniverseCampaigns({ root: missing }).sourceState, 'missing');
  assert.equal(sdk.readUniverseDeliveries('pack-universe', { root: missing }).sourceState, 'missing');
  assert.equal(sdk.readUniverseGraph('pack-universe', { root: missing }).sourceState, 'missing');
  assert.equal(json(['status', '--root', missing]).sourceState, 'missing');
  assert.equal(json(['campaign', 'status', '--root', missing]).sourceState, 'missing');
  assert.equal(json(['deliveries', 'pack-universe', '--root', missing]).sourceState, 'missing');
  assert.equal(json(['graph', 'pack-universe', '--root', missing], 1).sourceState, 'missing');
  assert.equal(existsSync(missing), false, 'Status reads must not create a missing store');
  assert.match(cli(['help']), /campaign/);
  assert.match(cli(['campaign', 'help']), /resume/);
  assert.match(cli(['deliver', '--help']), /deliveries/);
  assert.match(cli(['deliveries', '--help']), /deliver/);
  assert.match(cli(['graph', '--help']), /ancestors/);
  assert.equal(typeof json(['status', '--unexpected', '--root', missing], 2).error, 'string');
  assert.equal(typeof json(['campaign', 'run', '--unexpected', '--root', missing], 2).error, 'string');
  assert.equal(typeof json(['deliver', 'pack-universe', '--unexpected', '--root', missing], 2).error, 'string');
  assert.equal(typeof json(['graph', 'pack-universe', '--depth', '0', '--root', missing], 2).error, 'string');
  assert.equal(existsSync(missing), false, 'Invalid CLI flags must not create a store');

  const seed = join(fixtureRoot, 'seed');
  mkdirSync(seed, { mode: 0o700 });
  writeFileSync(join(seed, 'never-run.mjs'),
    "throw new Error('Package smoke must not execute a worker or evaluator');\n", { mode: 0o600 });
  const git = (...args) => execute('git', args, seed).trim();
  git('init', '-q');
  git('add', 'never-run.mjs');
  git('-c', 'user.name=Package Smoke', '-c', 'user.email=package-smoke@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'private smoke fixture');
  const root = join(fixtureRoot, 'store');
  const manifest = { schemaVersion: 1, id: 'pack-universe', name: 'Installed package smoke',
    objective: 'Verify registration and observation without executing work',
    seed: { repo: seed, revision: git('rev-parse', 'HEAD') },
    metric: { name: 'score', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'never-run.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'never-run', niche: 'smoke', hypothesis: 'No execution is expected',
      command: [process.execPath, 'never-run.mjs'] }] };
  const definition = { schemaVersion: 1, id: 'pack-sdk', universeId: manifest.id, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 1000, maxModelRequests: 0,
      maxStagnantGenerations: 1, maxReportedTokens: null } };
  const assertIdle = (summary, state) => {
    assert.equal(summary.sourceState, 'healthy');
    assert.equal(summary.state, state);
    assert.equal(summary.owner, null);
    assert.equal(summary.startedAt, null);
    assert.equal(summary.deadlineAt, null);
    assert.deepEqual(summary.steps, []);
    assert.equal(summary.progress.attempts, 0);
    assert.equal(summary.progress.reservedModelRequests, 0);
  };
  const pinnedSeed = join(root, 'universes', manifest.id, 'seed');
  try {
    assert.equal(sdk.initUniverse(manifest, { root }).id, manifest.id);
    const beforeRefs = git('show-ref');
    await assert.rejects(sdk.deliverUniverseElite(manifest.id, {
      root, trialId: 'missing-trial', branch: 'codex/never-delivered',
    }), /current independently selected elite/);
    assert.equal(typeof json(['deliver', manifest.id, '--trial', 'missing-trial',
      '--branch', 'codex/never-delivered', '--root', root], 1).error, 'string');
    assert.equal(git('show-ref'), beforeRefs, 'Rejected delivery must not change repository refs');
    assert.deepEqual(sdk.readUniverseDeliveries(manifest.id, { root }).deliveries, []);
    assertIdle(sdk.initUniverseCampaign(definition, { root }), 'ready');
    assertIdle(sdk.readUniverseCampaign(definition.id, { root }), 'ready');
    assertIdle(sdk.requestUniverseCampaignControl(definition.id, 'pause', { root }), 'paused');
    const stopped = sdk.requestUniverseCampaignControl(definition.id, 'stop', { root });
    assertIdle(stopped, 'stopped');
    // Terminal idempotence exercises the public entrypoint without starting work.
    assert.deepEqual(await sdk.runUniverseCampaign(definition.id, { root }), stopped,
      'A stopped campaign must not begin work or change its evidence');

    const path = join(fixtureRoot, 'campaign.json');
    writeFileSync(path, JSON.stringify({ ...definition, id: 'pack-cli' }), { mode: 0o600 });
    assertIdle(json(['campaign', 'init', '--manifest', path, '--root', root]), 'ready');
    assertIdle(json(['campaign', 'status', 'pack-cli', '--root', root]), 'ready');
    assertIdle(json(['campaign', 'pause', 'pack-cli', '--root', root]), 'paused');
    assertIdle(json(['campaign', 'stop', 'pack-cli', '--root', root]), 'stopped');
    assertIdle(json(['campaign', 'resume', 'pack-cli', '--root', root]), 'stopped');
    assert.equal(json(['campaign', 'status', '--root', root]).campaigns.length, 2);
    const overview = sdk.readUniverseOverview({ root });
    assert.equal(overview.sourceState, 'healthy');
    assert.equal(overview.campaigns.length, 2);
    assert.equal(overview.universes.length, 1);
    assert.deepEqual(overview.universes[0].runs, []);
    assert.deepEqual(overview.universes[0].elites, []);
    assert.equal(overview.universes[0].activeRun, null);
    const graph = sdk.readUniverseGraph(manifest.id, { root });
    assert.equal(graph.sourceState, 'healthy');
    assert.equal(graph.complete, true);
    assert.equal(graph.authority, 'observation-only');
    assert.equal(graph.nodes.filter((node) => node.kind === 'campaign').length, 2);
    assert.equal(graph.nodes.some((node) => node.kind === 'trial'), false);
    const cliGraph = json(['graph', manifest.id, '--root', root]);
    assert.deepEqual(cliGraph.nodes, graph.nodes, 'Installed SDK and CLI must expose the same graph');
    const focus = graph.nodes.find((node) => node.kind === 'universe');
    assert(focus, 'Registered graph must contain its Universe');
    const traversal = json(['graph', manifest.id, '--root', root, '--node', focus.id,
      '--direction', 'descendants', '--depth', '64']);
    assert.equal(traversal.traversal.complete, true);
    assert(traversal.traversal.nodeIds.includes(focus.id));
    assert.deepEqual(sdk.traverseUniverseGraph(graph, { nodeId: focus.id, direction: 'descendants', maxDepth: 64 }),
      traversal.traversal, 'Installed traversal must agree across SDK and CLI');
  } finally {
    // The fixture is a single-file seed created by this invocation. Unfreeze
    // only its directory so the surrounding gate can remove its disposable root.
    if (existsSync(pinnedSeed)) {
      const identity = lstatSync(pinnedSeed);
      assert(identity.isDirectory() && !identity.isSymbolicLink());
      chmodSync(pinnedSeed, 0o700);
    }
  }
  process.stdout.write('Installed Universe SDK and campaign smoke: passed (no work executed)\n');
}

export function installedUniverseSmokeArgs(fixtureRoot, bin) {
  return ['--input-type=module', '-e',
    `await (${verifyInstalledUniverse.toString()})(${JSON.stringify(fixtureRoot)}, ${JSON.stringify(bin)});`];
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
  run(process.execPath, installedUniverseSmokeArgs(join(workDir, 'universe-smoke'), bin), { cwd: installDir });

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

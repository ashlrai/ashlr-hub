#!/usr/bin/env node
// Inventory only: never collect/import tests, execute a shard, or attest a gate.
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_NATIVE_CANDIDATES } from '../test/config/release-native-candidates.mjs';

const MAX_FILES = 10_000;
const fail = (reason) => { throw new Error(`release-test-coverage: ${reason}`); };
const key = ({ project, file }) => `${project}\0${file}`;

function specs(value, label) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_FILES) fail(`${label} census invalid`);
  const pairs = new Set();
  const files = new Set();
  return Array.from(value, (entry) => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'file,project' ||
      typeof entry.project !== 'string' || !/^[a-zA-Z0-9._-]{1,80}$/.test(entry.project) ||
      typeof entry.file !== 'string' || !/^test\/(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.test\.ts$/.test(entry.file) ||
      entry.file.split('/').some((part) => part === '.' || part === '..')) fail(`${label} entry invalid`);
    if (pairs.has(key(entry)) || files.has(entry.file)) fail(`${label} duplicate file or project assignment`);
    pairs.add(key(entry)); files.add(entry.file);
    return { project: entry.project, file: entry.file };
  }).sort((a, b) => key(a).localeCompare(key(b)));
}

/** Verify explicit assignments independently against unfiltered discovery. */
export function verifyReleaseTestCoverage(discovered, nativeCandidates, assignments) {
  const census = specs(discovered, 'default');
  const native = specs(nativeCandidates, 'native');
  const available = new Map(census.map((entry) => [key(entry), entry]));
  const nativeKeys = new Set(native.map(key));
  for (const entry of native) if (!available.has(key(entry))) fail('native file missing or project mismatch');
  if (!Array.isArray(assignments) || assignments.length > MAX_FILES) fail('assignments invalid');
  const seen = new Set();
  const groups = { ordinary: [], native: [] };
  for (const entry of assignments) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'file,group,project' ||
      typeof entry.project !== 'string' || typeof entry.file !== 'string' ||
      (entry.group !== 'ordinary' && entry.group !== 'native')) fail('assignment invalid');
    const id = key(entry);
    if (!available.has(id)) fail('unknown assignment or project mismatch');
    if (seen.has(id)) fail('duplicate assignment');
    if ((entry.group === 'native') !== nativeKeys.has(id)) fail('assignment differs from native manifest');
    seen.add(id); groups[entry.group].push(available.get(id));
  }
  if (seen.size !== census.length) fail('unassigned default file');
  for (const entries of Object.values(groups)) entries.sort((a, b) => key(a).localeCompare(key(b)));
  return {
    schemaVersion: 1,
    kind: 'release-test-coverage-inventory',
    scope: 'hypothetical-whole-file-partition',
    testsExecuted: false,
    gateAttestation: false,
    default: census,
    groups,
    counts: { default: census.length, ordinary: groups.ordinary.length, native: groups.native.length },
  };
}

export function proposeReleaseTestCoverage(discovered, nativeCandidates = RELEASE_NATIVE_CANDIDATES) {
  const native = specs(nativeCandidates, 'native');
  const nativeKeys = new Set(native.map(key));
  return verifyReleaseTestCoverage(discovered, native, specs(discovered, 'default').map((entry) => ({
    ...entry, group: nativeKeys.has(key(entry)) ? 'native' : 'ordinary',
  })));
}

/** Check actual config discoveries and actual configured sequencer membership. */
export function verifyConfiguredReleaseTestCoverage(
  discovered, ordinaryFiles, nativeFiles, ordinaryShards, nativeCandidates = RELEASE_NATIVE_CANDIDATES,
) {
  const ordinary = specs(ordinaryFiles, 'ordinary configuration');
  const native = specs(nativeFiles, 'native configuration');
  const report = verifyReleaseTestCoverage(discovered, nativeCandidates, [
    ...ordinary.map((entry) => ({ ...entry, group: 'ordinary' })),
    ...native.map((entry) => ({ ...entry, group: 'native' })),
  ]);
  if (!Array.isArray(ordinaryShards) || ordinaryShards.length !== 3) fail('exactly three ordinary shards required');
  const expected = new Set(ordinary.map(key));
  const assigned = new Set();
  const shards = Array.from(ordinaryShards, (files, offset) => {
    const entries = specs(files, `ordinary shard ${offset + 1}`);
    for (const entry of entries) {
      const id = key(entry);
      if (!expected.has(id)) fail('foreign file or project in ordinary shard');
      if (assigned.has(id)) fail('overlapping ordinary shards');
      assigned.add(id);
    }
    return { index: offset + 1, count: 3, files: entries };
  });
  if (assigned.size !== expected.size) fail('ordinary file omitted by configured sequencer');
  return {
    ...report,
    schemaVersion: 2,
    scope: 'configured-whole-file-partition',
    ordinaryShards: shards,
  };
}

function projectFiles(discovered, canonicalRoot, label) {
  if (!Array.isArray(discovered)) fail(`${label} census invalid`);
  return specs(Array.from(discovered, (entry) => {
    if (!entry || typeof entry.moduleId !== 'string' || !entry.project) fail(`${label} specification invalid`);
    const canonicalFile = realpathSync(entry.moduleId);
    const file = relative(canonicalRoot, canonicalFile).replaceAll('\\', '/');
    if (isAbsolute(file) || file.startsWith('../')) fail('discovered file escapes root');
    // Refuse aliases rather than silently changing the discovered identity.
    if (resolve(entry.moduleId) !== canonicalFile) fail('discovered file is a path alias');
    return { project: entry.project.name, file };
  }), label);
}

async function discoverTestConfiguration(root, config, shardIndex) {
  const canonicalRoot = realpathSync(root);
  const { createVitest } = await import('vitest/node');
  let context;
  try {
    context = await createVitest('test', {
      root: canonicalRoot, config: resolve(canonicalRoot, config),
      watch: false, run: true, api: false, ui: false,
      ...(shardIndex === undefined ? {} : { shard: `${shardIndex}/3` }),
    });
    // Only file discovery; collecting modules can run user test code.
    const discovered = await context.globTestSpecifications();
    const files = projectFiles(discovered, canonicalRoot, 'default');
    if (shardIndex === undefined) return { files };
    if (context.config.shard?.index !== shardIndex || context.config.shard.count !== 3) fail('configured shard mismatch');
    if (discovered.length < 3) fail('too few ordinary files for three shards');
    const Sequencer = context.config.sequence.sequencer;
    // Mirrors Vitest's execution path: shard the complete project list before
    // sort/worker grouping. files-only listing alone does not apply sharding.
    const selected = await new Sequencer(context).shard([...discovered]);
    return { files, selected: projectFiles(selected, canonicalRoot, 'configured shard') };
  } finally {
    if (context) await context.close();
  }
}

/** Trusted local config is executed; test modules and setup files are not. */
export async function discoverReleaseTestFiles(root) {
  return (await discoverTestConfiguration(root, 'vitest.config.ts')).files;
}

export async function discoverConfiguredReleaseTestCoverage(root, nativeCandidates = RELEASE_NATIVE_CANDIDATES) {
  const baseline = await discoverReleaseTestFiles(root);
  const native = await discoverTestConfiguration(root, 'vitest.config.release-native.ts');
  const shards = [];
  let ordinary;
  for (let index = 1; index <= 3; index++) {
    const discovered = await discoverTestConfiguration(root, 'vitest.config.release-ordinary.ts', index);
    if (ordinary && JSON.stringify(ordinary) !== JSON.stringify(discovered.files)) fail('ordinary discovery changed between shards');
    ordinary = discovered.files;
    shards.push(discovered.selected);
  }
  return verifyConfiguredReleaseTestCoverage(baseline, ordinary, native.files, shards, nativeCandidates);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Independent CLI ceiling includes configuration startup and cleanup. A forced
  // exit is failure, never a successful census or cleanup attestation.
  const hardTimer = setTimeout(() => {
    process.stderr.write('release-test-coverage: deadline exceeded; cleanup unconfirmed\n');
    process.exit(1);
  }, 30_000);
  try {
    const args = process.argv.slice(2);
    const configured = args.length === 1 && args[0] === '--configured';
    if (args.length && !configured) fail('only --configured is supported; filters are not supported');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const report = configured
      ? await discoverConfiguredReleaseTestCoverage(root)
      : proposeReleaseTestCoverage(await discoverReleaseTestFiles(root));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'release-test-coverage: failed'}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(hardTimer);
  }
}

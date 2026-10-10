// Opt-in calibration only. Historical costs never define expected coverage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';
import { comparePartitions, readJson } from '../../.github/scripts/ci-partition-shadow.mjs';
import { URL } from 'node:url';
// Vite must not traverse this tool's optional built-artifact imports on config load.
const sourceToolingUrl = new URL('../../scripts/hosted-build-artifact.mjs', import.meta.url).href;
import { REAL_IO_TEST_FILES } from './realio-lane-membership.mjs';

export const CALIBRATION_INPUTS = Object.freeze([
  'package-lock.json', 'vitest.config.ts', 'test/config/realio-lane-membership.mjs',
  'test/setup/home.ts', 'test/setup/home-isolation-guard.ts', 'scripts/test-ci.mjs',
  'scripts/test-ci-sharded.mjs', 'test/config/weighted-sequencer.mjs',
  '.github/scripts/ci-partition-shadow.mjs',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Project the complete live Vitest collection, retaining its original specs. */
export async function calibrationInventory(root, specs) {
  const { sourceBinding, isolatedScope } = await import(/* @vite-ignore */ sourceToolingUrl);
  root = realpathSync(root);
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const source = sourceBinding(root, revision);
  const { suites, marker } = isolatedScope(root);
  const excluded = new Set([...suites, marker]);
  const expected = source.tracked.filter(({ path }) => /^test\/.*\.test\.ts$/.test(path) &&
    !/(?:^|\/)(?:node_modules|dist|\.ashlrcode)\//.test(path) && !excluded.has(path));
  assert.ok(expected.every(({ mode }) => mode === '100644' || mode === '100755'), 'nonregular test inventory');
  const expectedFiles = new Set(expected.map(({ path }) => path));
  const seen = new Set(); const realIO = new Set(REAL_IO_TEST_FILES);
  const modules = specs.map((spec) => {
    const file = relative(root, spec.moduleId).replaceAll('\\', '/');
    assert.ok(!seen.has(file), 'duplicate collected test'); seen.add(file);
    assert.ok(expectedFiles.has(file), 'unexpected or isolated collected test');
    const path = join(root, file);
    assert.equal(realpathSync(path), path, 'noncanonical collected test');
    assert.ok(lstatSync(path).isFile(), 'nonregular collected test');
    const project = spec.project.name;
    assert.equal(project, realIO.has(file) ? 'real-io' : 'unit', 'collected project differs');
    return { file, project, sha256: digest(readFileSync(path)) };
  });
  assert.deepEqual([...seen].sort(), expected.map(({ path }) => path).sort(), 'incomplete collected inventory');
  const configSha256 = digest(JSON.stringify(CALIBRATION_INPUTS.map((file) => [file, digest(readFileSync(join(root, file)))])));
  const vitestVersion = JSON.parse(readFileSync(join(root, 'node_modules/vitest/package.json'), 'utf8')).version;
  const identity = { revision: source.revision, tree: source.tree };
  assert.deepEqual(sourceBinding(root, revision), source, 'source changed during collection');
  return { schema: 'phantom-partition-inventory/v1', source: identity, collectionSource: identity,
    collectionState: 'observed', runtime: { platform: process.platform, nodeVersion: process.version, vitestVersion, configSha256 }, modules };
}

export class WeightedCalibrationSequencer extends BaseSequencer {
  async shard(specs) {
    const { shard, root } = this.ctx.config;
    // The actual default sequencer owns every unsupported/default path.
    if (process.env.ASHLR_TEST_CI_WEIGHTED_PARTITION !== '1' || process.platform !== 'darwin' ||
      shard?.count !== 4 || !Number.isInteger(shard.index) || shard.index < 1 || shard.index > 4) {
      return super.shard(specs);
    }
    let hints;
    try { hints = readJson(process.env.ASHLR_TEST_CI_WEIGHTED_HINTS); } catch { return super.shard(specs); }
    const inventory = await calibrationInventory(root, specs);
    if (inventory.runtime.vitestVersion !== '4.1.11') return super.shard(specs);
    const assignment = comparePartitions(inventory, hints);
    if (assignment.report.fallbackReason) return super.shard(specs);
    const original = new Map(inventory.modules.map((row, index) => [row, specs[index]]));
    const bins = assignment.proposed.map((rows) => rows.map((row) => original.get(row)));
    const union = bins.flat();
    const input = new Set(specs);
    assert.equal(union.length, specs.length, 'partition lost collected specs');
    assert.equal(new Set(union).size, specs.length, 'partition duplicated collected specs');
    assert.ok(union.every((spec) => input.has(spec)), 'partition replaced collected specs');
    return bins[shard.index - 1];
  }
}

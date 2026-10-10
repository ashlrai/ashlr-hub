/* global process, URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSequencer } from 'vitest/node';
import { calibrationInventory, WeightedCalibrationSequencer, CALIBRATION_INPUTS } from '../../test/config/weighted-sequencer.mjs';
import { isolatedScope } from '../../scripts/hosted-build-artifact.mjs';
import { comparePartitions } from '../scripts/ci-partition-shadow.mjs';

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-weighted-fixture-')));
  const root = join(parent, 'source'); mkdirSync(root);
  const home = join(parent, 'home'); mkdirSync(home);
  const previous = new Map();
  for (const [key, value] of Object.entries({ HOME: home, USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'none'),
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    ASHLR_TEST_CI_WEIGHTED_PARTITION: '1', ASHLR_TEST_CI_WEIGHTED_HINTS: join(parent, 'hints.json') })) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(parent, { recursive: true, force: true });
  });
  const put = (file, data) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), data); };
  for (const file of CALIBRATION_INPUTS) put(file, readFileSync(join(sourceRoot, file)));
  put('package.json', '{}'); put('.gitignore', 'node_modules/\n');
  put('node_modules/vitest/package.json', readFileSync(join(sourceRoot, 'node_modules/vitest/package.json')));
  const scope = isolatedScope(root);
  for (const file of [...scope.suites, scope.marker]) put(file, '// inert isolated source\n');
  const paths = ['test/resource-quota-launch-handoff.test.ts', ...['a', 'b', 'c', 'd', 'e', 'f'].map((name) => `test/${name}.test.ts`)];
  for (const file of paths) put(file, '// inert fixture, never imported\n');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }).trim();
  const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'); };
  git('init', '--quiet'); commit();
  const projects = Object.fromEntries(['unit', 'real-io'].map((name, index) => [name, {
    name, config: { name, root, isolate: true, sequence: { groupOrder: index } },
  }]));
  const specs = paths.map((file, index) => ({ moduleId: join(root, file),
    project: projects[index === 0 ? 'real-io' : 'unit'], pool: 'forks', taskId: `original-${index}` }));
  const ctx = (index) => ({ config: { root, shard: { index, count: 4 } },
    cache: { getFileTestResults: () => null, getFileStats: () => null } });
  const inventory = () => calibrationInventory(root, specs);
  const hints = async () => {
    const observed = await inventory();
    return { schema: 'phantom-partition-hints/v1', source: observed.source, runtime: observed.runtime,
      evidenceSha256: 'a'.repeat(64), run: { id: '123', attempt: 1 }, recordedAt: '2026-10-09T17:40:48.024Z',
      modules: observed.modules.map((row, index) => ({ ...row, elapsedMs: index === 0 ? 1_000 : 10 })) };
  };
  const save = (value) => writeFileSync(join(parent, 'hints.json'), JSON.stringify(value));
  return { parent, root, specs, scope, ctx, inventory, hints, save, put, git, commit };
}

test('opt-in collection preserves the complete original specs and inherited project sort', async (t) => {
  const f = fixture(t); const observed = await f.inventory(); const hints = await f.hints(); f.save(hints);
  // Non-Darwin remains the actual default. Pure planner semantics are host-independent.
  const planned = comparePartitions({ ...observed, runtime: { ...observed.runtime, platform: 'darwin' } },
    { ...hints, runtime: { ...hints.runtime, platform: 'darwin' } });
  assert.equal(planned.proposed.flat().length, f.specs.length);
  const bins = [];
  for (let index = 1; index <= 4; index++) {
    const adapter = new WeightedCalibrationSequencer(f.ctx(index));
    const bin = await adapter.shard(f.specs); bins.push(bin);
    const reverse = await adapter.shard([...f.specs].reverse());
    assert.deepEqual(new Set(reverse), new Set(bin));
    assert.deepEqual(await adapter.sort(bin), await new BaseSequencer(f.ctx(index)).sort(bin));
    if (process.platform === 'darwin') {
      assert.deepEqual(bin.map((spec) => spec.moduleId), planned.proposed[index - 1].map((row) => join(f.root, row.file)));
    } else {
      assert.deepEqual(bin, await new BaseSequencer(f.ctx(index)).shard(f.specs));
    }
  }
  assert.equal(bins.flat().length, f.specs.length);
  assert.equal(new Set(bins.flat()).size, f.specs.length);
  for (const spec of f.specs) assert.equal(bins.flat().filter((row) => row === spec).length, 1);
  assert.equal(bins.flat().find((row) => row.taskId === 'original-0').project, f.specs[0].project);
});

test('default, absent, malformed and incompatible hints invoke the actual original sharder', async (t) => {
  const f = fixture(t); const hints = await f.hints();
  for (const mode of ['disabled', 'absent', 'malformed', 'duplicate', 'runtime']) {
    process.env.ASHLR_TEST_CI_WEIGHTED_PARTITION = mode === 'disabled' ? '' : '1';
    if (mode === 'absent') delete process.env.ASHLR_TEST_CI_WEIGHTED_HINTS;
    else process.env.ASHLR_TEST_CI_WEIGHTED_HINTS = join(f.parent, 'hints.json');
    if (mode === 'malformed') writeFileSync(join(f.parent, 'hints.json'), '{');
    else f.save(mode === 'duplicate' ? { ...hints, modules: [...hints.modules, hints.modules[0]] }
      : mode === 'runtime' ? { ...hints, runtime: { ...hints.runtime, configSha256: 'b'.repeat(64) } } : hints);
    for (let index = 1; index <= 4; index++) assert.deepEqual(
      await new WeightedCalibrationSequencer(f.ctx(index)).shard(f.specs), await new BaseSequencer(f.ctx(index)).shard(f.specs));
  }
});

test('live duplicate, missing, wrong-project and isolated collections cannot become a smaller successful assignment', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => calibrationInventory(f.root, [...f.specs, f.specs[0]]), /duplicate collected/);
  await assert.rejects(() => calibrationInventory(f.root, f.specs.slice(1)), /incomplete collected/);
  await assert.rejects(() => calibrationInventory(f.root, [{ ...f.specs[0], project: f.specs[1].project }, ...f.specs.slice(1)]), /project differs/);
  await assert.rejects(() => calibrationInventory(f.root, [...f.specs, { ...f.specs[0], moduleId: join(f.root, f.scope.marker) }]), /isolated collected/);
  const path = f.specs[1].moduleId; unlinkSync(path); symlinkSync(f.specs[2].moduleId, path); f.commit();
  await assert.rejects(() => calibrationInventory(f.root, f.specs), /nonregular test inventory/);
});

test('source changes stay historical and new specs cannot disappear behind a stale hint manifest', async (t) => {
  const f = fixture(t); const old = await f.hints(); f.save(old);
  f.put('test/new.test.ts', '// new inert source\n'); f.put('test/a.test.ts', '// changed inert source\n'); f.commit();
  const added = { ...f.specs[1], moduleId: join(f.root, 'test/new.test.ts'), taskId: 'new-original' }; f.specs.push(added);
  const inventory = await f.inventory();
  assert.notEqual(inventory.source.tree, old.source.tree);
  const bins = [];
  for (let index = 1; index <= 4; index++) bins.push(await new WeightedCalibrationSequencer(f.ctx(index)).shard(f.specs));
  assert.equal(bins.flat().filter((spec) => spec === added).length, 1);
  assert.equal(new Set(bins.flat()).size, f.specs.length);
  if (process.platform === 'darwin') {
    const projected = comparePartitions(inventory, old).report;
    assert.equal(projected.diagnostics.unknownModules, 1); assert.equal(projected.diagnostics.staleTestBytes, 1);
    assert.equal(projected.sourceChangedSinceCalibration, true); assert.equal(projected.recordedAt, old.recordedAt);
    assert.equal(projected.measuredSpeedup, null);
  }
});

test('actual Vitest specs pass through the bundled calibration adapter with dist absent', async (t) => {
  const f = fixture(t);
  // Only public inert fixture tests execute; the repository suite is never collected.
  for (const spec of f.specs) f.put(spec.moduleId.slice(f.root.length + 1), "import { it } from 'vitest'; it('public inert fixture', () => {});\n");
  rmSync(join(f.root, 'node_modules'), { recursive: true });
  symlinkSync(realpathSync(join(sourceRoot, 'node_modules')), join(f.root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const adapter = new URL('../../test/config/weighted-sequencer.mjs', import.meta.url).href;
  const config = join(f.root, 'calibration.fixture.config.mjs');
  f.put('calibration.fixture.config.mjs', `import { WeightedCalibrationSequencer } from ${JSON.stringify(adapter)};
class Witness extends WeightedCalibrationSequencer {
  async shard(specs) {
    if (specs.some(spec => spec.constructor.name !== 'TestSpecification')) throw new Error('not actual Vitest specs');
    const selected = await super.shard(specs);
    if (selected.some(spec => !specs.includes(spec))) throw new Error('replaced spec object');
    console.error('actual-spec-object-witness'); return selected;
  }
}
export default { test: { sequence: { sequencer: Witness }, projects: [
  { test: { name: 'unit', root: ${JSON.stringify(f.root)}, include: ['test/[a-f].test.ts'], sequence: { groupOrder: 0 } } },
  { test: { name: 'real-io', root: ${JSON.stringify(f.root)}, include: ['test/resource-quota-launch-handoff.test.ts'], sequence: { groupOrder: 1 } } }
] } };\n`);
  f.commit(); const hints = await f.hints(); f.save(hints);
  const output = join(f.parent, 'actual.json');
  const child = spawnSync(process.execPath, [join(sourceRoot, 'node_modules/vitest/vitest.mjs'), 'run',
    '--root', f.root, '--config', config, '--shard=1/4', '--maxWorkers=1', '--fileParallelism=false',
    '--reporter=json', `--outputFile.json=${output}`], {
    cwd: f.root, env: { ...process.env, CI: 'true' }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined); assert.equal(child.signal, null); assert.equal(child.status, 0, child.stderr);
  assert.ok(child.stderr.includes('actual-spec-object-witness'));
  const raw = JSON.parse(readFileSync(output, 'utf8'));
  const expected = process.platform === 'darwin' ? comparePartitions(await f.inventory(), hints).proposed[0].map(row => join(f.root, row.file))
    : (await new BaseSequencer(f.ctx(1)).shard(f.specs)).map(spec => spec.moduleId);
  assert.deepEqual(raw.testResults.map(row => row.name).sort(), expected.sort());
  assert.equal(raw.numFailedTests, 0); assert.equal(raw.numPendingTests, 0);
});

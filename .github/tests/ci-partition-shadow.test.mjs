/* global structuredClone, process, URL */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePartitions, hashPartition } from '../scripts/ci-partition-shadow.mjs';

const sha = 'a'.repeat(64);
const source = { revision: 'a'.repeat(40), tree: 'b'.repeat(40) };
const runtime = { platform: 'darwin', nodeVersion: 'v22.22.3', vitestVersion: '4.1.11', configSha256: sha };
const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({ file: `test/${name}.test.ts`, project: name === 'a' ? 'real-io' : 'unit', sha256: sha }));
const inventory = (modules = files) => ({ schema: 'phantom-partition-inventory/v1', source, collectionSource: source,
  collectionState: 'observed', runtime, modules });
const hints = () => ({ schema: 'phantom-partition-hints/v1', source, runtime, evidenceSha256: sha,
  run: { id: '123', attempt: 1 }, recordedAt: '2026-10-09T17:40:48.024Z',
  modules: files.map((row, index) => ({ ...row, elapsedMs: 100 - index * 10 })) });

test('deterministic complete assignment preserves every collected project and object identity', () => {
  const before = structuredClone(files);
  const forward = comparePartitions(inventory(), hints());
  const reverse = comparePartitions(inventory([...files].reverse()), hints());
  assert.deepEqual(forward.report, reverse.report);
  for (const bins of [forward.baseline, forward.proposed]) {
    assert.equal(bins.flat().length, files.length);
    assert.equal(new Set(bins.flat()).size, files.length);
    for (const row of files) assert.equal(bins.flat().filter((entry) => entry === row).length, 1);
  }
  assert.deepEqual(files, before);
  assert.equal(forward.proposed[0][0], files[0]);
  assert.deepEqual(forward.proposed.map((bin) => bin[0]), files.slice(0, 4));
  assert.equal(forward.report.activationEnabled, false);
  assert.equal(forward.report.resultReuseEnabled, false);
  assert.equal(forward.report.measuredSpeedup, null);
});

test('zero weights use deterministic count and shard tie breaks', () => {
  const h = hints(); h.modules.forEach((row) => { row.elapsedMs = 0; });
  const out = comparePartitions(inventory(), h);
  assert.deepEqual(out.proposed.map((bin) => bin.map((row) => row.file)), [
    [files[0].file, files[4].file], [files[1].file, files[5].file], [files[2].file, files[6].file], [files[3].file],
  ]);
});

test('new, removed and changed modules are explicit historical diagnostics, never suppressed', () => {
  const changed = { ...files[0], sha256: 'b'.repeat(64) };
  const added = { ...files[1], file: 'test/new.test.ts' };
  const modules = [changed, ...files.slice(2), added];
  const inv = inventory(modules); inv.source = { ...source, tree: 'c'.repeat(40) }; inv.collectionState = 'historical';
  const out = comparePartitions(inv, hints());
  assert.deepEqual(out.report.diagnostics, { matchedTestBytes: 5, staleTestBytes: 1, unknownModules: 1, removedHistoricalModules: 1 });
  assert.equal(out.report.sourceChangedSinceCalibration, true);
  assert.equal(out.report.collectionState, 'historical');
  assert.equal(out.report.unknownFallbackMs, 70);
  assert.equal(out.proposed.flat().filter((row) => row === added).length, 1);
  assert.equal(out.proposed.flat().filter((row) => row.file === files[1].file).length, 0);
  const rows = out.report.proposed.flatMap((bin) => bin.modules);
  assert.equal(rows.find((row) => row.file === changed.file).state, 'historical-stale-test-bytes');
  assert.equal(rows.find((row) => row.file === added.file).state, 'unknown');
});

test('invalid or incompatible hints use one complete baseline fallback, without partial weights', () => {
  const mutations = [() => null, (h) => ({ ...h, schema: 'unsupported' }),
    (h) => ({ ...h, modules: [...h.modules, h.modules[0]] }),
    (h) => ({ ...h, modules: [{ ...h.modules[0], elapsedMs: Number.NaN }] }),
    (h) => ({ ...h, modules: [{ ...h.modules[0], elapsedMs: -1 }] }),
    (h) => ({ ...h, modules: [{ ...h.modules[0], elapsedMs: 1.5 }] }),
    (h) => ({ ...h, modules: h.modules.map((row) => ({ ...row, elapsedMs: Number.MAX_SAFE_INTEGER })) }),
    (h) => ({ ...h, modules: [{ ...h.modules[0], elapsedMs: Number.MAX_SAFE_INTEGER }] }),
    (h) => ({ ...h, modules: [{ ...h.modules[0], file: 'test/../escape.test.ts' }] }),
    (h) => ({ ...h, runtime: { ...runtime, nodeVersion: 'v24.0.0' } }),
    (h) => ({ ...h, runtime: { ...runtime, configSha256: 'b'.repeat(64) } })];
  for (const mutate of mutations) {
    const out = comparePartitions(inventory(), mutate(hints()));
    assert.deepEqual(out.proposed, hashPartition(files));
    assert.deepEqual(out.proposed, out.baseline);
    assert.ok(out.report.fallbackReason);
    assert.equal(out.report.unknownFallbackMs, null);
    assert.equal(out.report.analyticalSpanTailDifferenceMs, null);
    assert.equal(out.report.diagnostics.unknownModules, files.length);
    assert.ok(out.report.proposed.every((bin) => bin.historicalHintSumMs === null));
  }
});

test('duplicate, unsafe and unbound inventory is rejected rather than deduplicated', () => {
  assert.throws(() => comparePartitions(inventory([...files, files[0]]), hints()), /duplicate collected/);
  assert.throws(() => comparePartitions(inventory([{ ...files[0], file: '/test/a.test.ts' }]), hints()), /invalid collected/);
  assert.throws(() => comparePartitions({ ...inventory(), source: null }, hints()), /source binding/);
  assert.throws(() => comparePartitions({ ...inventory(), collectionState: 'assumed' }, hints()), /collection state/);
  assert.throws(() => comparePartitions({ ...inventory(), runtime: { ...runtime, vitestVersion: '5.0.0' } }, hints()), /unsupported baseline/);
});

test('offline CLI preserves inputs and reports malformed hint fallback as JSON', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'phantom-partition-fixture-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'inventory.json'); const historical = join(dir, 'hints.json');
  const raw = JSON.stringify(inventory()); writeFileSync(input, raw); writeFileSync(historical, '{');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-partition-shadow.mjs', import.meta.url)), input, historical], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(output);
  assert.equal(report.fallbackReason, 'invalid-hints');
  assert.equal(report.baseline.flatMap((bin) => bin.modules).length, files.length);
  assert.deepEqual(report.proposed, report.baseline);
  assert.equal(readFileSync(input, 'utf8'), raw);
  assert.equal(readFileSync(historical, 'utf8'), '{');
});

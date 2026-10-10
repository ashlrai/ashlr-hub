/* global process, console */
// Pure assignment planner: standalone offline output and explicit Vitest calibration.
// Historical hints never supply test results or qualification authority.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, openSync, fstatSync, readFileSync, closeSync, constants, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_MODULES = 20_000;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const runtimeKeys = ['platform', 'nodeVersion', 'vitestVersion', 'configSha256'];
const hash = (algorithm, text) => createHash(algorithm).update(text).digest('hex');
const order = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pathValid = (file) => typeof file === 'string' && file.length <= 512 &&
  /^test\/[A-Za-z0-9_./-]+\.test\.ts$/.test(file) &&
  !file.split('/').some((part) => part === '.' || part === '..' || part === '');

function runtimeValid(runtime) {
  return runtime && runtime.platform === 'darwin' &&
    /^v\d+\.\d+\.\d+$/.test(runtime.nodeVersion) &&
    /^\d+\.\d+\.\d+$/.test(runtime.vitestVersion) && SHA256.test(runtime.configSha256);
}
function sourceValid(source) {
  return source && SHA1.test(source.revision) && SHA1.test(source.tree);
}
function validateInventory(inventory) {
  assert.equal(inventory?.schema, 'phantom-partition-inventory/v1', 'unsupported inventory');
  assert.ok(sourceValid(inventory.source), 'invalid inventory source binding');
  assert.ok(sourceValid(inventory.collectionSource), 'invalid collection source binding');
  assert.ok(['observed', 'historical'].includes(inventory.collectionState), 'unknown collection state');
  assert.ok(runtimeValid(inventory.runtime), 'invalid inventory runtime');
  assert.equal(inventory.runtime.vitestVersion, '4.1.11', 'unsupported baseline sequencer version');
  assert.ok(Array.isArray(inventory.modules) && inventory.modules.length > 0 &&
    inventory.modules.length <= MAX_MODULES, 'invalid inventory size');
  const files = new Set();
  for (const row of inventory.modules) {
    assert.ok(pathValid(row?.file) && SHA256.test(row.sha256) &&
      typeof row.project === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(row.project), 'invalid collected module');
    assert.ok(!files.has(row.file), 'duplicate collected module');
    files.add(row.file);
  }
}
function hintsValid(hints, runtime, modules) {
  if (hints?.schema !== 'phantom-partition-hints/v1' || !sourceValid(hints.source) ||
    !runtimeValid(hints.runtime) || !SHA256.test(hints.evidenceSha256) ||
    typeof hints.run?.id !== 'string' || !/^[1-9]\d{0,19}$/.test(hints.run.id) ||
    !Number.isSafeInteger(hints.run?.attempt) || hints.run.attempt < 1 ||
    typeof hints.recordedAt !== 'string' || !Number.isFinite(Date.parse(hints.recordedAt)) ||
    new Date(hints.recordedAt).toISOString() !== hints.recordedAt ||
    !Array.isArray(hints.modules) || !hints.modules.length || hints.modules.length > MAX_MODULES) {
    return 'invalid-hints';
  }
  if (runtimeKeys.some((key) => hints.runtime[key] !== runtime[key])) return 'incompatible-runtime-hints';
  const seen = new Set(); let total = 0;
  for (const row of hints.modules) {
    if (!pathValid(row?.file) || !SHA256.test(row.sha256) || seen.has(row.file) ||
      !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0) return 'invalid-hints';
    seen.add(row.file); total += row.elapsedMs;
    if (!Number.isSafeInteger(total)) return 'invalid-hints';
  }
  const sorted = hints.modules.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)];
  const byFile = new Map(hints.modules.map((row) => [row.file, row.elapsedMs]));
  let projected = 0;
  for (const row of modules) {
    projected += byFile.get(row.file) ?? median;
    if (!Number.isSafeInteger(projected)) return 'invalid-hints';
  }
  return null;
}

// Mirrors BaseSequencer.shard's source-relative '/test/...' SHA-1 ordering
// and distributed range sizes. No tests are selected or executed here.
export function hashPartition(modules) {
  const sorted = modules.map((row) => ({ row, hash: hash('sha1', `/${row.file}`) }))
    .sort((a, b) => order(a.hash, b.hash) || order(a.row.file, b.row.file)).map(({ row }) => row);
  const size = Math.floor(sorted.length / 4); const extra = sorted.length % 4;
  let cursor = 0;
  return Array.from({ length: 4 }, (_, index) => {
    const length = size + (index < extra ? 1 : 0);
    const bin = sorted.slice(cursor, cursor + length); cursor += length; return bin;
  });
}
function assertUnion(bins, original) {
  const flat = bins.flat();
  const input = new Set(original);
  assert.equal(flat.length, original.length, 'assignment lost modules');
  assert.equal(new Set(flat).size, original.length, 'assignment duplicated modules');
  assert.ok(flat.every((row) => input.has(row)), 'assignment replaced collected identities');
}

export function comparePartitions(inventory, hints) {
  validateInventory(inventory);
  const baseline = hashPartition(inventory.modules);
  const refusal = hintsValid(hints, inventory.runtime, inventory.modules);
  const hintRows = refusal ? [] : hints.modules;
  const byFile = new Map(hintRows.map((row) => [row.file, row]));
  const weights = hintRows.map((row) => row.elapsedMs).sort((a, b) => a - b);
  // The lower historical median is a scheduling fallback, never an observed time.
  const median = weights.length ? weights[Math.floor((weights.length - 1) / 2)] : null;
  const inventoryFiles = new Set(inventory.modules.map((row) => row.file));
  const diagnostics = { matchedTestBytes: 0, staleTestBytes: 0, unknownModules: 0,
    removedHistoricalModules: hintRows.filter((hint) => !inventoryFiles.has(hint.file)).length };
  const metadata = new Map();
  for (const row of inventory.modules) {
    const hint = byFile.get(row.file);
    const state = !hint ? 'unknown' : hint.sha256 === row.sha256 ? 'historical-matched-test-bytes' : 'historical-stale-test-bytes';
    if (!hint) diagnostics.unknownModules++;
    else if (hint.sha256 === row.sha256) diagnostics.matchedTestBytes++;
    else diagnostics.staleTestBytes++;
    metadata.set(row, { state, elapsedMs: hint?.elapsedMs ?? median });
  }
  let proposed = baseline;
  if (!refusal) {
    proposed = Array.from({ length: 4 }, () => []);
    const sums = [0, 0, 0, 0];
    for (const row of [...inventory.modules].sort((a, b) => metadata.get(b).elapsedMs - metadata.get(a).elapsedMs || order(a.file, b.file))) {
      const index = [0, 1, 2, 3].sort((a, b) => sums[a] - sums[b] || proposed[a].length - proposed[b].length || a - b)[0];
      proposed[index].push(row); sums[index] += metadata.get(row).elapsedMs;
      assert.ok(Number.isSafeInteger(sums[index]), 'assignment hint sum overflow');
    }
  }
  assertUnion(baseline, inventory.modules); assertUnion(proposed, inventory.modules);
  const projection = (bins) => bins.map((rows, index) => ({ shard: index + 1, count: rows.length,
    historicalHintSumMs: refusal ? null : rows.reduce((sum, row) => sum + metadata.get(row).elapsedMs, 0),
    modules: rows.map((row) => ({ file: row.file, project: row.project, ...metadata.get(row) })) }));
  const baselineProjection = projection(baseline); const proposedProjection = projection(proposed);
  const maxima = (bins) => Math.max(...bins.map((bin) => bin.historicalHintSumMs));
  return { baseline, proposed, report: { schema: 'phantom-partition-shadow/v1', advisoryOnly: true,
    activationEnabled: false, resultReuseEnabled: false, measuredSpeedup: null,
    baselineAlgorithm: 'reviewed-vitest-4.1.11-sha1-ranges',
    source: inventory.source, collectionSource: inventory.collectionSource, collectionState: inventory.collectionState,
    runtime: inventory.runtime, inventorySha256: hash('sha256', JSON.stringify([...inventory.modules].sort((a, b) => order(a.file, b.file)))),
    hintSource: refusal ? null : hints.source, hintRun: refusal ? null : hints.run,
    recordedAt: refusal ? null : hints.recordedAt, evidenceSha256: refusal ? null : hints.evidenceSha256,
    hintsSha256: refusal ? null : hash('sha256', JSON.stringify(hints)),
    sourceChangedSinceCalibration: refusal ? null : hints.source.tree !== inventory.source.tree,
    diagnostics, fallbackReason: refusal, unknownFallbackMs: median,
    baseline: baselineProjection, proposed: proposedProjection,
    analyticalSpanTailDifferenceMs: refusal ? null : maxima(baselineProjection) - maxima(proposedProjection),
    limitations: ['Historical elapsed reporter spans are not CPU, queue or wall-time predictions.',
      'Matching test bytes do not prove unchanged transitive inputs or current performance.',
      'Inventory is supplied explicitly; this tool neither collects nor executes tests.',
      'Standalone output does not activate assignments; an explicit caller may use them. Qualification, acceptance and result-reuse policy remain unchanged.'] } };
}

const statIdentity = (stat) => ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => stat[key]);
export function readJson(input) {
  const path = resolve(input);
  assert.equal(realpathSync(path), path, 'symlink input');
  const before = lstatSync(path);
  assert.ok(before.isFile() && before.nlink === 1 && before.size <= MAX_INPUT_BYTES, 'unsafe input');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    assert.deepEqual(statIdentity(fstatSync(fd)), statIdentity(before));
    const bytes = readFileSync(fd); assert.equal(bytes.length, before.size);
    assert.deepEqual(statIdentity(fstatSync(fd)), statIdentity(before));
    assert.deepEqual(statIdentity(lstatSync(path)), statIdentity(before));
    return JSON.parse(bytes.toString('utf8'));
  } finally { closeSync(fd); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: ci-partition-shadow.mjs INVENTORY.json HINTS.json');
    const inventory = readJson(process.argv[2]);
    let hints; try { hints = readJson(process.argv[3]); } catch { hints = null; }
    console.log(JSON.stringify(comparePartitions(inventory, hints).report, null, 2));
  } catch (error) { console.error(`Offline partition comparison refused: ${error.message}`); process.exitCode = 1; }
}

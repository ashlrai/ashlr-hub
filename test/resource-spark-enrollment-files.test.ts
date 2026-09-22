/** Private real-file publication tests; no account clients, providers or ledger operations. */
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { resourcePoolConfigSnapshot } from '../src/core/resources/pool-evolution-policy.js';
import { prepareResourceSparkEnrollment } from '../src/core/resources/spark-enrollment.js';
import { prepareResourceSparkEnrollmentFiles } from '../src/core/resources/spark-enrollment-files.js';
import * as durability from '../src/core/util/durability.js';
import * as storage from '../src/core/util/private-storage.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const save = (file: string, value: unknown) => writeFileSync(file, canonical(value) + '\n', { mode: 0o600 });
function snapshot(file: string): unknown {
  const stat = lstatSync(file, { bigint: true });
  return { mode: String(stat.mode), ino: String(stat.ino), mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs),
    content: stat.isSymbolicLink() ? readlinkSync(file) : stat.isDirectory()
      ? Object.fromEntries(readdirSync(file).sort().map(name => [name, snapshot(join(file, name))])) : digest(readFileSync(file)) };
}
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spark-proposal-files-'))); roots.push(base);
  const inputs = join(base, 'inputs'); const parent = join(base, 'proposals');
  mkdirSync(inputs, { mode: 0o700 }); mkdirSync(parent, { mode: 0o700 });
  const { pool, bindings, poolDigest } = resourcePoolConfigSnapshot({ schemaVersion: 1, id: 'fixture', workers: [
    { id: 'personal', provider: 'codex', model: 'gpt-6-astra', maxConcurrent: 1, reservePercent: 25,
      maxTasksPerWindow: 7, taskWindowMs: 60_000, priority: 1 },
  ] }, [{ workerId: 'personal', capacityKey: 'account', kind: 'native-cli', command: ['/synthetic/never-invoked'] }]);
  const quotaConfig = { schemaVersion: 1, poolDigest, workers: [
    { workerId: 'personal', accountHint: 'a'.repeat(64), bucketIds: ['codex'] },
  ] };
  const options = { poolPath: join(inputs, 'pool.json'), bindingsPath: join(inputs, 'bindings.json'),
    quotaConfigPath: join(inputs, 'quota.json'), generalWorkerId: 'personal', sparkWorkerId: 'personal-spark', output: join(parent, 'proposal') };
  save(options.poolPath, pool); save(options.bindingsPath, bindings); save(options.quotaConfigPath, quotaConfig);
  // These are untouched sentinels, not a fabricated accounting fixture supplied to the planner.
  save(join(inputs, 'ledger-sentinel.json'), { attempts: ['retained'], ceilingPercent: 75, paused: true });
  save(join(inputs, 'observations-sentinel.json'), { freshness: 'not-observed' });
  return { base, inputs, parent, options, input: { pool, bindings, quotaConfig } };
}
const names = ['bindings.json', 'general-reservation.json', 'intent.json', 'manifest.json', 'pool.json', 'quota-config.json'];
function onOutputSync(output: string, callback: () => void) {
  const original = durability.fsyncDirectory; let invoked = false;
  vi.spyOn(durability, 'fsyncDirectory').mockImplementation(directory => {
    original(directory);
    if (directory === output && !invoked) { invoked = true; callback(); }
  });
  return () => expect(invoked).toBe(true);
}

describe('Spark enrollment private file publication', () => {
  it('publishes exact proposed bytes and final manifest hashes without touching sources or accounting', () => {
    const f = fixture(); const before = snapshot(f.inputs);
    const proposed = prepareResourceSparkEnrollment({ ...f.input, generalWorkerId: 'personal', sparkWorkerId: 'personal-spark' });
    const result = prepareResourceSparkEnrollmentFiles(f.options);
    expect(readdirSync(f.options.output).sort()).toEqual(names);
    expect(lstatSync(f.options.output).mode & 0o777).toBe(0o700);
    expect(result).toMatchObject({ status: 'prepared', ledgerChanged: false, quotaRefreshed: false,
      accountUnpaused: false, generalReservationApplied: false, fromPoolDigest: proposed.fromPoolDigest, toPoolDigest: proposed.toPoolDigest });
    const contents = { 'pool.json': proposed.pool, 'bindings.json': proposed.bindings, 'quota-config.json': proposed.quotaConfig,
      'general-reservation.json': proposed.generalExclusion };
    for (const [name, value] of Object.entries(contents)) {
      const bytes = readFileSync(join(f.options.output, name));
      expect(bytes.toString('utf8')).toBe(canonical(value) + '\n');
      expect(result.files[name]).toBe(digest(bytes)); expect(result.paths[name]).toBe(join(f.options.output, name));
    }
    for (const name of names) { const stat = lstatSync(join(f.options.output, name)); expect(stat.mode & 0o777).toBe(0o600); expect(stat.nlink).toBe(1); }
    expect(JSON.parse(readFileSync(join(f.options.output, 'intent.json'), 'utf8'))).toEqual({ schemaVersion: 1, inputDigest: digest(canonical(f.input)) });
    const { paths: _paths, manifestPath: _manifestPath, ...manifest } = result;
    expect(readFileSync(result.manifestPath, 'utf8')).toBe(canonical(manifest) + '\n');
    expect(snapshot(f.inputs)).toEqual(before);
    const completed = snapshot(f.base); expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow(); expect(snapshot(f.base)).toEqual(completed);
  });

  it.each(['empty-directory', 'file', 'symlink'] as const)('refuses existing output %s without altering it', kind => {
    const f = fixture();
    if (kind === 'empty-directory') mkdirSync(f.options.output, { mode: 0o700 });
    else if (kind === 'file') save(f.options.output, { retained: true });
    else symlinkSync(f.inputs, f.options.output);
    const before = snapshot(f.base); expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow(); expect(snapshot(f.base)).toEqual(before);
  });

  it.each(['public-parent', 'symlink-parent', 'input-symlink', 'input-hardlink', 'input-public', 'input-malformed', 'input-oversized'] as const)(
    'refuses %s before creating a proposal', kind => {
      const f = fixture();
      if (kind === 'public-parent') chmodSync(f.parent, 0o755);
      else if (kind === 'symlink-parent') { const alias = join(f.base, 'alias'); symlinkSync(f.parent, alias); f.options.output = join(alias, 'proposal'); }
      else if (kind === 'input-symlink') { const alias = join(f.inputs, 'alias'); symlinkSync(f.options.poolPath, alias); f.options.poolPath = alias; }
      else if (kind === 'input-hardlink') linkSync(f.options.poolPath, join(f.inputs, 'alias'));
      else if (kind === 'input-public') chmodSync(f.options.poolPath, 0o644);
      else if (kind === 'input-malformed') writeFileSync(f.options.poolPath, '{invalid');
      else writeFileSync(f.options.poolPath, ' '.repeat(256 * 1024 + 1));
      const before = snapshot(f.base); expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow();
      expect(existsSync(f.options.output)).toBe(false); expect(snapshot(f.base)).toEqual(before);
    });

  it('retains a failed publication without a completion manifest or automatic retry', () => {
    const f = fixture(); const before = snapshot(f.inputs);
    const injected = onOutputSync(f.options.output, () => { throw new Error('fixture durability failure'); });
    expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow('fixture durability failure'); injected();
    expect(readdirSync(f.options.output)).toEqual(['intent.json']); expect(snapshot(f.inputs)).toEqual(before);
    vi.restoreAllMocks(); const partial = snapshot(f.base);
    expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow(); expect(snapshot(f.base)).toEqual(partial);
  });

  it('rejects accessor options without invoking them or creating output', () => {
    const f = fixture(); const before = snapshot(f.base); const getter = vi.fn(() => f.options.poolPath);
    const options = { ...f.options }; Object.defineProperty(options, 'poolPath', { enumerable: true, get: getter });
    expect(() => prepareResourceSparkEnrollmentFiles(options)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(snapshot(f.base)).toEqual(before);
  });

  it('refuses directory replacement during assurance instead of adopting the replacement', () => {
    const f = fixture(); const original = storage.assurePrivateStoragePath; let injected = false;
    vi.spyOn(storage, 'assurePrivateStoragePath').mockImplementation((...args) => {
      if (!injected && args[0] === f.options.output && args[1] === 'directory') {
        injected = true; renameSync(f.options.output, join(f.parent, 'retained-original'));
        mkdirSync(f.options.output, { mode: 0o700 });
      }
      return original(...args);
    });
    expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow(); expect(injected).toBe(true);
    expect(readdirSync(f.options.output)).toEqual([]);
    expect(readdirSync(join(f.parent, 'retained-original'))).toEqual([]);
  });

  it('refuses source drift during publication and retains partial evidence', () => {
    const f = fixture(); const injected = onOutputSync(f.options.output, () => {
      save(f.options.quotaConfigPath, { ...f.input.quotaConfig, workers: [{ ...f.input.quotaConfig.workers[0], accountHint: 'b'.repeat(64) }] });
    });
    expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow(/inputs changed/); injected();
    expect(existsSync(join(f.options.output, 'intent.json'))).toBe(true);
    expect(existsSync(join(f.options.output, 'manifest.json'))).toBe(false);
  });

  it('refuses equivalent-JSON byte tampering instead of certifying an incorrect manifest hash', () => {
    const f = fixture(); const original = durability.fsyncDirectory; let injected = false;
    vi.spyOn(durability, 'fsyncDirectory').mockImplementation(directory => {
      original(directory); const file = join(f.options.output, 'pool.json');
      if (!injected && directory === f.options.output && existsSync(file)) {
        injected = true; const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
      }
    });
    expect(() => prepareResourceSparkEnrollmentFiles(f.options)).toThrow(); expect(injected).toBe(true);
    expect(existsSync(join(f.options.output, 'manifest.json'))).toBe(false);
  });
});

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectBuiltinEvaluatorBundle, resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { comparatorDigest, validateUniverseManifest, type ManifestRecord } from '../src/core/universe/store.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { resolvePreparationGit } from '../scripts/evaluators/preparation-verification-native.mjs';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

const files = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs',
  'preparation-verification-tool.mjs', 'preparation-verification.mjs'];
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'builtin-registry-'))); roots.push(root);
  const directory = join(root, 'installed'); fs.mkdirSync(directory, { mode: 0o700 });
  const manifest = { schemaVersion: 1, id: 'preparation-measurement-v1', files: files.map(name => {
    const text = ['preparation-verification-activity.mjs', 'preparation-verification-native.mjs', 'preparation-verification-protocol.mjs'].includes(name)
      ? fs.readFileSync(new URL(`../scripts/evaluators/${name}`, import.meta.url), 'utf8') : `// fixed packaged ${name}\n`;
    fs.writeFileSync(join(directory, name), text, { mode: 0o600 });
    return { name, digest: hash(text) };
  }) };
  fs.writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { root, directory, manifest };
}
function manifest(evaluation: unknown) {
  return { schemaVersion: 1, id: 'fixture', name: 'Fixture', objective: 'Measure preparation',
    seed: { repo: '/fixture', revision: 'a'.repeat(40) }, metric: { name: 'processes', direction: 'minimize', minImprovement: 1 },
    budget: { maxTrials: 1, maxParallel: 1, maxDurationMs: 1000, trialTimeoutMs: 1000 }, evaluation,
    variants: [{ id: 'trial', niche: 'verification', hypothesis: 'Keep behavior', command: [process.execPath, '-e', ''] }] };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('closed installed built-in evaluator registry', () => {
  it('accepts the explicit descriptor without adding command authority', () => {
    expect(validateUniverseManifest(manifest({ builtin: 'preparation-measurement-v1', timeoutMs: 1000 })).evaluation)
      .toEqual({ builtin: 'preparation-measurement-v1', timeoutMs: 1000 });
  });
  it.each([900_000, 900_001, 1_800_000])('accepts an explicitly selected diagnostic budget of %i without changing trial budgets', timeoutMs => {
    const input = manifest({ builtin: 'preparation-measurement-v1', timeoutMs });
    const value = validateUniverseManifest(input);
    expect(value.evaluation.timeoutMs).toBe(timeoutMs);
    expect(value.budget).toEqual(input.budget);
  });
  it.each([1_800_001, 1_800_000.5, Infinity])('refuses diagnostic budgets above the bounded ceiling: %s', timeoutMs => {
    expect(() => validateUniverseManifest(manifest({ builtin: 'preparation-measurement-v1', timeoutMs }))).toThrow();
  });
  it('preserves the command evaluator and whole-trial limits', () => {
    expect(validateUniverseManifest(manifest({ command: [process.execPath, 'evaluate.mjs'], timeoutMs: 900_000 })).evaluation.timeoutMs).toBe(900_000);
    expect(() => validateUniverseManifest(manifest({ command: [process.execPath, 'evaluate.mjs'], timeoutMs: 900_001 }))).toThrow();
    const input = manifest({ builtin: 'preparation-measurement-v1', timeoutMs: 1_800_000 });
    input.budget.trialTimeoutMs = 900_000;
    expect(validateUniverseManifest(input).budget.trialTimeoutMs).toBe(900_000);
    input.budget.trialTimeoutMs = 900_001;
    expect(() => validateUniverseManifest(input)).toThrow();
  });
  it.each([
    { builtin: 'unknown', timeoutMs: 1000 },
    { builtin: 'preparation-measurement-v1', command: [process.execPath], timeoutMs: 1000 },
    { builtin: 'preparation-measurement-v1', path: '/tmp/controller', timeoutMs: 1000 },
    { builtin: 'preparation-measurement-v1', env: {}, timeoutMs: 1000 },
    { builtin: 'preparation-measurement-v1', timeoutMs: 0 },
    { builtin: 'preparation-measurement-v1', timeoutMs: 1000, [Symbol('private')]: true },
  ])('rejects unknown, mixed or supplied authority: %j', evaluation => {
    expect(() => validateUniverseManifest(manifest(evaluation))).toThrow();
  });
  it('rejects accessor-backed built-in selection without invoking it', () => {
    const getter = vi.fn(() => 'preparation-measurement-v1');
    expect(() => validateUniverseManifest(manifest({ get builtin() { return getter(); }, timeoutMs: 1000 }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves the exact legacy comparator input and omits new fields', () => {
    const value = validateUniverseManifest(manifest({ command: [process.execPath, 'check.mjs'], timeoutMs: 1000 }));
    const record: Omit<ManifestRecord, 'comparatorDigest'> = { id: 'manifest', kind: 'manifest', manifest: value,
      manifestDigest: '1'.repeat(64), seedArtifact: { path: '/fixed', revision: 'a'.repeat(40), digest: '2'.repeat(64) },
      evaluationCommand: [process.execPath, '/fixed/check.mjs'], evaluationExecutableDigest: '3'.repeat(64) };
    expect(comparatorDigest(record)).toBe(digest(canonical({ objective: value.objective, metric: value.metric,
      seed: value.seed, seedDigest: record.seedArtifact.digest, evaluation: value.evaluation,
      evaluationCommand: record.evaluationCommand, evaluationExecutableDigest: record.evaluationExecutableDigest })));
    expect(comparatorDigest({ ...record, evaluationBuiltinDigest: '4'.repeat(64) })).not.toBe(comparatorDigest(record));
  });
  it('pins all installed files and the actual executable, returning detached metadata', () => {
    const f = fixture(), first = inspectBuiltinEvaluatorBundle(f.directory);
    expect(first.command).toEqual([process.execPath, '--experimental-vm-modules', '--no-warnings',
      join(f.directory, 'preparation-verification.mjs'), join(f.directory, 'preparation-bridge.mjs')]);
    expect(first.files.map(row => row.name)).toEqual(files);
    expect(first.executableDigest).toBe(hash(fs.readFileSync(process.execPath)));
    const original = first.digest; first.files[0]!.digest = 'f'.repeat(64); first.command[0] = '/unexpected';
    expect(inspectBuiltinEvaluatorBundle(f.directory).digest).toBe(original);
  });
  it('pins the actual selected Git bytes and returns independently detached native metadata', () => {
    const f = fixture(), selected = resolvePreparationGit(), first = inspectBuiltinEvaluatorBundle(f.directory);
    expect(first.git).toEqual(selected);
    expect(first.git.digest).toBe(hash(fs.readFileSync(selected.path)));
    expect(first.tools[0]).toEqual(selected);
    expect(first.tools.some(row => row.path === '/usr/bin/git')).toBe(false);
    const identity = first.digest;
    first.git.path = '/untrusted/git'; first.git.digest = 'f'.repeat(64);
    expect(first.tools[0]).toEqual(selected);
    first.tools[0]!.digest = 'e'.repeat(64);
    const next = inspectBuiltinEvaluatorBundle(f.directory);
    expect(next.git).toEqual(selected); expect(next.tools[0]).toEqual(selected);
    expect(next.digest).toBe(identity);
  });
  it('includes changed native Git content in the installed identity without changing a real executable', () => {
    const f = fixture(), before = inspectBuiltinEvaluatorBundle(f.directory), original = fs.readSync;
    const selected = fs.lstatSync(before.git.path, { bigint: true });
    let changedReads = 0;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
      const count = Reflect.apply(original, fs, args);
      const stat = fs.fstatSync(args[0], { bigint: true });
      if (stat.dev === selected.dev && stat.ino === selected.ino && args[4] === 0 && count > 0) {
        const buffer = args[1] as Buffer; buffer[0] = buffer[0]! ^ 1; changedReads++;
      }
      return count;
    }) as typeof fs.readSync);
    const after = inspectBuiltinEvaluatorBundle(f.directory);
    expect(changedReads).toBeGreaterThanOrEqual(2);
    expect(after.git.path).toBe(before.git.path); expect(after.git.digest).not.toBe(before.git.digest);
    expect(after.tools[0]).toEqual(after.git); expect(after.digest).not.toBe(before.digest);
  });
  it('refuses native Git content changing between initial capture and final verification', () => {
    const f = fixture(), pin = resolvePreparationGit(), original = fs.readSync;
    const selected = fs.lstatSync(pin.path, { bigint: true }); let reads = 0;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
      const count = Reflect.apply(original, fs, args);
      const stat = fs.fstatSync(args[0], { bigint: true });
      if (stat.dev === selected.dev && stat.ino === selected.ino && args[4] === 0 && count > 0 && ++reads > 1) {
        const buffer = args[1] as Buffer; buffer[0] = buffer[0]! ^ 1;
      }
      return count;
    }) as typeof fs.readSync);
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow('Installed built-in evaluator unavailable or changed');
    expect(reads).toBeGreaterThanOrEqual(2);
  });
  it('ignores hostile PATH and DEVELOPER_DIR when selecting and pinning Git', () => {
    const f = fixture(), before = inspectBuiltinEvaluatorBundle(f.directory);
    const prior = { PATH: process.env.PATH, DEVELOPER_DIR: process.env.DEVELOPER_DIR };
    try {
      process.env.PATH = join(f.root, 'untrusted-bin'); process.env.DEVELOPER_DIR = join(f.root, 'untrusted-developer');
      const after = inspectBuiltinEvaluatorBundle(f.directory);
      expect(after.git).toEqual(before.git); expect(after.tools).toEqual(before.tools); expect(after.digest).toBe(before.digest);
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  it.each(['changed', 'missing', 'extra', 'file-link', 'manifest-link', 'writable', 'manifest-fields', 'manifest-order'] as const)('refuses incomplete or altered installed bundles: %s', kind => {
    const f = fixture(), file = join(f.directory, files[0]!);
    if (kind === 'changed') fs.appendFileSync(file, '// change');
    if (kind === 'missing') fs.unlinkSync(file);
    if (kind === 'extra') fs.writeFileSync(join(f.directory, 'unexpected.mjs'), '// extra');
    if (kind === 'writable') fs.chmodSync(file, 0o620);
    if (kind === 'file-link' || kind === 'manifest-link') {
      const target = kind === 'file-link' ? file : join(f.directory, 'manifest.json');
      fs.renameSync(target, join(f.root, 'outside')); fs.symlinkSync(join(f.root, 'outside'), target);
    }
    if (kind === 'manifest-fields') fs.writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify({ ...f.manifest, path: '/tmp' }));
    if (kind === 'manifest-order') fs.writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify({ ...f.manifest, files: [...f.manifest.files].reverse() }));
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow('Installed built-in evaluator unavailable or changed');
  });
  it('rejects a symlinked bundle directory', () => {
    const f = fixture(), link = join(f.root, 'alias'); fs.symlinkSync(f.directory, link);
    expect(() => inspectBuiltinEvaluatorBundle(link)).toThrow();
  });
  it('detects an earlier file changing during a later file read', () => {
    const f = fixture(), original = fs.readSync;
    const later = fs.lstatSync(join(f.directory, files[1]!), { bigint: true });
    let mutated = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
      const count = Reflect.apply(original, fs, args), stat = fs.fstatSync(args[0], { bigint: true });
      if (!mutated && stat.dev === later.dev && stat.ino === later.ino && count > 0) {
        mutated = true; fs.appendFileSync(join(f.directory, files[0]!), '// concurrent change');
      }
      return count;
    }) as typeof fs.readSync);
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow();
    expect(mutated).toBe(true);
  });
  it('bounds descriptor reads to captured size plus one and refuses growth without consuming it', () => {
    const f = fixture(), original = fs.readSync;
    const selected = fs.lstatSync(join(f.directory, 'manifest.json'), { bigint: true });
    const bound = Number(selected.size) + 1;
    const reads: Array<{ capacity: number; offset: number; length: number }> = [];
    let selectedFd: number | undefined;
    const close = vi.spyOn(fs, 'closeSync');
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
      const stat = fs.fstatSync(args[0], { bigint: true });
      if (stat.dev !== selected.dev || stat.ino !== selected.ino) return Reflect.apply(original, fs, args);
      selectedFd = args[0];
      const buffer = args[1] as Buffer;
      reads.push({ capacity: buffer.length, offset: args[2], length: args[3] });
      // Model an arbitrarily growing descriptor while forcing short reads.
      const count = Math.min(17, args[3]); buffer.fill(0x61, args[2], args[2] + count); return count;
    }) as typeof fs.readSync);
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow('Installed built-in evaluator unavailable or changed');
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every(row => row.capacity === bound && row.offset + row.length === bound)).toBe(true);
    expect(reads.reduce((sum, row) => sum + Math.min(17, row.length), 0)).toBe(bound);
    expect(close).toHaveBeenCalledWith(selectedFd);
  });
  it.each(['preparation-verification-activity.mjs', 'preparation-verification-native.mjs'])('refuses a self-consistent bundle whose %s differs from the loaded host helper', name => {
    const f = fixture(), text = '// different helper\n';
    fs.writeFileSync(join(f.directory, name), text);
    f.manifest.files.find(row => row.name === name)!.digest = hash(text);
    fs.writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify(f.manifest));
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow();
  });
  it.each(['preparation-verification-activity.mjs', 'preparation-verification-native.mjs'])('refuses hot-updated %s instead of adopting different code in the running process', name => {
    const f = fixture(), original = fs.readSync;
    const helper = fs.lstatSync(new URL(`../scripts/evaluators/${name}`, import.meta.url), { bigint: true });
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: [number, NodeJS.ArrayBufferView, number, number, number | null]) => {
      const count = Reflect.apply(original, fs, args), stat = fs.fstatSync(args[0], { bigint: true });
      if (stat.dev === helper.dev && stat.ino === helper.ino && args[4] === 0 && count > 0) {
        const buffer = args[1] as Buffer; buffer[0] = buffer[0]! ^ 1;
      }
      return count;
    }) as typeof fs.readSync);
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow();
  });
  it('never resolves an arbitrary identifier or executable', () => {
    expect(() => resolveBuiltinEvaluator('/tmp/controller' as 'preparation-measurement-v1')).toThrow();
  });
});

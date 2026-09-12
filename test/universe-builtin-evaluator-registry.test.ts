import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectBuiltinEvaluatorBundle, resolveBuiltinEvaluator } from '../src/core/universe/builtin-evaluator-registry.js';
import { comparatorDigest, validateUniverseManifest, type ManifestRecord } from '../src/core/universe/store.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

const files = ['preparation-bridge.mjs', 'preparation-verification-activity.mjs', 'preparation-verification-child.mjs',
  'preparation-verification-controller.mjs', 'preparation-verification-fixtures.mjs', 'preparation-verification-protocol.mjs',
  'preparation-verification-tool.mjs', 'preparation-verification.mjs'];
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'builtin-registry-'))); roots.push(root);
  const directory = join(root, 'installed'); fs.mkdirSync(directory, { mode: 0o700 });
  const manifest = { schemaVersion: 1, id: 'preparation-measurement-v1', files: files.map(name => {
    const text = ['preparation-verification-activity.mjs', 'preparation-verification-protocol.mjs'].includes(name)
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
    const f = fixture(), original = fs.readFileSync; let count = 0;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const result = Reflect.apply(original, fs, args);
      if (++count === 3) fs.appendFileSync(join(f.directory, files[0]!), '// concurrent change');
      return result;
    }) as typeof fs.readFileSync);
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow();
  });
  it('refuses a self-consistent bundle whose activity helper differs from the loaded host helper', () => {
    const f = fixture(), name = 'preparation-verification-activity.mjs', text = '// different helper\n';
    fs.writeFileSync(join(f.directory, name), text);
    f.manifest.files.find(row => row.name === name)!.digest = hash(text);
    fs.writeFileSync(join(f.directory, 'manifest.json'), JSON.stringify(f.manifest));
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow();
  });
  it('refuses a hot-updated host helper instead of adopting different code in the running process', () => {
    const f = fixture(), original = fs.readFileSync;
    const helper = fs.lstatSync(new URL('../scripts/evaluators/preparation-verification-activity.mjs', import.meta.url), { bigint: true });
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      const result = Reflect.apply(original, fs, args);
      if (typeof args[0] === 'number' && fs.fstatSync(args[0], { bigint: true }).ino === helper.ino && Buffer.isBuffer(result)) {
        const changed = Buffer.from(result); changed[0] = changed[0]! ^ 1; return changed;
      }
      return result;
    }) as typeof fs.readFileSync);
    expect(() => inspectBuiltinEvaluatorBundle(f.directory)).toThrow();
  });
  it('never resolves an arbitrary identifier or executable', () => {
    expect(() => resolveBuiltinEvaluator('/tmp/controller' as 'preparation-measurement-v1')).toThrow();
  });
});

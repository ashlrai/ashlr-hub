/** Real compiler, fixed checker and private files; no emit, candidate execution,
 * installed bundle writes, native workload or provider calls. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorPreparationTypecheckProject } from '../scripts/build-preparation-typecheck.mjs';
import { PREPARATION_TYPECHECK_OPTIONS, PREPARATION_TYPECHECK_TARGET } from '../src/core/universe/preparation-typecheck-project.js';
import { verifyPreparationTypes } from '../src/core/universe/preparation-typecheck.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});
const compiler = createRequire(import.meta.url).resolve('typescript');
const compilerDirectory = dirname(compiler);
const roots: string[] = [];
const baseline = 'import type { Value } from "fixture-lib";\nexport function prepare(value: Value): string { return value; }\n';
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const invalid = /Preparation typecheck authoring inputs unavailable, invalid or changed/;

afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'preparation-typecheck-author-'))); roots.push(root);
  const write = (path: string, text: string | Buffer) => {
    const file = join(root, path); fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 });
  };
  write('tsconfig.json', JSON.stringify({ compilerOptions: PREPARATION_TYPECHECK_OPTIONS, include: ['src'] }));
  write('package.json', '{"type":"module"}');
  write(PREPARATION_TYPECHECK_TARGET, baseline);
  write('src/z-consumer.ts', 'import { prepare } from "./core/resources/engineering-preparation.js";\nexport const observed: string = prepare("ok");\n');
  write('node_modules/fixture-lib/package.json', '{"name":"fixture-lib","version":"1.0.0","type":"module","exports":{".":{"types":"./index.d.ts"}}}');
  write('node_modules/fixture-lib/index.d.ts', 'export type Value = string;\n');
  write('node_modules/typescript/package.json', fs.readFileSync(join(compilerDirectory, '../package.json')));
  write('node_modules/typescript/lib/typescript.js', fs.readFileSync(compiler));
  for (const name of fs.readdirSync(compilerDirectory).filter(name => /^lib\..*\.d\.ts$/.test(name))) {
    write(`node_modules/typescript/lib/${name}`, fs.readFileSync(join(compilerDirectory, name)));
  }
  const author = () => authorPreparationTypecheckProject({ repository: root, expectedSourceSha256: sha(baseline) });
  return { root, write, author };
}

describe('trusted preparation typecheck project authoring', () => {
  it('captures all roots, reverse consumers, referenced libs and package metadata deterministically without emitting files', async () => {
    const f = fixture(); const before = fs.readdirSync(f.root);
    const first = await f.author(), second = await f.author();
    expect(second).toEqual(first); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(32 * 1024 * 1024);
    expect(first.compilerVersion).toBe(ts.version); expect(first.baselineSourceSha256).toBe(sha(baseline));
    expect(first.rootNames).toEqual([PREPARATION_TYPECHECK_TARGET, 'src/z-consumer.ts']);
    expect(first.files.map(file => file.path)).toEqual(expect.arrayContaining(['tsconfig.json', 'package.json',
      'src/z-consumer.ts', 'node_modules/fixture-lib/package.json', 'node_modules/fixture-lib/index.d.ts',
      'node_modules/typescript/lib/lib.es2022.d.ts', 'node_modules/typescript/lib/lib.es5.d.ts']));
    expect(first.files.every(file => !file.path.startsWith('/') && !file.path.includes(f.root))).toBe(true);
    expect(verifyPreparationTypes(first, baseline)).toMatchObject({ passed: true, diagnosticCount: 0 });
    expect(verifyPreparationTypes(first, baseline.replace('): string { return value;', '): number { return value.length;')))
      .toMatchObject({ passed: false, code: 'PREPARATION_TYPES_DIAGNOSTICS' });
    expect(fs.readdirSync(f.root)).toEqual(before); expect(fs.existsSync(join(f.root, 'dist'))).toBe(false);
  }, 30_000);

  it('refuses an incorrect baseline pin', async () => {
    const f = fixture(); await expect(authorPreparationTypecheckProject({ repository: f.root, expectedSourceSha256: '0'.repeat(64) })).rejects.toThrow(invalid);
  }, 15_000);

  it('preserves a target UTF-8 BOM in the pinned source text and closed baseline check', async () => {
    const f = fixture(); const source = `\uFEFF${baseline}`; f.write(PREPARATION_TYPECHECK_TARGET, source);
    const project = await authorPreparationTypecheckProject({ repository: f.root, expectedSourceSha256: sha(source) });
    expect(project.baselineSourceSha256).toBe(sha(source));
    expect(project.files.find(file => file.path === PREPARATION_TYPECHECK_TARGET)?.text).toBe(source);
    expect(verifyPreparationTypes(project, source)).toMatchObject({ passed: true, diagnosticCount: 0 });
  }, 15_000);

  it('refuses a baseline whose reverse consumer fails full compilation', async () => {
    const f = fixture(); f.write('src/z-consumer.ts', 'import { prepare } from "./core/resources/engineering-preparation.js";\nexport const observed: number = prepare("ok");\n');
    await expect(f.author()).rejects.toThrow(invalid);
  }, 15_000);

  it.each(['source', 'dependency'])('refuses a symlinked %s outside the canonical authoring root', async kind => {
    const f = fixture(); const other = fixture();
    const path = kind === 'source' ? PREPARATION_TYPECHECK_TARGET : 'node_modules/fixture-lib/index.d.ts';
    fs.unlinkSync(join(f.root, path)); fs.symlinkSync(join(other.root, path), join(f.root, path));
    await expect(f.author()).rejects.toThrow(invalid);
  }, 15_000);

  it('refuses source drift after initial capture even if the discovery host used cached clean bytes', async () => {
    const f = fixture(); const actual = await vi.importActual<typeof import('node:fs')>('node:fs'); let injected = false;
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!injected && args[0] === join(f.root, 'src/z-consumer.ts')) {
        f.write(PREPARATION_TYPECHECK_TARGET, `${baseline}// changed during capture\n`); injected = true;
      }
      return actual.openSync(...args);
    });
    await expect(f.author()).rejects.toThrow(invalid); expect(injected).toBe(true);
  }, 15_000);

  it('refuses a new root inserted in an initially empty included directory during compilation', async () => {
    const f = fixture(); fs.mkdirSync(join(f.root, 'src/empty'), { mode: 0o700 });
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs'); let injected = false;
    vi.mocked(fs.openSync).mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (!injected && args[0] === join(f.root, 'src/z-consumer.ts')) {
        f.write('src/empty/new-root.ts', 'export const newlyAdded = 1;\n'); injected = true;
      }
      return actual.openSync(...args);
    });
    await expect(f.author()).rejects.toThrow(invalid); expect(injected).toBe(true);
  }, 15_000);

  it.each(['extends', 'references'])('refuses additional %s configuration authority', async key => {
    const f = fixture(); f.write('tsconfig.json', JSON.stringify({ compilerOptions: PREPARATION_TYPECHECK_OPTIONS,
      include: ['src'], [key]: key === 'extends' ? '../tsconfig.json' : [] }));
    await expect(f.author()).rejects.toThrow(invalid);
  }, 15_000);

  it('refuses outside include patterns rather than silently shrinking the configured project', async () => {
    const f = fixture(); f.write('tsconfig.json', JSON.stringify({ compilerOptions: PREPARATION_TYPECHECK_OPTIONS,
      include: ['src', '../another-project/src'] }));
    await expect(f.author()).rejects.toThrow(invalid);
  }, 15_000);

  it('refuses a mismatched compiler file rather than falling back to a host compiler', async () => {
    const f = fixture(); f.write('node_modules/typescript/lib/typescript.js', '// not the authoring compiler\n');
    await expect(f.author()).rejects.toThrow(invalid);
  }, 15_000);

  it('refuses a per-file bound before allocating or compiling its payload', async () => {
    const f = fixture(); const file = join(f.root, 'src/oversized.ts'); const fd = fs.openSync(file, 'w');
    try { fs.ftruncateSync(fd, 8 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
    await expect(f.author()).rejects.toThrow(invalid);
  }, 15_000);

});

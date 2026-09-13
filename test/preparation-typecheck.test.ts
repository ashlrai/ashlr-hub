/** Real compiler on a tiny, closed project; no source evaluation or native tools. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyPreparationTypes } from '../src/core/universe/preparation-typecheck.js';
import { parsePreparationTypecheckProject, validatePreparationTypecheckProject, PREPARATION_TYPECHECK_OPTIONS,
  PREPARATION_TYPECHECK_TARGET as target, MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES,
  type PreparationTypecheckProject } from '../src/core/universe/preparation-typecheck-project.js';

const source = 'export function value(): number { return 1; }\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(): PreparationTypecheckProject {
  return { schemaVersion: 1, kind: 'preparation-typecheck-project', compilerVersion: ts.version,
    baselineSourceSha256: hash(source), compilerOptions: { ...PREPARATION_TYPECHECK_OPTIONS, lib: ['ES2022'] },
    rootNames: ['src/consumer.ts', target].sort((a, b) => a.localeCompare(b)), files: [
      { path: 'package.json', text: '{"type":"module"}' },
      { path: 'node_modules/typescript/lib/lib.es2022.d.ts', text: 'interface Array<T> { length: number; [n:number]: T }\n' +
        ['Boolean', 'Function', 'CallableFunction', 'NewableFunction', 'IArguments', 'Number', 'Object', 'RegExp', 'String'].map(name => `interface ${name} {}`).join('\n') },
      { path: target, text: source },
      { path: 'src/consumer.ts', text: "import {value} from './core/resources/engineering-preparation.js'; export const result: number = value();\n" },
    ].sort((a, b) => a.path.localeCompare(b.path)) };
}
afterEach(() => vi.restoreAllMocks());
const passed = { passed: true, code: 'PREPARATION_TYPES_PASSED', diagnosticCount: 0, diagnosticCodes: [] };

describe('closed selected-source full-program TypeScript compiler', () => {
  it('checks baseline and changed selected source without mutating the project', () => {
    const project = fixture(), before = JSON.stringify(project);
    expect(verifyPreparationTypes(project, source)).toEqual(passed);
    expect(verifyPreparationTypes(project, source.replace('return 1', 'return 2'))).toEqual(passed);
    expect(JSON.stringify(project)).toBe(before);
  });
  it('detects selected source errors, not only the baseline overlay', () => {
    const result = verifyPreparationTypes(fixture(), source.replace('return 1', "return 'secret /private/path'"));
    expect(result).toMatchObject({ passed: false, code: 'PREPARATION_TYPES_DIAGNOSTICS', diagnosticCodes: [2322] });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|candidate\.ts/);
  });
  it('checks reverse consumers when the changed export is valid in isolation', () => {
    const result = verifyPreparationTypes(fixture(), "export function value(): string { return 'ok'; }\n");
    expect(result).toMatchObject({ passed: false, code: 'PREPARATION_TYPES_DIAGNOSTICS', diagnosticCodes: [2322] });
  });
  it('refuses unknown dependencies even if the ambient compiler host offers them', () => {
    const read = vi.spyOn(ts.sys, 'readFile').mockImplementation(() => 'export const absent: number = 1;');
    const exists = vi.spyOn(ts.sys, 'fileExists').mockReturnValue(true);
    const directories = vi.spyOn(ts.sys, 'getDirectories').mockReturnValue(['/private/external']);
    const result = verifyPreparationTypes(fixture(), "import {absent} from '/private/external.js'; export const value = () => absent;\n");
    expect(result.passed).toBe(false); expect(result.diagnosticCodes).toContain(2307);
    expect(read).not.toHaveBeenCalled(); expect(exists).not.toHaveBeenCalled(); expect(directories).not.toHaveBeenCalled();
  });
  it('uses packaged dependencies and package metadata without ts.sys reads, discovery or writes', () => {
    const methods = ['readFile', 'fileExists', 'readDirectory', 'getDirectories', 'directoryExists', 'realpath', 'getCurrentDirectory', 'writeFile'] as const;
    const spies = methods.map(method => vi.spyOn(ts.sys, method).mockImplementation((() => { throw new Error('Ambient access'); }) as never));
    const project = fixture();
    project.files.push({ path: 'node_modules/fixed/package.json', text: '{"name":"fixed","type":"module","types":"index.d.ts"}' },
      { path: 'node_modules/fixed/index.d.ts', text: 'export declare const count: number;' });
    project.files.sort((a, b) => a.path.localeCompare(b.path));
    expect(verifyPreparationTypes(project, "import {count} from 'fixed'; export const value = (): number => count;\n")).toEqual(passed);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
  it.each(['// @ts-nocheck\n', '// @ts-ignore\n', '// @ts-expect-error\n', '/* @ts-nocheck */\n',
    '/// <reference path="/private/external.ts" />\n', '/// <reference types="node" />\n', '/// <reference no-default-lib="true"/>\n'])(
    'refuses checking suppression or triple-slash directives %s', directive => {
      expect(verifyPreparationTypes(fixture(), directive + source)).toMatchObject({ passed: false, code: 'PREPARATION_TYPES_DIRECTIVE_REFUSED', diagnosticCodes: [99999] });
    });
  it.each([
    "export const literal = '// @ts-nocheck';\n",
    'export const literal = `// @ts-ignore`;\n',
    'export const literal = /@ts-expect-error/;\n',
    'export const literal = `head ${1} // @ts-ignore`;\n',
    'export const literal = `head ${1} middle ${2} // @ts-nocheck`;\n',
  ])('does not confuse literal bytes with comments %s', suffix => {
    expect(verifyPreparationTypes(fixture(), source + suffix)).toEqual(passed);
  });
  it('detects a real suppression inside a template expression', () => {
    expect(verifyPreparationTypes(fixture(), source + 'export const literal = `${\n// @ts-ignore\n1}`;\n'))
      .toMatchObject({ passed: false, code: 'PREPARATION_TYPES_DIRECTIVE_REFUSED' });
  });
  it('never executes candidate top-level source', () => {
    expect(verifyPreparationTypes(fixture(), source + "throw 'must not execute';\n")).toEqual(passed);
  });
  it.each(['version', 'digest', 'missing-target', 'missing-root', 'missing-lib', 'looser-options', 'plugin', 'path-map', 'absolute-path', 'duplicate', 'ancestor'])(
    'refuses invalid or incomplete project %s', kind => {
      const project = fixture();
      if (kind === 'version') project.compilerVersion = '0.0.1';
      if (kind === 'digest') project.baselineSourceSha256 = '0'.repeat(64);
      if (kind === 'missing-target') project.files = project.files.filter(row => row.path !== target);
      if (kind === 'missing-root') project.rootNames = ['src/consumer.ts'];
      if (kind === 'missing-lib') project.files = project.files.filter(row => !row.path.includes('/lib/'));
      if (kind === 'looser-options') project.compilerOptions.strict = false;
      if (kind === 'plugin') Object.assign(project.compilerOptions, { plugins: [{ name: 'foreign' }] });
      if (kind === 'path-map') Object.assign(project.compilerOptions, { paths: { '*': ['/private/*'] } });
      if (kind === 'absolute-path') project.files[0]!.path = '/private/external';
      if (kind === 'duplicate') project.files.push(project.files[0]!);
      if (kind === 'ancestor') { project.files.push({ path: 'src', text: '' }); project.files.sort((a, b) => a.path.localeCompare(b.path)); }
      expect(verifyPreparationTypes(project, source).passed).toBe(false);
    });
  it.each([null, 1, '\ud800', 'x'.repeat(MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES + 1)])('refuses invalid bounded candidate', candidate => {
    expect(verifyPreparationTypes(fixture(), candidate)).toMatchObject({ passed: false, code: 'PREPARATION_TYPES_INVALID_CANDIDATE' });
  });
});

describe('data-only preparation typecheck project codec', () => {
  it('roundtrips a detached bounded project', () => {
    const project = fixture(), decoded = parsePreparationTypecheckProject(JSON.stringify(project));
    expect(decoded).toEqual(project); decoded.files[0]!.text = 'changed'; expect(project.files[0]!.text).not.toBe('changed');
  });
  it('refuses proxies, revoked proxies, getters, sparse arrays, symbols and unknown fields without invocation', () => {
    const project = fixture(), getter = vi.fn(() => { throw new Error('private'); });
    const bad = { ...project }; Object.defineProperty(bad, 'files', { get: getter });
    const revoked = Proxy.revocable(project, {}); revoked.revoke();
    const sparse = { ...project, files: new Array(2) };
    for (const value of [bad, revoked.proxy, new Proxy(project, { get: getter }), sparse, { ...project, extra: true }, { ...project, [Symbol('hidden')]: 1 }]) {
      expect(() => validatePreparationTypecheckProject(value)).toThrow('Invalid preparation typecheck project');
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('redacts malformed JSON and rejects relaxed policies', () => {
    expect(() => parsePreparationTypecheckProject('{ /private/secret')).toThrow('Invalid preparation typecheck project');
    const project = fixture(); project.compilerOptions.noUnusedLocals = false;
    expect(() => validatePreparationTypecheckProject(project)).toThrow('Invalid preparation typecheck project');
  });
});

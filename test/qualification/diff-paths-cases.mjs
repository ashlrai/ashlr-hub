import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, Script } from 'node:vm';

const body = '@@ -3,2 +5,3 @@ section\n same\n-before\n+after\n+extra\n';
const patch = (oldPath, newPath, git = true) =>
  `${git ? `diff --git a/${oldPath ?? newPath} b/${newPath ?? oldPath}\n` : ''}--- ${oldPath === null ? '/dev/null' : `a/${oldPath}`}\n+++ ${newPath === null ? '/dev/null' : `b/${newPath}`}\n${oldPath === null ? '@@ -0,0 +1,2 @@\n+after\n+extra\n' : newPath === null ? '@@ -1,2 +0,0 @@\n-before\n-gone\n' : body}`;
const lines = [
  { kind: 'context', text: 'same', oldLineNo: 3, newLineNo: 5 },
  { kind: 'del', text: 'before', oldLineNo: 4, newLineNo: null },
  { kind: 'add', text: 'after', oldLineNo: null, newLineNo: 6 },
  { kind: 'add', text: 'extra', oldLineNo: null, newLineNo: 7 },
];
const file = (oldPath, newPath, index = 0) => ({
  id: `${index}:${newPath ?? oldPath}`, oldPath, newPath, displayPath: newPath ?? oldPath,
  status: oldPath === null ? 'added' : newPath === null ? 'deleted' : oldPath === newPath ? 'modified' : 'renamed',
  hunks: [oldPath === null ? { header: '@@ -0,0 +1,2 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2,
    lines: [{ kind: 'add', text: 'after', oldLineNo: null, newLineNo: 1 }, { kind: 'add', text: 'extra', oldLineNo: null, newLineNo: 2 }] }
    : newPath === null ? { header: '@@ -1,2 +0,0 @@', oldStart: 1, oldLines: 2, newStart: 0, newLines: 0,
      lines: [{ kind: 'del', text: 'before', oldLineNo: 1, newLineNo: null }, { kind: 'del', text: 'gone', oldLineNo: 2, newLineNo: null }] }
      : { header: '@@ -3,2 +5,3 @@ section', oldStart: 3, oldLines: 2, newStart: 5, newLines: 3, lines }],
  additions: newPath === null ? 0 : 2, deletions: oldPath === null ? 0 : newPath === null ? 2 : 1, unparsedNotice: null,
});
const same = (actual, expected) => isDeepStrictEqual(actual, expected);
const pairs = [
  ['ordinary-path', 'src/config.ts', 'src/config.ts', true],
  ['leading-a-directory', 'a/config.ts', 'a/config.ts', true],
  ['leading-b-directory', 'b/config.ts', 'b/config.ts', true],
  ['repeated-a-directory', 'a/a/config.ts', 'a/a/config.ts', true],
  ['mixed-prefix-directories', 'b/a/b/config.ts', 'b/a/b/config.ts', true],
  ['rename-between-prefix-directories', 'a/config.ts', 'b/config.ts', true],
  ['addition-in-a-directory', null, 'a/new.ts', true],
  ['deletion-in-b-directory', 'b/gone.ts', null, true],
  ['headerless-prefix-directory', 'a/plain.txt', 'a/plain.txt', false],
  ['ordinary-headerless', 'src/plain.txt', 'src/plain.txt', false],
];

export const CASE_NAMES = [...pairs.map(([name]) => name), 'multi-file-distinct-identities',
  'binary-notice', 'raw-fallback', 'empty-input', 'split-rows-preserve-input'];
export const CASE_MESSAGES = [
  'Ordinary src/config.ts path, status, or hunk evidence changed',
  'Repository path a/config.ts was not preserved',
  'Repository path b/config.ts was not preserved',
  'Repository path a/a/config.ts was not preserved',
  'Repository path b/a/b/config.ts was not preserved',
  'Rename a/config.ts to b/config.ts lost its paths or renamed status',
  'Added a/new.ts lost its path or null old path',
  'Deleted b/gone.ts lost its path or null new path',
  'Headerless a/plain.txt lost its path or hunk evidence',
  'Ordinary headerless src/plain.txt behavior changed',
  'Multiple config.ts files lost distinct paths, IDs, or file order',
  'Binary a/image.png notice or fallback paths changed',
  'Unparseable input was not preserved verbatim',
  'Empty, null, or undefined input behavior changed',
  'Split rows changed line evidence, pairing, or the input array',
];

export function runCases({ parseUnifiedDiff, toSplitRows }) {
  const checks = pairs.map(([, oldPath, newPath, git]) => () =>
    same(parseUnifiedDiff(patch(oldPath, newPath, git)), { files: [file(oldPath, newPath)], malformed: false }));
  checks.push(() => same(parseUnifiedDiff(patch('a/config.ts', 'a/config.ts') + patch('b/config.ts', 'b/config.ts')),
    { files: [file('a/config.ts', 'a/config.ts'), file('b/config.ts', 'b/config.ts', 1)], malformed: false }));
  checks.push(() => {
    const raw = 'diff --git a/a/image.png b/a/image.png\nBinary files a/a/image.png and b/a/image.png differ\n';
    return same(parseUnifiedDiff(raw), { malformed: false, files: [{ id: '0:a/image.png', oldPath: 'a/image.png',
      newPath: 'a/image.png', displayPath: 'a/image.png', status: 'modified', hunks: [], additions: 0,
      deletions: 0, unparsedNotice: raw.trim() }] });
  });
  checks.push(() => {
    const raw = '  proposal without a unified diff\n';
    return same(parseUnifiedDiff(raw), { malformed: true, files: [{ id: 'raw', oldPath: null, newPath: null,
      displayPath: '(unparsed diff)', status: 'modified', hunks: [], additions: 0, deletions: 0, unparsedNotice: raw }] });
  });
  checks.push(() => [undefined, null, '', ' \n '].every(input => same(parseUnifiedDiff(input), { files: [], malformed: false })));
  checks.push(() => {
    const input = Object.freeze(lines.map(line => Object.freeze({ ...line })));
    const before = JSON.stringify(input);
    const result = toSplitRows(input);
    return same(result, [{ left: lines[0], right: lines[0] }, { left: lines[1], right: lines[2] },
      { left: null, right: lines[3] }]) && JSON.stringify(input) === before;
  });
  return checks.map(check => { try { return check() === true; } catch { return false; } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Grade separation, not an OS sandbox: candidate code gets no host objects,
  // module imports, process, output stream, or assertions. The outer command
  // still runs under Universe's execution scope and fixed timeout.
  const context = createContext(Object.assign(Object.create(null), { console: undefined }), { codeGeneration: { strings: false, wasm: false } });
  const source = stripTypeScriptTypes(readFileSync(process.argv[2], 'utf8'), { mode: 'strip' })
    .replace(/\bexport\s+(?=function\s+(?:parseUnifiedDiff|toSplitRows)\b)/g, '');
  new Script(`
    const __freeze = Object.freeze;
    const __capture = (() => {
      const descriptors = Object.getOwnPropertyDescriptors, keys = Reflect.ownKeys, hasOwn = Object.hasOwn;
      const array = Array.isArray, create = Object.create, setPrototype = Object.setPrototypeOf;
      const stringify = JSON.stringify, finite = Number.isFinite;
      return value => {
        let nodes = 0;
        function copy(item, depth) {
          if (++nodes > 4096 || depth > 32) throw new Error('Output bounds');
          if (item === null || typeof item === 'boolean') return item;
          if (typeof item === 'string') { if (item.length > 65536) throw new Error('Output bounds'); return item; }
          if (typeof item === 'number' && finite(item)) return item;
          if (typeof item !== 'object') throw new Error('Output shape');
          const properties = descriptors(item), names = keys(properties), isArray = array(item);
          const out = isArray ? setPrototype([], null) : create(null);
          if (isArray && (!hasOwn(properties, 'length') || !hasOwn(properties.length, 'value') || properties.length.value > 4096)) throw new Error('Array bounds');
          for (let i = 0; i < names.length; i++) {
            const key = names[i], property = properties[key];
            if (typeof key !== 'string' || !hasOwn(property, 'value')) throw new Error('Output accessor');
            if (isArray && key === 'length') continue;
            if (isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= properties.length.value)) throw new Error('Array shape');
            out[key] = copy(property.value, depth + 1);
          }
          if (isArray && names.length !== properties.length.value + 1) throw new Error('Sparse array');
          return out;
        }
        return stringify(copy(value, 0));
      };
    })();
    const __parser = (function () { 'use strict';\n${source}\nreturn { parseUnifiedDiff, toSplitRows }; })();
  `).runInContext(context, { timeout: 250 });
  const call = expression => JSON.parse(new Script(`__capture(${expression})`).runInContext(context, { timeout: 100 }));
  const parser = {
    parseUnifiedDiff: input => call(`__parser.parseUnifiedDiff(${input === undefined ? 'undefined' : JSON.stringify(input)})`),
    toSplitRows: input => {
      const observed = call(`(() => { const input = ${JSON.stringify(input)}; for (let i = 0; i < input.length; i++) __freeze(input[i]); __freeze(input); return { result: __parser.toSplitRows(input), input }; })()`);
      if (!same(observed.input, input)) throw new Error('Input changed');
      return observed.result;
    },
  };
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, cases: runCases(parser) })}\n`);
}

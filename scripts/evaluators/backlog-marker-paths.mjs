/** Fixed local measurement, not a security sandbox or production acceptance.
 * Universe must pin this script in the immutable seed, keep it outside the
 * mutable file scope, and run it through its existing OS-confined evaluator.
 * Usage: node --experimental-vm-modules --no-warnings <pinned-script>
 * Only ASHLR_UNIVERSE_CANDIDATE selects the scored artifact; cwd is never a fallback.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { createContext, Script, SourceTextModule } from 'node:vm';
import { clearTimeout, setTimeout } from 'node:timers';
import { TextDecoder } from 'node:util';

const TARGET = 'src/core/portfolio/value-filter.ts';
const MAX_SOURCE_BYTES = 64 * 1024;
const SYNC_TIMEOUT_MS = 100;
const ASYNC_TIMEOUT_MS = 500;
const DETAIL = 'File marker: "TODO: retain deterministic ordering for pending batches".';
const item = (title, detail = DETAIL) => ({ id: 'fixed-marker-case', repo: '/fixture/repo', source: 'todo',
  title, detail, value: 3, effort: 2, score: 1.5, tags: ['todo'], ts: '2026-09-10T00:00:00.000Z' });

// Expected values remain in this trusted module, never in the candidate context.
// These cases preserve the existing isNonCodePath policy, not a new path policy.
const PATH_CASES = [
  ['Release Notes.md', true], ['src/My Component.test.ts', true], ['src/My Component.spec.ts', true],
  ['docs\\guide.ts', true], ['C:\\repo\\docs\\guide.ts', true], ['C:\\repo\\src\\My Component.test.ts', true],
  ['src\\__tests__\\case.ts', true], ['src/Release Notes.rst', true], ['fixtures/data.ts', true],
  ['third-party/utility.ts', true], ['src/My Component.ts', false], ['src/docs-handler.ts', false],
  ['src/contest.ts', false], ['C:\\repo\\src\\handler.ts', false], ['packages/app/src/worker.ts', false],
  ['src/über name.ts', false], ['src/über name.test.ts', true],
  ['src/my:file.test.ts', true], ['src/my:file.ts', false],
];
const cases = PATH_CASES.flatMap(([path, expected], index) => [
  { id: `path-${index + 1}`, method: 'isNonCodePath', input: path, expected },
  ...['1 marker', '2 markers', '2 MARKERS'].flatMap((prefix, form) => {
    const input = item(`${prefix} ${form === 2 ? 'IN' : 'in'} ${path}${form === 0 ? ':17' : form === 2 ? ':17:8' : ''}`);
    return ['isNonCodeMarkerItem', 'isTrivialItem'].map(method =>
      ({ id: `marker-${index + 1}-${form + 1}-${method}`, method, input, expected }));
  }),
]);
cases.push(
  { id: 'ordinary-title', method: 'isNonCodeMarkerItem', input: item('Implement docs/guide.ts behavior'), expected: false },
  { id: 'empty-marker-path', method: 'isNonCodeMarkerItem', input: item('1 marker in '), expected: false },
  { id: 'security-preserved', method: 'isTrivialItem', input: item('1 marker in Release Notes.md:17', 'Security vulnerability must be addressed.'), expected: false },
  { id: 'breaking-preserved', method: 'isTrivialItem', input: item('1 marker in src/My Component.test.ts:17', 'Breaking change requires the migration guide.'), expected: false },
  { id: 'specific-test-preserved', method: 'isTrivialItem', input: item('CI is failing', 'test("preserves pending batch ordering") fails.'), expected: false },
  { id: 'source-marker-preserved', method: 'isTrivialItem', input: item('1 marker in src/batch.ts:17'), expected: false },
  { id: 'bare-marker-preserved', method: 'isTrivialItem', input: item('1 marker in src/batch.ts:17', '"TODO:"'), expected: true },
  { id: 'comment-only-preserved', method: 'isTrivialItem', input: item('Add a doc-comment', 'Describe this helper.'), expected: true },
  { id: 'vague-ci-preserved', method: 'isTrivialItem', input: item('CI is failing', 'Please investigate.'), expected: true },
);

function source() {
  const root = process.env.ASHLR_UNIVERSE_CANDIDATE;
  if (process.argv.length !== 2 || typeof root !== 'string' || Buffer.byteLength(root) > 4096 ||
      !isAbsolute(root) || resolve(root) !== root || parse(root).root === root || realpathSync(root) !== root ||
      !lstatSync(root).isDirectory()) throw new Error();
  const path = join(root, TARGET); const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size > BigInt(MAX_SOURCE_BYTES) || realpathSync(path) !== path) throw new Error();
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd, { bigint: true });
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1); let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const after = fstatSync(fd, { bigint: true }); const named = lstatSync(path, { bigint: true });
    if (size > MAX_SOURCE_BYTES || size !== Number(before.size) ||
        [opened, after, named].some(stat => !stat.isFile() ||
          ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].some(key => stat[key] !== before[key])) ||
        realpathSync(path) !== path) throw new Error();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { if (fd !== undefined) closeSync(fd); }
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error()), ASYNC_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

async function evaluate() {
  let passedCases = 0;
  const diagnostics = [];
  let failure = 'CANDIDATE_SOURCE_UNAVAILABLE';
  try {
    const text = source();
    failure = 'CANDIDATE_MODULE_UNAVAILABLE';
    const context = createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
    });
    const subject = new SourceTextModule(stripTypeScriptTypes(text), {
      context, identifier: 'candidate-value-filter',
      importModuleDynamically: () => { throw new Error(); },
    });
    await bounded(subject.link(() => { throw new Error(); }));
    await bounded(subject.evaluate({ timeout: SYNC_TIMEOUT_MS }));
    Object.defineProperty(context, '__subject', { value: subject.namespace, writable: false, configurable: false });
    failure = 'CANDIDATE_PREDICATE_UNAVAILABLE';
    for (const test of cases) {
      // Only literal inputs enter the context. Compare the returned primitive
      // outside it; candidate code never receives the expected verdict/matrix.
      const expression = `__subject.${test.method}(${JSON.stringify(test.input)})${test.method === 'isTrivialItem' ? '.trivial' : ''}`;
      const actual = new Script(expression).runInContext(context, { timeout: SYNC_TIMEOUT_MS });
      if (typeof actual === 'boolean' && actual === test.expected) passedCases++;
      else if (diagnostics.length < 16) diagnostics.push({ code: 'BACKLOG_MARKER_CASE',
        message: `Case ${test.id}: ${test.expected ? 'filter non-code or trivial work' : 'preserve substantive or non-marker work'} using the existing path policy.`, path: TARGET });
    }
  } catch {
    diagnostics.push({ code: failure, message: 'The fixed evaluator could not obtain a bounded synchronous classification.', path: TARGET });
  }
  const passed = passedCases === cases.length && diagnostics.length === 0;
  return { passed, score: passed ? 1 : 0, metrics: { cases: cases.length, passedCases, failedCases: cases.length - passedCases },
    diagnostics: diagnostics.slice(0, 16) };
}

process.stdout.write(JSON.stringify(await evaluate()) + '\n');

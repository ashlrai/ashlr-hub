/** Real evaluator child processes; fixture-only candidate copies, no provider or host state. */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEvaluation } from '../src/core/universe/store.js';

const exec = promisify(execFile);
const SCRIPT = resolve('scripts/evaluators/backlog-marker-paths.mjs');
const TARGET = 'src/core/portfolio/value-filter.ts';
// Intentional historical seed dependency: this commit must be present in the
// test checkout. Never substitute today's candidate when testing baseline loss.
const BASELINE_SHA = '1a57744bd43ea5668f469bd8eaa394808a7f9bea';
const original = execFileSync('git', ['show', `${BASELINE_SHA}:${TARGET}`], {
  cwd: resolve('.'), encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
  env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
});
const untouched = readFileSync(resolve(TARGET), 'utf8');
let base: string; let candidate: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'backlog-marker-evaluator-')));
  candidate = join(base, 'candidate'); mkdirSync(join(candidate, 'src/core/portfolio'), { recursive: true });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });
function save(source: string | Buffer) { writeFileSync(join(candidate, TARGET), source); }
async function evaluate(root: string | undefined = candidate) {
  const result = await exec(process.execPath, ['--experimental-vm-modules', '--no-warnings', SCRIPT], {
    env: { PATH: process.env.PATH, HOME: base, TMPDIR: base, NODE_DISABLE_COMPILE_CACHE: '1',
      ...(root === undefined ? {} : { ASHLR_UNIVERSE_CANDIDATE: root }) },
    cwd: base, timeout: 5000, maxBuffer: 24 * 1024,
  });
  expect(result.stderr).toBe(''); expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(Buffer.byteLength(result.stdout)).toBeLessThan(24 * 1024);
  expect(result.stdout).not.toContain(base);
  const measurement = parseEvaluation(result.stdout);
  expect(measurement.metrics.cases).toBe(142);
  expect(measurement.metrics.passedCases! + measurement.metrics.failedCases!).toBe(142);
  expect(measurement.diagnostics!.length).toBeLessThanOrEqual(16);
  return measurement;
}
function fixedCandidate() {
  // A fixture-only repair demonstrates the immutable measurement distinguishes
  // baseline from the intended behavior. Never writes the production source.
  const patched = original
    .replace('const match = item.title.match(/^\\d+ markers? in ([^\\s:]+)/i);', 'const match = item.title.match(/^\\d+ markers? in (.+)$/i);')
    .replace('const filePath = match[1]!;\n  return NON_CODE_PATH_RE.test(filePath);',
      "const filePath = match[1]!.replace(/:\\d+(?::\\d+)?$/, '');\n  return isNonCodePath(filePath);");
  expect(patched).not.toBe(original); return patched;
}
function constants(value: string) {
  return `export function isNonCodePath(){return ${value}}\n` +
    `export function isNonCodeMarkerItem(){return ${value}}\nexport function isTrivialItem(){return {trivial:${value}}}`;
}

describe('fixed Hub backlog marker evaluator', () => {
  it('rejects the actual unchanged baseline and emits shareable diagnostics', async () => {
    save(original); const result = await evaluate();
    expect(result).toMatchObject({ passed: false, score: 0 });
    expect(result.metrics.failedCases).toBeGreaterThan(0);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'BACKLOG_MARKER_CASE', path: TARGET }));
    expect(readFileSync(resolve(TARGET), 'utf8')).toBe(untouched);
  });

  it('accepts a fixture-only copy preserving existing policy and meaningful work', async () => {
    save(fixedCandidate());
    expect(await evaluate()).toMatchObject({ passed: true, score: 1,
      metrics: { cases: 142, passedCases: 142, failedCases: 0 }, diagnostics: [] });
    expect(readFileSync(resolve(TARGET), 'utf8')).toBe(untouched);
  });

  it.each(['true', 'false', '1', '"true"', 'null', 'Promise.resolve(true)'])('rejects constant/nonboolean predicates: %s', async (value) => {
    save(constants(value)); expect(await evaluate()).toMatchObject({ passed: false, score: 0 });
  });

  it.each([
    ['throws', 'throw new Error("private candidate message")'],
    ['non-object result', 'export function isNonCodePath(){return true};export function isNonCodeMarkerItem(){return true};export function isTrivialItem(){return null}'],
    ['missing export', 'export const unrelated = true'],
    ['malformed source', 'export function {'],
    ['static runtime import', 'import fs from "node:fs"; export const unused = fs'],
    ['dynamic runtime import', 'await import("node:fs")'],
  ])('emits a fixed failed verdict for %s', async (_name, source) => {
    save(source); const result = await evaluate();
    expect(result).toMatchObject({ passed: false, score: 0 });
    expect(JSON.stringify(result)).not.toContain('private candidate message');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: expect.stringMatching(/^CANDIDATE_/) }));
  });

  it.each([
    ['module loop', 'while(true){}'],
    ['predicate loop', 'export function isNonCodePath(){while(true){}}'],
    ['unsettled top-level await', 'await new Promise(()=>{})'],
  ])('bounds %s and still emits valid failure JSON', async (_name, source) => {
    save(source); expect(await evaluate()).toMatchObject({ passed: false, score: 0 });
  });

  it.each(['missing', 'relative', 'root', 'unavailable'])('does not fall back to cwd for %s candidate environment', async (kind) => {
    save(fixedCandidate());
    const root = kind === 'missing' ? '' : kind === 'relative' ? 'candidate' : kind === 'root' ? '/' : join(base, 'absent');
    expect(await evaluate(root)).toMatchObject({ passed: false, score: 0,
      diagnostics: [expect.objectContaining({ code: 'CANDIDATE_SOURCE_UNAVAILABLE' })] });
  });

  it.each(['oversized', 'invalid UTF8', 'symlink'])('refuses %s source without evaluating it', async (kind) => {
    if (kind === 'oversized') save(' '.repeat(64 * 1024 + 1));
    else if (kind === 'invalid UTF8') save(Buffer.from([0xff]));
    else { const other = join(base, 'other.ts'); writeFileSync(other, fixedCandidate()); symlinkSync(other, join(candidate, TARGET)); }
    expect(await evaluate()).toMatchObject({ passed: false, score: 0,
      diagnostics: [expect.objectContaining({ code: 'CANDIDATE_SOURCE_UNAVAILABLE' })] });
  });
});

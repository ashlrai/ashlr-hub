/** Data-only installed project codec. Never import the TypeScript compiler here:
 * registry/score identity readers must not acquire a compiler runtime dependency. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { types } from 'node:util';

export const PREPARATION_TYPECHECK_TARGET = 'src/core/resources/engineering-preparation.ts';
export const PREPARATION_TYPECHECK_VIRTUAL_ROOT = '/ashlr-preparation-typecheck';
export const MAX_PREPARATION_TYPECHECK_INPUT_BYTES = 32 * 1024 * 1024;
export const MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES = 256 * 1024;
export const PREPARATION_TYPECHECK_OPTIONS = Object.freeze({ target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
  lib: Object.freeze(['ES2022']), outDir: 'dist', rootDir: 'src', strict: true, noImplicitOverride: true,
  noUnusedLocals: true, noUnusedParameters: true, noFallthroughCasesInSwitch: true, exactOptionalPropertyTypes: false,
  esModuleInterop: true, forceConsistentCasingInFileNames: true, skipLibCheck: true, declaration: true, sourceMap: true });
export interface PreparationTypecheckProject {
  schemaVersion: 1;
  kind: 'preparation-typecheck-project';
  compilerVersion: string;
  baselineSourceSha256: string;
  rootNames: string[];
  compilerOptions: Record<string, string | boolean | string[]>;
  files: Array<{ path: string; text: string }>;
}
const invalid = (): never => { throw new Error('Invalid preparation typecheck project'); };
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== keys.length) return invalid();
  const fields = Object.getOwnPropertyDescriptors(input);
  if (keys.some(key => !fields[key]?.enumerable || !Object.hasOwn(fields[key]!, 'value'))) return invalid();
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value]));
}
function array(input: unknown, maximum: number): unknown[] {
  if (types.isProxy(input) || !Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > maximum || Reflect.ownKeys(input).length !== input.length + 1) return invalid();
  return Array.from({ length: input.length }, (_, index) => {
    const row = Object.getOwnPropertyDescriptor(input, String(index));
    if (!row?.enumerable || !Object.hasOwn(row, 'value')) return invalid();
    return row.value;
  });
}
function path(input: unknown): string {
  if (typeof input !== 'string' || !input.length || Buffer.byteLength(input) > 4096 ||
      /[\\:]/u.test(input) || [...input].some(character => { const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159; }) ||
      Buffer.from(input).toString('utf8') !== input ||
      posix.isAbsolute(input) || posix.normalize(input) !== input ||
      input.split('/').some(part => !part || ['.', '..', '.git', '.ashlr'].includes(part))) return invalid();
  return input;
}
function ordered(names: string[]): void {
  if (names.some((name, index) => index > 0 && names[index - 1]!.localeCompare(name) >= 0)) invalid();
}
/** Exact checked-in compiler policy, not caller-selected relaxation or plugins. */
export function validatePreparationTypecheckProject(input: unknown): PreparationTypecheckProject {
  const row = object(input, ['schemaVersion', 'kind', 'compilerVersion', 'baselineSourceSha256', 'rootNames', 'compilerOptions', 'files']);
  if (row.schemaVersion !== 1 || row.kind !== 'preparation-typecheck-project' || typeof row.compilerVersion !== 'string' ||
      !/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,80})?$/.test(row.compilerVersion) ||
      typeof row.baselineSourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.baselineSourceSha256)) return invalid();
  const options = object(row.compilerOptions, Object.keys(PREPARATION_TYPECHECK_OPTIONS));
  for (const [key, value] of Object.entries(PREPARATION_TYPECHECK_OPTIONS)) {
    if (key === 'lib') {
      const lib = array(options.lib, 1); if (lib.length !== 1 || lib[0] !== 'ES2022') return invalid();
    } else if (options[key] !== value) return invalid();
  }
  let bytes = 0;
  const files = array(row.files, 8192).map(input => {
    const file = object(input, ['path', 'text']);
    if (typeof file.text !== 'string' || Buffer.byteLength(file.text) > 8 * 1024 * 1024 ||
        Buffer.from(file.text).toString('utf8') !== file.text) return invalid();
    bytes += Buffer.byteLength(file.text); if (bytes > MAX_PREPARATION_TYPECHECK_INPUT_BYTES) return invalid();
    return { path: path(file.path), text: file.text };
  });
  const names = new Set(files.map(file => file.path)); ordered(files.map(file => file.path));
  if (!files.length || files.some(file => file.path.split('/').slice(0, -1)
    .some((_part, index, parts) => names.has(parts.slice(0, index + 1).join('/'))))) return invalid();
  const rootNames = array(row.rootNames, 4096).map(path); ordered(rootNames);
  if (!rootNames.includes(PREPARATION_TYPECHECK_TARGET) || rootNames.some(name => !names.has(name) || !/\.[cm]?tsx?$/.test(name))) return invalid();
  const baseline = files.find(file => file.path === PREPARATION_TYPECHECK_TARGET);
  if (!baseline || Buffer.byteLength(baseline.text) > MAX_PREPARATION_TYPECHECK_CANDIDATE_BYTES ||
      createHash('sha256').update(baseline.text).digest('hex') !== row.baselineSourceSha256) return invalid();
  const project: PreparationTypecheckProject = { schemaVersion: 1, kind: 'preparation-typecheck-project', compilerVersion: row.compilerVersion,
    baselineSourceSha256: row.baselineSourceSha256, rootNames, compilerOptions: { ...PREPARATION_TYPECHECK_OPTIONS, lib: ['ES2022'] }, files };
  if (Buffer.byteLength(JSON.stringify(project)) > MAX_PREPARATION_TYPECHECK_INPUT_BYTES) return invalid();
  return project;
}
export function parsePreparationTypecheckProject(json: string): PreparationTypecheckProject {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_PREPARATION_TYPECHECK_INPUT_BYTES) return invalid();
  try { return validatePreparationTypecheckProject(JSON.parse(json)); } catch { return invalid(); }
}

/** Explicit project bindings; no discovery, directory creation, or permission repair. */
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';
import type { ResourceConsoleProjectInput } from './console-types.js';

export interface ResourceConsoleProjectBinding extends ResourceConsoleProjectInput { dev: string; ino: string }
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COUNT = /^(0|[1-9][0-9]{0,31})$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}
function clean(value: string): boolean {
  return [...value].every((char) => { const code = char.charCodeAt(0); return code >= 32 && !(code >= 127 && code <= 159); });
}
function project(value: unknown, binding: boolean): ResourceConsoleProjectInput {
  if (!object(value) || !exact(value, ['id', 'label', 'workspace', ...(binding ? ['dev', 'ino'] : [])]) ||
    typeof value.id !== 'string' || !ID.test(value.id) || typeof value.label !== 'string' ||
    !value.label.trim() || value.label !== value.label.trim() || Buffer.byteLength(value.label) > 128 || !clean(value.label) ||
    typeof value.workspace !== 'string' || value.workspace.length > 4096 || !clean(value.workspace) ||
    !isAbsolute(value.workspace) || resolve(value.workspace) !== value.workspace || value.workspace === parse(value.workspace).root ||
    binding && (typeof value.dev !== 'string' || !COUNT.test(value.dev) || typeof value.ino !== 'string' || !COUNT.test(value.ino))) {
    throw new Error('Invalid explicit resource project');
  }
  return { id: value.id, label: value.label, workspace: value.workspace };
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1 ||
    !Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) &&
      'value' in Object.getOwnPropertyDescriptor(value, index)!).every(Boolean)) throw new Error('Invalid resource project catalog');
}

/** Syntax/path-form only. Registration pins real directory identities separately. */
export function validateResourceConsoleProjects(value: unknown): ResourceConsoleProjectInput[] {
  array(value, 31); const ids = new Set(['default']); const paths = new Set<string>();
  return value.map((row) => {
    const parsed = project(row, false);
    if (ids.has(parsed.id) || paths.has(parsed.workspace)) throw new Error('Duplicate or reserved resource project');
    ids.add(parsed.id); paths.add(parsed.workspace); return parsed;
  });
}

export function validateResourceConsoleProjectBindings(value: unknown, workspace: string): ResourceConsoleProjectBinding[] {
  array(value, 32); const ids = new Set<string>(); const paths = new Set<string>(); const identities = new Set<string>();
  if (value.length === 0) throw new Error('Resource project bindings are missing');
  const result = value.map((row) => {
    const parsed = project(row, true); const identity = row as { dev: string; ino: string };
    const key = `${identity.dev}:${identity.ino}`;
    if (ids.has(parsed.id) || paths.has(parsed.workspace) || identities.has(key)) throw new Error('Duplicate resource project binding');
    ids.add(parsed.id); paths.add(parsed.workspace); identities.add(key); return { ...parsed, dev: identity.dev, ino: identity.ino };
  });
  if (result[0]!.id !== 'default' || result[0]!.workspace !== workspace) throw new Error('Legacy default workspace changed');
  return result;
}

/** Descriptor identity is checked against both the named directory and canonical path. */
export function pinResourceConsoleProject(value: ResourceConsoleProjectInput): ResourceConsoleProjectBinding {
  const parsed = project(value, false); let fd: number | undefined;
  try {
    const before = lstatSync(parsed.workspace, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(parsed.workspace) !== parsed.workspace) throw new Error();
    fd = openSync(parsed.workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd, { bigint: true }); const after = lstatSync(parsed.workspace, { bigint: true });
    if (!opened.isDirectory() || !after.isDirectory() || after.isSymbolicLink() ||
      opened.dev !== before.dev || opened.ino !== before.ino || after.dev !== opened.dev || after.ino !== opened.ino ||
      realpathSync(parsed.workspace) !== parsed.workspace) throw new Error();
    return { ...parsed, dev: opened.dev.toString(), ino: opened.ino.toString() };
  } catch { throw new Error('Resource project directory is unavailable'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function matchesResourceConsoleProject(binding: ResourceConsoleProjectBinding): boolean {
  try {
    const current = pinResourceConsoleProject({ id: binding.id, label: binding.label, workspace: binding.workspace });
    return current.dev === binding.dev && current.ino === binding.ino;
  } catch { return false; }
}

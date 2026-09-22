import type { ResourceConsoleFileListing, ResourceConsoleFilePreview } from '../../core/resources/console-files-types.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { ApiError, apiPost } from './client.js';

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const clean = (value: string) => ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159);
const relative = (value: unknown, root = false): value is string => typeof value === 'string' && bytes(value) <= 4096 &&
  clean(value) && !value.includes('\\') && (root && value === '' || value.split('/').every((part) => !!part && part !== '.' && part !== '..'));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Explicit privileged reads: no polling cache, URL paths, persistence or worker invocation. */
async function request(projectId: string, path: string, action: 'list' | 'read', signal?: AbortSignal): Promise<unknown> {
  if (!id(projectId) || !relative(path, action === 'list')) throw new Error('Select a registered project and relative file path.');
  const token = getMutationToken();
  if (!token) throw new Error('Unlock controls to read project files.');
  try {
    const value = await apiPost<unknown>(`/api/resources/projects/${projectId}/files/${action}`, { path }, token, signal);
    if (signal?.aborted || getMutationToken() !== token) throw new Error('Project file read was cancelled.');
    touchMutationHold(); return value;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401 && getMutationToken() === token) clearMutationToken();
    if (error instanceof ApiError && error.status === 404) throw new Error('Project path was not found. Refresh the directory and select an existing file.');
    throw error;
  }
}

export async function listWorkspaceFiles(projectId: string, path: string, signal?: AbortSignal): Promise<ResourceConsoleFileListing> {
  const value = await request(projectId, path, 'list', signal);
  if (!object(value) || !exact(value, ['projectId', 'path', 'entries']) || value.projectId !== projectId || value.path !== path ||
    !Array.isArray(value.entries) || value.entries.length > 256) throw new Error('Project directory response could not be verified.');
  const names = new Set<string>();
  for (const row of value.entries) {
    if (!object(row) || !exact(row, ['name', 'path', 'kind', 'sizeBytes']) || !relative(row.name) || row.name.includes('/') ||
      names.has(row.name) || row.path !== (path ? `${path}/${row.name}` : row.name) || !relative(row.path) ||
      !(row.kind === 'directory' && row.sizeBytes === null || row.kind === 'file' && count(row.sizeBytes))) {
      throw new Error('Project directory response could not be verified.');
    }
    names.add(row.name);
  }
  return value as unknown as ResourceConsoleFileListing;
}

export async function readWorkspaceFile(projectId: string, path: string, signal?: AbortSignal): Promise<ResourceConsoleFilePreview> {
  const value = await request(projectId, path, 'read', signal);
  if (!object(value) || !exact(value, ['projectId', 'path', 'text', 'sizeBytes', 'byteLength', 'truncated', 'digest']) ||
    value.projectId !== projectId || value.path !== path || typeof value.text !== 'string' || !count(value.byteLength) ||
    value.byteLength > 64 * 1024 || bytes(value.text) !== value.byteLength ||
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(new TextEncoder().encode(value.text)) !== value.text ||
    !count(value.sizeBytes) || value.sizeBytes < value.byteLength ||
    typeof value.truncated !== 'boolean' || value.truncated !== (value.byteLength < value.sizeBytes) ||
    typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || [...value.text].some((c) =>
      c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)) || c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) {
    throw new Error('Project file response could not be verified.');
  }
  return value as unknown as ResourceConsoleFilePreview;
}

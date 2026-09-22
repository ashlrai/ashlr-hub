import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiPost, ApiError } from './client.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { listWorkspaceFiles, readWorkspaceFile } from './workspace-files.js';
vi.mock('./client.js', async (original) => ({ ...await original<typeof import('./client.js')>(), apiPost: vi.fn() }));
vi.mock('./auth-store.js', () => ({ getMutationToken: vi.fn(), clearMutationToken: vi.fn(), touchMutationHold: vi.fn() }));
const post = vi.mocked(apiPost);
const preview = () => ({ projectId: 'default', path: 'README.md', text: 'hello', byteLength: 5, sizeBytes: 5, truncated: false, digest: 'a'.repeat(64) });
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getMutationToken).mockReturnValue('private-control'); });
afterEach(() => { vi.restoreAllMocks(); });
describe('explicit project file query boundary', () => {
  it('uses a control token, body-only relative path and abort signal', async () => {
    const controller = new AbortController(); const value = preview(); post.mockResolvedValue(value);
    await expect(readWorkspaceFile('default', 'README.md', controller.signal)).resolves.toEqual(value);
    expect(post).toHaveBeenCalledWith('/api/resources/projects/default/files/read', { path: 'README.md' }, 'private-control', controller.signal);
    expect(touchMutationHold).toHaveBeenCalledOnce();
  });
  it('does not request files without unlocked control authority', async () => {
    vi.mocked(getMutationToken).mockReturnValue(null); await expect(readWorkspaceFile('default', 'README.md')).rejects.toThrow('Unlock'); expect(post).not.toHaveBeenCalled();
  });
  it.each(['../secret', '/absolute', 'folder//file', 'folder/./file', 'a\\b', 'a\u0000b'])('rejects malformed relative paths %s', async (path) => {
    await expect(readWorkspaceFile('default', path)).rejects.toThrow('relative'); expect(post).not.toHaveBeenCalled();
  });
  it.each([
    { projectId: 'cortex' }, { path: 'other.md' }, { text: '\0' }, { byteLength: 6 }, { sizeBytes: 6 }, { digest: 'not-a-digest' }, { truncated: true }, { extra: true },
  ])('rejects mismatched or misleading file responses %j', async (patch) => {
    post.mockResolvedValue({ ...preview(), ...patch }); await expect(readWorkspaceFile('default', 'README.md')).rejects.toThrow('verified');
  });
  it('accepts empty root listing and rejects duplicate or misattributed entries', async () => {
    post.mockResolvedValue({ projectId: 'default', path: '', entries: [] }); await expect(listWorkspaceFiles('default', '')).resolves.toMatchObject({ entries: [] });
    const row = { name: 'README.md', path: 'README.md', kind: 'file', sizeBytes: 5 };
    post.mockResolvedValue({ projectId: 'default', path: '', entries: [row, row] }); await expect(listWorkspaceFiles('default', '')).rejects.toThrow('verified');
    post.mockResolvedValue({ projectId: 'default', path: 'src', entries: [row] }); await expect(listWorkspaceFiles('default', 'src')).rejects.toThrow('verified');
  });
  it('reports missing paths without claiming dispatch is disabled', async () => {
    post.mockRejectedValue(new ApiError('not found', 404, '/api/resources/projects/default/files/read'));
    await expect(readWorkspaceFile('default', 'README.md')).rejects.toThrow('Project path was not found');
  });
  it('does not return a late result after control authority changes', async () => {
    post.mockImplementation(async () => { vi.mocked(getMutationToken).mockReturnValue(null); return preview(); });
    await expect(readWorkspaceFile('default', 'README.md')).rejects.toThrow('cancelled'); expect(touchMutationHold).not.toHaveBeenCalled();
  });
  it('clears only the rejected current token', async () => {
    post.mockRejectedValue(new ApiError('rejected', 401, '/files')); await expect(readWorkspaceFile('default', 'README.md')).rejects.toThrow('rejected');
    expect(clearMutationToken).toHaveBeenCalledOnce();
  });
});

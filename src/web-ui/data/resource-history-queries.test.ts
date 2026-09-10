import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from './client.js';
import { clearMutationToken, setMutationToken } from './auth-store.js';
import { readResourceTaskHistory, deleteResourceTaskHistory, resourceConsoleScopeQuery } from './resource-pool-queries.js';
import { resourceFixture } from '../routes/resources/fixtures.test-support.js';

vi.mock('./client.js', async (original) => ({ ...await original<typeof import('./client.js')>(), apiGet: vi.fn(), apiPost: vi.fn() }));
const read = vi.mocked(apiGet); const write = vi.mocked(apiPost);
const value = { id: 'task-a', prompt: 'request', output: { text: 'response', truncated: false }, retention: 'local-until-deleted' };
beforeEach(() => { vi.clearAllMocks(); clearMutationToken(); });
describe('private history query contract', () => {
  it('reads exact task history with cancellation and no mutations', async () => {
    const signal = new AbortController().signal; read.mockResolvedValue(value);
    await expect(readResourceTaskHistory('task-a', signal)).resolves.toEqual(value);
    expect(read).toHaveBeenCalledWith('/api/resources/tasks/task-a/history', signal); expect(write).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...value, id: 'other' }, { ...value, retention: 'cloud' },
    { ...value, prompt: '😀'.repeat(8193) }, { ...value, output: { text: '😀'.repeat(16385), truncated: true } },
    { ...value, output: { text: 'x', truncated: 'false' } }, { ...value, extra: 'unexpected' },
    { ...value, output: { text: 'x', truncated: false, path: '/private' } }])('rejects malformed or over-limit payload %#', async (data) => {
    read.mockResolvedValue(data); await expect(readResourceTaskHistory('task-a')).rejects.toThrow('could not be verified');
  });
  it('accepts missing captured output honestly', async () => {
    read.mockResolvedValue({ ...value, output: null }); await expect(readResourceTaskHistory('task-a')).resolves.toMatchObject({ output: null });
  });
  it('requires control authority before deletion and validates acknowledgment', async () => {
    await expect(deleteResourceTaskHistory('task-a')).rejects.toThrow('Unlock'); expect(write).not.toHaveBeenCalled();
    setMutationToken('fixture-control'); write.mockResolvedValue({ job: { id: 'task-a', state: 'settled' } });
    await expect(deleteResourceTaskHistory('task-a')).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith('/api/resources/tasks/task-a/history/delete', {}, 'fixture-control');
    write.mockResolvedValue({ job: { id: 'task-a', state: 'settled', historyAvailable: true } });
    await expect(deleteResourceTaskHistory('task-a')).rejects.toThrow('could not be verified');
  });
  it.each(['../other', '', 'A', 'task/a'])('rejects invalid identifiers before IO: %s', async (id) => {
    await expect(readResourceTaskHistory(id)).rejects.toThrow('Invalid');
    await expect(deleteResourceTaskHistory(id)).rejects.toThrow('Invalid');
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it('rejects history capabilities on read-only scopes or malformed values', async () => {
    const { scope } = resourceFixture();
    for (const patch of [{ historySupported: 'yes' }, { historySupported: true, readOnly: true }]) {
      read.mockResolvedValue({ ...scope, ...patch }); await expect(resourceConsoleScopeQuery.fetch()).rejects.toThrow('explicit resource-pool scope');
    }
    read.mockResolvedValue({ ...scope, historySupported: true }); await expect(resourceConsoleScopeQuery.fetch()).resolves.toMatchObject({ historySupported: true });
  });
});

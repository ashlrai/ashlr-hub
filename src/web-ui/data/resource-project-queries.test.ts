import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from './client.js';
import { readResourceTaskHistory, resourceConsoleScopeQuery } from './resource-pool-queries.js';
import { resourceFixture } from '../routes/resources/fixtures.test-support.js';

vi.mock('./client.js', async (original) => ({ ...await original<typeof import('./client.js')>(), apiGet: vi.fn() }));
const read = vi.mocked(apiGet);
function scope() {
  const { scope: value } = resourceFixture();
  return { ...value, defaultProjectId: 'default', projects: [
    { id: 'default', label: 'Hub', workspace: value.workspace!, enabled: true },
    { id: 'cortex', label: 'Cortex', workspace: '/projects/cortex', enabled: false },
  ] };
}
beforeEach(() => { vi.clearAllMocks(); });
describe('registered project query boundaries', () => {
  it('accepts explicit default plus disabled historical project', async () => {
    const value = scope(); read.mockResolvedValue(value); await expect(resourceConsoleScopeQuery.fetch()).resolves.toEqual(value);
  });
  it.each([
    (value: ReturnType<typeof scope>) => ({ ...value, defaultProjectId: 'cortex' }),
    (value: ReturnType<typeof scope>) => ({ ...value, readOnly: true }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[1]] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], value.projects[0]] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], { ...value.projects[1], workspace: value.workspace }] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], { ...value.projects[1], label: '💡'.repeat(33) }] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], { ...value.projects[1], label: ' Cortex ' }] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], { ...value.projects[1], command: 'unexpected' }] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], { ...value.projects[1], enabled: 'true' }] }),
    (value: ReturnType<typeof scope>) => ({ ...value, projects: [value.projects[0], { ...value.projects[1], workspace: '../other' }] }),
  ])('rejects inconsistent or malformed project scope %#', async (change) => {
    read.mockResolvedValue(change(scope())); await expect(resourceConsoleScopeQuery.fetch()).rejects.toThrow('explicit resource-pool scope');
  });
  it('accepts exactly128 UTF-8 bytes in a label', async () => {
    const value = scope(); value.projects[1]!.label = '💡'.repeat(32); read.mockResolvedValue(value);
    await expect(resourceConsoleScopeQuery.fetch()).resolves.toEqual(value);
  });
  it('requires transcript project identity to match the selected project', async () => {
    const value = { id: 'task-a', prompt: 'Private project text', output: null, retention: 'local-until-deleted', projectId: 'cortex' };
    read.mockResolvedValue(value); await expect(readResourceTaskHistory('task-a', undefined, 'default')).rejects.toThrow('could not be verified');
    await expect(readResourceTaskHistory('task-a', undefined, 'cortex')).resolves.toEqual(value);
    const { projectId: _project, ...legacy } = value; read.mockResolvedValue(legacy);
    await expect(readResourceTaskHistory('task-a', undefined, 'default')).resolves.toEqual(legacy);
    await expect(readResourceTaskHistory('task-a', undefined, 'cortex')).rejects.toThrow('could not be verified');
  });
});

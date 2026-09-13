import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, apiPost } from './client.js';
import { resourceFixture } from '../routes/resources/fixtures.test-support.js';
import { readResourceTasksPage, readResourceTaskStatus, validResourceJobWindow } from './resource-task-history.js';
import { resourceConsoleSnapshotQuery } from './resource-pool-queries.js';

vi.mock('./client.js', async original => ({ ...await original<typeof import('./client.js')>(), apiGet: vi.fn(), apiPost: vi.fn() }));
const read = vi.mocked(apiGet);
const fixture = () => {
  const { snapshot } = resourceFixture(); const { jobs, ...supervisor } = snapshot.supervisor!;
  const job = { ...jobs.find(row => row.id === 'done-task')!, id: 'older-task', enqueuedAt: '2026-09-06T12:00:00.000Z' };
  return { snapshot, supervisor, job, page: { items: [job], totalJobs: 300, nextBefore: { enqueuedAt: job.enqueuedAt, id: job.id } } };
};
beforeEach(() => { vi.clearAllMocks(); });
describe('bounded task-history metadata transport', () => {
  it('encodes only the exact cursor and forwards cancellation without a mutation', async () => {
    const f = fixture(); read.mockResolvedValue(f.page); const signal = new AbortController().signal;
    const before = { enqueuedAt: '2026-09-07T12:00:00.000Z', id: 'latest' };
    await expect(readResourceTasksPage({ before, limit: 64 }, signal)).resolves.toEqual(f.page);
    expect(read).toHaveBeenCalledExactlyOnceWith(`/api/resources/tasks?${new URLSearchParams({ limit: '64', before: before.enqueuedAt, beforeId: before.id })}`, signal);
    expect(apiPost).not.toHaveBeenCalled();
  });
  it.each([{ limit: 0 }, { limit: 257 }, { before: { enqueuedAt: 'bad', id: 'task' } },
    { before: { enqueuedAt: '2026-09-07T12:00:00.000Z', id: '../private' } },
    { before: { enqueuedAt: '2026-09-07T12:00:00.000Z', id: 'task\n' } }, { root: '/private' }])('refuses malformed input before contact %#', async options => {
    await expect(readResourceTasksPage(options as Parameters<typeof readResourceTasksPage>[0])).rejects.toThrow('could not be verified');
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['duplicate', 'unknown-field', 'wrong-cursor', 'sparse', 'reverse-order', 'wrong-total'])('rejects malformed page %s', async kind => {
    const f = fixture(); const page: Record<string, unknown> = f.page;
    if (kind === 'duplicate') page.items = [f.job, f.job];
    if (kind === 'unknown-field') page.items = [{ ...f.job, prompt: 'PRIVATE' }];
    if (kind === 'wrong-cursor') page.nextBefore = { ...f.page.nextBefore, id: 'other-task' };
    if (kind === 'sparse') page.items = new Array(1);
    if (kind === 'reverse-order') page.items = [f.job, { ...f.job, id: 'newer', enqueuedAt: '2026-09-07T12:00:00.000Z' }];
    if (kind === 'wrong-total') page.totalJobs = 0;
    read.mockResolvedValue(page); await expect(readResourceTasksPage()).rejects.toThrow('could not be verified');
  });
  it('binds task detail to the selected ID and supervisor instance', async () => {
    const f = fixture(); read.mockResolvedValue({ job: f.job, supervisor: f.supervisor });
    await expect(readResourceTaskStatus(f.job.id, f.supervisor.instanceId)).resolves.toEqual(f.job);
    await expect(readResourceTaskStatus('other-task', f.supervisor.instanceId)).rejects.toThrow();
    await expect(readResourceTaskStatus(f.job.id, 'replacement')).rejects.toThrow();
    read.mockResolvedValue({ job: f.job, supervisor: { ...f.supervisor, jobs: [] } });
    await expect(readResourceTaskStatus(f.job.id, f.supervisor.instanceId)).rejects.toThrow();
  });
  it('does not disclose server errors or retry failed reads', async () => {
    read.mockRejectedValue(new ApiError('PRIVATE SERVER PATH', 503, '/api/resources/tasks'));
    await expect(readResourceTasksPage()).rejects.toThrow('Task history could not be verified');
    expect(read).toHaveBeenCalledOnce();
  });
  it.each([{ closing: true }, { error: 'PRIVATE FAULT' }])('rejects unavailable supervisor detail %#', async patch => {
    const f = fixture(); read.mockResolvedValue({ job: f.job, supervisor: { ...f.supervisor, ...patch } });
    await expect(readResourceTaskStatus(f.job.id, f.supervisor.instanceId)).rejects.toThrow('could not be verified');
  });
  it('rejects a late response after cancellation', async () => {
    const controller = new AbortController(); read.mockImplementation(async () => { controller.abort(); return fixture().page; });
    await expect(readResourceTasksPage({}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('pins the requested cursor before an awaited read', async () => {
    const f = fixture(); const before = { id: 'latest', enqueuedAt: '2026-09-07T12:00:00.000Z' };
    read.mockImplementation(async () => { before.enqueuedAt = '2026-09-01T12:00:00.000Z'; return f.page; });
    await expect(readResourceTasksPage({ before })).resolves.toEqual(f.page);
  });
  it('preserves canonical extended-year jobs and chronological page/cursor ordering', async () => {
    const f = fixture();
    const olderJob = { ...f.job, id: 'year-9999', enqueuedAt: '9999-12-31T23:59:59.999Z', updatedAt: '+010000-01-01T00:00:00.000Z' };
    const newerJob = { ...f.job, id: 'year-10000', enqueuedAt: '+010000-01-01T00:00:00.000Z', updatedAt: '+010000-01-01T00:00:00.001Z' };
    const page = { items: [newerJob, olderJob], totalJobs: 2, nextBefore: null };
    read.mockResolvedValue(page);
    await expect(readResourceTasksPage({ before: { enqueuedAt: '+010001-01-01T00:00:00.000Z', id: 'future' } })).resolves.toEqual(page);
    read.mockResolvedValue({ job: olderJob, supervisor: f.supervisor });
    await expect(readResourceTaskStatus(olderJob.id, f.supervisor.instanceId)).resolves.toEqual(olderJob);
    read.mockResolvedValue({ ...page, items: [olderJob, newerJob] });
    await expect(readResourceTasksPage()).rejects.toThrow('could not be verified');
    read.mockResolvedValue({ ...page, items: [{ ...newerJob, updatedAt: olderJob.enqueuedAt }] });
    await expect(readResourceTasksPage()).rejects.toThrow('could not be verified');
  });
  it.each(['+010000-01-01T00:00:00Z', '10000-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z\n'])('refuses noncanonical extended cursor %s before contact', async enqueuedAt => {
    await expect(readResourceTasksPage({ before: { enqueuedAt, id: 'task' } })).rejects.toThrow('could not be verified');
    expect(read).not.toHaveBeenCalled();
  });
  it('validates explicit omitted counts and preserves legacy snapshots', async () => {
    const f = fixture(); read.mockResolvedValue(f.snapshot);
    await expect(resourceConsoleSnapshotQuery(f.snapshot.pool.id).fetch()).resolves.toEqual(f.snapshot);
    f.snapshot.supervisor!.jobWindow = { totalJobs: 300, visibleJobs: 3, omittedJobs: 297 };
    await expect(resourceConsoleSnapshotQuery(f.snapshot.pool.id).fetch()).resolves.toEqual(f.snapshot);
    f.snapshot.supervisor!.jobWindow.omittedJobs = 0;
    await expect(resourceConsoleSnapshotQuery(f.snapshot.pool.id).fetch()).rejects.toThrow('selected pool');
    expect(validResourceJobWindow({ totalJobs: 300, visibleJobs: 300, omittedJobs: 0 })).toBe(false);
  });
});

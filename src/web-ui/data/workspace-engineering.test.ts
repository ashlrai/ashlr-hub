import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost, ApiError } from './client.js';
import { clearMutationToken, getMutationToken, touchMutationHold } from './auth-store.js';
import { controlWorkspaceEngineering, listWorkspaceEngineering, readWorkspaceEngineering } from './workspace-engineering.js';
import { engineeringEnrollment, engineeringJob } from '../routes/workspace/engineering-fixture.test-support.js';
vi.mock('./client.js', async (original) => ({ ...await original<typeof import('./client.js')>(), apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('./auth-store.js', () => ({ getMutationToken: vi.fn(), clearMutationToken: vi.fn(), touchMutationHold: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getMutationToken).mockReturnValue('control-fixture'); });

describe('workspace engineering evidence boundary', () => {
  it('reads metadata and exact status without mutation authority', async () => {
    const selected = engineeringEnrollment(); const status = engineeringJob(selected); const abort = new AbortController();
    vi.mocked(apiGet).mockResolvedValueOnce([selected]).mockResolvedValueOnce(status);
    expect(await listWorkspaceEngineering(abort.signal)).toEqual([selected]);
    expect(await readWorkspaceEngineering(selected, abort.signal)).toEqual(status);
    expect(apiGet).toHaveBeenLastCalledWith('/api/resources/engineering/default-build', abort.signal);
    expect(apiPost).not.toHaveBeenCalled(); expect(getMutationToken).not.toHaveBeenCalled();
  });
  it('submits only enrolled ID and digest, with current control token', async () => {
    const selected = engineeringEnrollment(); const abort = new AbortController(); vi.mocked(apiPost).mockResolvedValue(engineeringJob(selected));
    await controlWorkspaceEngineering(selected, 'start', abort.signal);
    expect(apiPost).toHaveBeenCalledWith('/api/resources/engineering/start', { enrollmentId: selected.id, expectedEnrollmentDigest: selected.enrollmentDigest }, 'control-fixture', abort.signal);
    expect(touchMutationHold).toHaveBeenCalledOnce();
    await controlWorkspaceEngineering(selected, 'cancel');
    expect(apiPost).toHaveBeenLastCalledWith('/api/resources/engineering/default-build/cancel', {}, 'control-fixture', undefined);
  });
  it('refuses controls without a token and never retries failed mutations', async () => {
    vi.mocked(getMutationToken).mockReturnValue(null);
    await expect(controlWorkspaceEngineering(engineeringEnrollment(), 'start')).rejects.toThrow('Unlock'); expect(apiPost).not.toHaveBeenCalled();
    vi.mocked(getMutationToken).mockReturnValue('control-fixture'); vi.mocked(apiPost).mockRejectedValue(new Error('lost response'));
    await expect(controlWorkspaceEngineering(engineeringEnrollment(), 'start')).rejects.toThrow('lost response'); expect(apiPost).toHaveBeenCalledOnce();
  });
  it.each([{ projectId: 'other' }, { enrollmentDigest: 'b'.repeat(64) }, { graphId: 'other-graph' }, { extra: true },
    { state: 'completed' }, { deadlineAt: 'tomorrow' }, { nodes: [{ id: 'deliver', kind: 'deliver', state: 'completed', artifactDigest: null }] },
  ])('rejects misattributed or unsupported job evidence %j', async (patch) => {
    vi.mocked(apiGet).mockResolvedValue({ ...engineeringJob(), ...patch });
    await expect(readWorkspaceEngineering(engineeringEnrollment())).rejects.toThrow('could not be verified');
  });
  it.each([{ id: '../path' }, { id: 'Uppercase' }, { projectId: 'UPPER' }, { enrollmentDigest: 'not-a-digest' }, { campaigns: [] }, { extra: 'not-supported' }])('rejects malformed catalog identity %j', async (patch) => {
    vi.mocked(apiGet).mockResolvedValue([{ ...engineeringEnrollment(), ...patch }]);
    await expect(listWorkspaceEngineering()).rejects.toThrow('could not be verified');
  });
  it('rejects duplicate IDs, unknown prerequisites and cycles; accepts a zero-request budget', async () => {
    const value = engineeringEnrollment(); vi.mocked(apiGet).mockResolvedValue([value, value]); await expect(listWorkspaceEngineering()).rejects.toThrow('verified');
    value.campaigns[0]!.dependsOn = ['missing']; vi.mocked(apiGet).mockResolvedValue([value]); await expect(listWorkspaceEngineering()).rejects.toThrow('verified');
    value.campaigns.push({ ...value.campaigns[0]!, id: 'missing', dependsOn: ['integer-campaign'] }); await expect(listWorkspaceEngineering()).rejects.toThrow('verified');
    value.campaigns = [{ ...value.campaigns[0]!, dependsOn: [] }]; value.campaigns[0]!.campaignBudget.maxModelRequests = 0;
    await expect(listWorkspaceEngineering()).resolves.toEqual([value]);
  });
  it('rejects late reads and token changes without refreshing the control hold', async () => {
    const abort = new AbortController(); vi.mocked(apiGet).mockImplementation(async () => { abort.abort(); return [engineeringEnrollment()]; });
    await expect(listWorkspaceEngineering(abort.signal)).rejects.toThrow('cancelled');
    vi.mocked(apiPost).mockImplementation(async () => { vi.mocked(getMutationToken).mockReturnValue(null); return engineeringJob(); });
    await expect(controlWorkspaceEngineering(engineeringEnrollment(), 'start')).rejects.toThrow('interrupted'); expect(touchMutationHold).not.toHaveBeenCalled();
  });
  it('clears rejected control and explains unavailable enrollment instead of generic dispatch flags', async () => {
    vi.mocked(apiPost).mockRejectedValue(new ApiError('denied', 401, '/engineering'));
    await expect(controlWorkspaceEngineering(engineeringEnrollment(), 'start')).rejects.toThrow('denied'); expect(clearMutationToken).toHaveBeenCalledOnce();
    vi.mocked(apiPost).mockRejectedValue(new ApiError('missing', 404, '/engineering'));
    await expect(controlWorkspaceEngineering(engineeringEnrollment(), 'start')).rejects.toThrow('Engineering enrollment is unavailable');
  });
});

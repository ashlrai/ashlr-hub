import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearMutationToken, getMutationToken, setMutationToken } from './auth-store.js';
import { checkEngineeringObjective, listEngineeringProfiles, prepareEngineeringObjective } from './engineering-preparation.js';
import { preparationInput, preparationPlan, preparationProfile, preparationResult } from '../routes/workspace/preparation-fixture.test-support.js';

const token = 'a'.repeat(64);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const request = vi.fn<typeof fetch>();
beforeEach(() => { vi.clearAllMocks(); clearMutationToken(); vi.stubGlobal('fetch', request); });
afterEach(() => { clearMutationToken(); vi.unstubAllGlobals(); });
describe('engineering preparation control boundary', () => {
  it.each(['admitted', 'unavailable'] as const)('accepts bounded automatic admission %s without another request', async state => {
    setMutationToken(token); const value = { ...preparationResult(), automaticAdmission: { state, supervisionId: 'fleet' } };
    request.mockResolvedValue(json(value));
    await expect(prepareEngineeringObjective(preparationInput(), preparationProfile(), preparationPlan(), undefined, true)).resolves.toEqual(value);
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, { state: 'launched', supervisionId: 'fleet' }, { state: 'admitted', supervisionId: '../private' },
    { state: 'unavailable', supervisionId: 'fleet', error: 'PRIVATE' }])('refuses missing or malformed expected automatic admission %j', async automaticAdmission => {
    setMutationToken(token); request.mockResolvedValue(json({ ...preparationResult(), ...(automaticAdmission === undefined ? {} : { automaticAdmission }) }));
    await expect(prepareEngineeringObjective(preparationInput(), preparationProfile(), preparationPlan(), undefined, true)).rejects.toThrow('verified');
  });
  it('requires control authority even to read profiles', async () => {
    await expect(listEngineeringProfiles('default')).rejects.toThrow('Unlock'); expect(request).not.toHaveBeenCalled();
    setMutationToken(token); request.mockResolvedValue(json({ profiles: [preparationProfile()] }));
    await expect(listEngineeringProfiles('default')).resolves.toEqual([preparationProfile()]);
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/resources/engineering/profiles', expect.objectContaining({ method: 'POST',
      body: JSON.stringify({ projectId: 'default' }), credentials: 'same-origin', headers: expect.objectContaining({ 'x-ashlr-token': token }) }));
  });
  it.each([{}, { profiles: null }, { profiles: [{ ...preparationProfile(), command: ['private'] }] },
    { profiles: [preparationProfile('other')] }, { profiles: [preparationProfile(), preparationProfile()] },
    { profiles: [{ ...preparationProfile(), files: ['../escape'] }] },
    { profiles: [{ ...preparationProfile(), acceptance: 'x'.repeat(1025) }] }])('rejects unknown/private/cross-project profiles %#', async value => {
    setMutationToken(token); request.mockResolvedValue(json(value)); await expect(listEngineeringProfiles('default')).rejects.toThrow('could not be verified');
  });
  it.each([{ ...preparationInput(), command: ['private'] }, { ...preparationInput(), id: '../escape' },
    { ...preparationInput(), name: 'é'.repeat(61) }, { ...preparationInput(), objective: 'é'.repeat(4097) },
    { ...preparationInput(), objective: '   ' }, { ...preparationInput(), profileId: 'other' }])('rejects invalid objective before contact %#', async value => {
    setMutationToken(token); await expect(checkEngineeringObjective(value, preparationProfile())).rejects.toThrow('could not be verified');
    expect(request).not.toHaveBeenCalled();
  });
  it('checks exact browser fields and prepares only the same checked digest', async () => {
    setMutationToken(token); const input = preparationInput(); const profile = preparationProfile(); const plan = preparationPlan();
    request.mockResolvedValueOnce(json(plan)).mockResolvedValueOnce(json(preparationResult(plan)));
    expect(await checkEngineeringObjective(input, profile)).toEqual(plan);
    expect(await prepareEngineeringObjective(input, profile, plan)).toEqual(preparationResult(plan));
    expect(request.mock.calls.map(([path, options]) => [path, JSON.parse(options!.body as string)])).toEqual([
      ['/api/resources/engineering/prepare/check', input], ['/api/resources/engineering/prepare', { ...input, expectedPlanDigest: plan.planDigest }],
    ]);
  });
  it('accepts the exact Unicode byte boundary and rejects one more character', async () => {
    setMutationToken(token); const input = { ...preparationInput(), name: 'é'.repeat(60), objective: 'é'.repeat(2000) };
    request.mockResolvedValue(json(preparationPlan(input)));
    await expect(checkEngineeringObjective(input, preparationProfile())).resolves.toBeDefined();
    request.mockClear();
    await expect(checkEngineeringObjective({ ...input, objective: input.objective + 'é' }, preparationProfile())).rejects.toThrow('could not be verified');
    expect(request).not.toHaveBeenCalled();
  });
  it.each([{ executionStarted: true }, { providerContacted: true }, { branch: 'codex/other' }, { name: 'changed' },
    { projectId: 'other' }, { profileDigest: 'bad' }, { command: 'private' }, { allowedWorkerIds: ['other'] },
    { metric: { name: 'correctness', direction: 'maximize', minImprovement: 0 } }])('rejects contradictory checked plan %#', async patch => {
    setMutationToken(token); request.mockResolvedValue(json({ ...preparationPlan(), ...patch }));
    await expect(checkEngineeringObjective(preparationInput(), preparationProfile())).rejects.toThrow('could not be verified');
  });
  it('refuses changed draft after check without contact', async () => {
    setMutationToken(token);
    await expect(prepareEngineeringObjective({ ...preparationInput(), objective: 'Different task' }, preparationProfile(), preparationPlan())).rejects.toThrow('could not be verified');
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['plan', 'enrollment', 'private'] as const)('rejects mismatched prepared %s', async mode => {
    setMutationToken(token); const result = preparationResult();
    const value = mode === 'plan' ? { ...result, plan: { ...result.plan, planDigest: 'd'.repeat(64) } } :
      mode === 'enrollment' ? { ...result, enrollment: { ...result.enrollment, projectId: 'other' } } : { ...result, raw: 'private' };
    request.mockResolvedValue(json(value));
    await expect(prepareEngineeringObjective(preparationInput(), preparationProfile(), preparationPlan())).rejects.toThrow('could not be verified');
  });
  it.each([401, 403, 409, 500])('redacts HTTP%i and never retries', async status => {
    setMutationToken(token); request.mockResolvedValue(json({ error: 'PRIVATE_SERVER_DETAIL' }, status));
    const error = await prepareEngineeringObjective(preparationInput(), preparationProfile(), preparationPlan()).catch((cause: Error) => cause);
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain('PRIVATE_SERVER_DETAIL'); expect(request).toHaveBeenCalledOnce();
    if (status === 401) expect(getMutationToken()).toBeNull();
  });
  it('discards a late response after token rotation', async () => {
    setMutationToken(token); let finish!: (value: Response) => void;
    request.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = checkEngineeringObjective(preparationInput(), preparationProfile());
    setMutationToken('b'.repeat(64)); finish(json(preparationPlan()));
    await expect(pending).rejects.toThrow('not confirmed'); expect(getMutationToken()).toBe('b'.repeat(64));
  });
});

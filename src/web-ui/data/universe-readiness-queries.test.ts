import { afterEach, describe, expect, it, vi } from 'vitest';
import { universeCampaignReadinessQuery, validateUniverseCampaignReadinessView } from './universe-readiness-queries.js';

const report = () => ({ schemaVersion: 1, readinessScope: 'recorded-campaign-evidence', campaignId: 'search',
  universeId: 'compiler', observedState: 'ready', sourceState: 'healthy', disposition: 'startable',
  reasonCode: 'never-started', resourceRuntimeRequired: true, sampledAt: '2026-09-08T12:00:00.000Z' });
afterEach(() => { vi.unstubAllGlobals(); });

describe('selected recorded campaign query', () => {
  it('uses only the campaign ID in its authenticated GET and propagates cancellation', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(report()))); vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    await expect(universeCampaignReadinessQuery('search', 'compiler').fetch(signal)).resolves.toEqual(report());
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/universe/campaign-readiness?campaignId=search', expect.objectContaining({ method: 'GET', credentials: 'same-origin', signal }));
  });

  it('keeps ambiguous hyphen-separated pairs in distinct caches', () => {
    expect(universeCampaignReadinessQuery('c', 'a-b').key).not.toBe(universeCampaignReadinessQuery('b-c', 'a').key);
  });

  it.each(['', '../search', 'SEARCH', 'a?root=b', 'a'.repeat(65)])('rejects invalid input %s before a request', (id) => {
    expect(() => universeCampaignReadinessQuery(id, 'compiler')).toThrow('identity');
    expect(() => universeCampaignReadinessQuery('search', id)).toThrow('identity');
  });

  it.each([
    { campaignId: 'other' }, { universeId: 'other' }, { universeId: null }, { observedState: null },
    { resourceRuntimeRequired: null }, { schemaVersion: 2 }, { readinessScope: 'live-providers' },
    { sourceState: 'unknown' }, { sourceState: ['healthy'] }, { disposition: 'live' }, { disposition: ['startable'] },
    { reasonCode: 'constructor' }, { reasonCode: ['never-started'] }, { observedState: ['ready'] },
    { resourceRuntimeRequired: 'yes' }, { sampledAt: '2026-02-30T12:00:00.000Z' }, { sampledAt: 'private error' },
    { expectedIdentity: { private: 'private path' } }, { automaticAction: 'run' }, { root: '/private/root' },
    { sourceState: 'degraded' }, { sourceState: 'missing', universeId: null, observedState: null, resourceRuntimeRequired: null },
  ])('rejects malformed or mismatched response %#', (override) => {
    expect(() => validateUniverseCampaignReadinessView({ ...report(), ...override }, 'search', 'compiler')).toThrow('unavailable');
  });

  it.each([null, [], 'private', {}, { ...report(), reasonCode: undefined }])('rejects incomplete/nonobject response %#', (value) => {
    expect(() => validateUniverseCampaignReadinessView(value, 'search', 'compiler')).toThrow('unavailable');
  });

  it.each(['missing', 'degraded'])('allows null identity for %s evidence, but never an unrelated universe', (sourceState) => {
    const value = { ...report(), sourceState, universeId: null, observedState: null, resourceRuntimeRequired: null, disposition: 'unavailable', reasonCode: sourceState === 'missing' ? 'campaign-missing' : 'evidence-degraded' };
    expect(validateUniverseCampaignReadinessView(value, 'search', 'compiler')).toEqual(value);
    expect(() => validateUniverseCampaignReadinessView({ ...value, universeId: 'other' }, 'search', 'compiler')).toThrow('unavailable');
  });
});

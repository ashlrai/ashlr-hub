import { afterEach, describe, expect, it, vi } from 'vitest';
import { isControllerId, readControllerStatus, validateControllerStatus } from './controller-status.js';

const at = '2026-09-09T10:00:00.000Z';
const report = { schemaVersion: 1, controllerId: 'fleet', sourceState: 'healthy', status: 'incomplete',
  createdAt: at, deadlineAt: at, observedAt: at, reasons: [], outcomes: [
    { campaignId: 'build', state: 'pending', attempted: false, reasonCode: 'waiting-for-dependencies' },
  ] };

describe('named controller observation query', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['', '../fleet', 'Fleet', 'fleet?root=x', 'fleet/root', 'a'.repeat(65), ['fleet'], undefined, null])('rejects invalid IDs (%j) without fetching', async (id) => {
    const request = vi.fn(); vi.stubGlobal('fetch', request);
    expect(isControllerId(id)).toBe(false);
    await expect(readControllerStatus(id as string)).rejects.toThrow('valid controller ID');
    expect(request).not.toHaveBeenCalled();
  });
  it('uses only the named GET route, with no root override, and strips nonpublic fields', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ ...report, definitionDigest: 'secret',
      outcomes: [{ ...report.outcomes[0], campaignDigest: 'secret', deliveryDigest: 'secret' }] })));
    vi.stubGlobal('fetch', request);
    const signal = new AbortController().signal;
    expect(await readControllerStatus('fleet', signal)).toEqual(report);
    expect(request).toHaveBeenCalledWith('/api/universe/controller-status?controllerId=fleet', expect.objectContaining({ method: 'GET', signal, credentials: 'same-origin' }));
  });
  it.each([
    { controllerId: 'other' }, { schemaVersion: 2 }, { sourceState: ['healthy'] }, { status: ['completed'] },
    { observedAt: '2026-02-30T10:00:00.000Z' }, { createdAt: 7 }, { reasons: ['private/path'] },
    { reasons: Array.from({ length: 129 }, () => 'reason') }, { outcomes: Array.from({ length: 65 }, () => report.outcomes[0]) },
    { outcomes: [report.outcomes[0], report.outcomes[0]] }, { outcomes: [{ ...report.outcomes[0], attempted: 'false' }] },
    { outcomes: [{ ...report.outcomes[0], state: ['pending'] }] },
    { control: { mode: ['open'], sequence: 1, requestedAt: at, acknowledgedAt: null } },
    { control: { mode: 'drain', sequence: 512, requestedAt: at, acknowledgedAt: null } },
    { control: { mode: 'drain', sequence: 1, requestedAt: at, acknowledgedAt: 'yesterday' } },
    { control: { mode: 'open', sequence: 1, requestedAt: at, acknowledgedAt: at } },
    { status: 'draining' }, { status: 'drained' },
    { status: 'drained', control: { mode: 'drain', sequence: 1, requestedAt: at, acknowledgedAt: null } },
    { status: 'draining', control: { mode: 'drain', sequence: 1, requestedAt: at, acknowledgedAt: at } },
  ])('rejects malformed or mismatched evidence (%j)', (patch) => {
    expect(() => validateControllerStatus({ ...report, ...patch }, 'fleet')).toThrow('could not be validated');
  });
  it.each(['completed', 'timed-out'])('accepts acknowledged drain independent of %s execution status', (status) => {
    const value = { ...report, status, control: { mode: 'drain', sequence: 3, requestedAt: at, acknowledgedAt: at } };
    expect(validateControllerStatus(value, 'fleet')).toEqual(value);
  });
  it('preserves missing evidence, null timestamps, and historical clock ordering', () => {
    const missing = { ...report, sourceState: 'missing', status: 'unavailable', createdAt: null, deadlineAt: null, outcomes: [], reasons: ['controller-missing'] };
    expect(validateControllerStatus(missing, 'fleet')).toEqual(missing);
    expect(validateControllerStatus({ ...report, createdAt: '2026-09-10T10:00:00Z' }, 'fleet').createdAt).toBe('2026-09-10T10:00:00Z');
  });
});

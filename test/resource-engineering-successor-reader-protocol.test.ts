/** Read-only transport contract with a fake queue, no disk or provider effects. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), close: vi.fn() }));
vi.mock('../src/core/web/bounded-read-worker.js', async original => ({
  ...await original<typeof import('../src/core/web/bounded-read-worker.js')>(), createBoundedReadWorker: transport.create,
}));
import { createEngineeringSuccessorReader } from '../src/core/resources/engineering-successor-reader.js';
import type { JournalScope } from '../src/core/resources/engineering-successor-store.js';
const scope = { directory: '/private/engineering-successors/automatic',
  config: { supervisionId: 'automatic', profileId: 'fixed', maxSuccessors: 2 },
  expectedEnrollment: { configDigest: 'a'.repeat(64), deadlineAt: '2099-01-01T00:00:00.000Z' } } as JournalScope;
function sample() {
  return { snapshot: { schemaVersion: 1, supervisionId: 'automatic', profileId: 'fixed', configDigest: 'a'.repeat(64),
    deadlineAt: scope.expectedEnrollment.deadlineAt, state: 'observing', maxSuccessors: 2, entries: [] },
  sampledAt: new Date().toISOString(), recordsDigest: 'b'.repeat(64) };
}
beforeEach(() => { vi.resetAllMocks(); transport.create.mockReturnValue(transport); transport.read.mockImplementation(async () => sample()); });
describe('successor observation response and fresh-request boundary', () => {
  it('uses distinct internal tokens even for overlapping reads', async () => {
    const reader = createEngineeringSuccessorReader({ scope, configFile: '/private/config.json' });
    await Promise.all([reader.read(), reader.read(), reader.read()]);
    expect(transport.read.mock.calls).toEqual([['snapshot', 1], ['snapshot', 2], ['snapshot', 3]]);
    const normalize = transport.create.mock.calls[0]![0].normalize;
    expect(normalize('snapshot', 1)).toBe(1);
    expect(() => normalize('prepare', 1)).toThrow(); expect(() => normalize('snapshot', {})).toThrow();
    await reader.close(); expect(transport.close).toHaveBeenCalledOnce();
  });
  it.each(['private-extra', 'foreign-config', 'live-phase', 'wrong-key', 'old-sample', 'future-sample', 'oversized'])(
    'refuses malformed or stale response: %s', async kind => {
      transport.read.mockImplementation(async () => {
        const result: any = sample();
        if (kind === 'private-extra') result.snapshot.output = 'PRIVATE-SENTINEL';
        if (kind === 'foreign-config') result.snapshot.configDigest = 'c'.repeat(64);
        if (kind === 'live-phase' || kind === 'wrong-key') result.snapshot.entries = [{ sourceEnrollmentId: 'source',
          proposalTaskId: `proposal-${'d'.repeat(48)}`, successorId: `successor-${(kind === 'wrong-key' ? 'e' : 'd').repeat(48)}`,
          state: kind === 'live-phase' ? 'preparing' : 'proposed', reason: null }];
        if (kind === 'old-sample') result.sampledAt = '2000-01-01T00:00:00.000Z';
        if (kind === 'future-sample') result.sampledAt = '2099-01-01T00:00:00.000Z';
        if (kind === 'oversized') result.extra = 'x'.repeat(32769);
        return result;
      });
      const reader = createEngineeringSuccessorReader({ scope, configFile: '/private/config.json' });
      await expect(reader.read()).rejects.toThrow();
    });
});

import { describe, expect, it } from 'vitest';
import { localChatRuns } from '../src/core/verse/power-work.js';
import type { VerseSession } from '../src/core/verse/types.js';
type Chat = Pick<VerseSession, 'status' | 'engine' | 'remote'>;
const cloud: Chat = { engine: 'devin', status: 'running', remote: { provider: 'devin', lane: 'cloud', state: null, url: null, acusConsumed: null, acuCap: null } };
describe('host-owned chat activity', () => {
  it('counts CLI orchestrators even when inference uses a cloud model', () => {
    expect(localChatRuns([{ engine: 'codex', status: 'running' }, { engine: 'claude', status: 'running' }, { engine: 'local', status: 'running' }])).toBe(3);
  });
  it('cloud-only Devin work does not hold this host awake', () => { expect(localChatRuns([cloud])).toBe(0); });
  it('the Devin CLI executes locally', () => { expect(localChatRuns([{ ...cloud, remote: { ...cloud.remote!, lane: 'cli' } }])).toBe(1); });
  it('unknown remote lane is unknown rather than invented local activity', () => { expect(localChatRuns([{ engine: 'devin', status: 'running' }])).toBeNull(); });
  it('unknown Devin lane never erases known local work regardless of ordering', () => {
    const unknown: Chat = { engine: 'devin', status: 'running' };
    const local: Chat = { engine: 'codex', status: 'running' };
    expect(localChatRuns([unknown, local])).toBe(1);
    expect(localChatRuns([local, unknown])).toBe(1);
  });
  it('finished, failed or cancelled sessions no longer count', () => {
    expect(localChatRuns([{ engine: 'codex', status: 'idle' }, { engine: 'claude', status: 'error' }, { ...cloud, status: 'idle' }])).toBe(0);
  });
});

describe('independent host activity sources', () => {
  it('includes verified Fleet work and keeps chat work when Fleet is unknown', async () => {
    const { combineLocalRuns } = await import('../src/core/verse/power-work.js');
    expect(combineLocalRuns(0, 2)).toBe(2); expect(combineLocalRuns(2, null)).toBe(2);
    expect(combineLocalRuns(null, 2)).toBe(2); expect(combineLocalRuns(2, 3)).toBe(5);
    expect(combineLocalRuns(0, 0)).toBe(0); expect(combineLocalRuns(0, null)).toBeNull();
    expect(combineLocalRuns(null, null)).toBeNull();
  });
});

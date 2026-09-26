/**
 * Comms request expiry — one unanswered question must not block the queue.
 *
 * Live incident: a question sent 2026-06-28 was never answered. Because only
 * one request may be outstanding, every later digest and Leader briefing (585
 * of them) sat pending for three months and `ashlr comms digest|ask-vision`
 * exited 1, which failed the daily ai.ashlr.oversight job.
 *
 * Invariants:
 *   - an outstanding question/approval older than the TTL is expired
 *   - pending requests older than the TTL are expired (no stale flood on unblock)
 *   - fresh requests and unparseable timestamps are untouched
 *   - expiry is never an answer: a late reply resolves nothing
 *   - runCommsCycle expires first, then sends the next fresh request
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendCalls: string[] = [];
vi.mock('../src/core/integrations/imessage.js', () => ({
  sendIMessage: async (text: string) => {
    sendCalls.push(text);
    return { ok: true };
  },
  pollInboundReplies: async () => [],
}));

import {
  DEFAULT_REQUEST_TTL_HOURS,
  expireStaleRequests,
  listRequests,
  outstanding,
  type CommsRequest,
} from '../src/core/comms/requests.js';
import { commsRequestTtlMs, runCommsCycle } from '../src/core/comms/dispatch.js';
import { makeCfg } from './helpers/h1-fixture.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-25T12:00:00.000Z');

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  sendCalls.length = 0;
  prevHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-comms-expiry-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  vi.useRealTimers();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function seed(records: Array<Partial<CommsRequest> & Pick<CommsRequest, 'id' | 'status'>>): void {
  const dir = join(tmpHome, '.ashlr', 'comms');
  mkdirSync(dir, { recursive: true });
  const lines = records.map((r) =>
    JSON.stringify({
      kind: 'test',
      type: 'question',
      text: `text ${r.id}`,
      options: ['yes', 'no'],
      createdAt: iso(NOW),
      ...r,
    }),
  );
  writeFileSync(join(dir, 'requests.jsonl'), lines.join('\n') + '\n', 'utf8');
}

function statusOf(id: string): string | undefined {
  return listRequests().find((r) => r.id === id)?.status;
}

describe('expireStaleRequests', () => {
  it('expires an outstanding question older than the TTL and unblocks the queue', () => {
    seed([
      { id: 'old-q', status: 'sent', createdAt: iso(NOW - 90 * 24 * HOUR), sentAt: iso(NOW - 89 * 24 * HOUR) },
      { id: 'fresh-report', status: 'pending', type: 'report', options: [], createdAt: iso(NOW - HOUR) },
    ]);
    expect(outstanding()?.id).toBe('old-q');

    const result = expireStaleRequests(NOW, 48 * HOUR);

    expect(result).toEqual({ expiredSent: 1, expiredPending: 0 });
    expect(statusOf('old-q')).toBe('expired');
    expect(listRequests().find((r) => r.id === 'old-q')?.expiredAt).toBe(iso(NOW));
    expect(outstanding()).toBeUndefined();
    expect(statusOf('fresh-report')).toBe('pending');
  });

  it('ages a sent question from sentAt, not createdAt', () => {
    seed([{ id: 'q', status: 'sent', createdAt: iso(NOW - 100 * HOUR), sentAt: iso(NOW - HOUR) }]);
    expect(expireStaleRequests(NOW, 48 * HOUR)).toEqual({ expiredSent: 0, expiredPending: 0 });
    expect(statusOf('q')).toBe('sent');
  });

  it('expires stale pending requests so unblocking does not flood stale digests', () => {
    seed([
      { id: 'stale-1', status: 'pending', type: 'report', createdAt: iso(NOW - 72 * HOUR) },
      { id: 'stale-2', status: 'pending', type: 'question', createdAt: iso(NOW - 49 * HOUR) },
      { id: 'fresh', status: 'pending', type: 'report', createdAt: iso(NOW - 47 * HOUR) },
    ]);
    expect(expireStaleRequests(NOW, 48 * HOUR)).toEqual({ expiredSent: 0, expiredPending: 2 });
    expect(statusOf('stale-1')).toBe('expired');
    expect(statusOf('stale-2')).toBe('expired');
    expect(statusOf('fresh')).toBe('pending');
  });

  it('never touches answered/expired records or unparseable timestamps', () => {
    seed([
      { id: 'answered', status: 'answered', createdAt: iso(NOW - 500 * HOUR), answerIndex: 0 },
      { id: 'bad-ts', status: 'pending', createdAt: 'not-a-date' },
    ]);
    const before = readFileSync(join(tmpHome, '.ashlr', 'comms', 'requests.jsonl'), 'utf8');
    expect(expireStaleRequests(NOW, 48 * HOUR)).toEqual({ expiredSent: 0, expiredPending: 0 });
    expect(readFileSync(join(tmpHome, '.ashlr', 'comms', 'requests.jsonl'), 'utf8')).toBe(before);
  });

  it('is a no-op for a non-positive or non-finite TTL', () => {
    seed([{ id: 'old', status: 'pending', createdAt: iso(NOW - 500 * HOUR) }]);
    expect(expireStaleRequests(NOW, 0)).toEqual({ expiredSent: 0, expiredPending: 0 });
    expect(expireStaleRequests(NOW, Number.NaN)).toEqual({ expiredSent: 0, expiredPending: 0 });
    expect(statusOf('old')).toBe('pending');
  });

  it('never throws when the store is absent', () => {
    expect(expireStaleRequests(NOW, HOUR)).toEqual({ expiredSent: 0, expiredPending: 0 });
  });
});

describe('commsRequestTtlMs', () => {
  it('defaults to 48h and honours a positive cfg.comms.requestTtlHours', () => {
    expect(DEFAULT_REQUEST_TTL_HOURS).toBe(48);
    expect(commsRequestTtlMs(makeCfg({}))).toBe(48 * HOUR);
    expect(commsRequestTtlMs(makeCfg({ comms: { requestTtlHours: 6 } }))).toBe(6 * HOUR);
    expect(commsRequestTtlMs(makeCfg({ comms: { requestTtlHours: -1 } }))).toBe(48 * HOUR);
  });
});

describe('runCommsCycle with a stale outstanding question', () => {
  it('expires the dead question and stale backlog, then sends the fresh request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    seed([
      { id: 'dead-q', status: 'sent', createdAt: iso(NOW - 2000 * HOUR), sentAt: iso(NOW - 2000 * HOUR) },
      { id: 'stale-digest', status: 'pending', type: 'report', options: [], createdAt: iso(NOW - 1000 * HOUR) },
      { id: 'fresh-digest', status: 'pending', type: 'report', options: [], text: 'fresh digest', createdAt: iso(NOW - HOUR) },
    ]);
    const cfg = makeCfg({ comms: { enabled: true, imessageHandle: '+15555550100', service: 'iMessage' } });

    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      const result = await runCommsCycle(cfg);
      expect(result.sent).toBe(1);
    } finally {
      Object.defineProperty(process, 'platform', origPlatform);
    }

    expect(sendCalls).toEqual(['fresh digest']);
    expect(statusOf('dead-q')).toBe('expired');
    expect(statusOf('stale-digest')).toBe('expired');
    expect(statusOf('fresh-digest')).toBe('answered');
  });
});

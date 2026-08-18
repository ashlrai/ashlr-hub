import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi, drainSseConnections } from '../src/core/web/api.js';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

afterEach(() => {
  drainSseConnections();
  vi.useRealTimers();
});

describe('operator-console SSE backpressure', () => {
  it('stops emitting after write(false) and closes the bounded slow consumer', async () => {
    const fixture: H1Fixture = makeFixture();
    vi.useFakeTimers();
    try {
      const req = Object.assign(new EventEmitter(), { url: '/api/events', method: 'GET', headers: {} }) as IncomingMessage;
      const writes: string[] = [];
      let ended = 0;
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead: vi.fn(),
        write(chunk: string) {
          writes.push(chunk);
          return writes.length !== 2; // initial comment succeeds; first frame backpressures.
        },
        end() { ended += 1; },
      }) as unknown as ServerResponse;

      expect(await handleApi(req, res, makeCfg(), {
        token: 'test', allowDispatch: false,
        readSession: { id: 'session-a', expiresAt: Date.now() + 60_000 },
      })).toBe(true);
      await Promise.resolve();
      expect(writes).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(writes).toHaveLength(2);
      expect(ended).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(ended).toBe(1);
      expect(writes).toHaveLength(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('cleans up immediately when the response emits an error', async () => {
    const fixture: H1Fixture = makeFixture();
    try {
      const req = Object.assign(new EventEmitter(), {
        url: '/api/events', method: 'GET', headers: {},
      }) as IncomingMessage;
      let ended = 0;
      const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writeHead: vi.fn(),
        write: vi.fn(() => true),
        end() { ended += 1; },
      }) as unknown as ServerResponse;

      expect(await handleApi(req, res, makeCfg(), {
        token: 'test', allowDispatch: false,
        readSession: { id: 'response-error', expiresAt: Date.now() + 60_000 },
      })).toBe(true);
      res.emit('error', new Error('socket failed'));
      expect(ended).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });
});

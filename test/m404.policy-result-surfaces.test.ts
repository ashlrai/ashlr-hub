import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const policyMocks = vi.hoisted(() => ({
  enroll: vi.fn(),
  unenroll: vi.fn(),
  setKill: vi.fn(),
}));

const fleetMocks = vi.hoisted(() => ({
  buildFleetStatus: vi.fn(async () => ({ killed: true })),
}));

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
  enroll: policyMocks.enroll,
  unenroll: policyMocks.unenroll,
  setKill: policyMocks.setKill,
}));

vi.mock('../src/core/fleet/status.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/fleet/status.js')>(),
  buildFleetStatus: fleetMocks.buildFleetStatus,
}));

import { cmdEnroll } from '../src/cli/sandbox.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { handleApi } from '../src/core/web/api.js';

beforeEach(() => {
  policyMocks.enroll.mockReset();
  policyMocks.unenroll.mockReset();
  policyMocks.setKill.mockReset();
  fleetMocks.buildFleetStatus.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function apiRequest(action: 'pause' | 'resume'): IncomingMessage {
  return {
    method: 'POST',
    url: `/api/fleet/${action}`,
    headers: {
      'content-type': 'application/json',
      'x-ashlr-token': 'operator-token',
    },
  } as IncomingMessage;
}

function apiResponse(): {
  res: ServerResponse;
  read: () => { status: number; body: Record<string, unknown> };
} {
  let status = 0;
  let payload = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      payload += chunk ?? '';
      return this;
    },
  } as unknown as ServerResponse;
  return {
    res,
    read: () => ({ status, body: JSON.parse(payload) as Record<string, unknown> }),
  };
}

async function callFleetApi(action: 'pause' | 'resume') {
  const response = apiResponse();
  const handled = await handleApi(
    apiRequest(action),
    response.res,
    {} as never,
    { token: 'operator-token', allowDispatch: true },
  );
  return { handled, ...response.read() };
}

describe('PolicyMutationResult operator surfaces', () => {
  it('reports unsafe enrollment storage as a CLI error', async () => {
    policyMocks.enroll.mockReturnValue({
      ok: false,
      changed: false,
      quiesced: true,
      reason: 'unsafe-enrollment-registry',
    });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdEnroll(['add', '/repo'])).resolves.toBe(1);

    expect(errors.join('\n')).toMatch(/unsafe policy storage.*unsafe-enrollment-registry/i);
    expect(logs).not.toHaveBeenCalled();
  });

  it('reports a non-quiesced fleet pause as busy and retryable in the CLI', async () => {
    policyMocks.setKill.mockReturnValue({
      ok: false,
      changed: true,
      quiesced: false,
      reason: 'kill armed; an outward mutation has not quiesced',
    });
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdFleet(['pause'])).resolves.toBe(1);

    expect(stderr).toMatch(/fleet pause is busy.*retry/i);
    expect(logs).not.toHaveBeenCalled();
  });

  it('returns HTTP 409 with retry guidance when pause has not quiesced', async () => {
    policyMocks.setKill.mockReturnValue({
      ok: true,
      changed: true,
      quiesced: false,
      reason: 'outward mutation still active',
    });

    const response = await callFleetApi('pause');

    expect(response.handled).toBe(true);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'pause',
      retryable: true,
      mutation: { ok: true, quiesced: false },
    });
  });

  it('returns a hard HTTP error for unsafe policy storage', async () => {
    policyMocks.setKill.mockReturnValue({
      ok: false,
      changed: false,
      quiesced: false,
      reason: 'unsafe-kill-sentinel',
    });

    const response = await callFleetApi('pause');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'pause',
      retryable: false,
      error: 'unsafe policy storage: unsafe-kill-sentinel',
    });
  });

  it('keeps void-returning legacy policy mocks compatible', async () => {
    policyMocks.setKill.mockReturnValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(cmdFleet(['pause'])).resolves.toBe(0);
  });
});

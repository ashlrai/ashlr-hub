import { existsSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { probeUp, tickRefused } = vi.hoisted(() => ({
  probeUp: vi.fn(async (id: string, url: string) => ({
    id,
    url,
    up: true,
    models: ['test-model'],
  })),
  tickRefused: vi.fn(async () => ({
    ran: false,
    reason: 'activation-refused' as const,
    dryRun: false,
  })),
}));

vi.mock('../src/core/providers.js', () => ({ probeEndpoint: probeUp }));
vi.mock('../src/core/daemon/loop.js', () => ({ tick: tickRefused }));

import { cmdDemo } from '../src/cli/demo.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fixture: H1Fixture | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  expect.hasAssertions();
  fixture = makeFixture();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  probeUp.mockClear();
  tickRefused.mockClear();
});

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.restoreAllMocks();
});

describe('M461 live demo activation refusal', () => {
  it('returns failure, reports the refusal, and still disposes the isolated context', async () => {
    const homeBefore = process.env.HOME;

    const code = await cmdDemo(['--json']);

    expect(code).toBe(1);
    expect(process.env.HOME).toBe(homeBefore);
    expect(tickRefused).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();

    const output = logSpy.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    const transcript = JSON.parse(output) as {
      ok: boolean;
      liveModel: boolean;
      error: string;
      steps: Array<{ step: string }>;
    };
    expect(transcript).toMatchObject({
      ok: false,
      liveModel: true,
      error: 'activation-refused',
    });
    expect(transcript.steps.at(-1)?.step).toBe('tick');

    const isolatedHome = output.match(/tmp HOME at ([^ ]+)/)?.[1];
    expect(isolatedHome).toBeDefined();
    expect(existsSync(isolatedHome!)).toBe(false);
  });
});

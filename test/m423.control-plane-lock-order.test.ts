import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';

const proposalLockBarrier = vi.hoisted(() => ({
  onAcquire: undefined as (() => void) | undefined,
}));

const directorMocks = vi.hoisted(() => ({
  sendTelegram: vi.fn(),
  postRequest: vi.fn(() => 'm423-request'),
  spawnEngine: vi.fn(),
}));

const pulseInboxMocks = vi.hoisted(() => ({
  loadProposal: vi.fn(() => ({ id: 'm423-proposal', status: 'pending' })),
  setStatus: vi.fn(() => true),
}));

vi.mock('../src/core/inbox/proposal-mutation-lock.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/inbox/proposal-mutation-lock.js')>(),
  acquireProposalMutationLock: (proposalId: string) => {
    proposalLockBarrier.onAcquire?.();
    return { key: proposalId, token: Symbol(proposalId) };
  },
  releaseProposalMutationLock: () => undefined,
}));

vi.mock('../src/core/inbox/store.js', () => ({
  loadProposal: pulseInboxMocks.loadProposal,
  setStatus: pulseInboxMocks.setStatus,
}));

vi.mock('../src/core/comms/director-context.js', () => ({
  buildDirectorContext: vi.fn(async () => ({})),
}));

vi.mock('../src/core/comms/director-prompt.js', () => ({
  DIRECTOR_SYSTEM_PROMPT: 'm423-system',
  renderDirectorPrompt: vi.fn(() => 'm423-user'),
}));

vi.mock('../src/core/run/model-catalog.js', () => ({
  defaultStrategistModel: vi.fn(() => 'm423-model'),
}));

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  buildEngineCommand: vi.fn(() => ['m423-engine']),
  spawnEngine: directorMocks.spawnEngine,
}));

vi.mock('../src/core/integrations/telegram.js', () => ({
  telegramEnabled: vi.fn(() => true),
  sendTelegramMessage: directorMocks.sendTelegram,
}));

vi.mock('../src/core/comms/requests.js', () => ({
  postRequest: directorMocks.postRequest,
}));

import { runDirectorCycle } from '../src/core/comms/director.js';
import { pollAndApplyCommands } from '../src/core/integrations/pulse-sync.js';
import { killSwitchOn, setKill } from '../src/core/sandbox/policy.js';

const directorDecision = JSON.stringify({
  reasoning: 'bounded test',
  resourcePosture: 'full',
  resourceRationale: 'test',
  topGoalId: null,
  suggestedNewGoal: null,
  backendHint: null,
  telegramDigest: 'M423 held digest',
  escalations: [{
    topic: 'Held escalation',
    context: 'Must publish before pause reports quiescence.',
    options: ['Acknowledge'],
    stakes: 'high',
  }],
  confidence: 'high',
});

let home: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;

beforeEach(() => {
  home = join(tmpdir(), `ashlr-m423-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PULSE_URL = 'http://pulse.m423.invalid';
  process.env.PULSE_FLEET_PAT = 'm423-pat';
  proposalLockBarrier.onAcquire = undefined;
  vi.clearAllMocks();
  directorMocks.spawnEngine.mockResolvedValue({ ok: true, output: directorDecision });
  directorMocks.sendTelegram.mockResolvedValue({ ok: true });
});

afterEach(() => {
  proposalLockBarrier.onAcquire = undefined;
  vi.unstubAllGlobals();
  delete process.env.PULSE_URL;
  delete process.env.PULSE_FLEET_PAT;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(home, { recursive: true, force: true });
});

describe('M423 control-plane lock order', () => {
  it.each(['approve_proposal', 'reject_proposal'] as const)(
    'lets pause linearize before %s proposal mutation and keeps the claim retryable',
    async (kind) => {
      const writes: Array<Record<string, unknown>> = [];
      let commandStatus: 'pending' | 'claimed' | 'done' | 'failed' = 'pending';
      let claimedAt: string | null = null;
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/fleet/commands?')) {
          const requestedStatus = new URL(url).searchParams.get('status');
          const command = {
            id: `m423-${kind}`,
            kind,
            target: 'm423-proposal',
            payload: {},
            status: commandStatus,
            claimedBy: commandStatus === 'claimed' ? 'm423' : null,
            claimedAt,
          };
          return Promise.resolve(Response.json({
            commands: requestedStatus === commandStatus ? [command] : [],
          }));
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push(body);
        commandStatus = body['status'] as typeof commandStatus;
        if (commandStatus === 'claimed') claimedAt = new Date().toISOString();
        return Promise.resolve(new Response('{}', { status: 200 }));
      }));

      let pauseResult: ReturnType<typeof setKill> | undefined;
      proposalLockBarrier.onAcquire = () => {
        pauseResult = setKill(true, { waitMs: 500 });
      };

      const results = await pollAndApplyCommands({ user: { id: 'm423' } } as AshlrConfig);

      expect(pauseResult).toMatchObject({ ok: true, quiesced: true });
      expect(killSwitchOn()).toBe(true);
      expect(results).toEqual([expect.objectContaining({
        outcome: 'skipped',
        detail: expect.stringMatching(/remains retryable: kill-switch/i),
      })]);
      expect(writes).toEqual([expect.objectContaining({ status: 'claimed' })]);

      // Simulate a daemon restart after the bounded lease. The resumed pass
      // requeues the abandoned claim, claims it again, and completes it once.
      claimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      proposalLockBarrier.onAcquire = undefined;
      expect(setKill(false, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });

      const retried = await pollAndApplyCommands({ user: { id: 'm423' } } as AshlrConfig);

      expect(retried).toEqual([expect.objectContaining({ outcome: 'done' })]);
      expect(pulseInboxMocks.setStatus).toHaveBeenCalledTimes(1);
      expect(writes.map((write) => write['status'])).toEqual([
        'claimed',
        'pending',
        'claimed',
        'done',
      ]);
    },
  );

  it('holds outward authority through an unresolved Director LLM phase', async () => {
    const llm = Promise.withResolvers<{ ok: boolean; output: string }>();
    directorMocks.spawnEngine.mockReturnValueOnce(llm.promise);
    const cfg = {
      comms: { director: true, telegram: { botToken: 'test', chatId: 'm423' } },
      foundry: { managerJudgeEngine: 'claude', allowedBackends: ['claude'] },
    } as unknown as AshlrConfig;

    const running = runDirectorCycle(cfg);
    await vi.waitFor(() => expect(directorMocks.spawnEngine).toHaveBeenCalledOnce());

    const startedAt = performance.now();
    const whileHeld = setKill(true, { waitMs: 60 });
    const waitedMs = performance.now() - startedAt;
    expect(whileHeld).toMatchObject({ ok: false, quiesced: false });
    expect(waitedMs).toBeGreaterThanOrEqual(40);

    llm.resolve({ ok: true, output: directorDecision });
    await running;
    expect(directorMocks.sendTelegram).not.toHaveBeenCalled();
    expect(directorMocks.postRequest).not.toHaveBeenCalled();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });

  it('holds outward authority through Telegram and suppresses later publication after pause', async () => {
    const telegramStarted = Promise.withResolvers<void>();
    const releaseTelegram = Promise.withResolvers<{ ok: boolean }>();
    directorMocks.sendTelegram.mockImplementationOnce(() => {
      telegramStarted.resolve();
      return releaseTelegram.promise;
    });

    const cfg = {
      comms: { director: true, telegram: { botToken: 'test', chatId: 'm423' } },
      foundry: { managerJudgeEngine: 'claude', allowedBackends: ['claude'] },
    } as unknown as AshlrConfig;
    const running = runDirectorCycle(cfg);
    await telegramStarted.promise;

    const startedAt = performance.now();
    const whileHeld = setKill(true, { waitMs: 60 });
    const waitedMs = performance.now() - startedAt;

    expect(whileHeld).toMatchObject({ ok: false, quiesced: false });
    expect(waitedMs).toBeGreaterThanOrEqual(40);
    expect(directorMocks.postRequest).not.toHaveBeenCalled();

    releaseTelegram.resolve({ ok: true });
    await running;
    expect(directorMocks.postRequest).not.toHaveBeenCalled();
    expect(setKill(true, { waitMs: 500 })).toMatchObject({ ok: true, quiesced: true });
  });
});

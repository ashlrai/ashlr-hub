/**
 * Review finding c2 (3.10): redTeamProposal's model half must resolve its
 * judge ONLY through the lanes the caller's SeatRouter admitted. An empty
 * lane list means "no seat may be spent" — no resolution, no model call —
 * and a refused judge ('' response) is reported as 'failed', never cached as
 * an answer. No model is ever called here (the resolver is mocked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({ resolveFrontierJudgeClient }));

import { redTeamProposal } from '../src/core/fleet/red-team.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const cfg = { foundry: { redTeam: true } } as unknown as AshlrConfig;
const proposal = {
  id: 'p-rt',
  title: 'add sub',
  summary: 'adds sub',
  engineModel: 'grok-cli:grok-4.7',
  diff: 'diff --git a/src/sub.ts b/src/sub.ts\n+export const sub = 1;\n',
} as unknown as Proposal;

beforeEach(() => {
  resolveFrontierJudgeClient.mockReset();
});

describe('redTeamProposal — routed judge (c2)', () => {
  it('an EMPTY admitted-lane list never resolves or calls a model', async () => {
    const result = await redTeamProposal(proposal, cfg, { judge: { allowedJudgeEngines: [] } });
    expect(resolveFrontierJudgeClient).not.toHaveBeenCalled();
    expect(result.frontier).toBe('none');
    expect(result.verdict).toBe('survived');
  });

  it('passes the admitted lanes and independence to the resolver', async () => {
    const complete = vi.fn(async () => '[]');
    resolveFrontierJudgeClient.mockReturnValue({ complete, model: 'claude-opus-4-8' });
    const judge = { producerModel: 'grok-cli:grok-4.7', requireIndependent: true, allowedJudgeEngines: ['claude-cli'] as const };
    const result = await redTeamProposal(proposal, cfg, { judge });
    expect(resolveFrontierJudgeClient).toHaveBeenCalledWith(cfg, judge);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.frontier).toBe('answered');
  });

  it("a refused judge ('' response) is 'failed', not an answer", async () => {
    resolveFrontierJudgeClient.mockReturnValue({ complete: async () => '', model: 'gpt-5.5' });
    const result = await redTeamProposal(proposal, cfg, { judge: { allowedJudgeEngines: ['codex'] } });
    expect(result.frontier).toBe('failed');
  });

  it('a throwing judge is \'failed\' and falls back to deterministic-only', async () => {
    resolveFrontierJudgeClient.mockReturnValue({ complete: async () => { throw new Error('boom'); }, model: 'gpt-5.5' });
    const result = await redTeamProposal(proposal, cfg, { judge: { allowedJudgeEngines: ['codex'] } });
    expect(result.frontier).toBe('failed');
    expect(result.verdict).toBe('survived');
  });
});

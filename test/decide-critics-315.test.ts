/**
 * decide-critics-315 — Jev typed extraction wired into the taste critic and
 * the red team (the judge models themselves are unchanged and mocked here).
 *
 *   taste: an unparseable reply, or one with no valid verdict, is read by Jev
 *          instead of becoming a neutral 'solid' / a verdict derived from the
 *          score. Unkeyed → exactly the old behaviour.
 *   red team: prose (non-JSON) replies can gain ONE finding at the severity
 *          Jev reads — escalate-only; a JSON reply never goes to Jev.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveFrontierJudgeClient = vi.fn();
vi.mock('../src/core/fleet/manager.js', () => ({ resolveFrontierJudgeClient, judgeProposal: vi.fn() }));

import { scoreTaste } from '../src/core/fleet/taste-critic.js';
import { redTeamProposal } from '../src/core/fleet/red-team.js';
import type { AshlrConfig, Proposal } from '../src/core/types.js';
import { TYPESAFE_API_KEY_ENV } from '../src/core/classify/typesafe-client.js';
import { clearDecisionCache } from '../src/core/decide/cache.js';
import { resetLedgerCountersForTests } from '../src/core/decide/ledger.js';
import { choice, FAKE_TYPESAFE_ENDPOINT, FAKE_TYPESAFE_KEY, installFakeTypeSafe, noul, type FakeTypeSafe } from './helpers/fake-typesafe.js';

const cfg = { foundry: { redTeam: true } } as unknown as AshlrConfig;
const proposal = {
  id: 'p-jev', title: 'add sub', summary: 'adds sub', engineModel: 'grok-cli:grok-4.7',
  diff: 'diff --git a/src/sub.ts b/src/sub.ts\n+export const sub = 1;\n',
} as unknown as Proposal;
const SAVED = { ...process.env };
let fake: FakeTypeSafe;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'jev-critics-'));
  process.env['ASHLR_HOME'] = home;
  process.env[TYPESAFE_API_KEY_ENV] = FAKE_TYPESAFE_KEY;
  process.env['ASHLR_TYPESAFE_ENDPOINT'] = FAKE_TYPESAFE_ENDPOINT;
  clearDecisionCache();
  resetLedgerCountersForTests();
  resolveFrontierJudgeClient.mockReset();
  fake = installFakeTypeSafe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
  for (const k of ['ASHLR_HOME', TYPESAFE_API_KEY_ENV, 'ASHLR_TYPESAFE_ENDPOINT']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

const taste = (raw: string) => {
  const complete = vi.fn(async () => raw);
  resolveFrontierJudgeClient.mockReturnValue({ complete, model: 'claude-opus-4-8' });
  return { complete, run: () => scoreTaste(proposal, { vision: 'v' } as never, cfg) };
};

describe('taste critic', () => {
  it('unparseable prose is read by Jev (one judge call, no neutral fallback)', async () => {
    fake.respond(() => ({ states_verdict: noul(0.95), verdict: choice('gold', 0.97), alignment: choice('5', 0.97), ambition: choice('4', 0.97), design: choice('5', 0.97) }));
    const t = taste('This is genuinely exemplary work — gold. Alignment 5, ambition 4, design 5.');
    const score = await t.run();
    expect(t.complete).toHaveBeenCalledTimes(1);
    expect(score).toMatchObject({ verdict: 'gold', alignment: 5, ambition: 4, design: 5, overall: 4.7 });
    expect(score.rationale).toContain('jev-extracted');
  });

  it('a JSON reply with no verdict gets the stated verdict, not one derived from the score', async () => {
    fake.respond(() => ({ states_verdict: noul(0.95), verdict: choice('mediocre', 0.96), alignment: choice('4', 0.96), ambition: choice('4', 0.96), design: choice('4', 0.96) }));
    const t = taste(JSON.stringify({ alignment: 4, ambition: 4, design: 4, overall: 4.2, rationale: 'Clean but I would call it mediocre.' }));
    const score = await t.run();
    expect(score.verdict).toBe('mediocre'); // the old path derived 'gold' from overall >= 4
    expect(score.overall).toBe(4.2);
  });

  it('a JSON reply WITH a verdict never goes to Jev', async () => {
    const t = taste(JSON.stringify({ alignment: 4, ambition: 3, design: 4, overall: 3.7, verdict: 'solid', rationale: 'fine' }));
    await t.run();
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('unkeyed: exactly the old behaviour (neutral on prose, derived verdict on JSON)', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    expect(await taste('not json at all').run()).toMatchObject({ verdict: 'solid', overall: 3 });
    expect((await taste(JSON.stringify({ alignment: 5, ambition: 5, design: 5, overall: 4.5 })).run()).verdict).toBe('gold');
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('red team', () => {
  const judge = { judge: { allowedJudgeEngines: ['claude-cli'] as const } };
  const redTeam = (raw: string) => {
    resolveFrontierJudgeClient.mockReturnValue({ complete: vi.fn(async () => raw), model: 'claude-opus-4-8' });
    return redTeamProposal(proposal, cfg, judge as never);
  };

  it('a prose reply reporting a high-severity problem now breaks the proposal', async () => {
    fake.respond(() => ({ severity: choice('high', 0.93) }));
    const r = await redTeam('The new endpoint writes the bearer token to the access log, so anyone with log access can replay it.');
    expect(r.verdict).toBe('broken');
    expect(r.attacks.some((a) => a.vector === 'frontier:unstructured-report' && a.severity === 'high')).toBe(true);
  });

  it('Jev can never remove a finding or flip a JSON verdict', async () => {
    fake.respond(() => ({ severity: choice('none', 0.99) }));
    const r = await redTeam(JSON.stringify({ attacks: [{ vector: 'inj', finding: 'SQL injection in sub()', severity: 'high' }] }));
    expect(fake.fetch).not.toHaveBeenCalled();
    expect(r.verdict).toBe('broken');
  });

  it('unkeyed prose: survived, as before', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    const r = await redTeam('I looked at it and have some thoughts.');
    expect(r).toMatchObject({ verdict: 'survived', frontier: 'answered' });
  });
});

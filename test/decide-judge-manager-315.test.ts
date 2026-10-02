/**
 * decide-judge-manager-315 — the manager judge's parser, with Jev typed
 * extraction in front of the paid reprompt (src/core/fleet/manager.ts).
 *
 *   - a reply the local parser cannot read, but which states a verdict, is
 *     extracted by Jev: ONE judge call instead of two;
 *   - Jev never invents a 'ship' (the reply must say it, and the rubric must
 *     allow it) — otherwise the reprompt runs exactly as before;
 *   - unkeyed, the chain is byte-for-byte the old one (two calls, then the
 *     tracked 'parse' failure).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../src/core/types.js';
import { TYPESAFE_API_KEY_ENV } from '../src/core/classify/typesafe-client.js';
import { clearDecisionCache } from '../src/core/decide/cache.js';
import { readLedger, resetLedgerCountersForTests } from '../src/core/decide/ledger.js';
import { choice, FAKE_TYPESAFE_ENDPOINT, FAKE_TYPESAFE_KEY, installFakeTypeSafe, noul, type FakeTypeSafe } from './helpers/fake-typesafe.js';

const SAVED = { ...process.env };
let tmpHome: string;
let fake: FakeTypeSafe;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-judge-'));
  process.env['HOME'] = tmpHome;
  process.env['ASHLR_HOME'] = path.join(tmpHome, '.ashlr');
  process.env[TYPESAFE_API_KEY_ENV] = FAKE_TYPESAFE_KEY;
  process.env['ASHLR_TYPESAFE_ENDPOINT'] = FAKE_TYPESAFE_ENDPOINT;
  clearDecisionCache();
  resetLedgerCountersForTests();
  fake = installFakeTypeSafe();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  for (const k of ['HOME', 'ASHLR_HOME', TYPESAFE_API_KEY_ENV, 'ASHLR_TYPESAFE_ENDPOINT']) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

let seq = 0;
function proposal(): Proposal {
  return {
    id: `prop-jev-${seq++}`,
    repo: '/repos/alpha',
    origin: 'backlog',
    kind: 'patch',
    title: 'Stop the dashboard from double-counting merges',
    summary: 'dedupe merge events by sha',
    engineModel: 'codex:gpt-5.5',
    engineTier: 'frontier',
    status: 'pending',
    createdAt: new Date().toISOString(),
    diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
  } as Proposal;
}

const rubric = (verdict: string, dims: [string, string, string, string], conf = 0.96) => ({
  states_verdict: noul(0.97),
  verdict: choice(verdict, conf),
  value: choice(dims[0], conf),
  correctness: choice(dims[1], conf),
  scope: choice(dims[2], conf),
  alignment: choice(dims[3], conf),
});

describe('manager judge — Jev extraction before the reprompt', () => {
  it('extracts a stated verdict from prose: one judge call, a considered judgment', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    fake.respond(() => rubric('review', ['4', '4', '3', '4']));
    const complete = vi.fn().mockResolvedValue(
      'My assessment: the change is sound but touches a shared counter. I would send it to REVIEW. '
      + 'Value four, correctness four, scope three, alignment four. RATIONALE: correct dedupe, shared state needs a human look',
    );
    const verdict = await judgeProposal(proposal(), {} as never, { id: 'anthropic', model: 'claude-sonnet-4-5', complete });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fake.fetch).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ verdict: 'review', value: 4, correctness: 4, scope: 3, alignment: 4 });
    expect(verdict.judgeFailure).toBeUndefined();
    expect(verdict.rationale).toContain('[jev-extracted]');
    expect(readLedger().find((l) => l.kind === 'judge-verdict')).toMatchObject({ path: 'jev', jevLabel: 'review', called: true });
  });

  it('never extracts a ship the reply did not state — the reprompt runs as before', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    fake.respond(() => rubric('ship', ['5', '5', '5', '5']));
    const complete = vi.fn()
      .mockResolvedValueOnce('Honestly this looks excellent and I would merge it immediately.')
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3, rationale: 'strict retry' }));
    const verdict = await judgeProposal(proposal(), {} as never, { id: 'anthropic', model: 'claude-sonnet-4-5', complete });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(verdict).toMatchObject({ verdict: 'review', rationale: 'strict retry' });
  });

  it('unkeyed: the old chain exactly (reprompt, then the tracked parse failure)', async () => {
    delete process.env[TYPESAFE_API_KEY_ENV];
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const complete = vi.fn().mockResolvedValue('I cannot provide a structured assessment at this time.');
    const verdict = await judgeProposal(proposal(), {} as never, { id: 'anthropic', model: 'claude-sonnet-4-5', complete });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(verdict).toMatchObject({ verdict: 'review', judgeFailure: 'parse', wouldMerge: false });
    expect(fake.fetch).not.toHaveBeenCalled();
  });

  it('a clean JSON verdict never consults Jev', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ verdict: 'noise', value: 1, correctness: 3, scope: 3, alignment: 2, rationale: 'cosmetic' }));
    await judgeProposal(proposal(), {} as never, { id: 'anthropic', model: 'claude-sonnet-4-5', complete });
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});


describe('outcome retirement during critic response', () => {
  it('prevents late Jev extraction and a paid recovery request after a contacted judge retires the outcome', async () => {
    const { judgeProposal } = await import('../src/core/fleet/manager.js');
    let current = true;
    const complete = vi.fn(async () => { await Promise.resolve(); current = false; return 'unstructured review'; });
    await expect(judgeProposal(proposal(), {} as never, { model: 'fixture-judge', complete }, {
      cache: false, selectedOutcomeAdmission: () => current,
    })).rejects.toMatchObject({ name: 'SelectedOutcomeAdmissionRefusal' });
    expect(complete).toHaveBeenCalledOnce(); expect(fake.fetch).not.toHaveBeenCalled();
  });
});

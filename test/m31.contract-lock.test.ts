/**
 * M31 — agent-contract CONFORMANCE LOCK.
 *
 * The CLI-first agent contract promises STABLE --json shapes (CONTRACT-M31
 * hard rule: "CLI JSON shapes are versioned contract"). These tests pin the
 * exact key sets of the agent-facing payloads so any drift fails a named
 * test instead of silently breaking downstream agents.
 *
 * Changing a shape is allowed — additively, deliberately, with this lock
 * updated in the same commit (that IS the versioning act).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { makeFixture, makeCfg, type H1Fixture } from './helpers/h1-fixture.js';
import { buildOrientation } from '../src/core/orient.js';
import { estimateRun } from '../src/core/observability/estimate.js';
import { nativeToolDefs, callNativeTool } from '../src/core/mcp-native.js';
import { AGENT_COMMANDS } from '../src/cli/help.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('OrientResult shape lock', () => {
  it('top-level keys are exactly the contracted set', async () => {
    const o = await buildOrientation(makeCfg());
    expect(Object.keys(o).sort()).toEqual([
      'attention',
      'backlogItems',
      'generatedAt',
      'genomeHits',
      'health',
      'pendingProposals',
      'repo',
    ]);
  });

  it('genomeHits/backlogItems entry keys are stable', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(fx.ashlrDir, 'genome'), { recursive: true });
    // Text contains the portfolio-wide orientation query's keywords
    // ("project conventions decisions overview") so recall surfaces it.
    writeFileSync(
      join(fx.ashlrDir, 'genome', 'hub.jsonl'),
      JSON.stringify({ id: 'g', project: null, source: 'hub', title: 'lock test entry', text: 'project conventions decisions overview for the lock test', tags: [], ts: new Date().toISOString() }) + '\n',
    );
    const o = await buildOrientation(makeCfg());
    const hit = o.genomeHits.find((h) => h.title === 'lock test entry');
    expect(hit).toBeTruthy();
    expect(Object.keys(hit!).sort()).toEqual(['project', 'score', 'text', 'title']);
  });
});

describe('RunEstimate shape lock', () => {
  it('top-level keys are exactly the contracted set', async () => {
    const e = await estimateRun('lock test', {}, makeCfg());
    expect(Object.keys(e).sort()).toEqual([
      'budgetClamped',
      'confidence',
      'durationMs',
      'estCostUsd',
      'generatedAt',
      'goal',
      'kind',
      'sampleSize',
      'steps',
      'tokens',
      'wouldBeCloudUsd',
    ]);
    expect(Object.keys(e.tokens).sort()).toEqual(['median', 'p25', 'p75']);
  });
});

describe('native MCP tool surface lock', () => {
  it('the 12 tool names and their safety classes are pinned', () => {
    const surface = nativeToolDefs()
      .map((t) => `${t.name}:${t.safety}`)
      .sort();
    expect(surface).toEqual([
      'ashlr_ask:read',
      'ashlr_backlog:read',
      'ashlr_desktop_open:proposal',
      'ashlr_health:read',
      'ashlr_impact:read',
      'ashlr_inbox_list:read',
      'ashlr_inbox_propose:proposal',
      'ashlr_learn:append',
      'ashlr_orient:read',
      'ashlr_pulse:read',
      'ashlr_recall:read',
      'ashlr_status:read',
    ]);
  });

  it('every tool result is the MCP text-content envelope', async () => {
    const r = await callNativeTool('ashlr_recall', { query: 'anything' });
    expect(Object.keys(r).sort()).toEqual(['content']);
    expect(r.content[0]!.type).toBe('text');
  });
});

describe('AGENT_COMMANDS registry lock', () => {
  it('entry keys are stable and the safety vocabulary is closed', () => {
    for (const cmd of AGENT_COMMANDS) {
      expect(Object.keys(cmd).sort()).toEqual(['description', 'jsonShape', 'safety', 'usage']);
    }
    const safeties = new Set(AGENT_COMMANDS.map((c) => c.safety));
    for (const s of safeties) {
      expect(['read', 'append', 'proposal', 'human-gate']).toContain(s);
    }
  });
});

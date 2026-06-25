/**
 * test/m109.attribution.test.ts — M109: Team attribution unit tests.
 *
 * CONTRACT verified:
 *  1. createProposal stamps owner from cfg.user.id when provided.
 *  2. createProposal stamps owner from cfg.user.name when id absent.
 *  3. createProposal leaves owner undefined when cfg absent (backward compat).
 *  4. createGoal stamps owner from cfg.user.id when provided.
 *  5. createGoal stamps owner from cfg.user.name when id absent.
 *  6. createGoal leaves owner undefined when cfg absent (backward compat).
 *  7. buildFleetSpans includes ashlr.fleet.owner on tick/proposal spans when owner set.
 *  8. buildFleetSpans omits ashlr.fleet.owner when owner absent.
 *  9. Proposal.owner takes priority over the configured owner in pulse spans.
 * 10. Existing M89 OTLP contract (ashlr.source, gen_ai.system, etc.) still holds.
 *
 * Mirror conventions from m89.pulse-export.test.ts (HOME redirect, seedProposal,
 * dynamic import, no real network calls).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers — seed daemon state + proposals into a tmp HOME (mirrors m89)
// ---------------------------------------------------------------------------

let tmpHome: string;
let origHome: string;

function seedDaemonState(ticks: object[]): void {
  const dir = join(tmpHome, '.ashlr');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'daemon.json'),
    JSON.stringify({
      running: false,
      pid: null,
      startedAt: null,
      lastTickAt: null,
      todayDate: '2026-06-24',
      todaySpentUsd: 0,
      itemsProcessed: 0,
      ticks,
    }),
    'utf8',
  );
}

function seedProposal(id: string, fields: object): void {
  const dir = join(tmpHome, '.ashlr', 'inbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      origin: 'daemon',
      kind: 'diff',
      title: 'Test proposal',
      summary: 'A test proposal',
      status: 'pending',
      repo: '/Users/test/my-repo',
      createdAt: '2026-06-24T10:00:00.000Z',
      ...fields,
    }),
    'utf8',
  );
}

beforeEach(() => {
  tmpHome = join(tmpdir(), `m109-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpHome, { recursive: true });
  origHome = process.env['HOME'] ?? '';
  process.env['HOME'] = tmpHome;
});

afterEach(() => {
  process.env['HOME'] = origHome;
  if (existsSync(tmpHome)) {
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// Dynamic import helpers — pick up patched HOME at call time.
async function getInboxStore() {
  return import('../src/core/inbox/store.js');
}
async function getGoalsStore() {
  return import('../src/core/goals/store.js');
}
async function getPulseExport() {
  return import('../src/core/fleet/pulse-export.js');
}

// ---------------------------------------------------------------------------
// Attribute map helper (mirrors m89)
// ---------------------------------------------------------------------------

function attrMap(attrs: Array<{ key: string; value: { stringValue?: string; intValue?: number } }>): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  for (const a of attrs) {
    m[a.key] = 'stringValue' in a.value ? a.value.stringValue : a.value.intValue;
  }
  return m;
}

// ---------------------------------------------------------------------------
// 1–3. createProposal — owner stamping
// ---------------------------------------------------------------------------

describe('createProposal — owner stamping (M109)', () => {
  it('stamps owner from cfg.user.id when provided', async () => {
    const { createProposal } = await getInboxStore();
    const proposal = createProposal(
      {
        origin: 'daemon',
        kind: 'note',
        title: 'Test',
        summary: 'Test',
        repo: null,
      },
      { user: { id: 'mason@evero-consulting.com', name: 'Mason' } },
    );
    expect(proposal.owner).toBe('mason@evero-consulting.com');
  });

  it('stamps owner from cfg.user.name when id absent', async () => {
    const { createProposal } = await getInboxStore();
    const proposal = createProposal(
      {
        origin: 'daemon',
        kind: 'note',
        title: 'Test',
        summary: 'Test',
        repo: null,
      },
      { user: { name: 'Mason' } },
    );
    expect(proposal.owner).toBe('Mason');
  });

  it('leaves owner undefined when cfg absent (backward compat)', async () => {
    const { createProposal } = await getInboxStore();
    const proposal = createProposal({
      origin: 'daemon',
      kind: 'note',
      title: 'Test',
      summary: 'Test',
      repo: null,
    });
    expect(proposal.owner).toBeUndefined();
  });

  it('respects owner already set by caller (not overridden by cfg)', async () => {
    const { createProposal } = await getInboxStore();
    const proposal = createProposal(
      {
        origin: 'daemon',
        kind: 'note',
        title: 'Test',
        summary: 'Test',
        repo: null,
        owner: 'explicit-owner',
      },
      { user: { id: 'cfg-owner@example.com' } },
    );
    // caller-supplied owner wins
    expect(proposal.owner).toBe('explicit-owner');
  });
});

// ---------------------------------------------------------------------------
// 4–6. createGoal — owner stamping
// ---------------------------------------------------------------------------

describe('createGoal — owner stamping (M109)', () => {
  it('stamps owner from cfg.user.id when provided', async () => {
    const { createGoal } = await getGoalsStore();
    const goal = createGoal('Ship M109 attribution', {
      now: '2026-06-24T00:00:00.000Z',
      cfg: { user: { id: 'mason@evero-consulting.com', name: 'Mason' } },
    });
    expect(goal.owner).toBe('mason@evero-consulting.com');
  });

  it('stamps owner from cfg.user.name when id absent', async () => {
    const { createGoal } = await getGoalsStore();
    const goal = createGoal('Ship M109 attribution name-only', {
      now: '2026-06-24T00:00:00.000Z',
      cfg: { user: { name: 'Mason' } },
    });
    expect(goal.owner).toBe('Mason');
  });

  it('leaves owner undefined when cfg absent (backward compat)', async () => {
    const { createGoal } = await getGoalsStore();
    const goal = createGoal('No owner goal', { now: '2026-06-24T00:00:00.000Z' });
    expect(goal.owner).toBeUndefined();
  });

  it('leaves owner undefined when cfg.user is empty', async () => {
    const { createGoal } = await getGoalsStore();
    const goal = createGoal('Empty user goal', {
      now: '2026-06-24T00:00:00.000Z',
      cfg: { user: {} },
    });
    expect(goal.owner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7–8. buildFleetSpans — ashlr.fleet.owner attribute presence/absence
// ---------------------------------------------------------------------------

describe('buildFleetSpans — ashlr.fleet.owner attribute (M109)', () => {
  it('includes ashlr.fleet.owner on tick span when owner provided', async () => {
    seedDaemonState([
      {
        ts: '2026-06-24T09:00:00.000Z',
        itemsConsidered: 1,
        proposalsCreated: 1,
        spentUsd: 0.001,
        reason: 'ok',
      },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans(undefined, 'mason@evero-consulting.com')
      .resourceSpans[0]!.scopeSpans[0]!.spans;

    const tickSpan = spans.find((s) => s.name === 'fleet.tick');
    expect(tickSpan).toBeDefined();
    const m = attrMap(tickSpan!.attributes);
    expect(m['ashlr.fleet.owner']).toBe('mason@evero-consulting.com');
  });

  it('omits ashlr.fleet.owner on tick span when owner absent', async () => {
    seedDaemonState([
      {
        ts: '2026-06-24T09:00:00.000Z',
        itemsConsidered: 1,
        proposalsCreated: 0,
        spentUsd: 0,
        reason: 'ok',
      },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;

    const tickSpan = spans.find((s) => s.name === 'fleet.tick');
    expect(tickSpan).toBeDefined();
    const m = attrMap(tickSpan!.attributes);
    expect(m['ashlr.fleet.owner']).toBeUndefined();
  });

  it('includes ashlr.fleet.owner on proposal span when owner provided', async () => {
    seedProposal('prop-m109-000001-aa01', {
      status: 'pending',
      createdAt: '2026-06-24T10:00:00.000Z',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans(undefined, 'mason@evero-consulting.com')
      .resourceSpans[0]!.scopeSpans[0]!.spans;

    const propSpan = spans.find((s) => s.name === 'fleet.proposal');
    expect(propSpan).toBeDefined();
    const m = attrMap(propSpan!.attributes);
    expect(m['ashlr.fleet.owner']).toBe('mason@evero-consulting.com');
  });

  it('omits ashlr.fleet.owner on proposal span when owner absent', async () => {
    seedProposal('prop-m109-000002-aa02', {
      status: 'pending',
      createdAt: '2026-06-24T10:01:00.000Z',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;

    const propSpan = spans.find((s) => s.name === 'fleet.proposal');
    expect(propSpan).toBeDefined();
    const m = attrMap(propSpan!.attributes);
    expect(m['ashlr.fleet.owner']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Proposal.owner takes priority over configured owner
// ---------------------------------------------------------------------------

describe('buildFleetSpans — proposal.owner takes priority over cfg owner (M109)', () => {
  it('uses proposal.owner when set, ignores cfg owner', async () => {
    seedProposal('prop-m109-000003-aa03', {
      status: 'pending',
      createdAt: '2026-06-24T11:00:00.000Z',
      owner: 'cofounder@evero-consulting.com',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans(undefined, 'mason@evero-consulting.com')
      .resourceSpans[0]!.scopeSpans[0]!.spans;

    const propSpan = spans.find((s) => s.name === 'fleet.proposal');
    expect(propSpan).toBeDefined();
    const m = attrMap(propSpan!.attributes);
    // Cofounder's proposal — cofounder's owner wins
    expect(m['ashlr.fleet.owner']).toBe('cofounder@evero-consulting.com');
  });
});

// ---------------------------------------------------------------------------
// 10. Existing M89 OTLP contract still holds (regression)
// ---------------------------------------------------------------------------

describe('M89 OTLP contract regression — unaffected by M109', () => {
  it('all required M89 attributes still present on tick span', async () => {
    seedDaemonState([
      {
        ts: '2026-06-24T12:00:00.000Z',
        itemsConsidered: 2,
        proposalsCreated: 1,
        spentUsd: 0.002,
        reason: 'ok',
        backends: { claude: 1 },
      },
    ]);

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans(undefined, 'mason@evero-consulting.com')
      .resourceSpans[0]!.scopeSpans[0]!.spans;

    const tickSpan = spans.find((s) => s.name === 'fleet.tick');
    expect(tickSpan).toBeDefined();
    const m = attrMap(tickSpan!.attributes);

    // All M89 required attributes
    expect(m['ashlr.source']).toBe('ashlr-fleet');
    expect(m['gen_ai.system']).toBe('claude');
    expect(typeof m['gen_ai.usage.input_tokens']).toBe('number');
    expect(typeof m['gen_ai.usage.output_tokens']).toBe('number');
    expect(m['ashlr.fleet.event']).toBe('tick');
    expect(typeof m['ashlr.fleet.repo']).toBe('string');
    expect(m['ashlr.fleet.outcome']).toBe('ok');
    expect(typeof m['ashlr.fleet.cost_usd']).toBe('string');
    expect(m['ashlr.fleet.ref_id']).toBe('2026-06-24T12:00:00.000Z');
    // M109 additive
    expect(m['ashlr.fleet.owner']).toBe('mason@evero-consulting.com');
  });

  it('all required M89 attributes still present on proposal span', async () => {
    seedProposal('prop-m109-000004-aa04', {
      status: 'pending',
      engineModel: 'claude:claude-sonnet-4-6',
      repo: '/Users/test/my-repo',
      createdAt: '2026-06-24T13:00:00.000Z',
    });

    const { buildFleetSpans } = await getPulseExport();
    const spans = buildFleetSpans().resourceSpans[0]!.scopeSpans[0]!.spans;

    const propSpan = spans.find((s) => s.name === 'fleet.proposal');
    expect(propSpan).toBeDefined();
    const m = attrMap(propSpan!.attributes);

    expect(m['ashlr.source']).toBe('ashlr-fleet');
    expect(m['gen_ai.system']).toBe('claude');
    expect(typeof m['gen_ai.usage.input_tokens']).toBe('number');
    expect(typeof m['gen_ai.usage.output_tokens']).toBe('number');
    expect(m['ashlr.fleet.event']).toBe('proposal');
    expect(m['ashlr.fleet.repo']).toBe('my-repo');
    expect(m['ashlr.fleet.outcome']).toBe('pending');
    expect(m['ashlr.fleet.ref_id']).toBe('prop-m109-000004-aa04');
    // No owner when absent
    expect(m['ashlr.fleet.owner']).toBeUndefined();
  });
});

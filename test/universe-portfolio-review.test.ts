import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { UniverseCampaignDefinition, UniverseCampaignSummary } from '../src/core/universe/types.js';
import type { UniversePortfolioDefinition } from '../src/core/universe/portfolio-types.js';

const runtime = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn() }));
vi.mock('../src/core/universe/campaign-store.js', async (original) => ({
  ...await original<typeof import('../src/core/universe/campaign-store.js')>(), readUniverseCampaign: runtime.read,
}));
vi.mock('../src/core/universe/campaign.js', () => ({ runUniverseCampaign: runtime.run }));

import { runUniversePortfolio } from '../src/core/universe/portfolio.js';

function digest(value: unknown): string {
  const ordered = JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  return createHash('sha256').update(ordered).digest('hex');
}

function campaign(id: string, overrides: Partial<UniverseCampaignSummary> = {}): UniverseCampaignSummary {
  const definition: UniverseCampaignDefinition = { schemaVersion: 1, id, universeId: `universe-${id}`, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 30000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } };
  return { definition, definitionDigest: digest(definition), manifestDigest: 'a'.repeat(64), comparatorDigest: 'b'.repeat(64),
    createdAt: '2026-09-07T00:00:00.000Z', state: 'ready', reason: null, startedAt: null, deadlineAt: null, finishedAt: null,
    steps: [], progress: { attempts: 0, completedRuns: 0, interruptedRuns: 0, reservedModelRequests: 0, reportedTokens: 0,
      recordedTokens: 0, usageComplete: true, admissions: 0, improvements: 0, stagnantGenerations: 0 },
    owner: null, sourceState: 'healthy', reasons: [], ...overrides };
}
function definition(dependencies: Record<string, string[]>): UniversePortfolioDefinition {
  return { schemaVersion: 1, id: 'independent-review', maxParallel: 2, maxDurationMs: 10000,
    tasks: Object.entries(dependencies).map(([campaignId, dependsOn]) => ({ campaignId, dependsOn })) };
}
function snapshots(ids: string[]) {
  const values = new Map(ids.map((id) => [id, campaign(id)]));
  runtime.read.mockImplementation((id: string) => structuredClone(values.get(id)!));
  const complete = (id: string) => {
    const result = { ...values.get(id)!, state: 'completed' as const, finishedAt: new Date().toISOString() };
    values.set(id, result); return structuredClone(result);
  };
  runtime.run.mockImplementation(async (id: string) => complete(id));
  return { values, complete };
}

describe('Universe portfolio independent scheduler review', () => {
  beforeEach(() => { runtime.read.mockReset(); runtime.run.mockReset(); });

  it('does not retry a rejected invocation and lets another dependency branch finish', async () => {
    const rows = snapshots(['a', 'b', 'c', 'd']);
    runtime.run.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('Test-owned rejected campaign invocation');
      if (id === 'b') await new Promise((resolve) => setTimeout(resolve, 10));
      return rows.complete(id);
    });
    const result = await runUniversePortfolio(definition({ a: [], b: [], c: ['a'], d: ['b'] }), { root: '/unused-review-root' });
    expect(result.status).not.toBe('completed');
    expect(runtime.run.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b', 'd']);
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'c')).toMatchObject({ attempted: false, status: 'blocked' });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'd')).toMatchObject({ attempted: true, status: 'completed' });
  });

  it('refuses a valid but changed campaign definition observed immediately before dispatch', async () => {
    const rows = snapshots(['a', 'b', 'c']); const reads = new Map<string, number>();
    runtime.read.mockImplementation((id: string) => {
      const count = (reads.get(id) ?? 0) + 1; reads.set(id, count);
      if (id === 'a' && count > 1) {
        const original = rows.values.get(id)!;
        const changed = { ...original.definition, budget: { ...original.definition.budget, maxGenerations: 2 } };
        return { ...original, definition: changed, definitionDigest: digest(changed) };
      }
      return structuredClone(rows.values.get(id)!);
    });
    const result = await runUniversePortfolio(definition({ a: [], b: [], c: ['a'] }), { root: '/unused-review-root' });
    expect(runtime.run.mock.calls.map(([id]) => id)).not.toContain('a');
    expect(runtime.run.mock.calls.map(([id]) => id)).not.toContain('c');
    expect(result.status).not.toBe('completed');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'a')?.attempted).toBe(false);
  });

  it('respects a control request that appears after planning rather than resuming through it', async () => {
    const rows = snapshots(['a', 'b']); let reads = 0;
    runtime.read.mockImplementation((id: string) => {
      if (id === 'a' && ++reads > 1) return { ...rows.values.get(id)!, state: 'pause-requested' };
      return structuredClone(rows.values.get(id)!);
    });
    const result = await runUniversePortfolio(definition({ a: [], b: ['a'] }), { root: '/unused-review-root' });
    expect(runtime.run).not.toHaveBeenCalled();
    expect(result.outcomes.every((outcome) => !outcome.attempted)).toBe(true);
    expect(result.status).not.toBe('completed');
  });

  it('does not adopt or abort a campaign already owned by another invocation', async () => {
    const rows = snapshots(['external', 'child', 'independent']);
    rows.values.set('external', campaign('external', { state: 'running', owner: { pid: 12345, startRef: 'external-owner' } }));
    const result = await runUniversePortfolio(definition({ external: [], child: ['external'], independent: [] }), { root: '/unused-review-root' });
    expect(runtime.run.mock.calls.map(([id]) => id)).toEqual(['independent']);
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'external')).toMatchObject({ attempted: false, status: 'busy' });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'child')?.attempted).toBe(false);
    expect(rows.values.get('external')!.state).toBe('running');
  });

  it('awaits delayed cooperative settlement before resolving caller cancellation', async () => {
    const rows = snapshots(['a', 'child']); const controller = new AbortController();
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve; });
    let settled = false;
    runtime.run.mockImplementation(async (id: string, options: { signal: AbortSignal }) => {
      started();
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => setTimeout(resolve, 15), { once: true }));
      settled = true;
      const paused = { ...rows.values.get(id)!, state: 'paused' as const };
      rows.values.set(id, paused); return paused;
    });
    const pending = runUniversePortfolio(definition({ a: [], child: ['a'] }), { root: '/unused-review-root', signal: controller.signal });
    await entered; controller.abort();
    const result = await pending;
    expect(settled).toBe(true); expect(result.status).toBe('cancelled');
    expect(runtime.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'a')?.campaign?.state).toBe('paused');
  });

  it('keeps pre-existing completed ordering distinct from newly declared causal ancestry', async () => {
    const rows = snapshots(['failed', 'past', 'next']);
    rows.values.set('failed', campaign('failed', { state: 'failed' }));
    rows.values.set('past', campaign('past', { state: 'completed' }));
    const result = await runUniversePortfolio(definition({ failed: [], past: ['failed'], next: ['past'] }), { root: '/unused-review-root' });
    expect(runtime.run.mock.calls.map(([id]) => id)).toEqual(['next']);
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'past')).toMatchObject({ attempted: false, status: 'completed' });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'next')).toMatchObject({ attempted: true, status: 'completed' });
    expect(result.plan.nodes.find((node) => node.campaignId === 'past')?.reason).toMatch(/ordering.*not.*accepted/i);
  });

  it('passes the exact plan identity into campaign execution for the under-lease recheck', async () => {
    const rows = snapshots(['a']); const original = structuredClone(rows.values.get('a')!);
    const result = await runUniversePortfolio(definition({ a: [] }), { root: '/unused-review-root' });
    expect(result.status).toBe('completed');
    expect(runtime.run).toHaveBeenCalledOnce();
    const options = runtime.run.mock.calls[0]![1] as { root: string; expectedIdentity?: unknown };
    expect(options.root).toBe('/unused-review-root');
    expect(options.expectedIdentity).toMatchObject({ definitionDigest: original.definitionDigest,
      manifestDigest: original.manifestDigest, comparatorDigest: original.comparatorDigest, summaryDigest: digest(original) });
  });

  it('does not release a descendant from a fulfilled but unrecorded completion', async () => {
    const rows = snapshots(['a', 'child']);
    runtime.run.mockImplementation(async (id: string) => ({ ...rows.values.get(id)!, state: 'completed' }));
    const result = await runUniversePortfolio(definition({ a: [], child: ['a'] }), { root: '/unused-review-root' });
    expect(runtime.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result.status).toBe('incomplete');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'a')).toMatchObject({ attempted: true, status: 'failed' });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'child')).toMatchObject({ attempted: false, status: 'blocked' });
  });

  it('does not adopt an unrelated durable completion after its own invocation rejected', async () => {
    const rows = snapshots(['a', 'child']);
    runtime.run.mockImplementation(async (id: string) => {
      rows.complete(id);
      throw new Error('This invocation rejected despite another terminal observation');
    });
    const result = await runUniversePortfolio(definition({ a: [], child: ['a'] }), { root: '/unused-review-root' });
    expect(runtime.run.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result.status).toBe('incomplete');
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'a')).toMatchObject({ attempted: true, status: 'failed',
      campaign: { state: 'completed' } });
    expect(result.outcomes.find((outcome) => outcome.campaignId === 'child')).toMatchObject({ attempted: false, status: 'blocked' });
  });
});

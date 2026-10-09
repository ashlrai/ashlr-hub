import { act, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { LocalResources } from './LocalResources.js';
import { servingRuntimeQuery } from '../autonomy/fleet-queries.js';
import { verseLocalModelsQuery } from '../usage/usage-queries.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
beforeEach(() => evictAll());
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
describe('local resource metrics wiring', () => {
  it('keeps catalog context and provenance separate from the serving allocation, even when names match', async () => {
    const catalog = { sampledAt: new Date(NOW).toISOString(),
      ollama: { reachable: true, models: [
        { id: 'qwen3.8:27b-ctx64k', state: 'available', contextLength: 65_536, nativeContextLength: 262_144 },
        { id: 'qwen3.8:27b-q8_0', state: 'available', contextLength: 262_144, nativeContextLength: 262_144 },
      ] },
      lmStudio: { reachable: true, models: [{ id: 'qwen/27b', state: 'available', contextLength: 32_768 }] },
      llamaServer: { reachable: true, status: 'ok', models: ['qwen3.8:27b-ctx64k'], modelCount: 1, slots: 4, reason: null },
    };
    const before = structuredClone(catalog);
    const { calls } = installFetch(call => {
      if (call.path === '/api/verse/local-models') return json(catalog);
      if (call.path === '/api/verse/runtime') return json({ kind: 'llama-server', state: 'running',
        endpoint: '127.0.0.1:8080', model: 'qwen3.8:27b-ctx64k', slotsTotal: 4, slotsBusy: 0, contextTokens: 65_536,
        startedAt: null, parallel: { capable: true, refusal: null, slots: 4 }, reason: null, supervised: false,
        sampledAt: new Date(NOW).toISOString() });
      return json({ error: 'unavailable' }, 404);
    });
    render(<ul><LocalResources status={null} now={NOW} onOpenUsage={() => {}} /></ul>);
    expect(await screen.findByText('Installed model catalog')).toBeInTheDocument();
    expect(screen.getByText('Reported model settings. The active runtime may use a different context window.')).toBeInTheDocument();
    const models = within(screen.getByRole('list', { name: 'Local models' }));
    const alias = within(models.getByTitle('qwen3.8:27b-ctx64k').closest('li')!);
    expect(alias.getByText('Ollama catalog')).toBeInTheDocument();
    expect(alias.getByText('64k of 256k context')).toBeInTheDocument();
    expect(alias.queryByText('Loaded')).not.toBeInTheDocument();
    const regular = within(models.getByTitle('qwen3.8:27b-q8_0').closest('li')!);
    expect(regular.getByText('Ollama catalog')).toBeInTheDocument();
    expect(regular.getByText('256k context')).toBeInTheDocument();
    expect(models.getByText('LM Studio catalog')).toBeInTheDocument();
    expect(models.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText(/64k context per agent · 0 of 4 slots busy$/)).toBeInTheDocument();
    expect(catalog).toEqual(before);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.some(call => /warm|generate|chat\/completions/.test(call.path))).toBe(false);
  });
  it('observes the current clock for independently arriving metadata and subsequent query updates', async () => {
    let clock = NOW;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    let complete!: (response: Response) => void;
    let sampledAt = new Date(NOW + 2000).toISOString();
    const reading = () => json({ sampledAt, ollama: { reachable: true, models: [] }, machine: { totalMemoryBytes: 64 * 1024 ** 3,
      freeMemoryBytes: 32 * 1024 ** 3, cpu: { usedPercent: 15, intervalMs: 30_000 } } });
    installFetch(call => call.path === '/api/verse/local-models'
      ? new Promise<Response>(resolve => { complete = resolve; }) : json({ error: 'unavailable' }, 404));
    render(<ul><LocalResources status={null} onOpenUsage={() => {}} /></ul>);
    clock += 2000;
    await act(async () => { complete(reading()); });
    expect(await screen.findByText('Host CPU · 15% across all cores · 30 s interval · just measured')).toBeInTheDocument();
    // A new child query result, without a parent timer tick or parent rerender.
    clock += 30_000;
    sampledAt = new Date(clock).toISOString();
    await act(async () => {
      const pending = refetchQuery(verseLocalModelsQuery.key, () => verseLocalModelsQuery.fetch());
      complete(reading());
      await pending;
    });
    expect(screen.getByText('Host CPU · 15% across all cores · 30 s interval · just measured')).toBeInTheDocument();
  });
  it('preserves explicit clocks and unknown ages for future or malformed samples', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 2000);
    let sampledAt = new Date(NOW + 1000).toISOString();
    installFetch(call => call.path === '/api/verse/local-models'
      ? json({ sampledAt, ollama: { reachable: true, models: [] }, machine: { cpu: { usedPercent: 15, intervalMs: 30_000 } } })
      : json({ error: 'unavailable' }, 404));
    const view = render(<ul><LocalResources status={null} now={NOW} onOpenUsage={() => {}} /></ul>);
    expect(await screen.findByText('Host CPU · 15% across all cores · 30 s interval · age unavailable')).toBeInTheDocument();
    view.rerender(<ul><LocalResources status={null} onOpenUsage={() => {}} /></ul>);
    expect(screen.getByText('Host CPU · 15% across all cores · 30 s interval · just measured')).toBeInTheDocument();
    for (const value of [new Date(NOW + 3000).toISOString(), 'invalid-time']) {
      sampledAt = value;
      await act(async () => { await refetchQuery(verseLocalModelsQuery.key, () => verseLocalModelsQuery.fetch()); });
      expect(screen.getByText('Host CPU · 15% across all cores · 30 s interval · age unavailable')).toBeInTheDocument();
    }
    // An actual backwards clock remains unknown, never a guessed zero age.
    vi.mocked(Date.now).mockReturnValue(NOW - 1000);
    sampledAt = new Date(NOW).toISOString();
    await act(async () => { await refetchQuery(verseLocalModelsQuery.key, () => verseLocalModelsQuery.fetch()); });
    expect(screen.getByText('Host CPU · 15% across all cores · 30 s interval · age unavailable')).toBeInTheDocument();
  });
  it('reads existing metadata/speed queries without invoking or warming a model', async () => {
    const { calls } = installFetch(call => {
      if (call.path === '/api/verse/local-models') return json({ sampledAt: new Date(NOW).toISOString(),
        machine: { totalMemoryBytes: 64 * 1024 ** 3, freeMemoryBytes: 32 * 1024 ** 3, cpu: { usedPercent: 25, intervalMs: 1000 } },
        ollama: { reachable: true, models: [{ id: 'qwen:27b', state: 'loaded', sizeBytes: 27 * 1024 ** 3 }] } });
      if (call.path === '/api/verse/multimodel/context') return json({ sampledAt: new Date(NOW).toISOString(), learned: {}, roi: {}, localOnly: { on: false, reason: null }, local: [{
        seatId: 'local:main', model: 'qwen:27b', contextWindow: 65536, tokPerSec: 31.234, tokPerSecSource: 'warm', tokPerSecScope: 'warm-decode',
        tokPerSecObservedAt: new Date(NOW).toISOString(), state: 'unknown', private: true, supportsTools: null }] });
      return json({ error: 'unavailable' }, 404);
    });
    render(<ul><LocalResources status={null} now={NOW} onOpenUsage={() => {}} /></ul>);
    expect(await screen.findByText('Host CPU · 25% across all cores · 1 s interval · just measured')).toBeInTheDocument();
    expect(await screen.findByText('31 tok/s · warm-up decode · just measured')).toBeInTheDocument();
    expect(screen.getByText('Model residency · 27 GB reported by Ollama / LM Studio')).toBeInTheDocument();
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET']);
    expect(calls.some(call => /warm|generate|chat\/completions/.test(call.path))).toBe(false);
  });
  it('keeps original local samples visibly historical after independent runtime and metadata failures', async () => {
    let failRuntime = false, failModels = false;
    let sampledAt = new Date(NOW - 120_000).toISOString();
    installFetch(call => {
      if (call.path === '/api/verse/runtime') return failRuntime ? json({ error: 'failed' }, 401) : json({
        kind: 'llama-server', state: 'running', endpoint: '127.0.0.1:8080', model: 'qwen:27b', slotsTotal: 4, slotsBusy: 2,
        contextTokens: 65536, startedAt: null, parallel: { capable: true, refusal: null, slots: 4 }, reason: null, supervised: false, sampledAt });
      if (call.path === '/api/verse/local-models') return failModels ? json({ error: 'failed' }, 401) : json({ sampledAt,
        machine: { totalMemoryBytes: 64 * 1024 ** 3, freeMemoryBytes: 32 * 1024 ** 3, cpu: { usedPercent: 15, intervalMs: 30_000 } },
        ollama: { reachable: true, models: [] } });
      return json({ error: 'unavailable' }, 404);
    });
    const view = render(<ul><LocalResources status={null} now={NOW} onOpenUsage={() => {}} /></ul>);
    expect(await screen.findByText('Runtime observation · 2 min ago')).toBeInTheDocument();
    failRuntime = true;
    await act(async () => { await refetchQuery(servingRuntimeQuery.key, () => servingRuntimeQuery.fetch()); });
    expect(screen.getByText('Last reading · Running')).toBeInTheDocument();
    expect(screen.getByText('Runtime observation · 2 min ago · refresh failed; current state unconfirmed')).toBeInTheDocument();
    expect(screen.getByText('Host CPU · 15% across all cores · 30 s interval · 2 min ago')).toBeInTheDocument();
    expect(screen.queryByText(/Local metadata refresh failed/)).not.toBeInTheDocument();
    failModels = true;
    await act(async () => { await refetchQuery(verseLocalModelsQuery.key, () => verseLocalModelsQuery.fetch()); });
    expect(screen.getByText('Local metadata refresh failed · showing retained observations.')).toBeInTheDocument();
    expect(screen.getByText('Host RAM · 64 GB total · 32 GB OS free · 2 min ago')).toBeInTheDocument();
    failRuntime = false;
    sampledAt = new Date(NOW + 1).toISOString();
    await act(async () => { await refetchQuery(servingRuntimeQuery.key, () => servingRuntimeQuery.fetch()); });
    expect(screen.getByText('Runtime observation · age unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Last reading · Running')).not.toBeInTheDocument();
    view.rerender(<ul><LocalResources status={{ kind: 'usable', label: 'Ready', detail: null, tone: 'success', usableAgain: null, coversConnection: false, checked: null, checkedTitle: null }} readinessRetained now={NOW} onOpenUsage={() => {}} /></ul>);
    expect(screen.getByText('Last readiness')).toBeInTheDocument();
    expect(screen.getByText(/latest refresh failed · current availability unconfirmed$/)).toBeInTheDocument();
  });

  it('makes unavailable speed and RAM honest while older model metadata remains usable', async () => {
    installFetch(call => call.path === '/api/verse/local-models'
      ? json({ reachable: true, models: [{ name: 'qwen:27b', loaded: false, sizeBytes: 27 * 1024 ** 3 }] })
      : json({ error: 'old server' }, 404));
    render(<ul><LocalResources status={null} now={NOW} onOpenUsage={() => {}} /></ul>);
    expect(await screen.findByText('Speed evidence unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Host CPU · not measured yet · age unavailable')).toBeInTheDocument();
    // The installed file's 27GB is not resident memory.
    expect(screen.getByText('Model residency · 0 MB reported by Ollama / LM Studio')).toBeInTheDocument();
  });
});

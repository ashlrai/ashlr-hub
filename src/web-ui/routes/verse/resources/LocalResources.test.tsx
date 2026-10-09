import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll, refetchQuery } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { LocalResources } from './LocalResources.js';
import { verseLocalModelsQuery } from '../usage/usage-queries.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
beforeEach(() => evictAll());
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
describe('local resource metrics wiring', () => {
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

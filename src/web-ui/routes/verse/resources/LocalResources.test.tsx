import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { LocalResources } from './LocalResources.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
beforeEach(() => evictAll());
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
describe('local resource metrics wiring', () => {
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

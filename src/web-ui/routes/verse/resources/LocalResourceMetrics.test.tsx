import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LocalModelBadge } from '../../../../core/verse/multimodel/types.js';
import { buildLocalModelsView } from '../usage/local-model.js';
import { projectLocalModels } from '../usage/usage-contract.js';
import { LocalResourceMetrics } from './LocalResourceMetrics.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const model = { id: 'qwen:27b', state: 'loaded', sizeBytes: 27 * 1024 ** 3, contextLength: 65536 };
function snapshot(extra = {}) {
  return projectLocalModels({ sampledAt: new Date(NOW - 120_000).toISOString(),
    machine: { totalMemoryBytes: 128 * 1024 ** 3, freeMemoryBytes: 45.678 * 1024 ** 3, cpu: { usedPercent: 12.345, intervalMs: 30_456 } },
    ollama: { reachable: true, models: [model] }, ...extra })!;
}
function badge(over: Partial<LocalModelBadge> = {}): LocalModelBadge {
  return { seatId: 'local:qwen-main', model: 'qwen:27b', state: 'unknown', contextWindow: 65536,
    tokPerSec: 41.23456, tokPerSecSource: 'turn', tokPerSecScope: 'turn-end-to-end', tokPerSecObservedAt: new Date(NOW - 7_200_000).toISOString(),
    private: true, supportsTools: null, ...over };
}
describe('local resource metric evidence', () => {
  it('keeps host memory and interval CPU separate from model residency with clean age and precision', () => {
    const snap = snapshot(); render(<LocalResourceMetrics snapshot={snap} view={buildLocalModelsView(snap, NOW)} now={NOW} local={[badge()]} speedAvailable />);
    expect(screen.getByText('Host RAM · 130 GB total · 46 GB OS free · 2 min ago')).toBeInTheDocument();
    expect(screen.getByText('Host CPU · 12% across all cores · 30 s interval · 2 min ago')).toBeInTheDocument();
    expect(screen.getByText('Model residency · 27 GB reported by Ollama / LM Studio')).toBeInTheDocument();
    expect(screen.getByText('41 tok/s · last turn, end to end · 2 h ago')).toBeInTheDocument();
    expect(screen.getByText(/llama-server resident memory is not reported/)).toBeInTheDocument();
  });
  it('keeps older server, unavailable reads and missing CPU distinct from measured zero', () => {
    const snap = snapshot({ machine: { totalMemoryBytes: 128 * 1024 ** 3 }, sampledAt: null });
    render(<LocalResourceMetrics snapshot={snap} view={buildLocalModelsView(snap, NOW)} now={NOW} local={undefined} speedAvailable={false} />);
    expect(screen.getByText(/Host CPU · not measured yet · age unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/OS free · age unavailable/)).toHaveTextContent('— OS free');
    expect(screen.getByText('Speed evidence unavailable.')).toBeInTheDocument();
  });
  it('shows retained and incomplete model residency without inventing llama-server bytes', () => {
    const snap = snapshot({ ollama: { reachable: true, stale: true, staleForMs: 3456, models: [model, { ...model, id: 'other', sizeBytes: null }] } });
    render(<LocalResourceMetrics snapshot={snap} view={buildLocalModelsView(snap, NOW)} now={NOW} local={[]} speedAvailable />);
    expect(screen.getByText('Model residency · unknown · retained reading (3.5 s old)')).toBeInTheDocument();
    expect(screen.getByText('No bound local speed readings.')).toBeInTheDocument();
  });
  it('never transfers speed across equal model names with different seat/context bindings', () => {
    render(<LocalResourceMetrics snapshot={null} view={null} now={NOW} local={[badge(), badge({ seatId: 'local:qwen-other', contextWindow: 32768, tokPerSec: null })]} speedAvailable />);
    expect(screen.getByText(/local:qwen-main · 64k context/)).toBeInTheDocument();
    expect(screen.getByText(/local:qwen-other · 32k context/)).toBeInTheDocument();
    expect(screen.getAllByText('41 tok/s · last turn, end to end · 2 h ago')).toHaveLength(1);
    expect(screen.getByText('speed not measured yet')).toBeInTheDocument();
  });
  it('labels decode separately and declines conflicting identities and invalid measurements', () => {
    render(<LocalResourceMetrics snapshot={null} view={null} now={NOW} local={[badge({ seatId: 'decode', tokPerSecScope: 'warm-decode' }), badge({ seatId: 'invalid', tokPerSec: Infinity }), badge({ seatId: 'collision' }), badge({ seatId: 'collision', contextWindow: 32768 })]} speedAvailable />);
    expect(screen.getByText('41 tok/s · warm-up decode · 2 h ago')).toBeInTheDocument();
    expect(screen.getByText('speed not measured yet')).toBeInTheDocument();
    expect(screen.queryByText(/collision/)).not.toBeInTheDocument();
  });
  it('shows bound recorded turn facts with two significant figures and their own historical age', () => {
    const turn = { scope: 'turn-end-to-end' as const, observedAt: new Date(NOW - 86_400_000).toISOString(), contextWindow: 65_536,
      durationMs: 12_345, inputTokens: 1256, outputTokens: 573, cacheReadTokens: 20, cacheCreationTokens: null };
    render(<LocalResourceMetrics snapshot={null} view={null} now={NOW} local={[badge({ completedTurn: turn, tokPerSecScope: 'warm-decode', tokPerSecObservedAt: new Date(NOW).toISOString() })]} speedAvailable />);
    expect(screen.getByText('41 tok/s · warm-up decode · just measured')).toBeInTheDocument();
    expect(screen.getByText('Recorded turn · 12 s · 1 d ago')).toBeInTheDocument();
    expect(screen.getByText('Tokens · 1,300 input · 570 output · 20 cache read · — cache write')).toBeInTheDocument();
  });
  it('does not invent turn facts for older, differently bound, future or malformed observations', () => {
    const turn = { scope: 'turn-end-to-end' as const, observedAt: new Date(NOW - 1000).toISOString(), contextWindow: 65_536,
      durationMs: 1000, inputTokens: 0, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const readings = [badge({ seatId: 'older' }),
      badge({ seatId: 'context', completedTurn: { ...turn, contextWindow: 32_768 } }),
      badge({ seatId: 'future', completedTurn: { ...turn, observedAt: new Date(NOW + 1000).toISOString() } }),
      badge({ seatId: 'invalid', completedTurn: { ...turn, durationMs: Infinity } }),
      badge({ seatId: 'missing', completedTurn: { ...turn, inputTokens: undefined } as unknown as typeof turn }),
      badge({ seatId: 'negative', completedTurn: { ...turn, cacheReadTokens: -1 } }),
    ];
    render(<LocalResourceMetrics snapshot={null} view={null} now={NOW} local={readings} speedAvailable />);
    expect(screen.getAllByText('Completed-turn details unavailable.')).toHaveLength(readings.length);
    expect(screen.queryByText(/Recorded turn ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tokens ·/)).not.toBeInTheDocument();
  });
  it('rejects invalid CPU percentages and intervals in backward-compatible projection', () => {
    for (const cpu of [{ usedPercent: -1, intervalMs: 100 }, { usedPercent: 101, intervalMs: 100 }, { usedPercent: 20, intervalMs: 0 }, { usedPercent: NaN, intervalMs: 100 }]) {
      expect(snapshot({ machine: { cpu } }).cpu).toBeNull();
    }
    expect(snapshot({ machine: { cpu: { usedPercent: 0, intervalMs: 1000 } } }).cpu).toEqual({ usedPercent: 0, intervalMs: 1000 });
  });
});

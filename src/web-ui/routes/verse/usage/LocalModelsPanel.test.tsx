/**
 * LocalModelsPanel.test.tsx — local capacity, pinned at the three places a
 * convenient rendering would mislead: a retained reading shown as fresh, a
 * model that cannot drive a session shown as quietly as one that can, and an
 * unreported VRAM split drawn as "all GPU".
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocalModelRow, LocalModelsView } from './local-model.js';
import { LocalModelsPanel } from './LocalModelsPanel.js';

function row(over: Partial<LocalModelRow> & { name: string }): LocalModelRow {
  return {
    displayName: over.name,
    nameDetail: null,
    runtime: 'ollama',
    resident: false,
    placement: 'unknown',
    memoryPct: null,
    family: null,
    sizeBytes: null,
    sizeVramBytes: null,
    gpuPct: null,
    expiresInMs: null,
    expiresAtMs: null,
    parameterSize: null,
    quantization: null,
    nativeContext: null,
    configuredContext: null,
    contextTruncated: false,
    tools: 'supported',
    ...over,
  };
}

function view(over: Partial<LocalModelsView> = {}): LocalModelsView {
  const rows = over.rows ?? [row({ name: 'qwen3-coder' })];
  return {
    reachable: true,
    reason: null,
    residentBytes: 0,
    memoryBudgetBytes: 128 * 1024 ** 3,
    memoryUsedPct: 0,
    freeMemoryBytes: 64 * 1024 ** 3,
    runtimes: [],
    notes: [],
    agenticCount: rows.filter((r) => r.tools === 'supported').length,
    nonAgenticCount: rows.filter((r) => r.tools === 'unsupported').length,
    unknownToolCount: rows.filter((r) => r.tools === 'unknown').length,
    ...over,
    rows,
  };
}

describe('LocalModelsPanel — staleness', () => {
  it('says a retained reading is the last known-good one, and how old it is', () => {
    render(
      <LocalModelsPanel
        view={view({
          runtimes: [
            {
              runtime: 'ollama',
              reachable: true,
              reason: 'ollama-tags-timeout',
              stale: true,
              staleForMs: 14_000,
              modelCount: 1,
            },
          ],
        })}
      />,
    );
    expect(screen.getAllByText('last known-good').length).toBeGreaterThan(0);
    expect(screen.getByText(/Local figures are from 14s ago/)).toBeInTheDocument();
    expect(screen.getByText(/didn.t answer in time/)).toBeInTheDocument();
  });

  it('says nothing about staleness when every runtime answered fresh', () => {
    render(<LocalModelsPanel view={view()} />);
    expect(screen.queryByText('last known-good')).not.toBeInTheDocument();
  });
});

describe('LocalModelsPanel — the agentic gate', () => {
  it('marks a model that cannot drive a session, in words', () => {
    render(<LocalModelsPanel view={view({ rows: [row({ name: 'embed-only', tools: 'unsupported' })] })} />);
    expect(screen.getByText('no tools')).toBeInTheDocument();
    expect(
      screen.getByText(/1 of 1 installed models cannot drive an agentic\s+session\./),
    ).toBeInTheDocument();
  });

  /**
   * The filter hides models that CANNOT drive a session. It must keep the ones
   * whose runtime declined to answer: hiding those would turn an unanswered
   * question into a verdict.
   */
  it('hides only the explicit "cannot", never the unreported', () => {
    render(
      <LocalModelsPanel
        view={view({
          rows: [
            row({ name: 'good', tools: 'supported' }),
            row({ name: 'bad', tools: 'unsupported' }),
            row({ name: 'unsaid', tools: 'unknown' }),
          ],
        })}
      />,
    );
    expect(screen.getByText('bad')).toBeInTheDocument();
    return userEvent
      .click(screen.getByRole('button', { name: /Hide models that cannot drive a session/ }))
      .then(() => {
        expect(screen.queryByText('bad')).not.toBeInTheDocument();
        expect(screen.getByText('unsaid')).toBeInTheDocument();
        expect(screen.getByText('good')).toBeInTheDocument();
      });
  });
});

describe('LocalModelsPanel — placement', () => {
  it('draws no placement bar when the runtime reported no VRAM split', () => {
    render(<LocalModelsPanel view={view({ rows: [row({ name: 'x', resident: true, gpuPct: null })] })} />);
    expect(screen.queryByRole('img', { name: /on GPU/ })).not.toBeInTheDocument();
  });

  it('draws the GPU/CPU split with both shares named', () => {
    render(
      <LocalModelsPanel
        view={view({ rows: [row({ name: 'x', resident: true, gpuPct: 62, placement: 'split' })] })}
      />,
    );
    expect(screen.getByRole('img', { name: 'x: 62% of resident bytes on GPU, 38% on CPU' })).toBeInTheDocument();
  });

  it('says "not resident" rather than showing a placement for an installed model', () => {
    render(<LocalModelsPanel view={view({ rows: [row({ name: 'x', resident: false })] })} />);
    expect(screen.getByText('not resident')).toBeInTheDocument();
  });
});

describe('LocalModelsPanel — memory chart', () => {
  it('refuses to chart an idle machine as a set of zero bars', () => {
    render(<LocalModelsPanel view={view({ rows: [row({ name: 'x', resident: false, sizeBytes: 10 })] })} />);
    expect(screen.getByText('No models in memory.')).toBeInTheDocument();
  });
});

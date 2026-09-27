/**
 * chat/SourceList.test.tsx — numbered citations under an answer (V3.15).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { collateSources } from '../../../../core/verse/trace.js';
import type { VerseSource } from '../../../../core/verse/types.js';
import { SourceList, SOURCES_COLLAPSE_AFTER } from './SourceList.js';

const file = (i: number): VerseSource => ({ kind: 'file', ref: `/r/f${i}.ts`, title: `f${i}.ts`, origin: 'tool', path: `/r/f${i}.ts`, toolUseId: `t${i}` });

describe('SourceList', () => {
  it('renders nothing without citations', () => {
    const { container } = render(<SourceList citations={[]} jumpToTool={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('folds past the limit and unfolds on request', async () => {
    const user = userEvent.setup();
    const citations = collateSources(Array.from({ length: SOURCES_COLLAPSE_AFTER + 3 }, (_, i) => file(i)));
    render(<SourceList citations={citations} jumpToTool={() => {}} />);
    expect(screen.getAllByRole('button', { name: /^Source \d+:/ })).toHaveLength(SOURCES_COLLAPSE_AFTER);
    await user.click(screen.getByRole('button', { name: 'Show 3 more sources' }));
    expect(screen.getAllByRole('button', { name: /^Source \d+:/ })).toHaveLength(SOURCES_COLLAPSE_AFTER + 3);
  });

  it('without an editor, a file jumps to the call that read it; a search to the search', async () => {
    const user = userEvent.setup();
    const jumpToTool = vi.fn();
    const citations = collateSources([
      file(1),
      { kind: 'search', ref: 'search:q', title: 'q', origin: 'tool', query: 'q', toolUseId: 'ws' },
    ]);
    render(<SourceList citations={citations} jumpToTool={jumpToTool} />);
    await user.click(screen.getByRole('button', { name: 'Source 1: /r/f1.ts' }));
    await user.click(screen.getByRole('button', { name: 'Source 2: web search for q' }));
    expect(jumpToTool.mock.calls).toEqual([['t1'], ['ws']]);
  });
});

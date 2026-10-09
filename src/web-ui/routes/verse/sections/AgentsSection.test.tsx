import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { installFetch, json } from '../context/context-fixtures.test-support.js';
import { revealAnchor } from '../shell/reveal-anchor.js';
import { AgentsSection } from './AgentsSection.js';
vi.mock('../agents/AgentsBoard.js', () => ({ AgentsBoard: () => <div>Coding board fixture</div> }));
beforeEach(() => { evictAll(); });
afterEach(() => { evictAll(); vi.unstubAllGlobals(); });
describe('agent views', () => {
  it('keeps coding as default without proactive reads, then loads the actual profile view on selection', async () => {
    const { calls } = installFetch(() => json({ schemaVersion: 1, profiles: [] }));
    render(<AgentsSection />);
    expect(screen.getByText('Coding board fixture')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Proactive agents' }));
    await screen.findByText('Bring your persistent agents together');
    expect(calls.map(call => call.path)).toEqual(['/api/verse/proactive-agents']);
    expect(screen.getByRole('radio', { name: 'Proactive agents' })).toHaveAttribute('aria-checked', 'true');
  });
  it('accepts the existing Resources navigation intent before its lazy section mounts', async () => {
    installFetch(() => json({ schemaVersion: 1, profiles: [] }));
    render(<div data-surface="agents"><AgentsSection /></div>);
    await revealAnchor({ section: 'agents', anchor: 'proactive-agents' });
    await screen.findByText('Bring your persistent agents together');
    expect(screen.queryByText('Coding board fixture')).not.toBeInTheDocument();
  });
});

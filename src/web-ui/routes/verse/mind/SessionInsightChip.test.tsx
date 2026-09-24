import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionInsightChip } from './SessionInsightChip.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { getVerseUiState, setVerseSection } from '../verse-ui-store.js';
import { SLOTS } from '../shell/slots.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('SessionInsightChip', () => {
  it('is the export the slot contract names', () => {
    expect(SLOTS['session-insight-chip']).toMatchObject({ path: 'mind/SessionInsightChip.tsx', exportName: 'SessionInsightChip', owner: 'C7' });
  });

  it('shows a quiet chip only when a loop or struggle cites this chat, and opens its detail from the keyboard', async () => {
    stubSurfaceFetch({ kind: 'live' });
    const user = userEvent.setup();
    setVerseSection('chat');
    render(<SessionInsightChip sessionId="s1" />);
    const chip = await screen.findByRole('button', { name: /Reasoning insight for this chat: Ran `npm test` 6 times/ });
    expect(chip).toHaveTextContent('Loops · 6×');
    chip.focus();
    await user.keyboard('{Enter}');
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Insights for this chat' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await user.click(chip);
    await user.click(screen.getByRole('button', { name: 'See it in Mind' }));
    expect(getVerseUiState().section).toBe('mind');
  });

  it('renders nothing for a chat no insight cites, or when the digest is missing', async () => {
    const { fetchMock } = stubSurfaceFetch({ kind: 'live', routes: { '/api/reasoning/digest': null } });
    const { container } = render(<SessionInsightChip sessionId="s1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
    vi.unstubAllGlobals();
    evictAll();
    stubSurfaceFetch({ kind: 'live' });
    const other = render(<SessionInsightChip sessionId="nobody" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(other.container.innerHTML).toBe('');
  });
});

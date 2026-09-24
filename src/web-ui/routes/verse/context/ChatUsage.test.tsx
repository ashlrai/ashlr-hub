/**
 * ChatUsage.test.tsx — the open chat's usage block in the dock's Context pane.
 *
 * Pinned here: the cache-hit share is a whole percent, and a real but tiny
 * share reads "<1%" — never "0%", which would say the cache served nothing
 * while the row above it shows cache reads.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatUsage } from './ChatUsage.js';
import { contextSession, SEATS } from './context-fixtures.test-support.js';

const NOW = Date.parse('2026-09-23T09:31:00.000Z');

function cacheHitCell(): HTMLElement {
  return screen.getByText('Cache hit').closest('div')!.querySelector('dd')!;
}

describe('ChatUsage', () => {
  it('states the cache-hit share as a whole percent', () => {
    // 1.2M read of 1.32M prompt tokens.
    render(<ChatUsage session={contextSession()} seats={SEATS} events={[]} now={NOW} />);
    expect(cacheHitCell()).toHaveTextContent(/^91%$/);
  });

  it('reads a real but tiny cache-hit share as "<1%", not "0%"', () => {
    const session = contextSession({
      usage: {
        ...contextSession().usage,
        inputTokens: 1_000_000,
        cacheReadTokens: 3_000,
        cacheCreationTokens: 0,
      },
    });
    render(<ChatUsage session={session} seats={SEATS} events={[]} now={NOW} />);
    expect(cacheHitCell()).toHaveTextContent(/^<1%$/);
  });

  it('says "none reported" rather than a percentage when the CLI reported no cache figures', () => {
    const session = contextSession({
      usage: { ...contextSession().usage, cacheReadTokens: 0, cacheCreationTokens: 0 },
    });
    render(<ChatUsage session={session} seats={SEATS} events={[]} now={NOW} />);
    expect(cacheHitCell()).toHaveTextContent('none reported');
  });
});

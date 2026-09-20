import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContextMeter, contextTone } from './ContextMeter.js';

describe('ContextMeter', () => {
  it('maps percentages to the 70/90 thresholds', () => {
    expect(contextTone(0)).toBe('ok');
    expect(contextTone(69)).toBe('ok');
    expect(contextTone(70)).toBe('warn');
    expect(contextTone(89)).toBe('warn');
    expect(contextTone(90)).toBe('danger');
    expect(contextTone(100)).toBe('danger');
    expect(contextTone(null)).toBe('unknown');
  });

  it('renders "123k / 200k" with the percent and an ok tone below 70%', () => {
    render(<ContextMeter contextTokens={123_000} contextWindow={200_000} />);
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter).toHaveAttribute('aria-valuenow', '62');
    expect(meter).toHaveAttribute('data-tone', 'ok');
    expect(meter).toHaveTextContent('62%');
    expect(meter).toHaveTextContent('123k / 200k');
  });

  it('turns amber at 70% and red at 90%', () => {
    const { rerender } = render(<ContextMeter contextTokens={140_000} contextWindow={200_000} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'warn');
    rerender(<ContextMeter contextTokens={180_000} contextWindow={200_000} />);
    expect(screen.getByRole('meter')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '90');
  });

  it('shows n/a when the window is unknown', () => {
    render(<ContextMeter contextTokens={5000} contextWindow={null} />);
    const meter = screen.getByRole('meter');
    expect(meter).toHaveAttribute('data-tone', 'unknown');
    expect(meter).not.toHaveAttribute('aria-valuenow');
    expect(meter).toHaveTextContent('n/a');
    expect(meter).toHaveTextContent('5k / n/a');
  });
});

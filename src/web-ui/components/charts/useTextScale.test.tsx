/**
 * useTextScale (V3.10.1 review): the chart label layout budgets widths from
 * the operator's Display size, read the way the app sets it — data-ui-scale
 * on <html>, resolved by design/tokens.css — and follows a change live.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { scopeWith, resolveToken } from '../../design/token-probe.test-support.js';
import { LABEL_CHAR_PX, labelCharPx } from './chart-math.js';
import { clearDisplaySize, setDisplaySize } from './chart-test-support.js';
import { readTextScale, useTextScale } from './useTextScale.js';

function Probe() {
  return <output>{useTextScale()}</output>;
}

describe('useTextScale', () => {
  afterEach(() => {
    clearDisplaySize();
    document.documentElement.style.removeProperty('--ui-text-scale');
  });

  it('reads Default as 1, and each Display size from tokens.css', () => {
    expect(readTextScale()).toBe(1);
    expect(setDisplaySize('large')).toBe(1.125);
    expect(setDisplaySize('xlarge')).toBe(1.25);
    expect(setDisplaySize('default')).toBe(1);
  });

  it('treats an unreadable multiplier as the default rather than collapsing the layout', () => {
    for (const bad of ['0', '-2', 'large', '']) {
      document.documentElement.style.setProperty('--ui-text-scale', bad);
      expect(readTextScale(), JSON.stringify(bad)).toBe(1);
    }
  });

  it('re-renders a mounted chart when the operator changes Display size', async () => {
    render(<Probe />);
    expect(screen.getByRole('status')).toHaveTextContent('1');
    await act(async () => {
      setDisplaySize('xlarge');
      await Promise.resolve(); // MutationObserver callbacks run as microtasks
    });
    expect(screen.getByRole('status')).toHaveTextContent('1.25');
    await act(async () => {
      setDisplaySize('default');
      await Promise.resolve();
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^1$/);
  });

  // The estimate is only honest while --text-xs-size stays 12px × the
  // multiplier: pin that contract at every step, so a retune of the type
  // ramp fails here instead of silently overprinting labels again.
  it.each([
    ['default', []],
    ['large', [':root[data-ui-scale="large"]']],
    ['xlarge', [':root[data-ui-scale="xlarge"]']],
  ])('budgets 0.6 × the rendered --text-xs-size at %s', (_name, selectors) => {
    const scope = scopeWith(selectors);
    const size = Number.parseFloat(resolveToken(scope, '--text-xs-size')!);
    const scale = Number.parseFloat(resolveToken(scope, '--ui-text-scale')!);
    expect(labelCharPx(scale)).toBeCloseTo(0.6 * size, 9);
    expect(LABEL_CHAR_PX).toBeCloseTo(0.6 * 12, 9);
  });
});

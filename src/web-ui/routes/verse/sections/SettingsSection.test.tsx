/**
 * routes/verse/sections/SettingsSection.test.tsx — the Settings surface.
 *
 * The important assertions are not "text appears" but:
 *   - a control CHANGES THE LIVE DESIGN TOKENS (that is the whole feature —
 *     live preview, no save button);
 *   - reset puts every one of them back;
 *   - the panel NEVER renders a token, even when the tab is holding one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsSection } from './SettingsSection.js';
import { LIGHT_SURFACE, DARK_SURFACE, accentReadability } from './AppearancePanel.js';
import { ToastProvider } from '../../../components/primitives/Toast.js';
import { evictAll } from '../../../data/cache.js';
import { resetAppearance, getAppearance } from '../../../data/appearance-store.js';
import { ACCENT_PRESETS } from '../../../data/appearance-presets.js';
import { clearMutationToken, setMutationToken } from '../../../data/auth-store.js';
import { darkScope, lightScope, resolveToken } from '../../../design/token-probe.test-support.js';

const root = () => document.documentElement;

function renderSettings() {
  return render(
    <ToastProvider>
      <SettingsSection />
    </ToastProvider>,
  );
}

describe('SettingsSection', () => {
  beforeEach(() => {
    evictAll();
    localStorage.clear();
    resetAppearance();
    clearMutationToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMutationToken();
    localStorage.clear();
    resetAppearance();
  });

  it('renders the four panels', () => {
    renderSettings();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connection' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Keyboard' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'About' })).toBeInTheDocument();
  });

  it('changes a live design token when the density control is used', async () => {
    const user = userEvent.setup();
    renderSettings();
    expect(root().getAttribute('data-density')).toBe('comfortable');

    const density = screen.getByRole('radiogroup', { name: 'Density' });
    await user.click(within(density).getByRole('radio', { name: 'Compact' }));

    expect(root().getAttribute('data-density')).toBe('compact');
    expect(getAppearance().density).toBe('compact');
  });

  /**
   * The display-size control: reachable by its accessible name, labelled in
   * words rather than multipliers, and LIVE — the whole point is that the app
   * you are looking at is the preview, so a reload must not be part of it.
   */
  it('offers a labelled display-size control with all three steps', () => {
    renderSettings();
    const size = screen.getByRole('radiogroup', { name: 'Display size' });
    expect(within(size).getByRole('radio', { name: 'Default' })).toBeInTheDocument();
    expect(within(size).getByRole('radio', { name: 'Large' })).toBeInTheDocument();
    expect(within(size).getByRole('radio', { name: 'Extra large' })).toBeInTheDocument();
    expect(within(size).getByRole('radio', { name: 'Default' })).toBeChecked();
  });

  it('changes the live root attribute when the display size is used', async () => {
    const user = userEvent.setup();
    renderSettings();
    expect(root().getAttribute('data-ui-scale')).toBe('default');

    const size = screen.getByRole('radiogroup', { name: 'Display size' });
    await user.click(within(size).getByRole('radio', { name: 'Extra large' }));

    expect(root().getAttribute('data-ui-scale')).toBe('xlarge');
    expect(getAppearance().uiScale).toBe('xlarge');
    // Live, with no save step: the control reflects the new state immediately.
    expect(within(size).getByRole('radio', { name: 'Extra large' })).toBeChecked();
  });

  /**
   * Display size sits beside Density, and the two are independent axes. If
   * picking one reset the other the panel would be lying about what it does.
   */
  it('leaves density alone when the display size changes, and vice versa', async () => {
    const user = userEvent.setup();
    renderSettings();

    const density = screen.getByRole('radiogroup', { name: 'Density' });
    await user.click(within(density).getByRole('radio', { name: 'Compact' }));
    const size = screen.getByRole('radiogroup', { name: 'Display size' });
    await user.click(within(size).getByRole('radio', { name: 'Large' }));

    expect(root().getAttribute('data-density')).toBe('compact');
    expect(root().getAttribute('data-ui-scale')).toBe('large');
  });

  it('writes the accent channels as the hue slider moves', () => {
    renderSettings();
    expect(root().style.getPropertyValue('--accent-h')).toBe('245');

    // jsdom does not implement the range widget's own key handling, so drive
    // the input the way the browser would deliver a drag: a change event.
    fireEvent.change(screen.getByRole('slider', { name: 'Hue' }), { target: { value: '300' } });

    expect(root().style.getPropertyValue('--accent-h')).toBe('300');
    expect(getAppearance().accentH).toBe(300);

    fireEvent.change(screen.getByRole('slider', { name: 'Saturation' }), { target: { value: '40' } });
    expect(root().style.getPropertyValue('--accent-s')).toBe('40%');
  });

  it('applies an accent preset to the document', async () => {
    const user = userEvent.setup();
    renderSettings();
    const teal = ACCENT_PRESETS.find((p) => p.id === 'teal')!;

    await user.click(screen.getByRole('radio', { name: teal.label }));

    expect(root().style.getPropertyValue('--accent-h')).toBe(String(teal.h));
    expect(root().style.getPropertyValue('--accent-s')).toBe(`${teal.s}%`);
  });

  it('switches the display font and the radius scale', async () => {
    const user = userEvent.setup();
    renderSettings();

    const fonts = screen.getByRole('radiogroup', { name: 'Display font' });
    await user.click(within(fonts).getByRole('radio', { name: 'Mono' }));
    expect(root().style.getPropertyValue('--font-display')).toBe('var(--font-mono)');

    const radii = screen.getByRole('radiogroup', { name: 'Corner radius' });
    await user.click(within(radii).getByRole('radio', { name: 'Sharp' }));
    expect(root().getAttribute('data-radius')).toBe('sharp');
  });

  it('toggles reduce motion through the switch', async () => {
    const user = userEvent.setup();
    renderSettings();
    const motion = screen.getByRole('switch', { name: 'Reduce motion' });
    const before = motion.getAttribute('aria-checked');

    await user.click(motion);

    expect(motion.getAttribute('aria-checked')).not.toBe(before);
    expect(root().getAttribute('data-motion')).toBe(
      motion.getAttribute('aria-checked') === 'true' ? 'reduce' : 'full',
    );
  });

  it('restores every token with reset to defaults', async () => {
    const user = userEvent.setup();
    renderSettings();

    const density = screen.getByRole('radiogroup', { name: 'Density' });
    await user.click(within(density).getByRole('radio', { name: 'Compact' }));
    const radii = screen.getByRole('radiogroup', { name: 'Corner radius' });
    await user.click(within(radii).getByRole('radio', { name: 'Soft' }));

    const reset = screen.getByRole('button', { name: /reset to defaults/i });
    expect(reset).toBeEnabled();
    await user.click(reset);

    expect(root().getAttribute('data-density')).toBe('comfortable');
    expect(root().getAttribute('data-radius')).toBe('default');
    expect(root().style.getPropertyValue('--accent-h')).toBe('245');
    expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeDisabled();
  });

  it('never renders the mutation token, even while a hold is active', () => {
    const secret = 'f'.repeat(64);
    setMutationToken(secret);
    const { container } = renderSettings();

    expect(container.textContent ?? '').not.toContain(secret);
    expect(container.innerHTML).not.toContain(secret);
    // It reports the STATE of the hold instead.
    expect(screen.getByText(/unlocked for/i)).toBeInTheDocument();
  });

  it('shows the server origin and the disconnect confirmation', async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByLabelText('Server address')).toHaveValue(window.location.origin);

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/disconnect from this server/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the hub version in About', () => {
    renderSettings();
    expect(screen.getByText(/^v\d+\.\d+\.\d+/)).toBeInTheDocument();
  });
});

describe('accent readability warning', () => {
  it('scores against the surfaces the stylesheet actually paints', () => {
    // If a token retune moves --bg-surface, these constants (and therefore
    // the warning) would silently score the wrong background.
    expect(resolveToken(lightScope(), '--bg-surface')).toBe(LIGHT_SURFACE);
    expect(resolveToken(darkScope(), '--bg-surface')).toBe(DARK_SURFACE);
  });

  it('passes the shipped presets and flags an unreadable hue', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(accentReadability(preset.h, preset.s, preset.l).failing).toEqual([]);
    }
    // Very light accent: fine on near-black, unreadable as link text on white.
    expect(accentReadability(55, 90, 78).failing).toContain('light');
  });
});

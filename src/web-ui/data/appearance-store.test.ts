/**
 * data/appearance-store.test.ts — the appearance store's four contracts:
 * it APPLIES (writes real custom properties/attributes on <html>), it
 * PERSISTS (one key, coerced on read), it RESETS, and it SURVIVES a
 * localStorage that throws — which is not hypothetical: Safari private mode
 * and a locked-down Tauri webview both do exactly that.
 *
 * Module-load behavior (apply-before-first-paint, the reduced-motion
 * default) is tested with `vi.resetModules()` + a fresh dynamic import,
 * since it happens once per module instance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCENT_PRESETS,
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  defaultAppearance,
  getAppearance,
  isDefaultAppearance,
  matchingAccentPreset,
  resetAppearance,
  setAppearance,
  subscribeAppearance,
} from './appearance-store.js';

const root = () => document.documentElement;

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('appearance-store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAppearance();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    resetAppearance();
  });

  it('applies defaults to the document element', () => {
    expect(root().getAttribute('data-density')).toBe('comfortable');
    expect(root().getAttribute('data-radius')).toBe('default');
    expect(root().style.getPropertyValue('--accent-h')).toBe('245');
    expect(root().style.getPropertyValue('--accent-s')).toBe('72%');
    expect(root().style.getPropertyValue('--accent-l')).toBe('58%');
    // grotesk is the token default, so no inline override is written.
    expect(root().style.getPropertyValue('--font-display')).toBe('');
  });

  it('writes the accent as the three raw channels tokens.css derives from', () => {
    setAppearance({ accentH: 190, accentS: 80, accentL: 40 });
    expect(root().style.getPropertyValue('--accent-h')).toBe('190');
    expect(root().style.getPropertyValue('--accent-s')).toBe('80%');
    expect(root().style.getPropertyValue('--accent-l')).toBe('40%');
  });

  it('maps density, radius, motion and display font onto the document', () => {
    setAppearance({ density: 'compact', radius: 'sharp', reduceMotion: true, displayFont: 'mono' });
    expect(root().getAttribute('data-density')).toBe('compact');
    expect(root().getAttribute('data-radius')).toBe('sharp');
    expect(root().getAttribute('data-motion')).toBe('reduce');
    expect(root().style.getPropertyValue('--font-display')).toBe('var(--font-mono)');

    setAppearance({ displayFont: 'grotesk', reduceMotion: false });
    expect(root().style.getPropertyValue('--font-display')).toBe('');
    // "full" is an explicit opt-out of the OS preference, not a no-op.
    expect(root().getAttribute('data-motion')).toBe('full');
  });

  it('delegates the theme to theme-store rather than writing data-theme itself', () => {
    setAppearance({ theme: 'dark' });
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(getAppearance().theme).toBe('dark');
    // theme-store owns its key; the appearance blob must not duplicate it.
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored).not.toHaveProperty('theme');
    expect(localStorage.getItem('ashlr.theme.v1')).toBe('dark');
  });

  it('persists under one key and reloads coerced values', async () => {
    setAppearance({ density: 'compact', accentH: 400, accentS: 999, accentL: 5 });
    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored.density).toBe('compact');
    // 400deg wraps, saturation clamps to 100, lightness clamps into the
    // readable band instead of producing a black "accent".
    expect(stored.accentH).toBe(40);
    expect(stored.accentS).toBe(100);
    expect(stored.accentL).toBe(30);

    vi.resetModules();
    const fresh = await import('./appearance-store.js');
    expect(fresh.getAppearance().density).toBe('compact');
    expect(fresh.getAppearance().accentH).toBe(40);
  });

  it('ignores a corrupt or hostile stored payload', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, '{"density":"enormous","radius":42,"accentH":"nope"}');
    vi.resetModules();
    const fresh = await import('./appearance-store.js');
    const value = fresh.getAppearance();
    expect(value.density).toBe('comfortable');
    expect(value.radius).toBe('default');
    expect(value.accentH).toBe(245);
  });

  it('notifies subscribers with a new snapshot object each change', () => {
    const seen: number[] = [];
    const before = getAppearance();
    const unsubscribe = subscribeAppearance(() => seen.push(getAppearance().accentH));
    setAppearance({ accentH: 100 });
    expect(seen).toEqual([100]);
    // useSyncExternalStore compares with Object.is — a mutated snapshot would
    // leave the UI stale.
    expect(getAppearance()).not.toBe(before);
    unsubscribe();
    setAppearance({ accentH: 120 });
    expect(seen).toEqual([100]);
  });

  it('resets everything, including the theme and the stored blob', () => {
    setAppearance({ theme: 'light', density: 'compact', radius: 'soft', accentH: 12 });
    expect(isDefaultAppearance()).toBe(false);

    resetAppearance();

    expect(getAppearance()).toEqual(defaultAppearance());
    expect(isDefaultAppearance()).toBe(true);
    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    expect(root().getAttribute('data-theme')).toBeNull();
    expect(root().getAttribute('data-density')).toBe('comfortable');
  });

  it('recognizes the accent presets', () => {
    expect(matchingAccentPreset()).toEqual(ACCENT_PRESETS[0]);
    const teal = ACCENT_PRESETS.find((p) => p.id === 'teal')!;
    setAppearance({ accentH: teal.h, accentS: teal.s, accentL: teal.l });
    expect(matchingAccentPreset()?.id).toBe('teal');
    setAppearance({ accentH: teal.h + 3 });
    expect(matchingAccentPreset()).toBeNull();
  });

  it('defaults reduce-motion to the prefers-reduced-motion media query', async () => {
    stubMatchMedia(true);
    vi.resetModules();
    const reduced = await import('./appearance-store.js');
    expect(reduced.defaultAppearance().reduceMotion).toBe(true);
    expect(reduced.getAppearance().reduceMotion).toBe(true);
    // No attribute is stamped for the default: the media queries already say
    // "reduce", and writing data-motion="reduce" here would be indistinguishable
    // from an explicit operator choice the next time the OS preference changed.
    expect(root().hasAttribute('data-motion')).toBe(false);

    stubMatchMedia(false);
    vi.resetModules();
    const full = await import('./appearance-store.js');
    expect(full.getAppearance().reduceMotion).toBe(false);
  });

  // A stored blob with no explicit `motion` is NOT a motion choice: persist()
  // writes the whole snapshot whenever the accent, density, display font or
  // radius changes, so a bare `reduceMotion: false` only records that the
  // operator once dragged a hue slider. It must not outrank the OS.
  it('ignores a legacy stored reduceMotion and follows the media query', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ reduceMotion: false, accentH: 200 }));
    stubMatchMedia(true);
    vi.resetModules();
    const fresh = await import('./appearance-store.js');
    expect(fresh.getAppearance().motion).toBe('system');
    expect(fresh.getAppearance().reduceMotion).toBe(true);
    // No attribute at all, so :root:not([data-motion="full"]) still matches.
    expect(root().hasAttribute('data-motion')).toBe(false);
  });

  it('keeps an EXPLICIT motion choice over the media query, in both directions', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ motion: 'full' }));
    stubMatchMedia(true);
    vi.resetModules();
    const full = await import('./appearance-store.js');
    expect(full.getAppearance().reduceMotion).toBe(false);
    expect(root().getAttribute('data-motion')).toBe('full');

    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ motion: 'reduce' }));
    stubMatchMedia(false);
    vi.resetModules();
    const reduced = await import('./appearance-store.js');
    expect(reduced.getAppearance().reduceMotion).toBe(true);
    expect(root().getAttribute('data-motion')).toBe('reduce');
  });

  it('turns the Settings switch into a stored motion choice, and nothing else does', async () => {
    stubMatchMedia(true);
    vi.resetModules();
    const fresh = await import('./appearance-store.js');

    // An unrelated appearance change must not write a motion choice.
    fresh.setAppearance({ accentH: 120 });
    expect(fresh.getAppearance().motion).toBe('system');
    expect(fresh.getAppearance().reduceMotion).toBe(true);

    // The switch does.
    fresh.setAppearance({ reduceMotion: false });
    expect(fresh.getAppearance().motion).toBe('full');
    expect(root().getAttribute('data-motion')).toBe('full');

    const stored = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    expect(stored['motion']).toBe('full');
    expect(stored).not.toHaveProperty('reduceMotion');
  });

  it('survives a localStorage that throws on read and on write', async () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);

    vi.resetModules();
    const fresh = await import('./appearance-store.js');
    expect(fresh.getAppearance()).toEqual(fresh.defaultAppearance());

    expect(() => fresh.setAppearance({ density: 'compact' })).not.toThrow();
    expect(fresh.getAppearance().density).toBe('compact');
    expect(root().getAttribute('data-density')).toBe('compact');
    expect(() => fresh.resetAppearance()).not.toThrow();

    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it('applyAppearance is a pure DOM write usable for previews', () => {
    applyAppearance({ ...defaultAppearance(), accentH: 300, density: 'compact' });
    expect(root().style.getPropertyValue('--accent-h')).toBe('300');
    expect(root().getAttribute('data-density')).toBe('compact');
    // …and it did not touch the persisted snapshot.
    expect(getAppearance().accentH).toBe(245);
  });
});

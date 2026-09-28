/**
 * Which app a path gets, and when /verse becomes the phone app on its own:
 * a coarse pointer on a narrow screen, never inside the desktop wrapper, and
 * never against the device's explicit choice.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  autoSelectVerseMobile,
  isScopedConsolePath,
  isVerseConsolePath,
  isVerseMobilePath,
  prefersVerseMobile,
  readVerseLayoutPreference,
  VERSE_LAYOUT_STORAGE_KEY,
  VERSE_MOBILE_MEDIA_QUERY,
  VERSE_MOBILE_PATH,
  writeVerseLayoutPreference,
} from './console-mode.js';

function fakeWindow(opts: { pathname?: string; phone?: boolean; tokens?: boolean; matchMedia?: boolean } = {}) {
  const queries: string[] = [];
  let pathname = opts.pathname ?? '/verse';
  const win = {
    location: {
      get pathname() {
        return pathname;
      },
    },
    history: {
      state: { keep: 1 },
      replaceState: (_s: unknown, _t: string, url: string) => {
        pathname = url;
      },
    },
    ...(opts.tokens ? { __ASHLR_TOKENS__: { readToken: 'x' } } : {}),
    ...(opts.matchMedia === false
      ? {}
      : {
          matchMedia: (q: string) => {
            queries.push(q);
            return { matches: opts.phone === true } as MediaQueryList;
          },
        }),
  } as unknown as Window;
  return { win, queries, path: () => pathname };
}

afterEach(() => {
  window.localStorage.clear();
});

describe('console paths', () => {
  it('knows the phone path with and without its slash, and keeps it scoped', () => {
    expect(VERSE_MOBILE_PATH).toBe('/verse/m/');
    expect(isVerseMobilePath('/verse/m')).toBe(true);
    expect(isVerseMobilePath('/verse/m/')).toBe(true);
    expect(isVerseMobilePath('/verse/mobile')).toBe(false);
    expect(isVerseMobilePath('/verse')).toBe(false);
    expect(isVerseConsolePath('/verse/m/')).toBe(false);
    // The phone app never opens the general Hub observer channel either.
    expect(isScopedConsolePath('/verse/m/')).toBe(true);
    expect(isScopedConsolePath('/')).toBe(false);
  });
});

describe('prefersVerseMobile', () => {
  it('asks for a coarse pointer on a narrow screen (portrait or landscape)', () => {
    const phone = fakeWindow({ phone: true });
    expect(prefersVerseMobile(phone.win)).toBe(true);
    expect(phone.queries).toEqual([VERSE_MOBILE_MEDIA_QUERY]);
    expect(VERSE_MOBILE_MEDIA_QUERY).toContain('(pointer: coarse)');
    expect(VERSE_MOBILE_MEDIA_QUERY).toContain('max-width: 767.98px');
    expect(VERSE_MOBILE_MEDIA_QUERY).toContain('max-height: 499.98px');
    expect(prefersVerseMobile(fakeWindow({ phone: false }).win)).toBe(false);
  });

  it('never inside the desktop wrapper, which hands the page its tokens', () => {
    expect(prefersVerseMobile(fakeWindow({ phone: true, tokens: true }).win)).toBe(false);
  });

  it('without matchMedia (old webviews) stays on the workbench', () => {
    expect(prefersVerseMobile(fakeWindow({ matchMedia: false }).win)).toBe(false);
  });

  it("follows the device's explicit choice over the media query", () => {
    writeVerseLayoutPreference('desktop');
    expect(readVerseLayoutPreference()).toBe('desktop');
    expect(prefersVerseMobile(fakeWindow({ phone: true }).win)).toBe(false);
    writeVerseLayoutPreference('mobile');
    expect(prefersVerseMobile(fakeWindow({ phone: false }).win)).toBe(true);
    writeVerseLayoutPreference('auto');
    expect(window.localStorage.getItem(VERSE_LAYOUT_STORAGE_KEY)).toBeNull();
    expect(readVerseLayoutPreference()).toBe('auto');
  });

  it('ignores a garbage stored value', () => {
    window.localStorage.setItem(VERSE_LAYOUT_STORAGE_KEY, 'tablet');
    expect(readVerseLayoutPreference()).toBe('auto');
  });
});

describe('autoSelectVerseMobile', () => {
  it('moves /verse to /verse/m/ in place on a phone, keeping history state', () => {
    const phone = fakeWindow({ pathname: '/verse', phone: true });
    expect(autoSelectVerseMobile(phone.win)).toBe(true);
    expect(phone.path()).toBe('/verse/m/');
  });

  it('leaves a desktop, the wrapper and other paths alone', () => {
    const desktop = fakeWindow({ pathname: '/verse/', phone: false });
    expect(autoSelectVerseMobile(desktop.win)).toBe(false);
    expect(desktop.path()).toBe('/verse/');
    const wrapper = fakeWindow({ pathname: '/verse', phone: true, tokens: true });
    expect(autoSelectVerseMobile(wrapper.win)).toBe(false);
    const universe = fakeWindow({ pathname: '/universe', phone: true });
    expect(autoSelectVerseMobile(universe.win)).toBe(false);
    expect(universe.path()).toBe('/universe');
  });
});

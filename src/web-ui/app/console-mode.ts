/** Scope is selected by a dedicated server-owned path, never a query argument. */
export function isUniverseConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/universe/' || pathname === '/universe';
}

export function isResourceConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/resources/' || pathname === '/resources';
}

/** Ashlr Verse: the interactive chat console (src/web-ui/routes/verse). */
export function isVerseConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/verse/' || pathname === '/verse';
}

/**
 * Verse on a phone (src/web-ui/routes/verse/mobile). The trailing slash is
 * canonical: the service worker's scope is `/verse/m/`, and a scope only
 * covers paths that START with it, so `/verse/m` is moved to `/verse/m/` on
 * load (VerseMobileApp) to be controlled offline.
 */
export const VERSE_MOBILE_PATH = '/verse/m/';

export function isVerseMobilePath(pathname = window.location.pathname): boolean {
  return pathname === '/verse/m/' || pathname === '/verse/m';
}

/** No scoped console subscribes to the general Hub observer channel — Verse
 * opens its own per-session streams (routes/verse/verse-events.ts). */
export function isScopedConsolePath(pathname = window.location.pathname): boolean {
  return isUniverseConsolePath(pathname) || isResourceConsolePath(pathname) || isVerseConsolePath(pathname) || isVerseMobilePath(pathname);
}

// ---------------------------------------------------------------------------
// Which Verse a device gets: the workbench or the phone app
// ---------------------------------------------------------------------------

/**
 * The device's own choice, set from the phone app's More screen ("Use the
 * desktop layout"). Layout state only — never a secret — which is why it may
 * live in localStorage like the theme does.
 */
export const VERSE_LAYOUT_STORAGE_KEY = 'ashlr.verse.layout.v1';
export type VerseLayoutPreference = 'auto' | 'desktop' | 'mobile';

export function readVerseLayoutPreference(): VerseLayoutPreference {
  try {
    const raw = window.localStorage.getItem(VERSE_LAYOUT_STORAGE_KEY);
    return raw === 'desktop' || raw === 'mobile' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeVerseLayoutPreference(pref: VerseLayoutPreference): void {
  try {
    if (pref === 'auto') window.localStorage.removeItem(VERSE_LAYOUT_STORAGE_KEY);
    else window.localStorage.setItem(VERSE_LAYOUT_STORAGE_KEY, pref);
  } catch {
    /* storage unavailable: the choice lasts this page only */
  }
}

/**
 * A phone: a coarse pointer on a narrow screen, portrait (< 768 wide) or
 * landscape (< 500 tall). Both halves, so a narrow desktop window (fine
 * pointer) keeps the workbench, and so does a tablet in either orientation
 * (the workbench has its own medium layout for it).
 */
export const VERSE_MOBILE_MEDIA_QUERY = '(pointer: coarse) and (max-width: 767.98px), (pointer: coarse) and (max-height: 499.98px)';

/**
 * Whether /verse should open as the phone app on this device. Never inside
 * the desktop wrapper (it hands the page its tokens before anything runs:
 * that page IS the Mac). An explicit choice beats the media query.
 */
export function prefersVerseMobile(win: Window = window): boolean {
  if (win.__ASHLR_TOKENS__ !== undefined) return false;
  const pref = readVerseLayoutPreference();
  if (pref !== 'auto') return pref === 'mobile';
  if (typeof win.matchMedia !== 'function') return false;
  return win.matchMedia(VERSE_MOBILE_MEDIA_QUERY).matches;
}

/**
 * On `/verse` from a phone: become `/verse/m/` in place — no reload, no
 * second request, the same read session. Returns true when it switched. The
 * workbench's hash deep links name desktop surfaces, so they are dropped.
 */
export function autoSelectVerseMobile(win: Window = window): boolean {
  if (!isVerseConsolePath(win.location.pathname) || !prefersVerseMobile(win)) return false;
  try {
    win.history.replaceState(win.history.state, '', VERSE_MOBILE_PATH);
  } catch {
    return false;
  }
  return true;
}

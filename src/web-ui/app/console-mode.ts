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

/** No scoped console subscribes to the general Hub observer channel — Verse
 * opens its own per-session streams (routes/verse/verse-events.ts). */
export function isScopedConsolePath(pathname = window.location.pathname): boolean {
  return isUniverseConsolePath(pathname) || isResourceConsolePath(pathname) || isVerseConsolePath(pathname);
}

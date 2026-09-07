/** Scope is selected by a dedicated server-owned path, never a query argument. */
export function isUniverseConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/universe/' || pathname === '/universe';
}

export function isResourceConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/resources/' || pathname === '/resources';
}

/** Neither scoped console subscribes to the general Hub observer channel. */
export function isScopedConsolePath(pathname = window.location.pathname): boolean {
  return isUniverseConsolePath(pathname) || isResourceConsolePath(pathname);
}

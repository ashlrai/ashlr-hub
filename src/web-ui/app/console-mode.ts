/** Scope is selected by a dedicated server-owned path, never a query argument. */
export function isUniverseConsolePath(pathname = window.location.pathname): boolean {
  return pathname === '/universe/' || pathname === '/universe';
}

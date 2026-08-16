/**
 * app/routes.tsx — the route table. Driven by NAV_GROUPS
 * (app/nav-config.ts) so every nav leaf resolves to *something* real:
 * FleetDashboardView for the one implemented leaf, PlaceholderView for
 * everything else. Two illustrative param routes (/work/runs/:id,
 * /work/swarms/:id) exist to prove deep-linking with a resource id works
 * end-to-end even before those views are built — that's the pattern a view
 * agent follows: add the real component, delete the placeholder route.
 *
 * ROUTING STRATEGY — hash-based (react-router-dom's HashRouter), on
 * purpose: src/core/web/static.ts (which this foundation must not modify)
 * only special-cases the literal "/" to resolve to index.html; every other
 * path is resolved as a literal file and 404s if it doesn't exist. A
 * pushState router would 404 on refresh or on a pasted deep link for any
 * route but "/". Hash routing sidesteps this entirely — the hash never
 * reaches the server — while still giving real hierarchical, bookmarkable,
 * shareable URLs (`#/work/runs/r_123`), which is what the foundation brief
 * actually asked for ("real client-side routing with deep links, not just
 * hash-to-view"). See DESIGN.md "Routing" for the full rationale and what
 * changes here once the legacy app is retired and server.ts gains a real
 * SPA catch-all.
 */
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Shell } from '../components/layout/Shell.js';
import { PlaceholderView } from '../routes/PlaceholderView.js';
import { FleetDashboardView } from '../routes/fleet-dashboard/FleetDashboardView.js';
import { NAV_GROUPS, ALL_NAV_LEAVES } from './nav-config.js';

function ResourceDetailPlaceholder({ kind }: { kind: string }) {
  const params = useParams();
  const id = Object.values(params)[0] ?? '(unknown)';
  return (
    <PlaceholderView
      title={`${kind} ${id}`}
      description={`Deep link resolved correctly for ${kind.toLowerCase()} id "${id}". The detail view itself isn't built yet.`}
    />
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/overview" replace />} />
        {ALL_NAV_LEAVES.map((leaf) =>
          leaf.implemented ? null : (
            <Route
              key={leaf.path}
              path={leaf.path}
              element={<PlaceholderView title={leaf.label} description={leaf.description} />}
            />
          ),
        )}
        <Route path="/overview" element={<FleetDashboardView />} />
        <Route path="/work/runs/:id" element={<ResourceDetailPlaceholder kind="Run" />} />
        <Route path="/work/swarms/:id" element={<ResourceDetailPlaceholder kind="Swarm" />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}

// Referenced by tests / DESIGN.md to assert every group's leaves round-trip
// through this route table without a manual re-listing.
export { NAV_GROUPS };

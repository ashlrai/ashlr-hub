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
import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from '../components/layout/Shell.js';
import { PlaceholderView } from '../routes/PlaceholderView.js';
import { FleetDashboardView } from '../routes/fleet-dashboard/FleetDashboardView.js';
import { JournalView } from '../routes/journal/JournalView.js';
import { PulseView } from '../routes/intelligence/pulse/PulseView.js';
import { GenomeView } from '../routes/intelligence/genome/GenomeView.js';
import { ProductionView } from '../routes/intelligence/production/ProductionView.js';
import { PortfolioView } from '../routes/portfolio/PortfolioView.js';
import { RunsView } from '../routes/work/runs/RunsView.js';
import { RunDetailView } from '../routes/work/runs/RunDetailView.js';
import { SwarmsView } from '../routes/work/swarms/SwarmsView.js';
import { SwarmDetailView } from '../routes/work/swarms/SwarmDetailView.js';
import { DaemonView } from '../routes/control/daemon/DaemonView.js';
import { FleetView } from '../routes/control/fleet/FleetView.js';
import { SecurityView } from '../routes/control/security/SecurityView.js';
import { GoalsView } from '../routes/goals/GoalsView.js';
import { InboxView } from '../routes/inbox/InboxView.js';
import { AgentOsView } from '../routes/agent-os/AgentOsView.js';
import { UniverseView } from '../routes/universe/UniverseView.js';
import { NAV_GROUPS, ALL_NAV_LEAVES } from './nav-config.js';

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
        <Route path="/agent-os" element={<AgentOsView />} />
        <Route path="/universe" element={<UniverseView />} />
        <Route path="/journal" element={<JournalView />} />
        <Route path="/intelligence/pulse" element={<PulseView />} />
        <Route path="/intelligence/genome" element={<GenomeView />} />
        <Route path="/intelligence/production" element={<ProductionView />} />
        <Route path="/portfolio" element={<PortfolioView />} />
        <Route path="/work/runs" element={<RunsView />} />
        <Route path="/work/runs/:id" element={<RunDetailView />} />
        <Route path="/work/swarms" element={<SwarmsView />} />
        <Route path="/work/swarms/:id" element={<SwarmDetailView />} />
        <Route path="/control/daemon" element={<DaemonView />} />
        <Route path="/control/fleet" element={<FleetView />} />
        <Route path="/control/security" element={<SecurityView />} />
        <Route path="/goals" element={<GoalsView />} />
        <Route path="/inbox" element={<InboxView />} />
        <Route path="/inbox/:id" element={<InboxView />} />
        <Route path="*" element={<Navigate to="/overview" replace />} />
      </Route>
    </Routes>
  );
}

// Referenced by tests / DESIGN.md to assert every group's leaves round-trip
// through this route table without a manual re-listing.
export { NAV_GROUPS };

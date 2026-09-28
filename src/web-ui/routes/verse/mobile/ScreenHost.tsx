/**
 * routes/verse/mobile/ScreenHost.tsx — every screen but Home, each its own
 * chunk. The host itself is off the first paint too (MobileShell preloads
 * it), so the first paint does not even carry these imports' preload lists.
 */
import { lazy } from 'react';
import type { MobileRoute } from './mobile-router.js';

// Literal dynamic imports: each screen is its own chunk.
const importAgents = () => import('./screens/AgentsScreen.js');
const importAgentDetail = () => import('./screens/AgentDetailScreen.js');
const importNewAgent = () => import('./screens/NewAgentScreen.js');
const importNeedsYou = () => import('./screens/NeedsYouScreen.js');
const importLeader = () => import('./screens/LeaderScreen.js');
const importFleet = () => import('./screens/FleetScreen.js');
const importMore = () => import('./screens/MoreScreen.js');

const AgentsScreen = lazy(() => importAgents().then((m) => ({ default: m.AgentsScreen })));
const AgentDetailScreen = lazy(() => importAgentDetail().then((m) => ({ default: m.AgentDetailScreen })));
const NewAgentScreen = lazy(() => importNewAgent().then((m) => ({ default: m.NewAgentScreen })));
const NeedsYouScreen = lazy(() => importNeedsYou().then((m) => ({ default: m.NeedsYouScreen })));
const LeaderScreen = lazy(() => importLeader().then((m) => ({ default: m.LeaderScreen })));
const FleetScreen = lazy(() => importFleet().then((m) => ({ default: m.FleetScreen })));
const MoreScreen = lazy(() => importMore().then((m) => ({ default: m.MoreScreen })));

/** Most-visited first: Needs you and Agents are what a phone is opened for. */
const SCREEN_IMPORTS = [importNeedsYou, importAgents, importAgentDetail, importLeader, importNewAgent, importFleet, importMore];

/** Warm every screen chunk (the shell calls this once the phone is idle); failures are the mount's to report. */
export function prefetchMobileScreens(): void {
  for (const load of SCREEN_IMPORTS) void load().catch(() => undefined);
}

export function ScreenHost({ route }: { route: Exclude<MobileRoute, { screen: 'home' }> }) {
  switch (route.screen) {
    case 'agents':
      return <AgentsScreen />;
    case 'agent':
      return <AgentDetailScreen key={route.id} sessionId={route.id} pane={route.pane} />;
    case 'new':
      return <NewAgentScreen />;
    case 'needs':
      return <NeedsYouScreen />;
    case 'leader':
      return <LeaderScreen />;
    case 'fleet':
      return <FleetScreen />;
    case 'more':
      return <MoreScreen />;
  }
}

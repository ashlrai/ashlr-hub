import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { isResourceConsolePath, isUniverseConsolePath } from './app/console-mode.js';

// The scoped console must not evaluate the general shell's observer modules.
const App = lazy(() => {
  if (isResourceConsolePath()) return import('./app/ResourcePoolConsoleApp.js').then((module) => ({ default: module.ResourcePoolConsoleApp }));
  if (isUniverseConsolePath()) return import('./app/UniverseConsoleApp.js').then((module) => ({ default: module.UniverseConsoleApp }));
  return import('./app/App.js').then((module) => ({ default: module.App }));
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<p role="status">Loading Ashlr…</p>}><App /></Suspense>
  </StrictMode>,
);

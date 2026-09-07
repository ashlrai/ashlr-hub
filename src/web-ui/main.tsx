import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { isUniverseConsolePath } from './app/console-mode.js';

// The scoped console must not evaluate the general shell's observer modules.
const App = lazy(() => isUniverseConsolePath()
  ? import('./app/UniverseConsoleApp.js').then((module) => ({ default: module.UniverseConsoleApp }))
  : import('./app/App.js').then((module) => ({ default: module.App })));

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<p role="status">Loading Ashlr…</p>}><App /></Suspense>
  </StrictMode>,
);

import { PRODUCT_NAME } from './app/product-brand.js';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { autoSelectVerseMobile, isResourceConsolePath, isUniverseConsolePath, isVerseConsolePath, isVerseMobilePath } from './app/console-mode.js';
import './data/appearance-boot.js';

// The scoped console must not evaluate the general shell's observer modules.
// Verse on a phone is its own chunk: /verse/m, or /verse opened on a phone
// (which becomes /verse/m/ in place). The workbench's modules never load there.
const App = lazy(() => {
  if (isResourceConsolePath()) return import('./app/ResourcePoolConsoleApp.js').then((module) => ({ default: module.ResourcePoolConsoleApp }));
  if (isUniverseConsolePath()) return import('./app/UniverseConsoleApp.js').then((module) => ({ default: module.UniverseConsoleApp }));
  if (isVerseMobilePath() || autoSelectVerseMobile()) return import('./app/VerseMobileApp.js').then((module) => ({ default: module.VerseMobileApp }));
  if (isVerseConsolePath()) return import('./app/VerseConsoleApp.js').then((module) => ({ default: module.VerseConsoleApp }));
  return import('./app/App.js').then((module) => ({ default: module.App }));
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <Suspense fallback={<p role="status">{`Loading ${PRODUCT_NAME}…`}</p>}><App /></Suspense>
  </StrictMode>,
);

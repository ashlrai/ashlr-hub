/**
 * routes/verse/panes/index.ts — the pane system's entry: the registry API,
 * the first-party panes, and every other unit's panes, DISCOVERED.
 *
 * DISCOVERY. Any file named `*.pane.ts` / `*.pane.tsx` under routes/verse/
 * is imported here (eagerly — it only registers; its component stays a
 * `lazy()` import of its own chunk). So a unit adds a pane by adding ONE
 * file in its own directory, e.g. routes/verse/reasoning/reasoning.pane.tsx:
 *
 *   import { lazyPane, registerPane } from '../panes/pane-registry.js';
 *   registerPane({ id: 'reasoning', title: 'Reasoning', icon: ReasoningGlyph,
 *     component: lazyPane(() => import('./ReasoningPane.js').then((m) => m.ReasoningPane)) });
 *
 * Load order does not matter: first-party panes always sit under a unit's
 * registration of the same id (pane-registry.ts registerBuiltinPane).
 *
 * The chat loads this module just after first paint (preloaded), never on
 * it — keep `*.pane.tsx` files to a registration and a lazy import.
 */
import './builtin-panes.js';
import { registerUnitPanes } from './register-adapter.js';

/**
 * Every `*.pane.ts(x)` under routes/verse — keyed by path, evaluated for
 * their registrations. Exported so the registry test can check discovery.
 */
export const DISCOVERED_PANE_MODULES: Record<string, unknown> = import.meta.glob(['../**/*.pane.ts', '../**/*.pane.tsx'], { eager: true });

/**
 * Every unit's `register.ts` (routes/verse/<unit>/register.ts) — the
 * self-describing form (`export const BROWSER_PANE = { id, label, load, … }`)
 * units shipped while the registry was landing. Each such export becomes a
 * registered pane (register-adapter.ts); a unit whose file has not landed is
 * simply an absent key. Registered AFTER the first-party panes (this body
 * runs once every import above has evaluated), so they replace the stubs.
 */
export const UNIT_PANE_MODULES: Record<string, unknown> = import.meta.glob('../*/register.ts', { eager: true });
export const UNIT_PANE_IDS: readonly string[] = registerUnitPanes(UNIT_PANE_MODULES);

export * from './pane-registry.js';
export { isUnitPaneRegistration, registerUnitPanes, type UnitPaneRegistration } from './register-adapter.js';
export { registerBuiltinPanes } from './builtin-panes.js';

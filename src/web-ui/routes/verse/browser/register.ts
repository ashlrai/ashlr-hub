/**
 * routes/verse/browser/register.ts — the Browser pane's registration for the
 * workbench pane registry (routes/verse/panes/**, landing separately).
 *
 * This file is deliberately tiny and import-free apart from a LAZY import:
 * the registry can list the pane (id, label, command, where it docks) on
 * first paint without pulling the pane's code — BrowserPanel and everything
 * behind it (Button, icons, the token dialog) load only when it is opened
 * (VerseApp.first-paint.test.ts keeps those out of the first-paint graph).
 *
 * Until the registry lands, a host mounts it with:
 *   const Browser = lazy(BROWSER_PANE.load);
 *   <Suspense fallback={null}><Browser sessionId={id} visible={shown} /></Suspense>
 */
import type { ComponentType } from 'react';
import type { BrowserPanelProps } from './BrowserPanel.js';

export interface VersePaneRegistration<P> {
  /** Stable id (layout persistence, commands). */
  id: string;
  label: string;
  /** Command palette id that opens the pane. */
  commandId: string;
  /** Palette search words. */
  keywords: readonly string[];
  /** Where the pane prefers to dock when first opened. */
  defaultSlot: 'dock' | 'side' | 'main';
  /** Needs a chat to be useful (it still browses without one). */
  chatScoped: boolean;
  load: () => Promise<{ default: ComponentType<P> }>;
}

export type { BrowserPanelProps };

export const BROWSER_PANE: VersePaneRegistration<BrowserPanelProps> = {
  id: 'browser',
  label: 'Browser',
  commandId: 'pane.browser',
  keywords: ['browser', 'web', 'preview', 'localhost', 'devtools', 'console', 'screenshot'],
  defaultSlot: 'dock',
  chatScoped: true,
  load: () => import('./BrowserPanel.js').then((m) => ({ default: m.BrowserPanel })),
};

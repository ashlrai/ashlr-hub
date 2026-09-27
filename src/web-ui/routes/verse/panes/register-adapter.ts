/**
 * routes/verse/panes/register-adapter.ts — panes that describe themselves
 * in a unit's `register.ts` (the shape the Browser, Terminal, Reasoning +
 * Sources and Changes units ship while the registry was landing):
 *
 *   export const BROWSER_PANE = {
 *     id: 'browser', label: 'Browser', commandId: 'pane.browser',
 *     keywords: […], defaultSlot: 'dock', chatScoped: true,
 *     load: () => import('./BrowserPanel.js').then((m) => ({ default: m.BrowserPanel })),
 *   };
 *
 * panes/index.ts discovers every `routes/verse/<unit>/register.ts` and hands
 * its exports here. Each export of that shape becomes a registered pane —
 * REPLACING the first-party one with the same id (so it keeps that pane's
 * key, order and header toggle) — and anything else in the file is ignored.
 *
 * The unit's component gets the full PaneProps. Components written against
 * the smaller `{ sessionId, visible }` contract simply ignore the rest; they
 * are handed `sessionId: null` when no chat is open (these panes accept it),
 * so `needsSession` is false for them.
 */
import type { ComponentType } from 'react';
import { PanelRightGlyph } from '../dock/dock-icons.js';
import { PANE_ID_RE } from '../shell/dock-catalog.js';
import { getPane, lazyPane, registerPane, type PaneIcon, type PaneProps } from './pane-registry.js';

/** The self-description a unit's `register.ts` exports. */
export interface UnitPaneRegistration {
  id: string;
  label: string;
  commandId?: string;
  keywords?: readonly string[];
  defaultSlot?: 'dock' | 'side' | 'main';
  chatScoped?: boolean;
  /** Optional: a 16px glyph; the first-party pane's icon (or a generic panel glyph) otherwise. */
  icon?: PaneIcon;
  /** Optional: its own chord ('mod+alt+t'); vetted like any pane shortcut. */
  shortcut?: string;
  description?: string;
  load: () => Promise<{ default: ComponentType<never> }>;
}

/** Ids a unit may use for a first-party pane under another name. */
const ID_ALIASES: Readonly<Record<string, string>> = { changes: 'diff', review: 'diff', preview: 'browser' };

export function isUnitPaneRegistration(value: unknown): value is UnitPaneRegistration {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v['id'] === 'string' && PANE_ID_RE.test(v['id']) && typeof v['label'] === 'string' && v['label'].trim() !== ''
    && typeof v['load'] === 'function';
}

/**
 * Register every pane the given modules describe. Returns the ids registered
 * (for tests) — duplicates across modules: the later module wins, like any
 * replacement.
 */
export function registerUnitPanes(modules: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path];
    if (mod === null || typeof mod !== 'object') continue;
    for (const value of Object.values(mod as Record<string, unknown>)) {
      if (!isUnitPaneRegistration(value)) continue;
      const id = ID_ALIASES[value.id] ?? value.id;
      const existing = getPane(id);
      const load = value.load;
      registerPane({
        id,
        title: value.label.trim(),
        icon: value.icon ?? existing?.icon ?? PanelRightGlyph,
        component: lazyPane(() => load().then((m) => m.default as unknown as ComponentType<PaneProps>)),
        needsSession: false,
        ...(value.shortcut ? { shortcut: value.shortcut } : {}),
        ...(value.description ? { description: value.description } : {}),
      });
      ids.push(id);
    }
  }
  return ids;
}

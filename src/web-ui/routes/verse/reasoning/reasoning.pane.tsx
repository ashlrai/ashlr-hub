/**
 * routes/verse/reasoning/reasoning.pane.tsx — the Sources and Reasoning
 * panes, registered with the workbench pane registry (panes/README.md).
 *
 * Same ids as the first-party stubs, so these REPLACE them and inherit their
 * keys (⇧⌘S Sources, ⇧⌘Y Reasoning), order and catalog commands. Only the
 * registration lives here — panes/index.ts imports every `*.pane.tsx` eagerly
 * after first paint — and each body is its own lazy chunk.
 */
import { ReasoningGlyph, SourcesGlyph } from '../dock/dock-icons.js';
import { lazyPane, registerPane } from '../panes/pane-registry.js';

registerPane({
  id: 'sources',
  title: 'Sources',
  icon: SourcesGlyph,
  description: 'Every file, page, search and doc this chat drew on — numbered, with the turns that cited each.',
  component: lazyPane(() => import('./dock-panes.js').then((m) => m.SourcesDockPane)),
});

registerPane({
  id: 'reasoning',
  title: 'Reasoning',
  icon: ReasoningGlyph,
  description: "The model's reasoning, turn by turn, with what each turn did.",
  component: lazyPane(() => import('./dock-panes.js').then((m) => m.ReasoningDockPane)),
});

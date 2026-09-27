/**
 * routes/verse/panes/builtin-panes.tsx — the workbench's first-party panes,
 * registered UNDER any unit's registration of the same id (so a unit's
 * `registerPane({ id: 'reasoning', … })` replaces the stub whatever the
 * module order). Metadata comes from shell/dock-catalog.ts DOCK_PANES;
 * bodies are lazy, so each loads the first time its tab opens.
 *
 *   id         title      key    body
 *   terminal   Terminal   ⌃`     C4's TerminalPane through its slot
 *   browser    Browser    ⇧⌘B    C4's PreviewPane through its slot
 *   diff       Changes    ⇧⌘D    C5's DiffPane through its slot
 *   files      Files      ⇧⌘O    stub: folders + files read / changed
 *   sources    Sources    ⇧⌘S    stub: pages, searches, files read
 *   reasoning  Reasoning  ⇧⌘Y    stub: the chat's thinking, by turn
 *   tasks      Tasks      —      this turn's calls + other running chats
 *   context    Context    —      usage, roots, memory, handoff
 */
import type { ComponentType } from 'react';
import {
  ContextGlyph,
  FilesGlyph,
  PreviewGlyph,
  ReasoningGlyph,
  ReviewGlyph,
  SourcesGlyph,
  TasksGlyph,
  TerminalGlyph,
} from '../dock/dock-icons.js';
import { DOCK_PANES, type BuiltinPaneId } from '../shell/dock-catalog.js';
import { isSlotAvailable } from '../shell/slots.js';
import { BrowserPaneBody, ChangesPaneBody, TerminalPaneBody } from './builtin/SlotPanes.js';
import { lazyPane, registerBuiltinPane, type PaneDefinition, type PaneIcon, type PaneProps } from './pane-registry.js';

type Body = ComponentType<PaneProps>;

const TasksBody = lazyPane(() => import('./builtin/ChatPanes.js').then((m) => m.TasksPaneBody));
const ContextBody = lazyPane(() => import('./builtin/ChatPanes.js').then((m) => m.ContextPaneBody));
const FilesBody = lazyPane(() => import('./builtin/FilesPane.js').then((m) => m.FilesPane));
const SourcesBody = lazyPane(() => import('./builtin/SourcesPane.js').then((m) => m.SourcesPane));
const ReasoningBody = lazyPane(() => import('./builtin/ReasoningPane.js').then((m) => m.ReasoningPane));

interface BuiltinExtras {
  icon: PaneIcon;
  component: Body;
  description: string;
  order: number;
  toggle?: boolean;
  needsSession?: boolean;
  when?: PaneDefinition['when'];
}

/** A slot pane exists once its owner's file is in the build (shell/slots.tsx). */
const slotLanded = (slot: Parameters<typeof isSlotAvailable>[0]) => () => isSlotAvailable(slot);

const EXTRAS: Readonly<Record<BuiltinPaneId, BuiltinExtras>> = {
  terminal: {
    icon: TerminalGlyph, component: TerminalPaneBody, order: 10, toggle: true, when: slotLanded('terminal-pane'),
    description: "A shell in this chat's folders. Commands the chat suggests paste here — you press Enter.",
  },
  browser: {
    icon: PreviewGlyph, component: BrowserPaneBody, order: 20, toggle: true, when: slotLanded('preview-pane'),
    description: 'Your dev server or a page the chat made, live beside the conversation.',
  },
  diff: {
    icon: ReviewGlyph, component: ChangesPaneBody, order: 30, toggle: true, when: slotLanded('diff-pane'),
    description: 'What changed — this turn, uncommitted, or the whole branch — with notes you can send back.',
  },
  files: {
    icon: FilesGlyph, component: FilesBody, order: 40,
    description: "The chat's folders, and every file it has read or changed.",
  },
  sources: {
    icon: SourcesGlyph, component: SourcesBody, order: 50,
    description: 'The pages, searches and files an answer rests on.',
  },
  reasoning: {
    icon: ReasoningGlyph, component: ReasoningBody, order: 60,
    description: "The model's thinking, turn by turn, beside the answer.",
  },
  tasks: {
    icon: TasksGlyph, component: TasksBody, order: 70, needsSession: false,
    description: "This turn's tool calls, and every other chat that is running.",
  },
  context: {
    icon: ContextGlyph, component: ContextBody, order: 80, needsSession: false,
    description: "How full this chat's context is, its folders, memory and handoff.",
  },
};

let disposers: Array<() => void> = [];

/** Register (or re-register, after a registry reset) every first-party pane. Idempotent. */
export function registerBuiltinPanes(): void {
  for (const dispose of disposers) dispose();
  disposers = DOCK_PANES.map((meta) => {
    const extra = EXTRAS[meta.id];
    return registerBuiltinPane({
      id: meta.id,
      title: meta.label,
      ...(meta.commandId ? { command: meta.commandId } : {}),
      ...extra,
    });
  });
}

registerBuiltinPanes();

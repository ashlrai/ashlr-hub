/**
 * routes/verse/shell/slots.tsx — where Chat mounts other units' UI (unit C0;
 * SPEC-310C §7 "Slots").
 *
 * C2 owns the chat, the dock and the header; C4, C5 and C7 own things that
 * render INSIDE them. Rather than C2 importing their files — which would not
 * compile until every one of them landed, and would drag each into C2's
 * chunk — C2 renders these slots. Each resolves ONE fixed file lazily and:
 *   - renders nothing until that file lands (and `isSlotAvailable` says so,
 *     so C2 can hide the toggle for a pane that does not exist yet);
 *   - loads in its own chunk (xterm and the diff viewer stay off the chat's
 *     critical path — SPEC-310C budgets: chat critical JS ≤ 350 KB);
 *   - is fenced by an error boundary: a crashed inline slot vanishes, a
 *     crashed pane says so with a retry — neither takes the chat down.
 *
 * The props below ARE the contract: each owning unit's component takes
 * exactly its slot's props, as a NAMED export (`export function BranchBar`).
 *
 * Resolution uses `import.meta.glob` with literal paths — the same "absent
 * file is an absent key" mechanism VerseApp uses for sections.
 */
import { Component, Suspense, lazy, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import type { VerseReviewScope, VerseTerminalLaunchVia } from '../../../../core/verse/workbench-types.js';

// ===========================================================================
// Contracts
// ===========================================================================

/** Open the Review pane on a root, at a scope (and optionally one file). */
export interface DiffPaneRequest {
  root: string;
  scope: VerseReviewScope;
  file?: string;
}

/** A file the chat's latest turn touched — the Review pane's "This turn" scope (C2 derives it from events). */
export interface TurnFileChange {
  root: string;
  /** Relative to `root`. */
  path: string;
}

/** Open the Terminal pane: a tab at `root`, optionally pasting (never running) a command. */
export interface TerminalOpenRequest {
  /** Changes on every request, so the same request twice is two opens. */
  nonce: number;
  root?: string;
  /** Force a new tab instead of focusing the root's existing one (⌃⇧`). */
  newTab?: boolean;
  /** "Run in terminal": pasted at the prompt, NEVER executed — the operator presses Enter. */
  paste?: string;
  /** Apps [Launch ▸]: the catalog app to launch in the new tab. */
  appId?: string;
  /**
   * With `appId`: HOW to launch it — the app's own CLI (`native`) or through
   * Ollama (`ollama`, with `model` naming the local tag). These mirror
   * VerseTerminalCreateRequest; the page only names the choice, the server
   * resolves the argv from the catalog and the installed binaries
   * (`resolveAppLaunch`) and refuses via/model without an appId.
   */
  via?: VerseTerminalLaunchVia;
  /** With `via: 'ollama'`: the local model tag to launch the app on. */
  model?: string;
  /** Preview's dev-server Start: the server to run in the new tab. */
  devServerId?: string;
}

/** Open the Preview pane on a loopback URL, a chat artifact, or a dev server. */
export interface PreviewOpenRequest {
  nonce: number;
  url?: string;
  artifactPath?: string;
  devServerId?: string;
}

/** C5 `git/BranchBar.tsx` → `export function BranchBar(props: BranchBarProps)` — above the composer. */
export interface BranchBarProps {
  sessionId: string;
  /** The chat's roots in priority order; the bar shows one row per root with changes, then "Show N more". */
  roots: readonly string[];
  /** The ± counts open the branch diff: C2 opens the dock's Review pane with this. */
  onOpenDiff: (request: DiffPaneRequest) => void;
}

/** C5 `git/DiffPane.tsx` → `export function DiffPane(props: DiffPaneProps)` — the dock's Review pane. */
export interface DiffPaneProps {
  sessionId: string;
  roots: readonly string[];
  /** Latest open request; null = the pane chooses (Uncommitted, first root with changes). */
  request: (DiffPaneRequest & { nonce: number }) | null;
  turnFiles: readonly TurnFileChange[];
  /** "Add to message": drafts `path:line: note` into the composer (⌘Enter sends). */
  onAddToMessage: (text: string) => void;
  /** False while the pane is a background tab — stop timers, skip work. */
  visible: boolean;
}

/** C4 `dock/terminal/TerminalPane.tsx` → `export function TerminalPane(props: TerminalPaneProps)`. */
export interface TerminalPaneProps {
  sessionId: string;
  roots: readonly string[];
  request: TerminalOpenRequest | null;
  /** "Send selection to chat": the text, already fenced as a code block. */
  onSendToChat: (text: string) => void;
  visible: boolean;
}

/** C4 `dock/preview/PreviewPane.tsx` → `export function PreviewPane(props: PreviewPaneProps)`. */
export interface PreviewPaneProps {
  sessionId: string;
  roots: readonly string[];
  request: PreviewOpenRequest | null;
  /** Dev-server Start runs the server in a terminal tab — through the dock, never directly. */
  onOpenTerminal: (request: Omit<TerminalOpenRequest, 'nonce'>) => void;
  visible: boolean;
}

/** C7 `mind/SessionInsightChip.tsx` → `export function SessionInsightChip(props)` — the chat header chip. */
export interface SessionInsightChipProps {
  sessionId: string;
}

export interface SlotPropsMap {
  'branch-bar': BranchBarProps;
  'diff-pane': DiffPaneProps;
  'terminal-pane': TerminalPaneProps;
  'preview-pane': PreviewPaneProps;
  'session-insight-chip': SessionInsightChipProps;
}

export type SlotId = keyof SlotPropsMap;

/**
 * Each slot's fixed file (relative to routes/verse), its named export, its
 * owner, and how a crash is shown: an INLINE slot vanishes; a PANE fills the
 * dock, so it says it failed and offers a retry.
 */
export const SLOTS = {
  'branch-bar': { path: 'git/BranchBar.tsx', exportName: 'BranchBar', owner: 'C5', kind: 'inline', label: 'Branch bar' },
  'diff-pane': { path: 'git/DiffPane.tsx', exportName: 'DiffPane', owner: 'C5', kind: 'pane', label: 'Review' },
  'terminal-pane': { path: 'dock/terminal/TerminalPane.tsx', exportName: 'TerminalPane', owner: 'C4', kind: 'pane', label: 'Terminal' },
  'preview-pane': { path: 'dock/preview/PreviewPane.tsx', exportName: 'PreviewPane', owner: 'C4', kind: 'pane', label: 'Preview' },
  'session-insight-chip': { path: 'mind/SessionInsightChip.tsx', exportName: 'SessionInsightChip', owner: 'C7', kind: 'inline', label: 'Insight' },
} as const satisfies Record<SlotId, { path: string; exportName: string; owner: string; kind: 'inline' | 'pane'; label: string }>;

export const SLOT_IDS = Object.keys(SLOTS) as SlotId[];

// ===========================================================================
// Resolution
// ===========================================================================

type Importer = () => Promise<unknown>;

/**
 * Every slot file that exists at build time, keyed `../<path>`. Literal
 * patterns (no wildcards): a slot may only ever load its owner's one file.
 * EXPORTED for the slot test, which checks it against SLOTS.
 */
export const SLOT_MODULES: Record<string, Importer> = import.meta.glob([
  '../git/BranchBar.tsx',
  '../git/DiffPane.tsx',
  '../dock/terminal/TerminalPane.tsx',
  '../dock/preview/PreviewPane.tsx',
  '../mind/SessionInsightChip.tsx',
]);

function importerFor(id: SlotId, modules: Record<string, Importer>): Importer | undefined {
  return modules[`../${SLOTS[id].path}`];
}

/** True once the slot's file has landed in this build. */
export function isSlotAvailable(id: SlotId, modules: Record<string, Importer> = SLOT_MODULES): boolean {
  return importerFor(id, modules) !== undefined;
}

type AnyComponent = ComponentType<Record<string, unknown>>;

/**
 * Build the lazy component for one slot. Absent → renders nothing. Present
 * but exporting no component of the contract name → throws on load, so the
 * boundary shows it (a slot that silently renders nothing because of a typo
 * would look exactly like "not landed yet").
 */
export function createSlotComponent(id: SlotId, modules: Record<string, Importer> = SLOT_MODULES): AnyComponent | null {
  const importer = importerFor(id, modules);
  if (!importer) return null;
  const { exportName } = SLOTS[id];
  return lazy(async () => {
    const mod = (await importer()) as Record<string, unknown>;
    const exported = mod[exportName];
    if (typeof exported !== 'function' && (typeof exported !== 'object' || exported === null)) {
      throw new Error(`${SLOTS[id].path} exports no ${exportName}`);
    }
    return { default: exported as AnyComponent };
  });
}

// One lazy component per slot for the life of the page: re-creating it per
// render would remount the pane (and drop a terminal's scrollback) each time.
const RESOLVED = new Map<SlotId, AnyComponent | null>();
function slotComponent(id: SlotId): AnyComponent | null {
  if (!RESOLVED.has(id)) RESOLVED.set(id, createSlotComponent(id));
  return RESOLVED.get(id)!;
}

// ===========================================================================
// Rendering
// ===========================================================================

interface BoundaryProps {
  kind: 'inline' | 'pane';
  label: string;
  /** Drop the cached module and mount a fresh boundary (a failed lazy import stays failed otherwise). */
  onRetry: () => void;
  children: ReactNode;
}

class SlotBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The console, not the page: operator copy never carries a stack or a path.
    console.error(`[verse] ${this.props.label} failed`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    if (this.props.kind === 'inline') return null;
    return <PaneFailed label={this.props.label} onRetry={this.props.onRetry} />;
  }
}

function PaneFailed({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <EmptyState
      compact
      tone="error"
      title={`${label} could not load`}
      body="The rest of the chat still works."
      action={
        <Button variant="subtle" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    />
  );
}

function SlotHost<K extends SlotId>({
  id,
  props,
  resolve = slotComponent,
  forget = (slot: SlotId) => RESOLVED.delete(slot),
}: {
  id: K;
  props: SlotPropsMap[K];
  resolve?: (id: SlotId) => AnyComponent | null;
  forget?: (id: SlotId) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const Resolved = resolve(id);
  if (!Resolved) return null;
  const { kind, label } = SLOTS[id];
  const retry = () => {
    forget(id);
    setAttempt((n) => n + 1);
  };
  return (
    // A new key per attempt: a fresh boundary AND a fresh lazy component.
    <SlotBoundary key={attempt} kind={kind} label={label} onRetry={retry}>
      <Suspense fallback={null}>
        <Resolved {...(props as unknown as Record<string, unknown>)} />
      </Suspense>
    </SlotBoundary>
  );
}

/** Test seam: render a slot against an injected module map (fake landed / absent / broken files). */
export function SlotForTest<K extends SlotId>({ id, props, modules }: { id: K; props: SlotPropsMap[K]; modules: Record<string, Importer> }) {
  const [cache] = useState(() => new Map<SlotId, AnyComponent | null>());
  const resolve = (slot: SlotId) => {
    if (!cache.has(slot)) cache.set(slot, createSlotComponent(slot, modules));
    return cache.get(slot)!;
  };
  return <SlotHost id={id} props={props} resolve={resolve} forget={(slot) => cache.delete(slot)} />;
}

export function BranchBarSlot(props: BranchBarProps) {
  return <SlotHost id="branch-bar" props={props} />;
}

export function DiffPaneSlot(props: DiffPaneProps) {
  return <SlotHost id="diff-pane" props={props} />;
}

export function TerminalPaneSlot(props: TerminalPaneProps) {
  return <SlotHost id="terminal-pane" props={props} />;
}

export function PreviewPaneSlot(props: PreviewPaneProps) {
  return <SlotHost id="preview-pane" props={props} />;
}

export function SessionInsightChipSlot(props: SessionInsightChipProps) {
  return <SlotHost id="session-insight-chip" props={props} />;
}

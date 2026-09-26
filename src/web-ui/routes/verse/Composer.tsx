/**
 * routes/verse/Composer.tsx — the message box and its controls (3.10: unit
 * C3; SPEC-310C §2 "Composer").
 *
 *   [queued follow-ups: Edit · Send now · ×]          (hidden when empty; portalled
 *                                                      to the host's `queueSlot` when given)
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ [attachment chips]                                                   │
 *   │ Ask anything — @ to add files, / for commands                        │
 *   │ [+] 🎙 ✎ Accept edits ▾     [C] Claude Max ◔  Opus 5 ▾  Effort: High ▾  ◔ 31%  Send ⏎ │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * FOOTER: left = how you write (attach, dictate, permission mode); right =
 * where it runs and what it sends (seat, model, effort, context, send). The
 * seat chip names the ACCOUNT and the Model picker the model, so the model is
 * said once. Effort appears only where the seat can set it. Labels are short
 * and never ellipsized; the full words are each control's name and tooltip
 * (shown on keyboard focus too). When the row is too narrow it folds
 * (composer/useFooterFold): "Effort:" → an icon, the seat chip → its
 * monogram, the mode → its icon, then the pickers into the ⋯ sheet. Nothing
 * re-folds while the ⋯ sheet or a picker's menu is open, and when a fold
 * takes away the control that had focus, focus lands on its replacement (⋯,
 * or the box). Controls are 28px, 8px apart; typing never reflows the row
 * (while a turn runs, ■ and Queue sit there empty or not; a send in flight
 * keeps Send's width and says so with a busy style).
 *
 * ALWAYS EDITABLE. Enter while a turn runs QUEUES the message on the server
 * (at most 3); the queue sends each follow-up when the turn before it ends
 * cleanly, and HOLDS after a failure or a Stop (queue row says why). ⇧⌘↩
 * stops the running turn and sends this message next. Esc stops the turn —
 * only from an empty box with no menu open, so it never eats a draft.
 *
 * CONTROLS apply from the next turn, even mid-run: Permission (⇧⌘M: Plan,
 * Accept edits, Auto, Bypass — bypass is red and confirmed per chat), Model
 * (⇧⌘I) and Effort (⇧⌘E). An option the seat cannot honour is listed
 * disabled with the reason. Keys come from C0's command catalog; the palette
 * reaches the same actions through the `ashlr:command` window event.
 *
 * ATTACHMENTS: [+] / ⌘U, paste or drop. Each becomes a private copy on the
 * server and an `@path` token in the text, which the engine grants with
 * exactly that folder. `@` fuzzy-finds project files; `/` at the start offers
 * handoff, compact, new, plan, effort, model.
 *
 * At 375px (or a column too narrow for the pickers) the footer folds to
 * [+] [mic] · seat · ⋯ (the pickers in a bottom sheet) · Send.
 *
 * Kept from 3.9: per-chat drafts that survive a reload, ↑ history recall, the
 * pre-send cost hint, dictation, ⌘. to stop, and the seat-health block (A2).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { VerseSeat } from '../../data/api-types.js';
import type { VerseEffort, VersePermissionMode } from '../../../core/verse/workbench-types.js';
import { VERSE_QUEUE_MAX } from '../../../core/verse/workbench-types.js';
import { MutationTokenDialog } from '../../components/auth/MutationTokenDialog.js';
import { IconPlus } from '../../components/primitives/icons.js';
import { Tooltip } from '../../components/primitives/Tooltip.js';
import { costHint, loadDraft, loadHistory, pushHistory, saveDraft, type CostHint } from './chat/composer-state.js';
import { AttachmentChips } from './composer/AttachmentChips.js';
import { BypassConfirmDialog } from './composer/BypassConfirmDialog.js';
import { COMPOSER_COMMAND_IDS, pressesCommand, shortcutLabel, WORKBENCH_COMMAND_EVENT, type ComposerCommandId } from './composer/composer-keys.js';
import { searchSessionFiles } from './composer/composer-queries.js';
import {
  activeTrigger,
  applyCompletion,
  insertAttachmentRef,
  matchSlashCommands,
  mentionFor,
  removeAttachmentRef,
  type ComposerTrigger,
  type SlashCommand,
} from './composer/composer-text.js';
import { ContextRing } from './composer/ContextRing.js';
import { ControlMenu } from './composer/ControlMenu.js';
import { ControlsSheet } from './composer/ControlsSheet.js';
import { QueueRow } from './composer/QueueRow.js';
import { capacityRingShown, SeatChip } from './composer/SeatChip.js';
import { SuggestMenu, suggestOptionId, type SuggestItem } from './composer/SuggestMenu.js';
import { useAttachmentDrafts, useFollowUpQueue, useSessionControls } from './composer/useComposerData.js';
import { FOOTER_FOLD_SHEET, useFooterFold } from './composer/useFooterFold.js';
import { useTokenGate } from './context/use-token-gate.js';
import { DictationButton } from './DictationButton.js';
import { ComposerSeatBlock } from './health/ComposerSeatBlock.js';
import type { SeatChoice } from './SeatSelector.js';
import { useViewport } from './shell/viewport.js';
import { ENGINE_LABEL, modelLabel, seatPillLabel } from './verse-model.js';
import { formatTokens } from './verse-store.js';
import type { VerseFileMatch } from '../../../core/verse/workbench-types.js';
import styles from './Composer.module.css';
import cstyles from './composer/composer.module.css';

export interface ComposerProps {
  /** Which chat this box belongs to — drafts, history, controls and the queue are per session. */
  sessionId?: string | null;
  seats: readonly VerseSeat[];
  seat: SeatChoice;
  /** Engine of the current chat (identity tick, and what the seat can do). */
  engine?: VerseSeat['engine'];
  running: boolean;
  disabled: boolean;
  disabledReason?: string | null;
  locked: boolean;
  /** True when this session already has turns — the hint row has done its job. */
  hintSeen?: boolean;
  /**
   * Live context occupancy, for the pre-send cost hint and the footer ring —
   * the SAME budget the header meter draws (verse-model `sessionContextBudget`).
   */
  contextTokens?: number | null;
  contextWindow?: number | null;
  autoCompactAt?: number | null;
  /** False when `contextTokens` is an upper bound (codex before its rollout is read). */
  contextExact?: boolean;
  /** The box was pre-filled with a handoff note that has not been sent yet. */
  handoffDraft?: boolean;
  onSend: (text: string) => Promise<boolean> | boolean;
  onStop: () => void;
  /** Start a new chat on a seat (the seat menu, `/new`). */
  onSeatChange: (choice: SeatChoice) => void;
  /** "Continue on ‹seat›": open the handoff prefilled for that seat. Absent → a new chat on it. */
  onContinueOn?: (choice: SeatChoice) => void;
  /** `/handoff`: open this chat's handoff. Absent → the command is listed disabled with where to find it. */
  onHandoff?: () => void;
  /**
   * Why `/handoff` cannot run right now (a turn is running, dispatch is off) —
   * the SAME reason the header's ⋯ item shows. Null/absent = available.
   */
  handoffDisabledReason?: string | null;
  /**
   * Where the "Queued turns" row renders. SPEC-310C §2 orders the rows above
   * the composer notice → queued → live status → branch bar; the queue's state
   * lives here, so the host (Workspace) passes the element at the queue's
   * place and the row is portalled into it. Absent/null → the row renders at
   * the top of the composer, as before.
   */
  queueSlot?: HTMLElement | null;
  /**
   * Text another pane drafts INTO the box (Review's "Add to message"
   * `path:line: note`, Terminal's "Send selection to chat"): each new `nonce`
   * appends `text` on its own paragraph and focuses the box. Never sends —
   * the operator reads it and presses Enter (or ⌘Enter).
   */
  insertRequest?: { nonce: number; text: string } | null;
  autoFocus?: boolean;
}

const MAX_TEXT_BYTES = 64 * 1024;
/** Typing must pause this long before the draft is written to localStorage (see saveDraft). */
const DRAFT_WRITE_DEBOUNCE_MS = 400;
/** The `@` finder waits for a pause in typing before it asks the server. */
const MENTION_DEBOUNCE_MS = 120;
/** DESIGN §5: the box grows to 40% of the viewport, then scrolls. */
const MAX_HEIGHT_RATIO = 0.4;
const MAX_HEIGHT_FALLBACK_PX = 320;

type PickerId = 'permission' | 'model' | 'effort';

/**
 * Permission-mode icons as inline SVG, NOT text glyphs (review 3.10 c18).
 * WHY: '◇ ✎ ↻ ⚠' all sit outside the Ashlr Sans Latin subset's unicode-range
 * (design/global.css), so the browser fetched the 230 KB full IBM Plex face
 * on every chat paint just to find that three of the four are not in Plex
 * either and fall back to a system font. SVG costs no font request and draws
 * the same in every OS. Same geometry as components/primitives/icons.tsx
 * (16-unit box, 1.5 stroke, round caps, currentColor); decorative — the menu
 * button already carries the mode's name.
 */
function ModeIcon({ children }: { children: ReactNode }) {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true">
      {children}
    </svg>
  );
}

const PERMISSION_GLYPH: Record<VersePermissionMode, ReactNode> = {
  // Plan: an outlined diamond (was '◇').
  plan: <ModeIcon><path d="M8 2.2 13.8 8 8 13.8 2.2 8Z" /></ModeIcon>,
  // Accept edits: a pencil (was '✎').
  'accept-edits': <ModeIcon><path d="M10.6 2.9 13.1 5.4 5.6 12.9 2.6 13.4 3.1 10.4Z" /><path d="M9.2 4.3 11.7 6.8" /></ModeIcon>,
  // Auto: a circular arrow (was '↻').
  auto: <ModeIcon><path d="M13.2 7.2a5.2 5.2 0 1 0-.7 3.5" /><path d="M13.5 3.4v3.9h-3.9" /></ModeIcon>,
  // Bypass: a warning triangle (was '⚠').
  bypass: <ModeIcon><path d="M8 2.6 14.2 13H1.8L8 2.6Z" /><path d="M8 6.6v3" /><circle cx="8" cy="11.3" r="0.75" fill="currentColor" stroke="none" /></ModeIcon>,
};

/** The footer's short mode names; the option's own label ("Bypass permissions") is the name and title. */
const PERMISSION_SHORT: Record<VersePermissionMode, string> = {
  plan: 'Plan',
  'accept-edits': 'Accept edits',
  auto: 'Auto',
  bypass: 'Bypass',
};

/** Effort, once "Effort:" folds away: three rising bars (same geometry rules as ModeIcon). */
const EFFORT_GLYPH = <ModeIcon><path d="M3.5 12.5v-2.5M8 12.5V7.5M12.5 12.5v-8" /></ModeIcon>;

/** The compact footer's "more settings" dots — SVG for the same reason ('⋯' U+22EF is outside the subset and not in Plex). */
const MORE_DOTS = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" focusable="false" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
);

export function Composer({ sessionId = null, seats, seat, engine, running, disabled, disabledReason, locked,
  hintSeen = false, contextTokens = null, contextWindow = null, autoCompactAt = null, contextExact = true, handoffDraft = false,
  onSend, onStop, onSeatChange, onContinueOn, onHandoff, handoffDisabledReason = null, queueSlot = null, insertRequest = null,
  autoFocus = false }: ComposerProps) {
  const { compact: phone } = useViewport();
  const gate = useTokenGate();
  const run = gate.run;
  const controls = useSessionControls(disabled ? null : sessionId, running, run);
  const followUps = useFollowUpQueue(disabled ? null : sessionId, running, run);
  const attachments = useAttachmentDrafts(disabled ? null : sessionId, run);

  // A draft survives ⌘K, a reload and a crash (Composer is keyed by session id).
  const [draft, setDraft] = useState(() => loadDraft(sessionId));
  const [interim, setInterim] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [sentHere, setSentHere] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [historyAt, setHistoryAt] = useState(-1);
  const [initialHistory] = useState(() => loadHistory(sessionId));
  const history = useRef<string[]>(initialHistory);
  const stashed = useRef('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  /** The ⋯ sheet was closed by the operator: focus goes back to ⋯ — or to the box, if ⋯ has folded away. */
  const sheetReturnFocus = useRef(false);
  const helpId = useId();
  const suggestId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedTrigger, setDismissedTrigger] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [fileMatches, setFileMatches] = useState<{ query: string; files: VerseFileMatch[]; primaryRoot: string | null } | null>(null);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<Record<PickerId, number>>({ permission: 0, model: 0, effort: 0 });
  const [openMenus, setOpenMenus] = useState<Record<PickerId, boolean>>({ permission: false, model: false, effort: false });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [bypassAsk, setBypassAsk] = useState(false);
  const [dragging, setDragging] = useState(false);

  const text = interim ? `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}${interim}` : draft;
  const tooLong = useMemo(() => new TextEncoder().encode(text).length > MAX_TEXT_BYTES, [text]);
  const queue = followUps.queue;
  const queueAvailable = queue !== null;
  const queueFull = (queue?.items.length ?? 0) >= VERSE_QUEUE_MAX;
  const hasText = text.trim().length > 0;
  const blockedByUpload = attachments.uploading;
  const canSend = !disabled && !sending && hasText && !tooLong && !blockedByUpload && (!running || (queueAvailable && !queueFull));
  const showHint = !hintSeen && !sentHere;
  const showHandoffHelp = handoffDraft && !sentHere && hasText;
  const cost = useMemo(
    () => costHint(text, { contextTokens, contextWindow, autoCompactAt, exact: contextExact }),
    [text, contextTokens, contextWindow, autoCompactAt, contextExact],
  );
  const view = controls.view;
  const effectiveEngine = engine ?? seats.find((s) => s.id === seat.seatId)?.engine ?? 'claude';
  const chipLabel = seatPillLabel(seats, { seatId: seat.seatId, engine: effectiveEngine, model: view?.controls.model ?? seat.model });
  // The chip names the account; a local seat's label IS its model's name, so it says "Local".
  const seatName = effectiveEngine === 'local'
    ? ENGINE_LABEL.local
    : seats.find((s) => s.id === seat.seatId)?.label ?? ENGINE_LABEL[effectiveEngine];
  const modelName = view ? labelOf(view.options.models, view.controls.model) : modelLabel(seats, seat);
  const effortOn = view?.options.efforts.some((o) => o.available) === true;
  const effortName = view?.controls.effort ? labelOf(view.options.efforts, view.controls.effort) : 'Default';
  const footerRow = useRef<HTMLDivElement>(null);
  // The seat chip's capacity ring (14px + a gap) arrives with a later roster
  // poll and takes room, so its presence is part of what the fold measures;
  // so is `phone`, which swaps the whole row for the compact one.
  const ringShown = capacityRingShown(seats.find((s) => s.id === seat.seatId), effectiveEngine);
  const pickerMenuOpen = Object.values(openMenus).some(Boolean);
  const fold = useFooterFold(footerRow, [seatName, modelName, effortOn && effortName, view?.controls.permissionMode,
    running, queueAvailable, queueFull, locked, disabled, ringShown, phone].join('|'), {
    // Nothing folds under an open overlay: a re-measure could unmount ⋯ or
    // the picker the overlay belongs to. What changed is measured on close.
    hold: sheetOpen || pickerMenuOpen,
    onSettle: (settled, focusBefore) => {
      // A fold took away the control that had focus (the pickers left for ⋯,
      // ⋯ left for the pickers, or new words passed the row through fold 0),
      // or the operator closed the sheet: put focus on the replacement.
      const active = document.activeElement;
      const lost = active === null || active === document.body;
      const returning = sheetReturnFocus.current;
      sheetReturnFocus.current = false;
      if (!lost || (!returning && (focusBefore === null || focusBefore.isConnected))) return;
      const more = phone || settled >= FOOTER_FOLD_SHEET ? moreButton.current : null;
      (more ?? textarea.current)?.focus();
    },
  });
  const compact = phone || fold >= FOOTER_FOLD_SHEET;
  const attachBlocked = effectiveEngine === 'grok'
    ? 'Grok can only open files inside the project folder, so it can’t read attachments.'
    : null;

  // ---- drafts ---------------------------------------------------------------
  const persistedDraft = useRef(draft);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;

  const flushDraft = useCallback(() => {
    if (persistedDraft.current === latestDraft.current) return;
    persistedDraft.current = latestDraft.current;
    saveDraft(sessionId, latestDraft.current);
  }, [sessionId]);

  useEffect(() => {
    if (persistedDraft.current === draft) return undefined;
    const id = setTimeout(flushDraft, DRAFT_WRITE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [draft, flushDraft]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushDraft);
    return () => {
      window.removeEventListener('beforeunload', flushDraft);
      flushDraft();
    };
  }, [flushDraft]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  // Text drafted in from another pane: appended once per nonce, never sent.
  const seenInsert = useRef<number | null>(insertRequest?.nonce ?? null);
  useEffect(() => {
    if (!insertRequest || insertRequest.nonce === seenInsert.current) return;
    seenInsert.current = insertRequest.nonce;
    const addition = insertRequest.text.replace(/\s+$/, '');
    if (!addition) return;
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${addition}` : addition));
    placeCaret(Number.MAX_SAFE_INTEGER);
  }, [insertRequest]);

  // ⌘. stops the running turn from anywhere in the app (armed only while one runs).
  useEffect(() => {
    if (!running) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '.' || (!event.metaKey && !event.ctrlKey) || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onStop();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [running, onStop]);

  // When the reply finishes, hand focus back to the box unless it went somewhere deliberate.
  useEffect(() => {
    if (running || !autoFocus) return;
    const active = document.activeElement;
    const ours = active !== null && active !== textarea.current && form.current?.contains(active) === true;
    if (active === null || active === document.body || !active.isConnected || ours) textarea.current?.focus();
  }, [running, autoFocus]);

  // Grow with content up to 40% of the viewport; shrink back when cleared.
  useEffect(() => {
    const node = textarea.current;
    if (!node) return;
    const viewport = typeof window === 'undefined' ? 0 : window.innerHeight;
    const max = viewport > 0 ? Math.round(viewport * MAX_HEIGHT_RATIO) : MAX_HEIGHT_FALLBACK_PX;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, max)}px`;
  }, [text]);

  // ---- `@` and `/` ------------------------------------------------------------
  const trigger: ComposerTrigger | null = useMemo(() => {
    if (disabled || interim || caret === null) return null;
    const found = activeTrigger(draft, caret);
    if (!found || found.start === dismissedTrigger) return null;
    if (found.kind === 'mention' && !sessionId) return null;
    return found;
  }, [draft, caret, disabled, interim, dismissedTrigger, sessionId]);

  useEffect(() => {
    if (trigger?.kind !== 'mention' || !sessionId) {
      setFileSearchError(null);
      return undefined;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      searchSessionFiles(sessionId, trigger.query, abort.signal)
        .then((result) => {
          setFileMatches({ query: result.query, files: result.files, primaryRoot: result.primaryRoot ?? null });
          setFileSearchError(null);
        })
        .catch(() => { if (!abort.signal.aborted) setFileSearchError('Files could not be listed.'); });
    }, MENTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [trigger?.kind, trigger?.query, sessionId]);

  const commands: SlashCommand[] = trigger?.kind === 'command' ? matchSlashCommands(trigger.query) : [];
  const commandDisabled = useCallback((id: SlashCommand['id']): string | null => {
    if (id === 'handoff' && !onHandoff) return 'Use Hand off in the chat header’s Chat actions menu'; // named, not drawn as the U+22EF glyph, which is outside the font subset (c18)
    if (id === 'handoff' && handoffDisabledReason) return handoffDisabledReason;
    if ((id === 'plan' || id === 'effort' || id === 'model') && !view) return 'This server has no session controls yet';
    if (id === 'plan' && view && !view.options.permissionModes.find((o) => o.id === 'plan')?.available) return 'This seat has no plan mode';
    return null;
  }, [onHandoff, handoffDisabledReason, view]);

  const suggestItems: SuggestItem[] = trigger?.kind === 'command'
    ? commands.map((c) => ({ id: c.id, primary: c.title, secondary: c.description, disabledReason: commandDisabled(c.id) }))
    : trigger?.kind === 'mention'
      ? (fileMatches?.files ?? []).slice(0, 12).map((f) => ({ id: `${f.root}:${f.path}`, primary: f.path, secondary: fileMatches?.primaryRoot === f.root ? null : f.root }))
      : [];
  const suggestOpen = trigger !== null;
  const suggestStatus = trigger?.kind === 'mention'
    ? fileSearchError ?? (fileMatches === null || fileMatches.query !== trigger.query ? 'Searching…' : suggestItems.length === 0 ? 'No files match' : null)
    : null;
  const boundedActive = suggestItems.length === 0 ? 0 : Math.min(activeIndex, suggestItems.length - 1);

  useEffect(() => { setActiveIndex(0); }, [trigger?.kind, trigger?.query]);

  function syncCaret() {
    const node = textarea.current;
    if (node) setCaret(node.selectionStart === node.selectionEnd ? node.selectionStart : null);
  }

  function placeCaret(position: number) {
    requestAnimationFrame(() => {
      const node = textarea.current;
      if (!node) return;
      const at = Math.min(position, node.value.length);
      node.focus();
      node.setSelectionRange(at, at);
      setCaret(at);
    });
  }

  const openPicker = useCallback((id: PickerId) => {
    if (compact) {
      setSheetOpen(true);
      return;
    }
    setOpenRequest((current) => ({ ...current, [id]: current[id] + 1 }));
  }, [compact]);

  function runSlash(command: SlashCommand) {
    if (!trigger) return;
    const reason = commandDisabled(command.id);
    if (reason) {
      setNote({ text: reason, error: false });
      return;
    }
    // Every command but /compact consumes its own text.
    const without = `${draft.slice(0, trigger.start)}${draft.slice(trigger.end)}`.replace(/^\s+/, '');
    switch (command.id) {
      case 'compact': {
        const next = applyCompletion(draft, trigger, '/compact');
        setDraft(next.text);
        placeCaret(next.caret);
        return;
      }
      case 'new':
        setDraft(without);
        onSeatChange({ seatId: seat.seatId, model: view?.controls.model ?? seat.model });
        return;
      case 'handoff':
        setDraft(without);
        onHandoff?.();
        return;
      case 'plan':
        setDraft(without);
        placeCaret(0);
        void changePermission('plan');
        return;
      case 'effort':
      case 'model':
        setDraft(without);
        openPicker(command.id);
        return;
      default:
    }
  }

  function acceptSuggestion(index: number) {
    if (!trigger) return;
    if (trigger.kind === 'command') {
      const command = commands[index];
      if (command) runSlash(command);
      return;
    }
    const match = fileMatches?.files[index];
    if (!match) return;
    const next = applyCompletion(draft, trigger, mentionFor(match, fileMatches?.primaryRoot ?? null));
    setDraft(next.text);
    placeCaret(next.caret);
  }

  // ---- controls ---------------------------------------------------------------
  const changePermission = useCallback(async (mode: VersePermissionMode) => {
    if (mode === 'bypass') {
      setBypassAsk(true);
      return;
    }
    const ok = await controls.update({ permissionMode: mode }, 'Change this chat’s permission mode.');
    if (ok) setNote({ text: running ? 'Permission mode changes from the next turn.' : `Permission mode: ${labelOf(view?.options.permissionModes, mode)}.`, error: false });
  }, [controls, running, view]);

  const changeModel = useCallback(async (model: string) => {
    const ok = await controls.update({ model }, 'Change this chat’s model.');
    if (ok) setNote({ text: running ? 'The new model takes over from the next turn.' : `Model: ${labelOf(view?.options.models, model)}.`, error: false });
  }, [controls, running, view]);

  const changeEffort = useCallback(async (effort: VerseEffort | null) => {
    const ok = await controls.update({ effort }, 'Change this chat’s reasoning effort.');
    if (ok) setNote({ text: running ? 'Effort changes from the next turn.' : `Effort: ${effort ? labelOf(view?.options.efforts, effort) : 'the CLI default'}.`, error: false });
  }, [controls, running, view]);

  async function confirmBypass() {
    setBypassAsk(false);
    const ok = await controls.update({ permissionMode: 'bypass', confirmBypass: true }, 'Bypass permissions for this chat.');
    if (ok) setNote({ text: 'Bypass is on for this chat — every check is skipped.', error: false });
    textarea.current?.focus();
  }

  // ---- attachments ------------------------------------------------------------
  const addFiles = useCallback((files: readonly File[]) => {
    if (files.length === 0 || disabled) return;
    if (attachBlocked) {
      setNote({ text: attachBlocked, error: true });
      return;
    }
    attachments.add(files, (ref) => {
      setDraft((current) => insertAttachmentRef(current, ref).text);
    });
  }, [attachments, attachBlocked, disabled]);

  async function removeChip(key: string) {
    const ref = await attachments.remove(key);
    if (ref) setDraft((current) => removeAttachmentRef(current, ref));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  function onDrop(event: DragEvent<HTMLFormElement>) {
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  }

  const openFilePicker = useCallback(() => {
    if (disabled) return;
    if (attachBlocked) {
      setNote({ text: attachBlocked, error: true });
      return;
    }
    fileInput.current?.click();
  }, [disabled, attachBlocked]);

  // ---- send / queue -------------------------------------------------------------
  const clearAfterSend = useCallback((value: string) => {
    const last = history.current[history.current.length - 1];
    if (last !== value) history.current = [...history.current, value];
    pushHistory(sessionId, value);
    setHistoryAt(-1);
    stashed.current = '';
    setDraft('');
    persistedDraft.current = '';
    latestDraft.current = '';
    saveDraft(sessionId, '');
    setInterim('');
    setSentHere(true);
    attachments.reset();
  }, [sessionId, attachments]);

  const submit = useCallback(async (mode: 'send' | 'stop-and-send' = 'send') => {
    if (disabled || sending || tooLong) return;
    const value = text.trim();
    if (!value) return;
    if (blockedByUpload) {
      setNote({ text: 'Wait for the attachments to finish uploading.', error: false });
      return;
    }
    setSending(true);
    setNote(null);
    try {
      if (running && queueAvailable) {
        if (mode !== 'stop-and-send' && queueFull) {
          setNote({ text: `Up to ${VERSE_QUEUE_MAX} follow-ups can wait — send or remove one first.`, error: true });
          return;
        }
        const result = await followUps.enqueue(value, { sendNow: mode === 'stop-and-send' });
        if (result) {
          clearAfterSend(value);
          if (mode === 'stop-and-send') setNote({ text: 'Stopping the turn — this message goes next.', error: false });
        }
        return;
      }
      if (running) return; // older server: no queue, the box just keeps the draft
      const ok = await onSend(value);
      if (ok) clearAfterSend(value);
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  }, [disabled, sending, tooLong, text, blockedByUpload, running, queueAvailable, queueFull, followUps, clearAfterSend, onSend]);

  async function editQueued(queueId: string, queuedText: string) {
    const ok = await followUps.remove(queueId);
    if (!ok) return;
    setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${queuedText}` : queuedText));
    placeCaret(Number.MAX_SAFE_INTEGER);
  }

  // ---- keys ----------------------------------------------------------------------
  // What is actually on screen: the sheet renders whenever it is open (and
  // there are pickers to show), and a picker menu reports itself closed when
  // a fold unmounts it — so Esc-to-stop is never disarmed by an overlay that is gone.
  const sheetShown = sheetOpen && view !== null;
  const anyOverlayOpen = suggestOpen || pickerMenuOpen || sheetShown || bypassAsk || gate.dialog.open;

  const runCommand = useCallback((id: ComposerCommandId) => {
    switch (id) {
      case 'composer.permission': openPicker('permission'); return;
      case 'composer.model': openPicker('model'); return;
      case 'composer.effort': openPicker('effort'); return;
      case 'composer.attach': openFilePicker(); return;
      // "Run in cloud" lives in the Chat settings sheet (ControlsSheet), with
      // its own disabled reasons and token gate; the palette only opens it.
      case 'composer.cloud':
        if (view) setSheetOpen(true);
        else setNote({ text: 'Run in cloud opens from a chat whose controls have loaded — open or start a chat first.', error: false });
        return;
      case 'composer.send': void submit('send'); return;
      case 'composer.stop-and-send': void submit('stop-and-send'); return;
      case 'composer.stop': if (running) onStop(); return;
      default:
    }
  }, [openPicker, openFilePicker, submit, running, onStop, view]);

  // Chat-scope keys (⇧⌘M/I/E, ⌘U) are live while the chat is on screen, not
  // only while the box has focus; a modal dialog anywhere owns the keys.
  useEffect(() => {
    if (disabled) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      for (const id of ['composer.permission', 'composer.model', 'composer.effort', 'composer.attach'] as const) {
        if (pressesCommand(event, id)) {
          event.preventDefault();
          runCommand(id);
          return;
        }
      }
    };
    const onCommand = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id === 'string' && (COMPOSER_COMMAND_IDS as readonly string[]).includes(id)) runCommand(id as ComposerCommandId);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener(WORKBENCH_COMMAND_EVENT, onCommand);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(WORKBENCH_COMMAND_EVENT, onCommand);
    };
  }, [disabled, runCommand]);

  function recall(delta: -1 | 1): boolean {
    const list = history.current;
    if (list.length === 0) return false;
    if (historyAt === -1) {
      if (delta > 0) return false;
      stashed.current = draft;
      const next = list.length - 1;
      setHistoryAt(next);
      setDraft(list[next]!);
      setInterim('');
      return true;
    }
    const next = historyAt + delta;
    if (next < 0) return true;
    if (next >= list.length) {
      setHistoryAt(-1);
      setDraft(stashed.current);
      return true;
    }
    setHistoryAt(next);
    setDraft(list[next]!);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const node = event.currentTarget;
    const collapsed = node.selectionStart === node.selectionEnd;
    const composing = event.nativeEvent.isComposing;

    if (suggestOpen && !composing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (suggestItems.length > 0) {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setActiveIndex((boundedActive + step + suggestItems.length) % suggestItems.length);
        }
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) || event.key === 'Tab') {
        if (suggestItems.length > 0) {
          event.preventDefault();
          acceptSuggestion(boundedActive);
          return;
        }
        if (event.key === 'Tab') return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setDismissedTrigger(trigger?.start ?? null);
        return;
      }
    }

    if (!composing && pressesCommand(event, 'composer.stop-and-send')) {
      event.preventDefault();
      void submit('stop-and-send');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !composing) {
      event.preventDefault();
      void submit('send');
      return;
    }
    if (!composing && event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      // Esc stops the turn ONLY from an empty box with nothing open over it,
      // so it can never discard a draft or fight a menu for the key.
      if (running && !hasText && !anyOverlayOpen) {
        event.preventDefault();
        onStop();
      }
      return;
    }
    if (event.key === 'ArrowUp' && collapsed && (historyAt !== -1 || (node.selectionStart === 0 && !interim))) {
      if (recall(-1)) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown' && collapsed && historyAt !== -1) {
      if (recall(1)) event.preventDefault();
    }
  }

  // ---- render ----------------------------------------------------------------------
  const placeholder = disabled
    ? disabledReason ?? 'Sending is disabled'
    : running
      ? (queueAvailable ? 'Queue a follow-up — it sends when this turn ends…' : 'Draft your next message…')
      : 'Ask anything — @ to add files, / for commands';

  const permissionValue = view?.controls.permissionMode ?? null;
  const bypassOn = permissionValue === 'bypass';
  const appliesNote = running ? 'Changes apply from the next turn.' : null;
  const pickers = view ? (variant: 'menu' | 'list') => ({
    permission: (
      <ControlMenu<VersePermissionMode> key="permission" label="Permission mode" variant={variant}
        valueLabel={PERMISSION_SHORT[view.controls.permissionMode]}
        valueTitle={labelOf(view.options.permissionModes, view.controls.permissionMode)} iconOnly={fold >= 3}
        options={view.options.permissionModes} value={view.controls.permissionMode}
        onChange={(mode) => { void changePermission(mode); }} disabled={controls.pending}
        shortcut={shortcutLabel('composer.permission')} openRequest={openRequest.permission}
        icon={PERMISSION_GLYPH[view.controls.permissionMode]} danger={bypassOn} note={appliesNote}
        onOpenChange={(open) => setOpenMenus((m) => ({ ...m, permission: open }))} />
    ),
    model: (
      <ControlMenu<string> key="model" label="Model" variant={variant}
        valueLabel={modelName}
        options={view.options.models} value={view.controls.model}
        onChange={(model) => { void changeModel(model); }} disabled={controls.pending}
        shortcut={shortcutLabel('composer.model')} openRequest={openRequest.model} note={appliesNote}
        onOpenChange={(open) => setOpenMenus((m) => ({ ...m, model: open }))} />
    ),
    // No control at all where the seat cannot set effort (local models, an old CLI).
    effort: effortOn ? (
      <ControlMenu<VerseEffort> key="effort" label="Effort" variant={variant}
        valueLabel={fold >= 1 ? effortName : `Effort: ${effortName}`} valueTitle={effortName}
        icon={fold >= 1 ? EFFORT_GLYPH : undefined}
        options={view.options.efforts} value={view.controls.effort}
        defaultOption={{ label: 'Default', description: 'The CLI decides', onSelect: () => { void changeEffort(null); } }}
        onChange={(effort) => { void changeEffort(effort); }} disabled={controls.pending}
        shortcut={shortcutLabel('composer.effort')} openRequest={openRequest.effort} note={appliesNote}
        onOpenChange={(open) => setOpenMenus((m) => ({ ...m, effort: open }))} />
    ) : null,
  }) : null;
  const wide = pickers?.('menu') ?? null;

  // No "Sending…": a label that changes width on Enter would shift the row. The button is disabled +
  // aria-busy instead, which Composer.module.css draws as the accent, pulsing, with a progress cursor —
  // never the quiet grey of an empty box (the text stays in the box until the send is accepted).
  const sendLabel = running ? (queueFull ? 'Queue full' : 'Queue') : locked ? 'Unlock & send' : 'Send';
  const returnKey = <span className={cstyles.sendKey} aria-hidden="true">⏎</span>;

  return (
    <form ref={form} className={`${styles.composer} ${compact ? cstyles.composerCompact : ''}`}
      onSubmit={(event) => { event.preventDefault(); void submit('send'); }} aria-describedby={helpId}
      onDragOver={(event) => {
        if (disabled || !Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={onDrop}>
      {disabled ? null : <ComposerSeatBlock seats={seats} seatId={seat.seatId} onSeatChange={onSeatChange} />}
      {portalInto(queueSlot, (
        <QueueRow queue={queue} running={running} disabled={disabled}
          onEdit={(id, queued) => { void editQueued(id, queued); }}
          onSendNow={(id) => { void followUps.sendNow(id); }}
          onRemove={(id) => { void followUps.remove(id); }} />
      ))}
      <div className={`${styles.box} ${listening ? styles.boxListening : ''} ${dragging ? cstyles.boxDragging : ''} ${bypassOn ? cstyles.boxBypass : ''}`}>
        {suggestOpen ? (
          <SuggestMenu id={suggestId} label={trigger?.kind === 'command' ? 'Commands' : 'Files in this chat’s folders'}
            items={suggestItems} activeIndex={boundedActive} status={suggestStatus}
            onPick={acceptSuggestion} onHover={setActiveIndex} />
        ) : null}
        <AttachmentChips drafts={attachments.drafts} onRemove={(key) => { void removeChip(key); }} disabled={disabled} />
        <textarea ref={textarea} className={styles.textarea} value={text} rows={1} placeholder={placeholder}
          aria-label="Message" disabled={disabled}
          aria-autocomplete={suggestOpen ? 'list' : undefined}
          aria-controls={suggestOpen && suggestItems.length > 0 ? suggestId : undefined}
          aria-expanded={suggestOpen ? true : undefined}
          aria-activedescendant={suggestOpen && suggestItems.length > 0 ? suggestOptionId(suggestId, boundedActive) : undefined}
          onChange={(event) => {
            setInterim('');
            setHistoryAt(-1);
            setDraft(event.target.value);
            setDismissedTrigger(null);
            setCaret(event.target.selectionStart === event.target.selectionEnd ? event.target.selectionStart : null);
          }}
          onSelect={syncCaret} onClick={syncCaret} onKeyUp={(event) => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') syncCaret(); }}
          onBlur={() => setCaret(null)} onFocus={syncCaret}
          onPaste={onPaste} onKeyDown={onKeyDown} />
        <input ref={fileInput} type="file" multiple hidden tabIndex={-1} aria-hidden="true"
          onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
        <div ref={footerRow} className={`${styles.row} ${cstyles.footer}`}>
          <div className={cstyles.footerLeft}>
            <Tooltip label={attachBlocked ?? 'Attach files — or paste, or drop'} shortcut={attachBlocked ? undefined : shortcutLabel('composer.attach')}>
              <button type="button" className={cstyles.iconButton} aria-label="Attach files" aria-disabled={attachBlocked ? true : undefined}
                disabled={disabled} onClick={openFilePicker}>
                <IconPlus width={16} height={16} aria-hidden="true" />
              </button>
            </Tooltip>
            <DictationButton disabled={disabled}
              onInterim={setInterim}
              onFinal={(chunk) => setDraft((current) => (current && !current.endsWith(' ') ? `${current} ${chunk}` : `${current}${chunk}`))}
              onListeningChange={setListening} />
            {!compact && wide ? wide.permission : null}
          </div>
          <div className={cstyles.footerRight}>
            <SeatChip seats={seats} seat={{ seatId: seat.seatId, model: view?.controls.model ?? seat.model }} engine={effectiveEngine}
              label={chipLabel} name={seatName} disabled={disabled} compact={compact || fold >= 2}
              {...(onContinueOn ? { onContinueOn } : {})} onNewChat={onSeatChange} />
            {compact ? null : wide ? wide.model : (
              // No session controls (an older or read-only server, or still loading): the model, stated once, not a picker.
              <span className={cstyles.controlStatic} title={`Model: ${modelName}`}>{modelName}</span>
            )}
            {!compact && wide ? wide.effort : null}
            {!compact ? <ContextRing contextTokens={contextTokens} contextWindow={contextWindow} autoCompactAt={autoCompactAt} exact={contextExact} engine={effectiveEngine} /> : null}
            {compact && view ? (
              <button ref={moreButton} type="button" className={`${cstyles.iconButton} ${bypassOn ? cstyles.iconButtonDanger : ''}`}
                aria-haspopup="dialog" aria-label={`Chat settings: ${labelOf(view.options.permissionModes, view.controls.permissionMode)}, ${modelName}`}
                title="Chat settings" onClick={() => setSheetOpen(true)} disabled={disabled}>
                {MORE_DOTS}
              </button>
            ) : null}
            {running ? (
              <Tooltip label="Stop the running turn — or Esc from an empty box" shortcut="⌘.">
                <button key="stop" type="button" className={`${cstyles.iconButton} ${styles.stop}`} onClick={onStop} aria-label="Stop the running turn">
                  <span className={styles.stopIcon} aria-hidden="true" />
                </button>
              </Tooltip>
            ) : null}
            {/* While a turn runs, Queue stays put — disabled until there is text — so typing never adds a button. */}
            {running && !queueAvailable ? null : (
              <button key={running ? 'queue' : 'send'} type="submit" className={styles.send} disabled={!canSend} aria-busy={sending || undefined}
                aria-label={running ? (queueFull ? 'Queue is full' : 'Queue this message — it sends when the turn ends') : locked ? 'Send (unlocks first)' : 'Send message'}>
                {sendLabel}{returnKey}
              </button>
            )}
          </div>
        </div>
      </div>
      {cost ? (
        <p className={styles.cost} data-tone={cost.tone} role="status">
          <span className={styles.costFigure}>≈{formatTokens(cost.draftTokens)}</span> tokens for this message —
          sending would reach <span className={styles.costFigure}>{cost.projectedPercent}%</span> of the context window.
          {costConsequence(cost)}
          <span className="visually-hidden"> This is an estimate; the provider counts the real total.</span>
        </p>
      ) : null}
      <p id={helpId} className={`${styles.help} ${showHint || tooLong || listening || running || disabled || historyAt !== -1 || showHandoffHelp || note || controls.error || followUps.error ? '' : styles.helpQuiet}`}>
        {tooLong ? <span role="alert" className={styles.helpError}>Message is over 64 KB — trim it before sending.</span>
          : followUps.error ? <span role="alert" className={styles.helpError}>{followUps.error}</span>
            : controls.error && view ? <span role="alert" className={styles.helpError}>{controls.error}</span>
              : note ? <span role={note.error ? 'alert' : 'status'} className={note.error ? styles.helpError : undefined}>{note.text}</span>
                : listening ? 'Listening… Esc stops dictation.'
                  : disabled && disabledReason ? disabledReason
                    : running ? (queueAvailable
                      ? <><kbd>Enter</kbd> queues (sends when this turn ends) · <kbd>{shortcutLabel('composer.stop-and-send')}</kbd> stops and sends · <kbd>Esc</kbd> stops</>
                      : <>Reply in progress — your draft stays here · <kbd>⌘.</kbd> or Stop interrupts the turn</>)
                      : showHandoffHelp
                        ? <>Handoff note drafted from the previous chat — review or edit it; nothing is spent until you press Send.</>
                        : historyAt !== -1 ? <>Recalled message {historyAt + 1} of {history.current.length} · <kbd>↓</kbd> returns to your draft</>
                          : showHint
                            ? <><kbd>Enter</kbd> sends · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line · <kbd>@</kbd> files · <kbd>/</kbd> commands · <kbd>↑</kbd> recalls</>
                            : null}
      </p>
      {/* Mounted whenever there are pickers, not only while the row is
          compact: an open sheet must never be unmounted by a fold (it would
          drop focus to <body> and leave `sheetOpen` set with nothing on screen). */}
      {pickers ? (
        <ControlsSheet open={sheetOpen} onClose={() => { sheetReturnFocus.current = true; setSheetOpen(false); }}>
          {(() => {
            const list = pickers('list');
            return <>{list.permission}{list.model}{list.effort}</>;
          })()}
        </ControlsSheet>
      ) : null}
      <BypassConfirmDialog open={bypassAsk} chatLabel={chipLabel} running={running}
        onCancel={() => { setBypassAsk(false); textarea.current?.focus(); }} onConfirm={() => { void confirmBypass(); }} />
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </form>
  );
}

/** Render `node` into `host` when one is given (the queue's place above the live row), else in place. */
function portalInto(host: HTMLElement | null, node: ReactNode) {
  return host ? createPortal(node, host) : node;
}

function labelOf<T extends string>(options: ReadonlyArray<{ id: T; label: string }> | undefined, id: T): string {
  return options?.find((o) => o.id === id)?.label ?? String(id);
}

/**
 * The sentence after the percentage: what actually happens if this is sent.
 * Worded from the compaction point when it is known, because that — not the
 * window — is where the agent starts losing detail.
 */
export function costConsequence(cost: CostHint): string {
  const bound = cost.exact ? '' : ' (The current size is an upper bound, so this may overstate it.)';
  if (cost.tone === 'over') return ` That is past the whole window — the CLI must compact first, or the turn fails. Continue in a fresh chat.${bound}`;
  if (cost.pastCompaction) return ` That reaches the auto-compaction point, so the CLI will summarise earlier turns during this reply. Continue in a fresh chat to keep full detail.${bound}`;
  if (cost.autoCompactAt !== null) {
    const left = Math.max(0, cost.autoCompactAt - cost.projectedTokens);
    return ` About ${formatTokens(left)} left before the CLI auto-compacts.${cost.tone === 'danger' ? ' Start a new chat to keep the agent sharp.' : ''}${bound}`;
  }
  return `${cost.tone === 'danger' ? ' Start a new chat to keep the agent sharp.' : ''}${bound}`;
}

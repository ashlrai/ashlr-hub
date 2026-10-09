/**
 * routes/verse/NewChatDialog.tsx — start a chat: pick a project (saved
 * projects + enrolled repos + any project a previous chat used, or "Other
 * folder…" with an absolute path), describe the work, and let Automatic pick the resource. Manual selection stays in Advanced.
 * Built on the shared Dialog primitive so focus trap / Escape / return-focus
 * come free.
 *
 * A folder typed here can be KEPT: "Save as a project" writes it to the
 * workspace registry and it is in this picker from then on. Before that
 * button existed the only folders that came back were ones a chat had already
 * been created on (core/verse/projects.ts remembers those), so a folder
 * opened and not chatted on was gone by the next launch.
 *
 * The native directory chooser is offered ALONGSIDE the text input, never
 * instead of it — the same console runs in a plain browser, where there is no
 * chooser at all.
 *
 * The seat list is where the choice actually GETS MADE, so the picked seat's
 * capacity is shown here too, under the picker: plan, the binding window as a
 * meter, its reset verbatim, and any credit balance — the same projection the
 * resources panel renders, so the two can never describe one seat differently.
 *
 * Opening the dialog also re-reads the roster. `bootstrap` has no SSE
 * invalidation and the account collector needs ~75s to warm, so a dialog
 * opened early in a session would otherwise show the cold, empty reading
 * taken at mount and present it as the state of the world.
 *
 * V3.9 — THE CONTEXT A CHAT WILL HAVE IS DECIDED HERE TOO (docs/VERSE-CONTEXT.md):
 *
 *  - CONTEXT MODE. For a model with a real expansive budget (1M Claude
 *    models, GPT-6 / GPT-5.6 on Codex) the operator picks Standard or
 *    Expansive, defaulting to the seat's saved preference, and can make the
 *    choice that seat's default. The mode is sent explicitly whenever there
 *    was a choice, so the chat is created in exactly the mode on screen — even
 *    if the preference changed underneath the open dialog.
 *  - CONTEXT FIT. The chosen folders (or saved project) are sized by
 *    GET /context-fit — git ls-files, bytes ÷ 4, zero spend — and every model
 *    row compares the tracked project inventory against one context. This is
 *    advisory: a focused task can read relevant files without loading it all.
 *    Suggests, never switches: nothing here changes the mode on its own.
 *  - SEAT FACTS. The chosen seat's pinned CLI version and its own notes
 *    (binary skew, catalog not fetched yet) are shown in visible text; a
 *    model the pinned CLI cannot run is refused here, with the reason, rather
 *    than at turn time.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import type { VerseCreateSessionRequest, VerseModelOption, VerseProject, VerseSeat, VerseWorkspace } from '../../data/api-types.js';
import type { VerseContextFit, VerseContextMode, VersePreferences } from '../../../core/verse/types.js';
import { budgetFor, hasExpansiveMode } from '../../../core/verse/context-math.js';
import { Dialog } from '../../components/primitives/Dialog.js';
import { Segmented } from '../../components/primitives/Segmented.js';
import { ApiError } from '../../data/client.js';
import { useRefetch } from '../../data/hooks.js';
import { fetchContextFit, fetchPreferences, updatePreferences } from './context/context-queries.js';
import { defaultWorktreeName, isValidWorktreeName, resolveChatFolder, WorktreeOption, type WorktreeValue } from './git/WorktreeOption.js';
import { describeGitError } from './git/git-model.js';
import { defaultSeatChoice, SeatSelector, type SeatChoice } from './SeatSelector.js';
import { initialAutoSeat } from './multimodel/initial-auto-seat.js';
import { labelPromptRemote } from './multimodel/multimodel-queries.js';
import { LiveCapacityStrip } from './usage/CapacityStrip.js';
import {
  CONTEXT_MODE_LABEL,
  FIT_LABEL,
  fitMethodNote,
  contextModeDescription,
  effectiveBudget,
  fitExplanation,
  fitIsFloor,
  modelFit,
  modelUnavailableReason,
  noModeReason,
  resolveContextMode,
  seatCliLine,
  seatContextNotes,
  seatModelOption,
} from './usage/context-model.js';
import { WINDOW_SOURCE_TEXT } from './verse-model.js';
import {
  defaultWorkspaceName,
  extraRootsCaveat,
  extraRootsNote,
  MAX_WORKSPACE_ROOTS,
  validateRootSet,
  workspaceSummary,
} from './workspace-model.js';
import { createVerseWorkspace, verseBootstrapQuery, VerseMutationLockedError } from './verse-queries.js';
import { formatTokens } from './verse-readouts.js';
import { nativePickerAvailable, pickDirectory } from './folder-picker.js';
import styles from './NewChatDialog.module.css';

/** 3.16: local-model facts + Warm up, in their own lazy chunk. */
const LocalSeatBadge = lazy(() => import('./multimodel/LocalSeatBadge.js'));

/**
 * Prefix marking a select value as a WORKSPACE id rather than a folder path.
 * Safe for the same reason `OTHER` is: it starts with a NUL, and a filesystem
 * path can never contain one.
 */
const WORKSPACE_PREFIX = '\0workspace:';

const OTHER = '\u0000other';

/**
 * How long a typed path must sit still before it is sized. Sizing is cheap
 * and cached server-side (60 s), but a request per keystroke would still
 * spawn `git ls-files` for every prefix of a path being typed.
 */
export const FIT_DEBOUNCE_MS = 350;

/**
 * Runs a write that needs the mutation token. ChatSection passes its own guard
 * (which opens the token dialog and resumes); resolving `null` means the
 * operator dismissed that dialog and nothing was written.
 */
export type RunMutation = <T>(reason: string, action: () => Promise<T>) => Promise<T | null>;

const runDirectly: RunMutation = (_reason, action) => action();

/** How a "make this the default" write ended — carried as a value so no guard can swallow a failure. */
type DefaultSave = { ok: true; prefs: VersePreferences } | { ok: false; error: unknown };

type FitState =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; fit: VerseContextFit }
  | { status: 'error'; key: string; message: string };

/** The seat's saved default mode for new chats; `standard` when none, or when preferences are unread. */
export function seatPreferredMode(prefs: VersePreferences | null, seatId: string): VerseContextMode {
  return prefs?.seats[seatId]?.contextMode ?? 'standard';
}

/**
 * Whether the create request carries `contextMode`, and which.
 *
 * Sent whenever the operator HAD a choice (the model has an expansive budget),
 * so the chat starts in exactly the mode on screen. Also sent — as `standard` —
 * when the seat's saved default is a mode this model does not have, so the
 * server's default resolution can never reject a model the operator was
 * allowed to pick. Otherwise omitted: the server's own default is the only
 * possible answer, and a model with no known window has no budget to name.
 */
export function requestContextMode(option: VerseModelOption | null, mode: VerseContextMode, preferred: VerseContextMode): VerseContextMode | null {
  if (!option) return null;
  if (hasExpansiveMode(option)) return resolveContextMode(option, mode);
  if (preferred !== 'standard' && budgetFor(option, 'standard') !== null) return 'standard';
  return null;
}

/** The operator-facing sentence for a failed read or write: the server's own words first. */
function describeError(err: unknown): string {
  if (err instanceof VerseMutationLockedError) return 'Unlock actions with the mutation token to save a default.';
  if (err instanceof ApiError) return err.detail ?? err.message;
  return err instanceof Error ? err.message : String(err);
}

/** View preference only; never part of the session API body. */
export interface NewChatRoutingOptions { automatic: boolean }

export interface NewChatDialogProps {
  open: boolean;
  onClose: () => void;
  projects: readonly VerseProject[];
  seats: readonly VerseSeat[];
  /** Named multi-folder workspaces. Absent on an older server. */
  workspaces?: readonly VerseWorkspace[];
  /** Pre-fill (e.g. "same project, different seat" from the composer). */
  initialProjectPath?: string | null;
  initialSeat?: SeatChoice | null;
  /** Only an explicit “New chat on…” choice pins the initial resource. */
  initialManual?: boolean;
  busy?: boolean;
  error?: string | null;
  onCreate: (req: VerseCreateSessionRequest, firstMessage?: string, routing?: NewChatRoutingOptions) => Promise<void> | void;
  /** Existing guard for Jev labelling, worktree creation and saved preferences. */
  runMutation?: RunMutation;
}

export function NewChatDialog({ open, onClose, projects, seats, workspaces = [], initialProjectPath, initialSeat, initialManual = false, busy = false, error, onCreate, runMutation = runDirectly }: NewChatDialogProps) {
  const titleId = useId();
  const projectId = useId();
  const pathId = useId();
  const nameId = useId();
  const seatId = useId();
  const promptId = useId();
  const advancedId = useId();
  const firstField = useRef<HTMLTextAreaElement>(null);
  const [projectChoice, setProjectChoice] = useState<string>('');
  const [customPath, setCustomPath] = useState('');
  const [seat, setSeat] = useState<SeatChoice | null>(null);
  const [title, setTitle] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [manual, setManual] = useState(initialManual);
  const [advanced, setAdvanced] = useState(initialManual);
  const [routing, setRouting] = useState(false);
  const submission = useRef<AbortController | null>(null);
  useEffect(() => () => submission.current?.abort(), []);
  useEffect(() => {
    if (!open) {
      submission.current?.abort();
      submission.current = null;
    }
  }, [open]);
  const [localError, setLocalError] = useState<string | null>(null);
  /** Ad-hoc folders beyond the primary, when not binding to a workspace. */
  const [extraRoots, setExtraRoots] = useState<string[]>([]);
  /**
   * Projects saved from THIS dialog, held locally as well as sent.
   *
   * `workspaces` is refreshed by the cache invalidation the mutation triggers,
   * but that is a round trip. Keeping the created record here means the option
   * the operator just saved is in the picker on the very next paint — the
   * whole promise of the button is that the folder is now kept, so a second of
   * "did that work?" would undo it.
   */
  const [saved, setSaved] = useState<VerseWorkspace[]>([]);
  const [savingProject, setSavingProject] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  /** The operator's standing choices; null until read (or when the read failed — then every seat defaults to Standard). */
  const [prefs, setPrefs] = useState<VersePreferences | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);
  /** An explicit mode pick for the chosen model; null = follow the seat's saved default. */
  const [modeChoice, setModeChoice] = useState<VerseContextMode | null>(null);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultNote, setDefaultNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [fitState, setFitState] = useState<FitState>({ status: 'idle' });
  /** "Isolate in a worktree" (C5): off by default; a name is offered once it is turned on. */
  const [worktree, setWorktree] = useState<WorktreeValue>({ enabled: false, name: '' });
  /** True while the worktree is being created, before the chat is. */
  const [isolating, setIsolating] = useState(false);
  /** Readings taken while this dialog is open, so flipping between folders does not re-ask. */
  const fitCache = useRef(new Map<string, VerseContextFit>());

  const sortedProjects = useMemo(() => [...projects].sort((a, b) => Number(b.enrolled) - Number(a.enrolled) || a.name.localeCompare(b.name)), [projects]);

  // Reset to the caller's pre-fill ONLY on the open transition. The pre-fill
  // inputs are read through a ref: `projects`/`seats` are fresh arrays on
  // every bootstrap refetch (which any turn finishing elsewhere triggers),
  // and re-running the reset on those would wipe a half-typed path or title.
  const prefill = useRef({ initialProjectPath, initialSeat, initialManual, projects, seats, sortedProjects });
  prefill.current = { initialProjectPath, initialSeat, initialManual, projects, seats, sortedProjects };
  useEffect(() => {
    if (!open) return;
    const { initialProjectPath: path, initialSeat: seatChoice, initialManual: isManual, projects: known, seats: available, sortedProjects: sorted } = prefill.current;
    const knownPath = path && known.some((p) => p.path === path) ? path : null;
    setProjectChoice(knownPath ?? (path ? OTHER : sorted[0]?.path ?? OTHER));
    setCustomPath(knownPath ? '' : path ?? '');
    setSeat(normalizeChoice(seatChoice ?? null, available) ?? defaultSeatChoice(available));
    setTitle('');
    setFirstMessage('');
    setManual(isManual);
    setAdvanced(isManual);
    setRouting(false);
    setLocalError(null);
    setExtraRoots([]);
    setSavedNote(null);
    setSavingProject(false);
    setSaved([]);
    setModeChoice(null);
    setDefaultNote(null);
    setSavingDefault(false);
    setWorktree({ enabled: false, name: defaultWorktreeName() });
    setIsolating(false);
    fitCache.current = new Map();
  }, [open]);

  // Preferences are re-read on every open: a default saved from another tab
  // (or by the CLI) must be what this dialog starts from.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setPrefsError(null);
    fetchPreferences()
      .then((next) => {
        if (!cancelled) setPrefs(next);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPrefs(null);
        setPrefsError(describeError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Seats that arrive after the dialog opened (slow bootstrap) fill an empty
  // seat once, without touching anything the operator has typed.
  useEffect(() => {
    if (!open || seat !== null || seats.length === 0) return;
    setSeat(normalizeChoice(initialSeat ?? null, seats) ?? defaultSeatChoice(seats));
  }, [open, seat, seats, initialSeat]);

  // One re-read per open, not per render: the roster is worth a fresh look at
  // the moment a seat is about to be chosen, and worth nothing after that.
  const refetchBootstrap = useRefetch(verseBootstrapQuery);
  useEffect(() => {
    if (open) refetchBootstrap();
  }, [open, refetchBootstrap]);

  // The picker's saved-project list: what the server has, plus anything saved
  // in this dialog that the refreshed list has not caught up with yet.
  const savedProjects = useMemo(() => {
    const byId = new Map<string, VerseWorkspace>();
    for (const w of workspaces) byId.set(w.id, w);
    for (const w of saved) if (!byId.has(w.id)) byId.set(w.id, w);
    return [...byId.values()];
  }, [workspaces, saved]);

  const usingWorkspace = projectChoice.startsWith(WORKSPACE_PREFIX);
  const workspaceId = usingWorkspace ? projectChoice.slice(WORKSPACE_PREFIX.length) : null;
  const projectPath = usingWorkspace ? '' : projectChoice === OTHER ? customPath.trim() : projectChoice;
  const chosenSeat = seat === null ? null : seats.find((s) => s.id === seat.seatId) ?? null;
  const chosenOption = chosenSeat === null || seat === null ? null : seatModelOption(chosenSeat, seat.model);
  const disabledSeat = chosenSeat?.health.state === 'unavailable';
  // A model the pinned CLI cannot run is refused HERE, with its reason, not at
  // turn time — and a model the seat no longer lists is not a choice at all.
  const modelReason = chosenSeat !== null && chosenOption !== null ? modelUnavailableReason(chosenSeat, chosenOption) : null;
  // Isolation applies to an ad-hoc folder only: a saved project's roots are
  // fixed in the registry (the same reason extra folders are hidden for one).
  const offersWorktree = !usingWorkspace && projectPath.length > 0;
  const isolate = offersWorktree && worktree.enabled;
  const canCreate = !busy && !isolating && !routing && (usingWorkspace || projectPath.length > 0)
    && (manual ? seat !== null && !disabledSeat && chosenOption !== null && modelReason === null : firstMessage.trim().length > 0 && seats.length > 0)
    && (!isolate || isValidWorktreeName(worktree.name));
  const chosenWorkspace = workspaceId === null ? null : savedProjects.find((w) => w.id === workspaceId) ?? null;

  // ---- context mode ------------------------------------------------------
  const preferredMode = seat === null ? 'standard' : seatPreferredMode(prefs, seat.seatId);
  const chatMode = resolveContextMode(chosenOption, modeChoice ?? preferredMode);
  const offersModes = hasExpansiveMode(chosenOption);
  const savedDefault = resolveContextMode(chosenOption, preferredMode);

  /** Every OTHER row shows its seat's default mode; the chosen row shows the mode picked for it. */
  const modeFor = useCallback((rowSeat: VerseSeat, model: VerseModelOption): VerseContextMode => {
    if (seat !== null && rowSeat.id === seat.seatId && model.id === seat.model) return chatMode;
    return resolveContextMode(model, seatPreferredMode(prefs, rowSeat.id));
  }, [seat, chatMode, prefs]);

  function chooseSeat(choice: SeatChoice) {
    setManual(true);
    setSeat(choice);
    // A mode picked for one model says nothing about another: follow the new
    // seat's saved default until the operator picks again.
    setModeChoice(null);
    setDefaultNote(null);
  }

  async function makeSeatDefault() {
    if (seat === null || chosenSeat === null) return;
    const mode = chatMode;
    setSavingDefault(true);
    setDefaultNote(null);
    try {
      // The action SETTLES as a value, never as a rejection. A guard that parks
      // the action behind the token prompt and runs it after the unlock may not
      // forward a rejection (ChatSection's `withToken` resolves only), and then
      // this function's catch/finally would never run: the button would sit on
      // "Saving…" for the rest of the dialog with no error shown. Catching
      // here makes both outcomes reach the code below whichever guard runs it.
      const outcome = await runMutation(`Saving ${CONTEXT_MODE_LABEL[mode]} as the default context mode for ${chosenSeat.label}.`,
        () => updatePreferences({ seatId: seat.seatId, contextMode: mode }).then(
          (saved): DefaultSave => ({ ok: true, prefs: saved }),
          (error: unknown): DefaultSave => ({ ok: false, error }),
        ));
      if (outcome === null) return; // the operator closed the token prompt: nothing was sent
      if (!outcome.ok) {
        setDefaultNote({ ok: false, text: describeError(outcome.error) });
        return;
      }
      setPrefs(outcome.prefs);
      setModeChoice(null);
      setDefaultNote({ ok: true, text: `New chats on ${chosenSeat.label} now start in ${CONTEXT_MODE_LABEL[mode]}.` });
    } catch (err) {
      // Only the guard itself can still throw here (e.g. a direct run with no token held).
      setDefaultNote({ ok: false, text: describeError(err) });
    } finally {
      setSavingDefault(false);
    }
  }

  // ---- context fit -------------------------------------------------------
  // What to size: the saved project by id (the server reads its roots), or
  // the ad-hoc folder set once it validates. Nothing is sized for a path that
  // is still being typed into something invalid.
  const fitRequest = useMemo((): { key: string; query: { workspaceId?: string; projectPath?: string; extraRoots?: string[] } } | null => {
    if (workspaceId !== null) return { key: `w:${workspaceId}`, query: { workspaceId } };
    if (usingWorkspace) return null;
    const validation = validateRootSet(projectPath, extraRoots);
    if (!validation.ok) return null;
    const [primary, ...rest] = validation.roots;
    return {
      key: `p:${validation.roots.join('\n')}`,
      query: rest.length > 0 ? { projectPath: primary!, extraRoots: rest } : { projectPath: primary! },
    };
  }, [workspaceId, usingWorkspace, projectPath, extraRoots]);
  const fitRequestRef = useRef(fitRequest);
  fitRequestRef.current = fitRequest;
  const fitKey = fitRequest?.key ?? null;

  useEffect(() => {
    const request = fitRequestRef.current;
    if (!open || fitKey === null || request === null) {
      setFitState({ status: 'idle' });
      return undefined;
    }
    const cached = fitCache.current.get(fitKey);
    if (cached) {
      setFitState({ status: 'ready', key: fitKey, fit: cached });
      return undefined;
    }
    let cancelled = false;
    setFitState({ status: 'loading', key: fitKey });
    const timer = setTimeout(() => {
      fetchContextFit(request.query)
        .then((fit) => {
          fitCache.current.set(fitKey, fit);
          if (!cancelled) setFitState({ status: 'ready', key: fitKey, fit });
        })
        .catch((err: unknown) => {
          if (!cancelled) setFitState({ status: 'error', key: fitKey, message: describeError(err) });
        });
    }, FIT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, fitKey]);

  // The reading for the folders on screen NOW. Between a change and the
  // effect that re-reads, the held state belongs to the previous folders, so
  // it is shown as "sizing" rather than attributed to the new ones.
  const currentFit: FitState = fitKey === null
    ? { status: 'idle' }
    : fitState.status !== 'idle' && fitState.key === fitKey ? fitState : { status: 'loading', key: fitKey };
  const fit = currentFit.status === 'ready' ? currentFit.fit : null;

  // A seat whose CLI takes no additional-directory flag reaches only the
  // primary folder. Say that at the point the extra folders are chosen, rather
  // than letting the operator discover it from a diff that will not apply.
  // This holds for a SAVED project too — a project saved with three folders
  // still reaches one of them on a Grok seat, and the picker is the only place
  // that knows both facts at once.
  const adHocNote = extraRootsNote(chosenSeat?.engine ?? null, 1 + extraRoots.length);
  const workspaceCaveat = extraRootsCaveat(chosenSeat?.engine ?? null, chosenWorkspace?.roots.length ?? 0);

  /** The native chooser, where there is one. The text input never goes away. */
  const showPicker = nativePickerAvailable();
  async function choosePrimary() {
    const picked = await pickDirectory();
    if (picked !== null && picked.length > 0) {
      setProjectChoice(OTHER);
      setCustomPath(picked);
    }
  }
  async function chooseExtra(index: number) {
    const picked = await pickDirectory();
    if (picked !== null && picked.length > 0) {
      setExtraRoots(extraRoots.map((r, i) => (i === index ? picked : r)));
    }
  }

  /**
   * Keep the folder set that is on screen, so it is in this picker next time.
   *
   * Deliberately one press with no naming step: the folder's own name is very
   * nearly always the right one, and the project can be renamed from the
   * sidebar. A dialog inside a dialog to collect a name would cost more than
   * it is worth at the moment someone just wants to keep a folder.
   */
  async function saveProject() {
    const validation = validateRootSet(projectPath, extraRoots);
    if (!validation.ok) {
      setLocalError(validation.error);
      return;
    }
    setSavingProject(true);
    setLocalError(null);
    setSavedNote(null);
    try {
      const name = defaultWorkspaceName(validation.roots[0]!);
      const workspace = await createVerseWorkspace({ name, roots: validation.roots });
      setSaved((prev) => [...prev, workspace]);
      setProjectChoice(`${WORKSPACE_PREFIX}${workspace.id}`);
      setSavedNote(`Saved. “${workspace.name}” is in this list from now on.`);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingProject(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || isolating || submission.current) return;
    const validation = validateRootSet(projectPath, extraRoots);
    const roots = workspaceId === null ? (validation.ok ? validation.roots : []) : chosenWorkspace?.roots.map((root) => root.path) ?? [];
    if (workspaceId === null && !validation.ok) {
      setLocalError(validation.error);
      return;
    }
    if (isolate && !isValidWorktreeName(worktree.name)) {
      setLocalError('Name the worktree with letters, digits, dots, dashes or underscores.');
      return;
    }
    if (!manual && !firstMessage.trim()) {
      setLocalError('Describe what you want to work on.');
      return;
    }
    const controller = new AbortController();
    submission.current = controller;
    setLocalError(null);
    setRouting(!manual);
    try {
      const choice = manual ? seat : await initialAutoSeat({
        text: firstMessage.trim(), roots, seats, signal: controller.signal,
        label: (request) => runMutation('Choosing a resource for your message with the decision adviser.', () => labelPromptRemote(request)),
      });
      controller.signal.throwIfAborted();
      if (choice === null) return;
      if (choice.model === null) throw new Error('No runnable model is available for this resource.');
      const selectedSeat = seats.find((candidate) => candidate.id === choice.seatId);
      const option = seatModelOption(selectedSeat, choice.model);
      if (!selectedSeat || selectedSeat.health.state === 'unavailable') throw new Error('Choose an available resource.');
      if (!option) throw new Error('Pick a model this resource offers.');
      const reason = modelUnavailableReason(selectedSeat, option);
      if (reason) throw new Error(`${option.label} cannot run on this seat: ${reason}.`);
      const req: VerseCreateSessionRequest = { projectPath: roots[0]!, seatId: choice.seatId, model: choice.model };
      if (workspaceId !== null) {
        req.workspaceId = workspaceId;
        delete (req as Partial<VerseCreateSessionRequest>).projectPath;
      } else if (roots.length > 1) req.extraRoots = roots.slice(1);
      const named = title.trim();
      if (named) req.title = named;
      const preferred = seatPreferredMode(prefs, choice.seatId);
      const mode = requestContextMode(option, manual ? chatMode : resolveContextMode(option, preferred), preferred);
      if (mode !== null) req.contextMode = mode;
      if (isolate) await createIsolated(roots[0]!, req, firstMessage.trim() || undefined, { automatic: !manual }, controller.signal);
      else await onCreate(req, firstMessage.trim() || undefined, { automatic: !manual });
    } catch (err) {
      if (!controller.signal.aborted) setLocalError(describeError(err));
    } finally {
      if (submission.current === controller) submission.current = null;
      if (!controller.signal.aborted) setRouting(false);
    }
  }

  /**
   * "Isolate in a worktree": create `~/.ashlr-worktrees/<repo>/<name>` on
   * `verse/<name>` FIRST (a git write — through the same token guard as every
   * other write this dialog makes), then start the chat in it. Only the
   * primary folder moves; extra folders stay where they are. A refusal (a
   * taken name, a folder that is not a repository, a repo with no commits)
   * is shown here and no chat is created.
   */
  async function createIsolated(primary: string, req: VerseCreateSessionRequest, prompt: string | undefined, routing: NewChatRoutingOptions, signal: AbortSignal) {
    setIsolating(true);
    try {
      const outcome = await runMutation(`Creating the worktree ${worktree.name} (a new branch verse/${worktree.name}) for this chat.`,
        () => resolveChatFolder(primary, worktree).then(
          (folder): { ok: true; folder: string } | { ok: false; error: unknown } => ({ ok: true, folder }),
          (error: unknown): { ok: false; error: unknown } => ({ ok: false, error }),
        ));
      if (outcome === null) return; // the token prompt was dismissed: nothing was created
      if (!outcome.ok) {
        setLocalError(`The worktree could not be created: ${describeGitError(outcome.error)}`);
        return;
      }
      if (signal.aborted) return;
      await onCreate({ ...req, projectPath: outcome.folder }, prompt, routing);
    } catch (err) {
      setLocalError(describeGitError(err));
    } finally {
      if (!signal.aborted) setIsolating(false);
    }
  }

  const message = localError ?? error ?? null;

  return (
    <Dialog open={open} onClose={onClose} titleId={titleId} title="New chat" initialFocusRef={firstField} widthClassName={styles.width}>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.fields} disabled={routing || busy || isolating}>
        <label className={styles.field} htmlFor={promptId}>
          <span className={styles.label}>What would you like to work on?</span>
          <textarea id={promptId} ref={firstField} className={`${styles.input} ${styles.prompt}`} value={firstMessage}
            onChange={(event) => setFirstMessage(event.target.value)} disabled={routing || busy || isolating}
            placeholder="Describe the outcome. Automatic chooses a connected resource for your message." />
        </label>
        <label className={styles.field} htmlFor={projectId}>
          <span className={styles.label}>Project</span>
          <select id={projectId} value={projectChoice} onChange={(event) => setProjectChoice(event.target.value)} className={styles.select}>
            {/* The group exists only when there is something in it. An empty
                "Saved projects" heading is a promise the console cannot keep,
                and until this dialog could create one it was exactly that. */}
            {savedProjects.length > 0 ? (
              <optgroup label="Saved projects">
                {savedProjects.map((w) => (
                  <option key={w.id} value={`${WORKSPACE_PREFIX}${w.id}`}>
                    {w.name} — {workspaceSummary(w)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {sortedProjects.map((p) => (
              <option key={p.path} value={p.path}>{p.name}{p.enrolled ? '' : ' (recent)'} — {p.path}</option>
            ))}
            <option value={OTHER}>Other folder…</option>
          </select>
        </label>
        {projectChoice === OTHER && !usingWorkspace ? (
          <label className={styles.field} htmlFor={pathId}>
            <span className={styles.label}>Folder path</span>
            {/* The text input is unconditional: the console also runs in a
                plain browser, which has no directory chooser at all. The
                native button is an ADDITION where a shell can provide one. */}
            <div className={styles.rootRow}>
              <input id={pathId} className={styles.input} value={customPath} onChange={(event) => setCustomPath(event.target.value)}
                placeholder="/absolute/path/to/project" autoComplete="off" spellCheck={false} />
              {showPicker ? (
                <button type="button" className={styles.addRoot} onClick={() => void choosePrimary()}>Choose folder…</button>
              ) : null}
            </div>
          </label>
        ) : null}
        {workspaceCaveat ? <p className={styles.hint}>{workspaceCaveat}</p> : null}
        {/* Extra folders, for the very common "this service plus the shared
            library it depends on". Hidden for a workspace, whose roots are
            defined once in the registry and must not be edited per chat —
            that is the difference between a workspace and an ad-hoc set. */}
        {usingWorkspace ? null : (
          <div className={styles.field}>
            <span className={styles.label}>
              Also include <span className={styles.optional}>optional</span>
            </span>
            {extraRoots.map((root, index) => (
              <div key={index} className={styles.rootRow}>
                <input
                  className={styles.input}
                  value={root}
                  onChange={(event) => setExtraRoots(extraRoots.map((r, i) => (i === index ? event.target.value : r)))}
                  placeholder="/absolute/path/to/another/folder"
                  aria-label={`Additional folder ${index + 1}`}
                  autoComplete="off"
                  spellCheck={false}
                />
                {showPicker ? (
                  <button
                    type="button"
                    className={styles.removeRoot}
                    onClick={() => void chooseExtra(index)}
                    aria-label={`Choose additional folder ${index + 1}`}
                  >Choose folder…</button>
                ) : null}
                <button
                  type="button"
                  className={styles.removeRoot}
                  onClick={() => setExtraRoots(extraRoots.filter((_, i) => i !== index))}
                  aria-label={`Remove additional folder ${index + 1}`}
                >Remove</button>
              </div>
            ))}
            {extraRoots.length + 1 < MAX_WORKSPACE_ROOTS ? (
              <button type="button" className={styles.addRoot} onClick={() => setExtraRoots([...extraRoots, ''])}>
                Add a folder
              </button>
            ) : null}
            {adHocNote ? <p className={styles.hint}>{adHocNote}</p> : null}
            {/* Keep this folder set. Nothing about a SAVED project can be
                edited per chat — that is the difference between a project and
                an ad-hoc set — so the offer appears only on the ad-hoc path. */}
            <div className={styles.rootRow}>
              <button type="button" className={styles.addRoot} onClick={() => void saveProject()}
                disabled={savingProject || projectPath.length === 0}>
                {savingProject ? 'Saving…' : 'Save as a project'}
              </button>
              <span className={styles.hint}>Keeps these folders in the list above. No chat needed first.</span>
            </div>
          </div>
        )}
        {/* OUTSIDE the ad-hoc block on purpose: saving switches the picker to
            the project it just created, which unmounts that block — and the
            confirmation that the folder was kept is exactly what must not
            disappear at that moment. */}
        {savedNote ? <p role="status" className={styles.hint}>{savedNote}</p> : null}

        {offersWorktree ? (
          <WorktreeOption repoName={folderName(projectPath)} value={worktree} onChange={setWorktree} disabled={isolating || busy} />
        ) : null}

        <p className={styles.hint}>{manual ? 'Manual · your selected resource will handle this message.' : 'Automatic · chooses a connected resource for your message using availability, capability and project privacy.'}</p>
        <button type="button" className={styles.addRoot} aria-expanded={advanced} aria-controls={advancedId}
          onClick={() => setAdvanced(!advanced)} disabled={routing || busy || isolating}>Advanced</button>
        {advanced ? <div id={advancedId} className={styles.form}>
        <div className={styles.rootRow}>
          <button type="button" className={styles.addRoot} aria-pressed={!manual} onClick={() => setManual(false)}>Automatic</button>
          <button type="button" className={styles.addRoot} aria-pressed={manual} onClick={() => setManual(true)}>Manual</button>
        </div>
        {!manual ? <p className={styles.hint}>Choose a resource below to switch to Manual.</p> : null}
        <SeatSelector id={seatId} seats={seats} value={seat} onChange={chooseSeat}
          workingSetTokens={fit?.totalEstTokens ?? null} modeFor={modeFor} />
        {/* THE shared capacity view (usage/CapacityStrip, SPEC-310C §4), for
            the chosen seat. Full density on purpose: the verbatim reset and
            any credit balance are what decide "can I start this now", and
            the compact row drops both. */}
        {chosenSeat === null ? null : (
          <div className={styles.capacity}>
            <LiveCapacityStrip seats={seats} seatIds={[chosenSeat.id]} local="each" headline={false}
              title={`${chosenSeat.label} capacity`} />
          </div>
        )}
        {/* 3.16: a local model's facts (private, context, speed, Warm up) and a local-only repo's warning. */}
        <Suspense fallback={null}>
          <LocalSeatBadge seatId={chosenSeat?.engine === 'local' ? chosenSeat.id : null}
            projectPath={projectPath.startsWith('/') ? projectPath : null} />
        </Suspense>
        {chosenSeat === null || chosenOption === null ? null : (
          <ContextChoice
            seat={chosenSeat}
            option={chosenOption}
            unavailableReason={modelReason}
            mode={chatMode}
            offersModes={offersModes}
            savedDefault={savedDefault}
            prefsLoaded={prefs !== null}
            prefsError={prefsError}
            onMode={(mode) => {
              setManual(true);
              setModeChoice(mode);
              setDefaultNote(null);
            }}
            savingDefault={savingDefault}
            defaultNote={defaultNote}
            onMakeDefault={() => void makeSeatDefault()}
            fitState={currentFit}
          />
        )}
        {seats.length === 0 ? <p className={styles.hint}>No seats yet — connect an account or start Ollama, then reload.</p> : null}
        <label className={styles.field} htmlFor={nameId}>
          <span className={styles.label}>Title <span className={styles.optional}>optional</span></span>
          <input id={nameId} className={styles.input} value={title} onChange={(event) => setTitle(event.target.value)}
            placeholder="Defaults to your first message" maxLength={120} />
        </label>
        </div> : null}
        </fieldset>
        {message ? <p role="alert" className={styles.error}>{message}</p> : null}
        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.create} disabled={!canCreate}>
            {isolating ? 'Creating worktree…' : busy ? 'Creating…' : routing ? 'Choosing resource…' : 'Start chat'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The last segment of a folder path — the repository name the worktree hint shows. */
function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * A pre-fill resolved against the CURRENT roster: an aliased model id (a chat
 * remembered on `claude-opus-5.5`) becomes the seat's own spelling, so the
 * picker shows the choice instead of "Choose a seat…". Nothing else changes —
 * a remembered model the pinned CLI cannot run stays chosen, so its reason is
 * shown rather than the choice being silently swapped for another.
 */
export function normalizeChoice(choice: SeatChoice | null, seats: readonly VerseSeat[]): SeatChoice | null {
  if (choice === null) return null;
  const seat = seats.find((s) => s.id === choice.seatId);
  const option = seatModelOption(seat, choice.model);
  return option === null ? choice : { seatId: choice.seatId, model: option.id };
}

interface ContextChoiceProps {
  seat: VerseSeat;
  option: VerseModelOption;
  unavailableReason: string | null;
  mode: VerseContextMode;
  offersModes: boolean;
  /** The seat's saved default, resolved for this model. */
  savedDefault: VerseContextMode;
  prefsLoaded: boolean;
  prefsError: string | null;
  onMode: (mode: VerseContextMode) => void;
  savingDefault: boolean;
  defaultNote: { ok: boolean; text: string } | null;
  onMakeDefault: () => void;
  fitState: FitState;
}

/**
 * The chosen model's context, under the picker: its budget and provenance,
 * the mode selector (only where a real second budget exists), the fit verdict
 * for the chosen folders, and the seat's pinned CLI and notes.
 */
function ContextChoice({
  seat,
  option,
  unavailableReason,
  mode,
  offersModes,
  savedDefault,
  prefsLoaded,
  prefsError,
  onMode,
  savingDefault,
  defaultNote,
  onMakeDefault,
  fitState,
}: ContextChoiceProps) {
  const labelId = useId();
  const budget = effectiveBudget(option, mode);
  const cli = seatCliLine(seat);
  const notes = seatContextNotes(seat);
  const verdict = fitState.status === 'ready' ? modelFit(fitState.fit.totalEstTokens, option, mode, seat.engine) : null;

  return (
    <div className={styles.context} role="group" aria-labelledby={labelId}>
      <div className={styles.contextHead}>
        <span id={labelId} className={styles.label}>Context</span>
        <span className={styles.contextBudget}>
          {budget === null
            ? 'Window unknown'
            : `${formatTokens(budget.contextWindow)} window${budget.autoCompactAt === null ? '' : ` · compacts ≈${formatTokens(budget.autoCompactAt)}`}`}
        </span>
      </div>
      {budget !== null && option.windowSource ? (
        <p className={styles.hint}>Window {WINDOW_SOURCE_TEXT[option.windowSource]}.</p>
      ) : null}

      {unavailableReason !== null ? (
        <p className={styles.warn}>{option.label} cannot run on this seat: {unavailableReason}. Pick another model.</p>
      ) : null}

      {offersModes ? (
        <>
          <Segmented<VerseContextMode>
            aria-label="Context mode"
            size="sm"
            value={mode}
            onChange={onMode}
            options={(['standard', 'expansive'] as const).map((m) => {
              const b = budgetFor(option, m);
              return {
                value: m,
                label: b === null ? CONTEXT_MODE_LABEL[m] : `${CONTEXT_MODE_LABEL[m]} · ≈${formatTokens(b.autoCompactAt ?? b.contextWindow)}`,
                ariaLabel: CONTEXT_MODE_LABEL[m],
              };
            })}
          />
          <p className={styles.hint}>{contextModeDescription(seat.engine, option, mode)}</p>
          {prefsLoaded && mode !== savedDefault ? (
            <div className={styles.rootRow}>
              <button type="button" className={styles.addRoot} onClick={onMakeDefault} disabled={savingDefault}>
                {savingDefault ? 'Saving…' : `Make ${CONTEXT_MODE_LABEL[mode]} the default for ${seat.label}`}
              </button>
            </div>
          ) : null}
          {defaultNote !== null ? (
            <p role={defaultNote.ok ? 'status' : 'alert'} className={defaultNote.ok ? styles.hint : styles.error}>{defaultNote.text}</p>
          ) : null}
          {prefsError !== null ? (
            <p className={styles.hint}>Saved defaults could not be read ({prefsError}); this chat starts in {CONTEXT_MODE_LABEL[mode]} unless you pick otherwise.</p>
          ) : null}
        </>
      ) : (
        <p className={styles.hint}>{noModeReason(seat.engine, option)}</p>
      )}

      <div className={styles.fit} aria-live="polite">
        {fitState.status === 'idle' ? null
          : fitState.status === 'loading' ? <p className={styles.hint}>Sizing the chosen folders…</p>
            : fitState.status === 'error' ? <p className={styles.hint}>Could not size the chosen folders: {fitState.message}</p>
              : verdict === null ? (
                <p className={styles.hint}>
                  Project inventory estimate: {fitIsFloor(fitState.fit) ? 'at least ' : ''}~{formatTokens(fitState.fit.totalEstTokens)} tokens. This model&rsquo;s budget is unknown, so no fit is claimed. This estimate is not the prompt or current chat context.
                </p>
              ) : (
                <>
                  <p className={styles.fitLine}>
                    <span className={styles.fitBadge} data-fit={verdict}>{FIT_LABEL[verdict]}</span>
                    <span>{fitExplanation({ verdict, tokens: fitState.fit.totalEstTokens, option, mode, floor: fitIsFloor(fitState.fit) })}</span>
                  </p>
                  <p className={styles.hint}>{fitMethodNote(seat.engine)}</p>
                </>
              )}
      </div>

      {cli === null && notes.length === 0 ? null : (
        <ul className={styles.seatFacts} aria-label={`${seat.label} facts`}>
          {cli === null ? null : <li>Runs {cli}.</li>}
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </div>
  );
}

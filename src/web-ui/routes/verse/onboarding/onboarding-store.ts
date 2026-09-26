/**
 * routes/verse/onboarding/onboarding-store.ts — whether the first-run tour
 * is showing, and whether it has already been answered.
 *
 * Framework-free, same shape as verse-ui-store.ts: a module-level snapshot,
 * a listener set, and one `useSyncExternalStore` hook in ./useOnboarding.ts.
 *
 * Persisted under `ashlr.verse.onboarding.v1`. Two facts are stored and they
 * are deliberately different:
 *
 *   - `completedAt` — the operator walked to the end.
 *   - `dismissedAt` — the operator skipped, or closed it part-way.
 *
 * Either one silences the tour for good; storing which happened means a
 * later build can tell "has seen it" from "chose not to", and it makes the
 * Settings replay affordance honest about what it is replaying.
 *
 * Two UI prefs ride along in the same record:
 *
 *   - `expanded` — the tour starts as a one-line chip ("Getting started
 *     1/6 →") and only becomes the full card when the operator opens it. A
 *     420×640 card over every surface on first launch covered half a 900px
 *     window; the chip asks for nothing. Whichever the operator last chose
 *     is kept across launches.
 *   - `step` — where they were, so the chip's "2/6" survives a relaunch.
 *
 * SHOWING IT IS FAIL-SAFE IN THE QUIET DIRECTION. A storage read that throws
 * (private window, storage disabled) or returns something malformed resolves
 * to NOT showing the tour. A first-run flow that reappears on every launch
 * because storage is unavailable would be worse than one that never appears:
 * the app is fully usable without it, and it is reachable from Settings.
 */

export interface OnboardingRecord {
  /** ISO timestamp of the run that reached the last step. */
  completedAt: string | null;
  /** ISO timestamp of a skip or an early close. */
  dismissedAt: string | null;
}

/** What is stored: the answer plus the two UI prefs. */
interface StoredOnboarding extends OnboardingRecord {
  expanded: boolean;
  step: number;
}

export interface OnboardingState extends OnboardingRecord {
  /** Is the flow on screen right now (as the chip or the card)? */
  open: boolean;
  /** The full card (true) or the one-line chip (false). */
  expanded: boolean;
  /** 0-based index into the step list (./onboarding-model.ts ONBOARDING_STEPS). */
  step: number;
}

export const VERSE_ONBOARDING_STORAGE_KEY = 'ashlr.verse.onboarding.v1';

const EMPTY: StoredOnboarding = { completedAt: null, dismissedAt: null, expanded: false, step: 0 };

function readStored(): StoredOnboarding {
  try {
    const raw = localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<StoredOnboarding> | null;
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    return {
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
      dismissedAt: typeof parsed.dismissedAt === 'string' ? parsed.dismissedAt : null,
      expanded: parsed.expanded === true,
      step: typeof parsed.step === 'number' && Number.isFinite(parsed.step) ? Math.max(0, Math.trunc(parsed.step)) : 0,
    };
  } catch {
    // Unreadable storage means "answered" — see the fail-safe note above.
    return { ...EMPTY, dismissedAt: new Date(0).toISOString() };
  }
}

function persist(): void {
  const stored: StoredOnboarding = {
    completedAt: state.completedAt,
    dismissedAt: state.dismissedAt,
    expanded: state.expanded,
    step: state.step,
  };
  try {
    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    /* best-effort: a private window without storage still runs the app */
  }
}

/** True when neither answer has been recorded yet. */
export function isFirstRun(record: OnboardingRecord): boolean {
  return record.completedAt === null && record.dismissedAt === null;
}

const initialStored = readStored();

let state: OnboardingState = {
  completedAt: initialStored.completedAt,
  dismissedAt: initialStored.dismissedAt,
  open: isFirstRun(initialStored),
  expanded: initialStored.expanded,
  step: initialStored.step,
};

const listeners = new Set<() => void>();

/** Apply `delta`; notify (and, with `save`, persist) only when something changed. */
function patch(delta: Partial<OnboardingState>, save = false): void {
  const next = { ...state, ...delta };
  if ((Object.keys(delta) as (keyof OnboardingState)[]).every((k) => Object.is(state[k], next[k]))) return;
  state = next;
  if (save) persist();
  for (const l of listeners) l();
}

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOnboardingState(): OnboardingState {
  return state;
}

export function setOnboardingStep(step: number): void {
  patch({ step: Math.max(0, Math.trunc(step)) }, true);
}

/** The chip was clicked: show the full card. */
export function expandOnboarding(): void {
  patch({ expanded: true }, true);
}

/** Back to the one-line chip — the tour is NOT answered, just out of the way. */
export function collapseOnboarding(): void {
  patch({ expanded: false }, true);
}

/** Skip, or the chip's × — the same answer. */
export function dismissOnboarding(): void {
  patch({ dismissedAt: new Date().toISOString(), open: false }, true);
}

/** Walked to the end. */
export function completeOnboarding(): void {
  patch({ completedAt: new Date().toISOString(), open: false }, true);
}

/** Settings → "Replay onboarding". Reopens at the first step, as the full
 * card (the operator asked for it); the stored answer is kept, so closing
 * the replay does not re-arm the first run. */
export function replayOnboarding(): void {
  patch({ open: true, expanded: true, step: 0 });
}

/** Test hygiene — forgets the stored answer and re-arms the first run (as the chip). */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(VERSE_ONBOARDING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  state = { completedAt: null, dismissedAt: null, open: true, expanded: false, step: 0 };
  for (const l of listeners) l();
}

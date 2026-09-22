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

export interface OnboardingState extends OnboardingRecord {
  /** Is the flow on screen right now? */
  open: boolean;
  /** 0-based index into the step list (./onboarding-model.ts ONBOARDING_STEPS). */
  step: number;
}

export const VERSE_ONBOARDING_STORAGE_KEY = 'ashlr.verse.onboarding.v1';

const EMPTY: OnboardingRecord = { completedAt: null, dismissedAt: null };

function readRecord(): OnboardingRecord {
  try {
    const raw = localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<OnboardingRecord>;
    return {
      completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : null,
      dismissedAt: typeof parsed.dismissedAt === 'string' ? parsed.dismissedAt : null,
    };
  } catch {
    // Unreadable storage means "answered" — see the fail-safe note above.
    return { completedAt: null, dismissedAt: new Date(0).toISOString() };
  }
}

function persist(record: OnboardingRecord): void {
  try {
    localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* best-effort: a private window without storage still runs the app */
  }
}

/** True when neither answer has been recorded yet. */
export function isFirstRun(record: OnboardingRecord): boolean {
  return record.completedAt === null && record.dismissedAt === null;
}

const initialRecord = readRecord();

let state: OnboardingState = {
  ...initialRecord,
  open: isFirstRun(initialRecord),
  step: 0,
};

const listeners = new Set<() => void>();

function patch(delta: Partial<OnboardingState>): void {
  const next = { ...state, ...delta };
  if ((Object.keys(delta) as (keyof OnboardingState)[]).every((k) => Object.is(state[k], next[k]))) return;
  state = next;
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
  patch({ step: Math.max(0, Math.trunc(step)) });
}

/** Skip, Escape, or the close button — all the same answer. */
export function dismissOnboarding(): void {
  const record: OnboardingRecord = { completedAt: state.completedAt, dismissedAt: new Date().toISOString() };
  persist(record);
  patch({ ...record, open: false });
}

/** Walked to the end. */
export function completeOnboarding(): void {
  const record: OnboardingRecord = { completedAt: new Date().toISOString(), dismissedAt: state.dismissedAt };
  persist(record);
  patch({ ...record, open: false });
}

/** Settings → "Replay onboarding". Reopens at the first step; the stored
 * answer is kept, so closing the replay does not re-arm the first run. */
export function replayOnboarding(): void {
  patch({ open: true, step: 0 });
}

/** Test hygiene — forgets the stored answer and re-arms the first run. */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(VERSE_ONBOARDING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  state = { completedAt: null, dismissedAt: null, open: true, step: 0 };
  for (const l of listeners) l();
}

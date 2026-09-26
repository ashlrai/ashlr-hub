/**
 * routes/verse/autonomy/AutonomyOffState.tsx — the one "autonomy is off"
 * state Command, Fleet, Growth and Mind show in place of their empty cards.
 *
 *   ● Autonomy is off                               Fleet dark since Sep 1
 *     Nothing runs or merges on its own until the one-time setup is done.
 *     NEXT  GitHub App   Browser · GitHub
 *     The ashlr-fleet key is in custody, but the App is not installed on …
 *     [ $ ashlr authority setup                                  ⧉ Copy ]
 *     ▸ 6 of 15 ready  ✓✓✓✓✓✓●○○○○○○○×
 *
 * One title, one line of why, ONE primary action: copy the next step's
 * command, approve the grant, or go to the surface that has the control (left
 * out when that surface is the one showing the state — its control is already
 * on screen). The decision is autonomy-off-model.ts; the checklist is
 * GET /api/verse/authority/setup (setup-checklist-model.ts), rendered by the
 * lazily loaded SetupChecklist. The grant draft is never read here: only the
 * Touch ID sheet drafts, when the operator opens it.
 */
import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AuthoritySetupReportV1 } from '../../../../core/authority/types.js';
import type { WorkbenchSectionId } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { IconCheck, IconCopy } from '../../../components/primitives/icons.js';
import { ensureQuery, getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { goToSection } from '../command/nav.js';
import { authorityQuery, fleetLiveQuery, optionalQuery, type OptionalRead } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { autonomyOffState, type AutonomyOffState as OffState } from './autonomy-off-model.js';
import {
  AUTHORITY_SETUP_PATH,
  narrowSetupReport,
  SETUP_FRESH_MS,
  SETUP_POLL_MS,
  setupReadiness,
  type SetupReadiness,
} from './setup-checklist-model.js';
import styles from './autonomy-off.module.css';

// Split off the state's own chunk: the checklist renders only while autonomy
// is off, and never on the chat first-paint path.
const SetupChecklist = lazy(() => import('./SetupChecklist.js'));

/** How long "Copied" stays on the button (SPEC-310C §4's copy-pill timing). */
const COPIED_MS = 1_200;

/** Authority and the live view move slowly while autonomy is off; a minute is plenty for a state. */
export const AUTONOMY_OFF_POLL_MS = 60_000;

/** GET /api/verse/authority/setup — the server's own `ashlr authority setup --dry-run --json`. */
export const authoritySetupQuery = optionalQuery('verse-authority-setup', AUTHORITY_SETUP_PATH, 'The setup checklist', narrowSetupReport);

export interface SetupChecklistRead {
  /** Undefined while the first read is in flight; 'unknown' when not enabled or unanswered. */
  readiness: SetupReadiness | undefined;
  report: AuthoritySetupReportV1 | null;
}

/**
 * The live setup checklist — read ONLY while `enabled` (there is no grant),
 * refreshed every minute while it is on screen, so reruns of setup in a
 * terminal show up without a reload. An active fleet never reads it.
 */
export function useSetupChecklist(enabled: boolean): SetupChecklistRead {
  const key = authoritySetupQuery.key;
  const snap = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(key, listener), [key]),
    () => getQuerySnapshot<OptionalRead<AuthoritySetupReportV1>>(key),
    () => getQuerySnapshot<OptionalRead<AuthoritySetupReportV1>>(key),
  );
  useEffect(() => {
    if (enabled) void ensureQuery(key, () => authoritySetupQuery.fetch(), SETUP_FRESH_MS);
  }, [enabled, key]);
  const refetch = useRefetch(authoritySetupQuery);
  usePollWhileVisible(refetch, SETUP_POLL_MS, { enabled, refreshOnShow: false });
  if (!enabled) return { readiness: 'unknown', report: null };
  return { readiness: setupReadiness(snap.data), report: snap.data?.value ?? null };
}

/**
 * The state for a surface that does not hold the authority / live reads
 * itself. Undefined until everything it needs has answered (so a loading
 * surface never flashes "off"); null when autonomy is on.
 */
export function useAutonomyOff(quietSince: string | null = null): OffState | null | undefined {
  const authority = useQuery(authorityQuery, { freshMs: 30_000 });
  const live = useQuery(fleetLiveQuery, { freshMs: 10_000 });
  const refetchAuthority = useRefetch(authorityQuery);
  const refetchLive = useRefetch(fleetLiveQuery);
  usePollWhileVisible(() => {
    refetchAuthority();
    refetchLive();
  }, AUTONOMY_OFF_POLL_MS);
  const noGrant = authority.data?.value?.grant.state === 'none';
  const setup = useSetupChecklist(noGrant);
  if (!authority.data || !live.data || setup.readiness === undefined) return undefined;
  return autonomyOffState({ authority: authority.data.value, live: live.data.value, quietSince, readiness: setup.readiness, setup: setup.report });
}

export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    const ok = await copyText(command);
    setState(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  };
  return (
    <div className={styles.command} data-state={state}>
      <code className={styles.code}>
        <span className={styles.prompt} aria-hidden="true">$ </span>
        {command}
      </code>
      <Button
        variant="primary"
        size="sm"
        icon={state === 'copied' ? <IconCheck /> : <IconCopy />}
        onClick={() => void copy()}
        aria-label={`Copy the command: ${command}`}
      >
        {state === 'copied' ? 'Copied' : 'Copy'}
      </Button>
      <span className={styles.visuallyHidden} role="status" aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed. Select the command and copy it yourself.' : ''}
      </span>
    </div>
  );
}

export interface AutonomyOffStateProps {
  /** The autonomy state; null = autonomy is on (a surface's own empty line, no action). */
  state: OffState | null;
  /** The surface showing it: a "go to" action pointing here is left out. */
  here: WorkbenchSectionId;
  /** A surface's own headline in place of the state's ("Growth starts with the first fleet run."). */
  title?: string;
  /** A surface's own line in place of the state's why. */
  why?: string | null;
  /**
   * Command only: opens its Touch ID sheet. When given and the state carries
   * a grant action, that button is the primary action instead of "go to".
   */
  onGrant?: (intent: 'grant' | 're-approve') => void;
}

export function AutonomyOffState({ state, here, title, why, onGrant }: AutonomyOffStateProps) {
  const titleId = useId();
  const go = state?.go && state.go.section !== here ? state.go : null;
  const grant = onGrant && state?.grant ? state.grant : null;
  let action: ReactNode = null;
  if (state?.command) action = <CopyCommand command={state.command} />;
  else if (grant) {
    action = (
      <div className={styles.action}>
        <Button variant="primary" size="sm" onClick={() => onGrant?.(grant.intent)}>
          {grant.label}
        </Button>
      </div>
    );
  } else if (go) {
    action = (
      <div className={styles.action}>
        <Button variant="primary" size="sm" onClick={() => goToSection(go.section, go.anchor)}>
          {go.label}
        </Button>
      </div>
    );
  }
  // A surface headline takes the title's place, so the state's own title
  // becomes the start of the line: "Autonomy is off. Approve a standing grant…"
  const line = why !== undefined ? why : !state ? null : title ? `${state.title}. ${state.why}` : state.why;
  return (
    <section className={styles.state} aria-labelledby={titleId} data-kind={state?.kind ?? 'none'} data-testid="autonomy-off">
      <header className={styles.head}>
        <span className={styles.titleRow}>
          <span className={styles.dot} data-tone={state?.tone ?? 'neutral'} aria-hidden="true" />
          <h3 id={titleId} className={styles.title}>{title ?? state?.title ?? ''}</h3>
        </span>
        {state?.since ? <span className={styles.since}>{state.since}</span> : null}
      </header>
      {line ? <p className={styles.why}>{line}</p> : null}
      {state?.setup ? (
        // Until the checklist chunk arrives, the action stands alone (never a blank gap).
        <Suspense fallback={action}>
          <SetupChecklist report={state.setup} action={action} />
        </Suspense>
      ) : action}
    </section>
  );
}

/**
 * routes/verse/autonomy/AutonomyOffState.tsx — the one "autonomy is off"
 * state Command, Fleet, Growth and Mind show in place of their empty cards.
 *
 *   ● Autonomy is off                               Fleet dark since Sep 1
 *     Nothing runs or merges on its own until setup is done.
 *     [ $ ashlr authority setup                                  ⧉ Copy ]
 *     ✓ Custody helper  ✓ Signing key  ○ GitHub App  ○ Claude token  ○ Standing grant
 *
 * One title, one line of why, ONE primary action: copy the setup command, or
 * go to the surface that has the control (left out when that surface is the
 * one showing the state — its control is already on screen). The decision is
 * autonomy-off-model.ts; `useAutonomyOff` reads it for the surfaces that do
 * not already hold the authority and live reads.
 */
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WorkbenchSectionId } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { copyText } from '../../../components/primitives/clipboard.js';
import { IconCheck, IconCopy } from '../../../components/primitives/icons.js';
import type { AuthorityGrantDraft } from '../../../../core/authority/types.js';
import { ensureQuery, getQuerySnapshot, subscribeQuery } from '../../../data/cache.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { goToSection } from '../command/nav.js';
import { authorityDraftQuery, authorityQuery, fleetLiveQuery, type OptionalRead } from '../command/surface-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { autonomyOffState, draftReadiness, type AutonomyOffState as OffState, type DraftReadiness, type SetupCheck } from './autonomy-off-model.js';
import styles from './autonomy-off.module.css';

/** How long "Copied" stays on the button (SPEC-310C §4's copy-pill timing). */
const COPIED_MS = 1_200;

/** Authority and the live view move slowly while autonomy is off; a minute is plenty for a state. */
export const AUTONOMY_OFF_POLL_MS = 60_000;

/** A drafted grant is only a readiness probe here; a minute-old answer is fine (the sheet re-drafts on open). */
const DRAFT_FRESH_MS = 60_000;

/**
 * Whether a new grant can be drafted — read ONLY while `enabled` (there is
 * no grant), so an active fleet never asks the server to draft one.
 * Undefined while that read is in flight.
 */
export function useDraftReadiness(enabled: boolean): DraftReadiness | undefined {
  const key = authorityDraftQuery.key;
  const snap = useSyncExternalStore(
    useCallback((listener: () => void) => subscribeQuery(key, listener), [key]),
    () => getQuerySnapshot<OptionalRead<AuthorityGrantDraft>>(key),
    () => getQuerySnapshot<OptionalRead<AuthorityGrantDraft>>(key),
  );
  useEffect(() => {
    if (enabled) void ensureQuery(key, () => authorityDraftQuery.fetch(), DRAFT_FRESH_MS);
  }, [enabled, key]);
  return enabled ? draftReadiness(snap.data) : 'unknown';
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
  const draft = useDraftReadiness(noGrant);
  if (!authority.data || !live.data || draft === undefined) return undefined;
  return autonomyOffState({ authority: authority.data.value, live: live.data.value, quietSince, draft });
}

function CopyCommand({ command }: { command: string }) {
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

function Checks({ checks }: { checks: SetupCheck[] }) {
  const done = checks.filter((c) => c.done === true).length;
  return (
    <div className={styles.progress}>
      <span className={styles.count} aria-hidden="true">
        {done} of {checks.length} ready
      </span>
      <ul className={styles.checks} aria-label={`Setup: ${done} of ${checks.length} ready`}>
        {checks.map((c) => {
          const mark = c.done === true ? 'done' : c.done === false ? 'todo' : 'unknown';
          return (
            <li key={c.id} className={styles.check} data-mark={mark}>
              <span className={styles.mark} aria-hidden="true">
                {mark === 'done' ? <IconCheck size={10} strokeWidth={2.5} /> : null}
              </span>
              {c.label}
              <span className={styles.visuallyHidden}>{mark === 'done' ? ' — done' : mark === 'todo' ? ' — to do' : ' — unknown'}</span>
            </li>
          );
        })}
      </ul>
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
      {action}
      {state && state.checks.length > 0 ? <Checks checks={state.checks} /> : null}
    </section>
  );
}

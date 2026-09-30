/**
 * routes/verse/mobile/screens/NewAgentScreen.tsx — spin up an agent from the
 * phone: pick a repo, a seat (or several), say what to do, Start.
 *
 * Reads the bootstrap the shell already has (seats, projects, sessions) —
 * the same cache key the workbench's New chat uses, so both pickers list the
 * same seats with the same refusals. Writes are the workbench's own helpers
 * (verse-queries.ts createVerseSession + sendVerseTurn), inside ONE guarded
 * action: a single agent starts without a confirmation sheet (it is what the
 * button says, and the chat can be stopped at once); several agents confirm
 * first, because each spends from its own seat.
 *
 * Nothing typed is lost to a failure: a start where some seats fail keeps the
 * prompt, leaves only the failed seats selected (so Start again retries just
 * those) and says which failed and why.
 */
import { useId, useMemo, useRef, useState } from 'react';
import type { VerseSeat } from '../../../../data/api-types.js';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { refetchQuery } from '../../../../data/cache.js';
import { describeActionError, useGuardState } from '../../shell/guard-store.js';
import { verseBootstrapQuery } from '../../verse-bootstrap-query.js';
import { createVerseSession, fetchVerseSessionDetail, sendVerseTurn } from '../../verse-queries.js';
import { MicButton } from '../MicButton.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import { showMobileToast } from '../mobile-toast.js';
import { Button, cx, Screen, SkeletonList } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, Section, ui } from '../ui-parts.js';
import {
  defaultProjectPath,
  defaultSeatId,
  modelOptionText,
  orderProjects,
  orderSeats,
  partialFailureText,
  seatBlockedReason,
  spawnConsequences,
  spawnPlan,
  startBlocker,
  type SpawnResult,
  type SpawnTarget,
} from './new-agent-model.js';
import styles from './NewAgentScreen.module.css';

/** Rows shown before "Show all" — enough for the repos a person actually uses. */
export const REPO_ROWS = 6;

function projectLabel(path: string, projects: readonly { path: string; name: string }[]): string {
  return projects.find((p) => p.path === path)?.name ?? path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

async function startOne(projectPath: string, target: SpawnTarget, prompt: string, existingId: string | null, remember: (id: string) => void): Promise<SpawnResult> {
  let sessionId = existingId;
  try {
    if (!sessionId) {
      const session = await createVerseSession({ projectPath, seatId: target.seatId, model: target.model });
      sessionId = session.id;
      // Keep an opened chat even if sending fails, so Retry cannot create a duplicate.
      remember(sessionId);
    }
    await sendVerseTurn(sessionId, prompt);
    return { target, sessionId, error: null };
  } catch (err) {
    const status = typeof err === 'object' && err !== null && 'status' in err ? err.status : null;
    return { target, sessionId, error: describeActionError(err), ...(typeof status !== 'number' || status < 100 || status >= 500 ? { unknownOutcome: true } : {}) };
  }
}

export function NewAgentScreen() {
  const { permissions, reachability, navigate } = useMobile();
  // Busy while any guarded action is open (confirming, unlocking, running): a
  // cancel or a failure closes it, so the button can never stay stuck.
  const guard = useGuardState();
  const busy = guard.request !== null;
  const running = guard.phase === 'running';
  const bootstrap = useQuery(verseBootstrapQuery);
  const retry = useRefetch(verseBootstrapQuery);
  const data = bootstrap.data;
  const projects = useMemo(() => data?.projects ?? [], [data]);
  const sessions = useMemo(() => data?.sessions ?? [], [data]);
  const seats = useMemo(() => orderSeats(data?.seats ?? []), [data]);

  // null = "not touched yet": the default follows the data until the operator chooses.
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showAllRepos, setShowAllRepos] = useState(false);
  const [multi, setMulti] = useState(false);
  const [seatChoice, setSeatChoice] = useState<string[] | null>(null);
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [interim, setInterim] = useState('');
  const openedChats = useRef(new Map<string, string>());
  const [uncertain, setUncertain] = useState<SpawnResult[]>([]);
  const [inspection, setInspection] = useState<Record<string, string>>({});
  const [checkingChat, setCheckingChat] = useState<string | null>(null);
  const checkChat = async (id: string) => {
    setCheckingChat(id);
    try {
      const detail = await fetchVerseSessionDetail(id);
      const messages = detail.events.filter((e) => e.type === 'user-message');
      setInspection((prev) => ({ ...prev, [id]: messages.length > 0
        ? `This chat has ${messages.length} recorded prompt${messages.length === 1 ? '' : 's'}; status: ${detail.session.status}. Open it to inspect the transcript before sending again.`
        : `No prompt is visible yet; status: ${detail.session.status}. The original request may still arrive. Open this chat before sending again.` }));
    } catch (err) {
      setInspection((prev) => ({ ...prev, [id]: `Could not inspect the chat: ${describeActionError(err)}. No prompt was resent.` }));
    } finally { setCheckingChat(null); }
  };

  const repoFilterId = useId();
  const modelId = useId();
  const promptId = useId();

  const projectPath = projectChoice ?? defaultProjectPath(projects, sessions);
  const fallbackSeat = defaultSeatId(seats);
  const seatIds = seatChoice ?? (fallbackSeat ? [fallbackSeat] : []);
  const primary: VerseSeat | undefined = seats.find((s) => s.id === seatIds[0]);
  const plan = spawnPlan({ seats, seatIds, primaryModel: modelChoice });
  const blocker = startBlocker({ projectPath, plan, prompt });
  const canAct = canShowActions(permissions);
  const offline = reachability === 'offline' || reachability === 'unreachable';
  const ordered = orderProjects(projects, sessions, query);
  const visibleRepos = showAllRepos || query.trim() ? ordered : ordered.slice(0, REPO_ROWS);
  const blockedSeats = seats
    .map((seat) => ({ seat, reason: seatBlockedReason(seat, seats) }))
    .filter((s): s is { seat: VerseSeat; reason: string } => s.reason !== null);
  const runnable = seats.length - blockedSeats.length;
  const shown = interim ? `${prompt}${prompt && !prompt.endsWith(' ') ? ' ' : ''}${interim}` : prompt;

  const toggleSeat = (id: string) => {
    if (!multi) {
      setSeatChoice([id]);
      if (id !== seatIds[0]) setModelChoice(null);
      return;
    }
    const next = seatIds.includes(id) ? seatIds.filter((s) => s !== id) : [...seatIds, id];
    if (next[0] !== seatIds[0]) setModelChoice(null);
    setSeatChoice(next);
  };

  const setMultiMode = (on: boolean) => {
    setMulti(on);
    // Back to one seat: keep the primary only.
    if (!on && seatIds.length > 1) setSeatChoice(seatIds.slice(0, 1));
  };

  const start = () => {
    if (blocker || !projectPath || busy || uncertain.length > 0) return;
    const text = prompt.trim();
    const targets = plan;
    const repoName = projectLabel(projectPath, projects);
    const many = targets.length > 1;
    let results: SpawnResult[] = [];
    runMobileAction({
      title: many ? `Start ${targets.length} agents?` : 'Start agent',
      consequences: spawnConsequences(targets, repoName),
      confirmLabel: many ? `Start ${targets.length} agents` : 'Start agent',
      confirm: many,
      run: async () => {
        results = await Promise.all(targets.map(async (t) => {
          const key = JSON.stringify([projectPath, t.seatId, t.model]);
          const result = await startOne(projectPath, t, text, openedChats.current.get(key) ?? null,
            (id) => openedChats.current.set(key, id));
          if (!result.error) openedChats.current.delete(key);
          return result;
        }));
        const failed = results.filter((r) => r.error !== null);
        const unknown = failed.filter((r) => r.unknownOutcome);
        setUncertain(unknown);
        // Nothing started at all: a failure, so the sheet (or toast) says why and nothing moves.
        if (failed.length === results.length && results.every((r) => r.sessionId === null)) {
          throw new Error(unknown.length > 0 ? 'Agent creation was not confirmed. A chat may have opened; check Agents before starting again. Your draft is kept here.' : failed.length === 1 ? failed[0]!.error! : `No agent started. ${failed.map((r) => `${r.target.seatLabel}: ${r.error}`).join(' ')}`);
        }
      },
      onDone: () => {
        const failed = results.filter((r) => r.error !== null);
        if (results.length === 1) {
          const only = results[0]!;
          // Stay with the words; the next Start retries this chat rather than opening another.
          if (only.error) {
            showMobileToast(only.unknownOutcome
              ? `The chat opened, but prompt delivery was not confirmed: ${only.error} Inspect this chat before sending again. Your draft is kept here.`
              : `The chat opened, but the server refused this prompt: ${only.error} Try again to send it in the same chat.`, 'danger');
            return;
          }
          if (only.sessionId) navigate({ screen: 'agent', id: only.sessionId, pane: 'transcript' });
          return;
        }
        if (failed.length === 0) {
          showMobileToast(`Started ${results.length} agents`, 'success');
          navigate({ screen: 'agents' });
          return;
        }
        // Partial: keep the words and leave only the seats that did not start selected.
        showMobileToast(results.some((r) => r.unknownOutcome) ? `${partialFailureText(results)} Some responses were not confirmed; inspect those chats before sending again.` : partialFailureText(results), 'danger');
        setSeatChoice(failed.map((r) => r.target.seatId));
      },
    });
  };

  const refresh = () => refetchQuery(verseBootstrapQuery.key, () => verseBootstrapQuery.fetch(), true);

  let body;
  if (!data && (bootstrap.status === 'loading' || bootstrap.status === 'idle')) {
    body = (
      <>
        <Section title="Repo" flat><SkeletonList rows={3} label="Loading repos" /></Section>
        <Section title="Seat" flat><SkeletonList rows={2} label="Loading seats" /></Section>
      </>
    );
  } else if (!data) {
    body = <ErrorState title="Couldn’t load your repos and seats" reason={readFailureReason(bootstrap.error)} onRetry={retry} />;
  } else if (projects.length === 0) {
    body = (
      <EmptyState
        title="No repos yet"
        body={<>Enroll a repo on your Mac with <code className={ui.mono}>ashlr verse</code> (or open one there once) and it shows here.</>}
      />
    );
  } else {
    body = (
      <>
        <Section title="Repo" flat>
          <div className={ui.stack}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor={repoFilterId}>Find a repo</label>
              <input
                id={repoFilterId}
                className={ui.input}
                type="search"
                placeholder={`${projects.length} repos`}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className={ui.group} role="radiogroup" aria-label="Repo">
              {visibleRepos.length === 0 ? (
                <div className={ui.row}><span className={ui.muted}>No repo matches “{query.trim()}”.</span></div>
              ) : (
                visibleRepos.map((p) => {
                  const selected = p.path === projectPath;
                  return (
                    <button
                      key={p.path}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={cx(ui.row, styles.choice)}
                      onClick={() => setProjectChoice(p.path)}
                    >
                      <span className={ui.rowBody}>
                        <span className={ui.rowTitle}>{p.name}</span>
                        <span className={cx(ui.rowSub, ui.mono)}>{p.path}</span>
                      </span>
                      <span className={ui.rowTrail}>
                        {p.enrolled ? <Badge tone="info">Enrolled</Badge> : null}
                        <span className={styles.check} data-on={selected ? '' : undefined} aria-hidden="true" />
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            {!showAllRepos && !query.trim() && ordered.length > REPO_ROWS ? (
              <Button variant="plain" onClick={() => setShowAllRepos(true)}>Show all {ordered.length} repos</Button>
            ) : null}
          </div>
        </Section>

        <Section
          title={multi ? 'Seats' : 'Seat'}
          flat
          footer={runnable === 0 ? undefined : multi ? 'The same prompt starts on each selected seat. The first one uses the model below; the rest use their default.' : undefined}
        >
          <div className={ui.stack}>
            <button
              type="button"
              role="switch"
              aria-checked={multi}
              className={cx(ui.row, ui.card, styles.switchRow)}
              onClick={() => setMultiMode(!multi)}
            >
              <span className={ui.rowBody}>
                <span className={ui.rowTitle}>Spawn on several seats</span>
                <span className={ui.rowSub}>Start the same prompt on more than one seat at once.</span>
              </span>
              <span className={styles.switchTrack} data-on={multi ? '' : undefined} aria-hidden="true"><span className={styles.switchThumb} /></span>
            </button>
            {seats.length === 0 || runnable === 0 ? (
              <EmptyState
                title="No seat can run right now"
                body={blockedSeats.length > 0 ? 'Every seat is signed out, out of usage or unavailable — see why below.' : 'Your Mac reported no seats. Connect Claude Code, Codex, Grok or a local model there.'}
              />
            ) : (
              <div className={ui.chips} role="group" aria-label={multi ? 'Seats' : 'Seat'}>
                {seats.map((seat) => {
                  const blocked = seatBlockedReason(seat, seats) !== null;
                  return (
                    <button
                      key={seat.id}
                      type="button"
                      className={ui.chip}
                      aria-pressed={seatIds.includes(seat.id)}
                      disabled={blocked}
                      onClick={() => toggleSeat(seat.id)}
                    >
                      {seat.label}
                    </button>
                  );
                })}
              </div>
            )}
            {blockedSeats.length > 0 ? (
              <ul className={styles.reasons} aria-label="Seats that can’t run">
                {blockedSeats.map(({ seat, reason }) => (
                  <li key={seat.id}><strong>{seat.label}</strong>: {reason}</li>
                ))}
              </ul>
            ) : null}
            {primary && seatBlockedReason(primary, seats) === null ? (
              <div className={ui.field}>
                <label className={ui.label} htmlFor={modelId}>{multi && plan.length > 1 ? `Model on ${primary.label}` : 'Model'}</label>
                <select
                  id={modelId}
                  className={ui.select}
                  value={plan.find((t) => t.seatId === primary.id)?.model ?? ''}
                  onChange={(e) => setModelChoice(e.target.value)}
                >
                  {primary.models.map((m) => (
                    <option key={m.id} value={m.id} disabled={Boolean(m.unavailableReason)}>{modelOptionText(m)}</option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </Section>
      </>
    );
  }

  const ready = Boolean(data) && projects.length > 0;
  const startLabel = plan.length > 1 ? `Start ${plan.length} agents` : 'Start agent';
  const hint = !canAct
    ? permissions.actReason ?? 'This device can’t start agents.'
    : offline
      ? 'Your Mac isn’t answering, so nothing can start. It will as soon as it does.'
      : blocker ?? (plan.length > 1 ? `Starts ${plan.length} agents in ${projectLabel(projectPath ?? '', projects)}.` : null);

  return (
    <Screen title="New agent" onBack={() => navigate({ screen: 'agents' })} backLabel="Agents" onRefresh={refresh} label="New agent">
      {body}
      {ready ? (
        <Section title="Prompt" flat>
          <div className={ui.stack}>
            <label htmlFor={promptId} className="visually-hidden">What should the agent do?</label>
            <textarea
              id={promptId}
              className={cx(ui.textarea, styles.prompt)}
              placeholder="What should the agent do?"
              value={shown}
              onChange={(e) => {
                setInterim('');
                setPrompt(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
            />
            <MicButton
              size="large"
              disabled={busy}
              onInterim={setInterim}
              onFinal={(phrase) => setPrompt((p) => `${p}${p && !p.endsWith(' ') ? ' ' : ''}${phrase}`)}
            />
          </div>
        </Section>
      ) : null}
      {ready ? (
        <div className={styles.startBar}>
          {uncertain.length > 0 ? <Banner tone="warning">
            <p>Delivery was not confirmed. Your draft is kept here; Start is paused to avoid duplicating work.</p>
            {uncertain.map((result) => result.sessionId ? <div key={result.sessionId}>
              <p>{result.target.seatLabel}: {inspection[result.sessionId] ?? 'The chat opened. Check its transcript before sending again.'}</p>
              <Button disabled={checkingChat !== null} onClick={() => void checkChat(result.sessionId!)}>Check opened chat</Button>
              <Button onClick={() => navigate({ screen: 'agent', id: result.sessionId!, pane: 'transcript' })}>Open chat</Button>
            </div> : <p key={result.target.seatId}>{result.target.seatLabel}: chat creation was not confirmed. Check Agents before starting again.</p>)}
            {uncertain.some((r) => !r.sessionId) ? <Button onClick={() => navigate({ screen: 'agents' })}>View chats</Button> : null}
          </Banner> : null}
          {offline && canAct ? <Banner tone="warning">Offline — starting waits until your Mac answers.</Banner> : null}
          {canAct ? (
            <Button variant="primary" block disabled={Boolean(blocker) || offline || busy || uncertain.length > 0} onClick={start} aria-busy={busy || undefined}>
              {running ? 'Starting…' : startLabel}
            </Button>
          ) : null}
          {hint ? <p className={cx(ui.faint, styles.hint)} role={!canAct ? 'note' : undefined}>{hint}</p> : null}
        </div>
      ) : null}
    </Screen>
  );
}

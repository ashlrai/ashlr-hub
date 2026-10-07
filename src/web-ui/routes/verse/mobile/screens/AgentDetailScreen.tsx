/**
 * routes/verse/mobile/screens/AgentDetailScreen.tsx — one agent on the
 * phone: its live transcript, what it changed (read-only), and the three
 * things worth doing from a pocket — Send, Interject, Stop.
 *
 * Live data is the workbench's own store, so the phone and the Mac show the
 * same chat from the same events:
 *   useVerseSession     opens the chat (detail GET, then the resumed SSE stream)
 *   useVerseTranscript  the derived transcript (one rebuild per frame while streaming)
 *   useVerseLive        the running turn's progress / thinking / notices
 *   checkpointClient    the Changes pane (GET /api/verse/checkpoints*)
 *
 * Writes (every one through runMobileAction):
 *   idle     Send       POST /sessions/:id/turns             (no confirmation: a message)
 *   running  Interject  POST /queue/:id { sendNow: true }    (stops the turn, sends this next)
 *            Queue      POST /queue/:id                      (sends after the turn)
 *            Stop       POST /sessions/:id/cancel            (confirmed)
 * A Devin chat stops the same way; ending the Devin session for good
 * (terminate) is deliberately not offered from the phone.
 *
 * The transcript is drawn compactly here rather than with Transcript.tsx /
 * MessageMarkdown (too heavy for this chunk): prose as pre-wrapped text,
 * ``` fences as code blocks, tool calls as one-line chips.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { VerseCheckpointDiffFile, VerseCheckpointDiffResponse } from '../../../../../core/verse/checkpoint-types.js';
import { useQuery } from '../../../../data/hooks.js';
import { STATUS_WORD, totals, turnCheckpointError, turnHasCheckpoint } from '../../changes/changes-model.js';
import { checkpointClient, describeCheckpointError, errorCode } from '../../changes/checkpoint-queries.js';
import { noteSessionSeen } from '../../chat/use-chat-activity.js';
import { enqueueFollowUp } from '../../composer/composer-queries.js';
import { useVerseLive, useVerseSession } from '../../useVerseSession.js';
import { useVerseTranscript } from '../../useVerseTranscript.js';
import { verseBootstrapQuery } from '../../verse-bootstrap-query.js';
import { modelLabel, seatLabel } from '../../verse-model.js';
import { cancelVerseTurn, sendVerseTurn } from '../../verse-queries.js';
import type { TranscriptItem } from '../../verse-transcript.js';
import { MobileComposer } from '../MobileComposer.js';
import { runMobileAction } from '../mobile-actions.js';
import { canShowActions, useMobile } from '../mobile-context.js';
import type { AgentPane } from '../mobile-router.js';
import { Button, Screen, SkeletonList, cx } from '../ui.js';
import { Badge, Banner, EmptyState, ErrorState, ui } from '../ui-parts.js';
import {
  clipLines,
  diffLines,
  diffSummary,
  liveStatusText,
  safeHttpsUrl,
  shortElapsed,
  splitFences,
  systemLine,
  thinkingLabel,
  toolSummary,
  TRANSCRIPT_WINDOW,
  visibleItems,
  windowItems,
} from './agent-transcript-model.js';
import styles from './AgentDetailScreen.module.css';

export interface AgentDetailScreenProps {
  sessionId: string;
  pane: AgentPane;
}

type SendMode = 'interject' | 'queue';

export const STOP_CONSEQUENCES = 'Stops the turn in progress. What it already changed stays on disk.';

/** A load error in operator words: the store keeps the raw "GET … failed (HTTP 404)." sentence. */
function describeLoadError(message: string): { title: string; reason: string } {
  if (/HTTP 404/.test(message)) return { title: 'Chat not found', reason: 'Your Mac has no chat with this id. It may have been deleted.' };
  if (/HTTP \d+/.test(message)) return { title: 'Couldn’t open this chat', reason: 'Your Mac could not load this chat right now.' };
  return { title: 'Couldn’t open this chat', reason: message };
}

export function AgentDetailScreen({ sessionId, pane }: AgentDetailScreenProps) {
  const { permissions, reachability, navigate } = useMobile();
  const [reload, setReload] = useState(0);
  const [changesReload, setChangesReload] = useState(0);
  const head = useVerseSession(sessionId, reload);
  const boot = useQuery(verseBootstrapQuery);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<SendMode>('interject');

  const session = head.session;
  const running = session?.status === 'running';
  const canAct = canShowActions(permissions);
  const disconnected = reachability === 'offline' || reachability === 'unreachable';
  const seats = boot.data?.seats ?? [];

  // Opening (and watching) a chat reads it: clear its unread count here and on the Mac.
  const turnCount = session?.turnCount ?? null;
  useEffect(() => {
    if (head.loaded && turnCount !== null) noteSessionSeen(sessionId, turnCount);
  }, [sessionId, head.loaded, turnCount]);

  const back = useCallback(() => navigate({ screen: 'agents' }), [navigate]);
  const showPane = (next: AgentPane) => {
    if (next !== pane) navigate({ screen: 'agent', id: sessionId, pane: next }, { replace: true });
  };

  const stop = () => {
    runMobileAction({
      title: 'Stop this turn?',
      consequences: STOP_CONSEQUENCES,
      confirmLabel: 'Stop',
      destructive: true,
      run: () => cancelVerseTurn(sessionId),
      success: 'Stopped',
    });
  };

  const submit = (text: string) => {
    const kind: 'send' | SendMode = running ? mode : 'send';
    runMobileAction({
      title: kind === 'send' ? 'Send message' : kind === 'interject' ? 'Interject' : 'Queue message',
      consequences:
        kind === 'send'
          ? 'Sends this message to the agent, which starts a new turn.'
          : kind === 'interject'
            ? 'Stops the current turn and sends this next.'
            : 'Sends this after the current turn finishes.',
      confirmLabel: kind === 'send' ? 'Send' : kind === 'interject' ? 'Interject' : 'Queue',
      confirm: false,
      run: () => (kind === 'send' ? sendVerseTurn(sessionId, text) : enqueueFollowUp(sessionId, text, kind === 'interject' ? { sendNow: true } : {})),
      success: kind === 'queue' ? 'Queued for after this turn' : undefined,
      // Clear only what was sent: words typed while it was in flight stay.
      onDone: () => setDraft((current) => (current.trim() === text ? '' : current)),
    });
  };

  const refresh = () => {
    if (pane === 'changes') setChangesReload((n) => n + 1);
    else setReload((n) => n + 1);
  };

  // ---- states before there is a chat to show --------------------------------

  if (head.loadError && !session) {
    const { title, reason } = describeLoadError(head.loadError);
    return (
      <Screen title="Agent" onBack={back} backLabel="Agents">
        <ErrorState title={title} reason={reason} onRetry={() => setReload((n) => n + 1)} />
        <Button variant="plain" block onClick={back}>Back to Agents</Button>
      </Screen>
    );
  }
  if (!head.loaded || !session) {
    return (
      <Screen title="Agent" onBack={back} backLabel="Agents">
        <SkeletonList rows={4} label="Loading the conversation" />
      </Screen>
    );
  }

  // ---- the chat ---------------------------------------------------------------

  const badge = running
    ? <Badge tone="running" dot pulse>Working</Badge>
    : session.status === 'error'
      ? <Badge tone="danger">Failed</Badge>
      : <Badge tone="neutral">Idle</Badge>;
  const who = [seatLabel(seats, session), modelLabel(seats, session)].filter(Boolean).join(' · ');

  const header = (
    <div className={styles.header}>
      <div className={styles.meta}>
        <span className={styles.who}>{who}</span>
        {badge}
      </div>
      <div className={styles.segmented} role="group" aria-label="View">
        <button type="button" className={styles.segment} aria-pressed={pane === 'transcript'} onClick={() => showPane('transcript')}>Transcript</button>
        <button type="button" className={styles.segment} aria-pressed={pane === 'changes'} onClick={() => showPane('changes')}>Changes</button>
      </div>
      {disconnected ? (
        <Banner tone="warning">
          {reachability === 'offline'
            ? 'You’re offline. Showing what was loaded; sending resumes when you reconnect.'
            : 'Can’t reach your Mac. Showing what was loaded; sending resumes when it answers.'}
        </Banner>
      ) : head.stream === 'reconnecting' ? (
        <Banner tone="info">Reconnecting to the live stream…</Banner>
      ) : null}
    </div>
  );

  const hint = disconnected
    ? 'Sending is paused until your Mac is reachable.'
    : running
      ? mode === 'interject'
        ? 'Interject stops the current turn and sends this next.'
        : 'Queue sends this after the current turn finishes.'
      : permissions.act === 'locked'
        ? 'Sending asks for the mutation token first.'
        : undefined;

  const footer = pane !== 'transcript'
    ? undefined
    : canAct ? (
      <MobileComposer
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        placeholder={running ? 'Tell it something now…' : 'Message this agent…'}
        submitLabel={running ? (mode === 'interject' ? 'Interject' : 'Queue') : 'Send'}
        disabled={disconnected}
        hint={hint}
        label="Message"
        above={running ? (
          <div className={ui.chips} role="group" aria-label="When to send">
            <button type="button" className={cx(ui.chip, styles.modeChip)} aria-pressed={mode === 'interject'} onClick={() => setMode('interject')}>Interject now</button>
            <button type="button" className={cx(ui.chip, styles.modeChip)} aria-pressed={mode === 'queue'} onClick={() => setMode('queue')}>Queue for after</button>
          </div>
        ) : undefined}
      />
    ) : (
      <div className={ui.composer}>
        <p className={ui.composerHint}>{permissions.actReason ?? 'This device can read this chat but not send to it.'}</p>
      </div>
    );

  const trailing = running && canAct ? (
    <Button variant="destructiveTinted" onClick={stop} disabled={disconnected}>Stop</Button>
  ) : null;

  return (
    <Screen
      title={session.title || 'Untitled chat'}
      onBack={back}
      backLabel="Agents"
      trailing={trailing}
      header={header}
      footer={footer}
      onRefresh={refresh}
      label={pane === 'changes' ? 'Changes' : 'Transcript'}
    >
      {pane === 'changes' ? (
        <ChangesPane sessionId={sessionId} version={`${session.status}:${session.turnCount}:${changesReload}`} />
      ) : (
        <TranscriptPane sessionId={sessionId} running={running} canAct={canAct} />
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

/** Within this many pixels of the end counts as "at the bottom" (following the stream). */
const STICK_PX = 48;

/**
 * Screen renders its children straight into its scroller, so the pane's
 * parent IS the scroll container (ui.tsx Screen).
 */
function scrollerOf(pane: HTMLElement | null): HTMLElement | null {
  return pane?.parentElement ?? null;
}

/** A clock that ticks once a second while `on` (the typing line's elapsed time). */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

function TranscriptPane({ sessionId, running, canAct }: { sessionId: string; running: boolean; canAct: boolean }) {
  const transcript = useVerseTranscript(sessionId);
  const live = useVerseLive(sessionId);
  const [limit, setLimit] = useState(TRANSCRIPT_WINDOW);
  const [jump, setJump] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const streaming = running || transcript.live;
  const now = useNow(streaming);

  const all = useMemo(() => visibleItems(transcript.items), [transcript.items]);
  const shown = useMemo(() => windowItems(all, limit), [all, limit]);

  useEffect(() => {
    const el = scrollerOf(root.current);
    if (!el) return undefined;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
      stick.current = atBottom;
      if (atBottom) setJump(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Follow new content while the operator is at the bottom; otherwise offer the pill.
  const last = all[all.length - 1];
  const signature = `${all.length}:${last?.key ?? ''}:${last && 'text' in last ? last.text.length : 0}:${last?.kind === 'tool' ? String(last.result !== null) : ''}:${streaming}`;
  useLayoutEffect(() => {
    const el = scrollerOf(root.current);
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setJump(true);
  }, [signature]);

  const toLatest = () => {
    const el = scrollerOf(root.current);
    stick.current = true;
    setJump(false);
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div ref={root} className={styles.log} role="log" aria-label="Conversation" aria-live="off">
      {shown.hidden > 0 ? (
        <Button variant="tinted" block onClick={() => setLimit((n) => n + TRANSCRIPT_WINDOW)}>
          Show earlier ({shown.hidden})
        </Button>
      ) : null}
      {all.length === 0 && !streaming ? (
        <EmptyState title="No messages yet" body={canAct ? 'Send the first message below.' : 'Messages sent from your Mac show up here.'} />
      ) : null}
      {shown.items.map((item) => <TranscriptEntry key={item.key} item={item} />)}
      {streaming ? (
        <p className={styles.typing} role="status">
          <span className={cx(ui.dot, ui.pulse)} aria-hidden="true" />
          <span>{liveStatusText(live, now)}</span>
        </p>
      ) : null}
      {jump ? (
        <div className={styles.jumpWrap}>
          <Button variant="primary" className={styles.jump} onClick={toLatest}>Jump to latest</Button>
        </div>
      ) : null}
    </div>
  );
}

function TranscriptEntry({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={styles.userRow}>
          <div className={styles.userBubble}>{item.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className={styles.assistant}>
          {splitFences(item.text).map((seg, i) =>
            seg.kind === 'code' ? (
              <pre key={i} className={styles.code} aria-label={seg.lang ? `${seg.lang} code` : 'Code'}>{seg.text}</pre>
            ) : (
              <p key={i} className={styles.prose}>{seg.text}</p>
            ),
          )}
        </div>
      );
    case 'tool':
      return <ToolChip item={item} />;
    case 'thinking':
      return <ThinkingChip item={item} />;
    case 'remote-pr': {
      const href = safeHttpsUrl(item.url);
      return (
        <p className={styles.system} data-tone="info">
          {href ? <a href={href} target="_blank" rel="noopener noreferrer" className={styles.link}>Devin opened a pull request</a> : 'Devin opened a pull request'}
        </p>
      );
    }
    default: {
      const line = systemLine(item);
      return line ? <p className={styles.system} data-tone={line.tone}>{line.text}</p> : null;
    }
  }
}

function ToolChip({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(item.name, item.input);
  const state = item.result === null ? 'running' : item.result.isError ? 'error' : 'ok';
  const stateText = state === 'running' ? 'running' : state === 'error' ? 'failed' : shortElapsed(item.durationMs) ?? '';
  const output = item.result ? clipLines(item.result.output) : null;
  return (
    <div className={styles.tool}>
      <button type="button" className={styles.toolChip} data-state={state} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={styles.toolText}>{summary}</span>
        {stateText ? <span className={styles.toolState}>{stateText}</span> : null}
      </button>
      {open ? (
        output ? (
          <>
            <pre className={styles.output} data-error={state === 'error' || undefined}>{output.text || 'No output.'}</pre>
            {output.hidden > 0 ? <p className={styles.note}>{output.hidden} more {output.hidden === 1 ? 'line' : 'lines'} — open this chat on your Mac for the full output.</p> : null}
          </>
        ) : (
          <p className={styles.note}>Still running — no output yet.</p>
        )
      ) : null}
    </div>
  );
}

function ThinkingChip({ item }: { item: Extract<TranscriptItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.tool}>
      <button type="button" className={cx(styles.toolChip, styles.thinkingChip)} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={styles.toolText}>{thinkingLabel(item)}</span>
      </button>
      {open ? (
        <p className={styles.thinkingText}>{item.redacted || !item.text.trim() ? 'The model kept this reasoning private.' : item.text}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes (read-only)
// ---------------------------------------------------------------------------

interface RootDiff {
  rootId: string;
  name: string;
  diff: VerseCheckpointDiffResponse;
}

type ChangesLoad =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'empty'; reason: string | null }
  | { state: 'ready'; turnId: string; roots: RootDiff[] };

const NO_CHECKPOINT = 'VERSE_CHECKPOINT_UNAVAILABLE';

function ChangesPane({ sessionId, version }: { sessionId: string; version: string }) {
  const [load, setLoad] = useState<ChangesLoad>({ state: 'loading' });
  const [retry, setRetry] = useState(0);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    // Keep the last answer on screen while a refresh runs (no flash to a skeleton).
    setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }));
    void (async () => {
      const list = await checkpointClient.list(sessionId, ctl.signal);
      // "Everything this chat changed": from the checkpoint before its FIRST
      // turn that has one, to the files on disk now.
      const first = list.turns.find(turnHasCheckpoint);
      if (!first) {
        const reason = list.turns.map(turnCheckpointError).find((r) => r !== null) ?? null;
        if (!ctl.signal.aborted) setLoad({ state: 'empty', reason });
        return;
      }
      const rootIds = first.roots.filter((r) => r.pre?.commit).map((r) => r.rootId);
      const names = new Map(list.roots.map((r) => [r.rootId, r.name]));
      const diffs = await Promise.all(
        rootIds.map((rootId) => checkpointClient.diff({ chatId: sessionId, turnId: first.turnId, rootId, mode: 'since' }, ctl.signal)),
      );
      if (ctl.signal.aborted) return;
      setLoad({
        state: 'ready',
        turnId: first.turnId,
        roots: diffs.map((diff, i) => ({ rootId: rootIds[i]!, name: names.get(rootIds[i]!) ?? 'Repository', diff })),
      });
    })().catch((err: unknown) => {
      if (ctl.signal.aborted) return;
      if (errorCode(err) === NO_CHECKPOINT) setLoad({ state: 'empty', reason: null });
      else setLoad({ state: 'error', message: describeCheckpointError(err) });
    });
    return () => ctl.abort();
  }, [sessionId, version, retry]);

  if (load.state === 'loading') return <SkeletonList rows={3} label="Loading changes" />;
  if (load.state === 'error') return <ErrorState title="Couldn’t load the changes" reason={load.message} onRetry={() => setRetry((n) => n + 1)} />;
  if (load.state === 'empty') {
    return <EmptyState title="No checkpoint for this chat yet" body={load.reason ?? 'Phantom snapshots a git repository when a turn starts there; changes show up after the first one.'} />;
  }

  const allFiles = load.roots.flatMap((r) => r.diff.files);
  const sum = totals(allFiles);
  const multi = load.roots.length > 1;
  return (
    <div className={styles.changes}>
      <p className={styles.summary} aria-label="Summary">{diffSummary(sum)}</p>
      {allFiles.length === 0 ? <EmptyState title="No changes on disk" body="Everything this chat changed has been undone, or it has not edited a file yet." /> : null}
      {load.roots.map((root) =>
        root.diff.files.length === 0 ? null : (
          <section key={root.rootId} className={ui.section} aria-label={root.name}>
            {multi ? <h2 className={styles.rootName}>{root.name}</h2> : null}
            <div className={ui.group}>
              {root.diff.files.map((file) => {
                const key = `${root.rootId}\u0000${file.path}`;
                const expanded = open === key;
                return (
                  <div key={key} className={styles.fileBlock}>
                    <button type="button" className={cx(ui.row, styles.fileRow)} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : key)}>
                      <span className={styles.fileStatus} data-status={file.status} title={STATUS_WORD[file.status]}>{file.status}</span>
                      <span className={styles.filePath}>{file.oldPath && file.status === 'R' ? `${file.path} (was ${file.oldPath})` : file.path}</span>
                      <span className={styles.fileCounts}>
                        {file.binary ? 'binary' : <><span className={styles.add}>+{file.additions}</span> <span className={styles.del}>−{file.deletions}</span></>}
                      </span>
                    </button>
                    {expanded ? <FilePatch sessionId={sessionId} turnId={load.turnId} rootId={root.rootId} file={file} /> : null}
                  </div>
                );
              })}
            </div>
          </section>
        ),
      )}
      <p className={ui.sectionFooter}>Read-only here. Review and undo on your Mac.</p>
    </div>
  );
}

type PatchLoad = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; diff: VerseCheckpointDiffResponse };

function FilePatch({ sessionId, turnId, rootId, file }: { sessionId: string; turnId: string; rootId: string; file: VerseCheckpointDiffFile }) {
  const [load, setLoad] = useState<PatchLoad>({ state: 'loading' });
  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ state: 'loading' });
    checkpointClient.diff({ chatId: sessionId, turnId, rootId, mode: 'since', file: file.path }, ctl.signal).then(
      (diff) => { if (!ctl.signal.aborted) setLoad({ state: 'ready', diff }); },
      (err: unknown) => { if (!ctl.signal.aborted) setLoad({ state: 'error', message: describeCheckpointError(err) }); },
    );
    return () => ctl.abort();
  }, [sessionId, turnId, rootId, file.path]);

  if (load.state === 'loading') return <p className={styles.note} role="status">Loading the diff…</p>;
  if (load.state === 'error') return <p className={styles.note} role="alert">{load.message}</p>;
  const patch = load.diff.patch;
  if (file.binary || patch?.binary) return <p className={styles.note}>Binary file — open it on your Mac to compare.</p>;
  if (!file.captured) return <p className={styles.note}>Too large to snapshot, so there is no diff for it.</p>;
  if (!patch || !patch.text.trim()) return <p className={styles.note}>No text changes.</p>;
  return (
    <>
      <div className={styles.patch} aria-label={`Diff of ${file.path}`}>
        {diffLines(patch.text).map((line, i) => (
          <div key={i} className={styles.line} data-kind={line.kind}>{line.text || ' '}</div>
        ))}
      </div>
      {patch.truncated ? <p className={styles.note}>This diff was cut short — see the whole change on your Mac.</p> : null}
    </>
  );
}

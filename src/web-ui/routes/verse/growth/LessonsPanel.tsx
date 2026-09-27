/**
 * routes/verse/growth/LessonsPanel.tsx — Growth ⌘3 › Lessons (3.15).
 *
 * Every finished task leaves a retro; this is where they are read and where
 * their suggested knowledge is decided:
 *
 *   Recurring causes (stacked by fleet / cloud / leader) | Suggested knowledge (approve / edit / reject)
 *   Recent retros (what was asked, what happened, why, what next) | Approved knowledge (hits, AGENTS.md)
 *
 * Lazy-loaded by GrowthSection: nothing here is fetched until Growth opens.
 * Every write goes through useGuardedAction (the token dialog first); a
 * read-only server explains itself instead of failing.
 */
import { useMemo, useState } from 'react';
import { BarStack } from '../../../components/charts/BarStack.js';
import type { ChartStatus } from '../../../components/charts/ChartFrame.js';
import { seriesColor } from '../../../components/charts/colors.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Tag } from '../../../components/primitives/Tag.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { useGuardedAction } from '../autonomy/use-guarded-action.js';
import { Card, CardNote } from '../command/Surface.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import type { KnowledgeNoteV1, RetroSummary } from '../../../../core/learn/retro/types.js';
import { decideKnowledgeNote, lessonsQuery, proposeKnowledgeToAgentsMd, sweepLessons } from './lessons-data.js';
import {
  END_KIND_LABEL,
  END_KIND_TONE,
  SOURCES,
  SOURCE_LABEL,
  budgetLine,
  causeChart,
  parseScopeForm,
  scopeLabel,
} from './lessons-model.js';
import styles from './lessons.module.css';

export const LESSONS_POLL_MS = 300_000;

const CAUSE_SEGMENTS = SOURCES.map((s, i) => ({ id: s, label: SOURCE_LABEL[s], color: seriesColor(i) }));

function RetroRow({ retro }: { retro: RetroSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.retro}>
      <button type="button" className={styles.retroHead} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <StatusBadge status={retro.endKind} tone={END_KIND_TONE[retro.endKind]}>{END_KIND_LABEL[retro.endKind]}</StatusBadge>
        <span className={styles.retroAsked}>{retro.asked}</span>
        <span className={styles.meta}>
          {SOURCE_LABEL[retro.source]}{retro.repo ? ` · ${retro.repo}` : ''} · {formatRelative(retro.endedAt)}
        </span>
      </button>
      {open ? (
        <dl className={styles.retroBody}>
          <dt>What happened</dt>
          <dd>{retro.happened}</dd>
          {retro.rootCause ? (
            <>
              <dt>Root cause</dt>
              <dd>
                <strong>{retro.rootCause.label}</strong> — {retro.rootCause.detail}{' '}
                <span className={styles.meta}>(from {retro.rootCause.evidence})</span>
              </dd>
            </>
          ) : null}
          {retro.doDifferently.length > 0 ? (
            <>
              <dt>Next time</dt>
              <dd>
                <ul className={styles.bullets}>
                  {retro.doDifferently.map((d) => <li key={d}>{d}</li>)}
                </ul>
              </dd>
            </>
          ) : null}
          {retro.betterPrompt ? (
            <>
              <dt>A better prompt</dt>
              <dd><pre className={styles.prompt}>{retro.betterPrompt}</pre></dd>
            </>
          ) : null}
          {retro.modelAssisted ? <dd className={styles.meta}>Refined by a local / Grok model pass.</dd> : null}
        </dl>
      ) : null}
    </li>
  );
}

interface NoteRowProps {
  note: KnowledgeNoteV1;
  disabled: boolean;
  onApprove: (note: KnowledgeNoteV1, edit?: { text: string; scope: KnowledgeNoteV1['scope'] }) => void;
  onReject: (note: KnowledgeNoteV1) => void;
}

function PendingNote({ note, disabled, onApprove, onReject }: NoteRowProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [repo, setRepo] = useState(note.scope.repo ?? '');
  const [globs, setGlobs] = useState(note.scope.pathGlobs.join(', '));
  const [kinds, setKinds] = useState(note.scope.taskKinds.join(', '));
  const scope = parseScopeForm(repo, globs, kinds);
  const valid = scope !== null && text.trim().length >= 8;
  return (
    <li className={styles.note}>
      {editing ? (
        <div className={styles.editor}>
          <label className={styles.field}>
            <span className={styles.label}>Lesson</span>
            <textarea className={styles.textarea} value={text} rows={3} maxLength={600} onChange={(e) => setText(e.target.value)} />
          </label>
          <div className={styles.scopeRow}>
            <label className={styles.field}>
              <span className={styles.label}>Repo (owner/name, blank = any)</span>
              <input className={styles.input} value={repo} onChange={(e) => setRepo(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Paths (globs, comma-separated)</span>
              <input className={styles.input} value={globs} onChange={(e) => setGlobs(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Task kinds</span>
              <input className={styles.input} value={kinds} placeholder="fix, tests, …" onChange={(e) => setKinds(e.target.value)} />
            </label>
          </div>
          {!valid ? <CardNote tone="danger">Check the scope: repo as owner/name, simple globs, known task kinds.</CardNote> : null}
          <div className={styles.actions}>
            <Button size="sm" variant="primary" disabled={disabled || !valid} onClick={() => scope && onApprove(note, { text: text.trim(), scope })}>
              Approve edited
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <>
          <p className={styles.noteText}>{note.text}</p>
          <p className={styles.meta}>
            {scopeLabel(note.scope)}{note.seen > 1 ? ` · suggested ${note.seen}×` : ''} · from {note.source}
          </p>
          <div className={styles.actions}>
            <Button size="sm" variant="subtle" disabled={disabled} onClick={() => onApprove(note)}>Approve</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setEditing(true)}>Edit</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onReject(note)}>Reject</Button>
          </div>
        </>
      )}
    </li>
  );
}

export function LessonsPanel() {
  const lessons = useQuery(lessonsQuery, { freshMs: 60_000 });
  const refetch = useRefetch(lessonsQuery);
  usePollWhileVisible(refetch, LESSONS_POLL_MS);
  const guard = useGuardedAction();
  const [notice, setNotice] = useState<string | null>(null);

  const state = lessons.data?.value ?? null;
  const chart = useMemo(() => causeChart(state?.causes ?? []), [state]);
  const causeStatus: ChartStatus = !lessons.data
    ? { kind: 'loading' }
    : !state
      ? { kind: 'unknown', reason: lessons.data.reason ?? 'Lessons did not answer.' }
      : chart.categories.length === 0
        ? { kind: 'empty', message: `No failed task ends in ${state.windowDays} days.` }
        : { kind: 'ready' };

  const busy = guard.busy;
  const approve = (note: KnowledgeNoteV1, edit?: { text: string; scope: KnowledgeNoteV1['scope'] }) =>
    guard.request(
      () => decideKnowledgeNote({ id: note.id, decision: 'approve', ...(edit ? { text: edit.text, scope: edit.scope } : {}) }),
      'Approve a lesson so future matching tasks are told about it',
      () => setNotice('Approved. Matching fleet and cloud tasks will be told about it.'),
    );
  const reject = (note: KnowledgeNoteV1) =>
    guard.request(() => decideKnowledgeNote({ id: note.id, decision: 'reject' }), 'Reject a suggested lesson', () => setNotice('Rejected. It will not be suggested again.'));
  const agentsMd = (note: KnowledgeNoteV1) =>
    guard.request(
      () => proposeKnowledgeToAgentsMd(note.id),
      'File a fleet task that proposes this lesson for the repo’s AGENTS.md',
      () => setNotice('Queued a fleet task. The AGENTS.md change arrives as a proposal and passes every gate.'),
    );
  const sweep = () =>
    guard.request(sweepLessons, 'Scan finished tasks for new retros', (r) => setNotice(`Swept: ${r.created} new retro(s), ${r.candidates} new suggestion(s).`));

  const sweepAction = (
    <Button size="sm" variant="ghost" disabled={busy || guard.readOnly} onClick={sweep}>Sweep now</Button>
  );

  return (
    <div className={styles.panel} aria-label="Lessons">
      <header className={styles.head}>
        <h3 className={styles.title}>Lessons</h3>
        <span className={styles.meta}>
          {state?.sweptAt ? `Last sweep ${formatRelative(state.sweptAt)}` : 'Not swept yet'}
        </span>
        <span className={styles.spacer} />
        {sweepAction}
      </header>
      {notice ? <CardNote>{notice}</CardNote> : null}
      {guard.error ? <CardNote tone="danger">{guard.error}</CardNote> : null}
      {guard.readOnly ? <CardNote>This server runs without dispatch: lessons can be read, not decided.</CardNote> : null}
      <div className={styles.grid}>
        <div className={styles.wide}>
          <BarStack
            title={`Recurring failure causes · ${state?.windowDays ?? 30}d`}
            description="Why tasks ended without landing, by where they ran"
            status={causeStatus}
            categories={chart.categories}
            segments={CAUSE_SEGMENTS}
            values={chart.values}
            height={200}
          />
        </div>
        <div className={styles.narrow}>
          <Card title="Suggested knowledge" caption={state ? `${state.knowledge.pending.length} waiting` : undefined}>
            {!state ? (
              <CardNote tone="unknown">{lessons.data?.reason ?? 'Loading…'}</CardNote>
            ) : state.knowledge.pending.length === 0 ? (
              <CardNote>Nothing to review. Failed tasks suggest lessons here.</CardNote>
            ) : (
              <ul className={styles.list}>
                {state.knowledge.pending.slice(0, 8).map((n) => (
                  <PendingNote key={n.id} note={n} disabled={busy || guard.readOnly} onApprove={approve} onReject={reject} />
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className={styles.wide}>
          <Card title="Recent retros" caption={state ? `${state.retros.length} shown` : undefined}>
            {!state ? (
              <CardNote tone="unknown">{lessons.data?.reason ?? 'Loading…'}</CardNote>
            ) : state.retros.length === 0 ? (
              <CardNote>No finished tasks yet. Each merge, revert, close, refusal or veto leaves a retro here.</CardNote>
            ) : (
              <ul className={styles.list}>
                {state.retros.slice(0, 20).map((r) => <RetroRow key={r.id} retro={r} />)}
              </ul>
            )}
          </Card>
        </div>
        <div className={styles.narrow}>
          <Card title="Approved knowledge" caption={state ? budgetLine(state.knowledge.approvedBytes, state.knowledge.capBytes) : undefined}>
            {!state ? (
              <CardNote tone="unknown">{lessons.data?.reason ?? 'Loading…'}</CardNote>
            ) : state.knowledge.approved.length === 0 && state.playbook.length === 0 ? (
              <CardNote>No approved lessons yet.</CardNote>
            ) : (
              <ul className={styles.list}>
                {state.knowledge.approved.map((n) => (
                  <li key={n.id} className={styles.note}>
                    <p className={styles.noteText}>{n.text}</p>
                    <p className={styles.meta}>
                      {scopeLabel(n.scope)} · used {n.hits}×{n.lastHitAt ? `, last ${formatRelative(n.lastHitAt)}` : ''}{n.edited ? ' · edited' : ''}
                    </p>
                    {n.scope.repo ? (
                      <div className={styles.actions}>
                        {n.agentsMdTaskId ? (
                          <Tag size="sm">AGENTS.md proposal queued</Tag>
                        ) : (
                          <Button size="sm" variant="ghost" disabled={busy || guard.readOnly} onClick={() => agentsMd(n)}>
                            Propose for AGENTS.md
                          </Button>
                        )}
                      </div>
                    ) : null}
                  </li>
                ))}
                {state.playbook.map((p) => (
                  <li key={`${p.addedAt}:${p.text}`} className={styles.note}>
                    <p className={styles.noteText}>{p.text}</p>
                    <p className={styles.meta}>Leader veto lesson{p.hits > 0 ? ` · repeated ${p.hits}×` : ''} · read by the Leader</p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      <MutationTokenDialog open={guard.tokenOpen} onClose={guard.closeToken} reason={guard.tokenReason} tokenHelp="the mutation token ashlr verse printed" />
    </div>
  );
}

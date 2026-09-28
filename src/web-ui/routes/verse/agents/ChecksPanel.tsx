/**
 * routes/verse/agents/ChecksPanel.tsx — one agent's Checks: git status, its
 * PR, every CI check, review comments, what Auto-merge would do right now —
 * and the two switches, Auto-fix CI and Auto-merge when green.
 *
 * Shown in the Agents board's detail panel and as the chat dock's "Checks"
 * pane (checks.pane.tsx). A chat that is not an agent gets the same read,
 * read-only (the switches live on agents: they need a workspace branch).
 *
 * A review comment can go back to the agent in one click ("Send to agent"):
 * it is drafted into the chat's composer when the dock hosts this panel, or
 * sent as a turn from the board (through the ordinary turn route).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { VERSE_AGENTS_PATH, type AgentBoardResponse, type AgentChecksDetail } from '../../../../core/verse/agents/types.js';
import { apiGet } from '../../../data/client.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { sendVerseTurn } from '../verse-queries.js';
import { fetchAgentChecks, openAgentPr, updateAgentSettings } from './agents-queries.js';
import styles from './Agents.module.css';

const REFRESH_MS = 30_000;

export interface ChecksPanelProps {
  /** An agent id (`ag_…`) or `chat:<sessionId>`. */
  cardId: string;
  visible?: boolean;
  /** Draft text into the chat's composer (dock pane); absent → "Send to agent" sends a turn. */
  draftToChat?: (text: string) => void;
  /** Called after a switch or PR changes something the board shows. */
  onChanged?: () => void;
}

const CI_TEXT: Record<AgentChecksDetail['ci'], string> = {
  passing: 'All checks green',
  failing: 'Checks failing',
  pending: 'Checks running',
  none: 'No checks reported',
  unknown: 'Checks unknown',
};

export function commentToAgentText(c: AgentChecksDetail['comments'][number]): string {
  return [`Review comment from @${c.author}${c.path ? ` on ${c.path}` : ''}:`, '', c.body.split('\n').map((l) => `> ${l}`).join('\n'), '', 'Address it in this workspace, then commit and push to the same branch.'].join('\n');
}

export function ChecksPanel({ cardId, visible = true, draftToChat, onChanged }: ChecksPanelProps) {
  const [detail, setDetail] = useState<AgentChecksDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const gate = useTokenGate();
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback((fresh: boolean) => {
    const ctl = new AbortController();
    setLoading(true);
    fetchAgentChecks(cardId, fresh, ctl.signal).then(
      (d) => { if (alive.current) { setDetail(d); setError(null); } },
      (err: unknown) => { if (alive.current && !ctl.signal.aborted) setError(describeContextError(err)); },
    ).finally(() => { if (alive.current) setLoading(false); });
    return ctl;
  }, [cardId]);

  useEffect(() => {
    if (!visible) return undefined;
    const first = load(false);
    const timer = setInterval(() => load(false), REFRESH_MS);
    return () => { first.abort(); clearInterval(timer); };
  }, [visible, load]);

  const agentId = cardId.startsWith('ag_') ? cardId : null;
  const act = async (key: string, why: string, run: () => Promise<string | null>) => {
    setBusy(key);
    setNote(null);
    try {
      const message = await gate.run(why, run);
      if (message) setNote(message);
      onChanged?.();
      load(true);
    } catch (err) {
      setNote(describeContextError(err));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (key: 'autoFix' | 'autoMerge', next: boolean) => {
    if (!agentId) return;
    void act(key, key === 'autoFix' ? 'Change Auto-fix CI for this agent' : 'Change Auto-merge for this agent', async () => {
      await updateAgentSettings(agentId, { [key]: next });
      return null;
    });
  };

  const sendComment = (c: AgentChecksDetail['comments'][number]) => {
    const text = commentToAgentText(c);
    if (draftToChat) {
      draftToChat(text);
      setNote('Drafted into the chat — edit and send it.');
      return;
    }
    const sessionId = detail?.sessionId;
    if (!sessionId) return;
    void act(`comment:${c.at ?? c.body.slice(0, 10)}`, 'Send this review comment to the agent', async () => {
      await sendVerseTurn(sessionId, text);
      return 'Sent to the agent.';
    });
  };

  if (error && !detail) return <p className={styles.panelNote} role="alert">{error}</p>;
  if (!detail) return <p className={styles.panelNote}>{loading ? 'Reading git and GitHub…' : 'No checks yet.'}</p>;

  const d = detail;
  return (
    <div className={styles.checks} aria-label="Checks">
      <div className={styles.checksHead}>
        <div className={styles.checksBranch}>
          <span className={styles.mono}>{d.branch ?? 'detached HEAD'}</span>
          {d.base ? <span className={styles.muted}> → {d.base}</span> : null}
        </div>
        <Button size="sm" variant="ghost" onClick={() => load(true)} busy={loading}>Refresh</Button>
      </div>

      <dl className={styles.facts}>
        <div><dt>Working tree</dt><dd>{d.dirty === 0 ? 'Clean' : `${d.dirty} uncommitted`}</dd></div>
        <div><dt>Branch</dt><dd>{d.ahead} ahead{d.behind ? ` · ${d.behind} behind` : ''}{d.diffstat ? ` · +${d.diffstat.additions} −${d.diffstat.deletions} in ${d.diffstat.files} files` : ''}</dd></div>
        <div>
          <dt>PR</dt>
          <dd>
            {d.pr ? (
              <a href={d.pr.url} target="_blank" rel="noreferrer">#{d.pr.number} {d.pr.title}</a>
            ) : d.unavailable ? d.unavailable : 'None yet'}
            {d.pr ? <span className={styles.muted}> · {d.pr.state}{d.pr.mergeable === false ? ' · conflicts' : ''}</span> : null}
          </dd>
        </div>
        <div><dt>CI</dt><dd data-ci={d.ci}>{CI_TEXT[d.ci]}</dd></div>
      </dl>

      {!d.pr && agentId && d.ahead + d.dirty > 0 ? (
        <Button
          size="sm"
          variant="subtle"
          busy={busy === 'pr'}
          onClick={() => void act('pr', 'Push this agent’s branch and open a PR', async () => {
            const res = await openAgentPr(agentId);
            return `Opened PR #${res.pr.number}.`;
          })}
        >
          Push and open PR
        </Button>
      ) : null}

      {d.checks.length > 0 ? (
        <ul className={styles.checkList} aria-label="CI checks">
          {d.checks.map((c, i) => (
            <li key={`${c.name}-${i}`} data-state={c.state}>
              <span className={styles.checkDot} aria-hidden="true" />
              <span className={styles.checkName}>{c.name}</span>
              <span className={styles.muted}>{c.state}</span>
              {c.url ? <a href={c.url} target="_blank" rel="noreferrer">log</a> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {agentId ? (
        <div className={styles.loop}>
          <Switch
            checked={d.autoFix}
            onChange={(v) => toggle('autoFix', v)}
            disabled={busy !== null}
            label="Auto-fix CI"
          />
          <p className={styles.hint}>On a red check, the failing log goes back to this same seat — once per push, at most three times.</p>
          <Switch
            checked={d.autoMerge}
            onChange={(v) => toggle('autoMerge', v)}
            disabled={busy !== null}
            label="Auto-merge when green"
          />
          <p className={styles.hint} data-allowed={d.mergeVerdict.allowed || undefined}>{d.mergeVerdict.reason}</p>
          {d.loopNote ? <p className={styles.loopNote} role="status">{d.loopNote}</p> : null}
        </div>
      ) : (
        <p className={styles.hint}>This chat is not an agent: Auto-fix and Auto-merge belong to agents in their own workspace.</p>
      )}

      {d.comments.length > 0 ? (
        <section className={styles.comments} aria-label="Review comments">
          <h4 className={styles.smallHead}>Comments</h4>
          <ul>
            {d.comments.map((c, i) => (
              <li key={`${c.at ?? ''}-${i}`}>
                <div className={styles.commentMeta}>
                  <strong>@{c.author}</strong>
                  {c.path ? <span className={styles.mono}> {c.path}</span> : null}
                </div>
                <p className={styles.commentBody}>{c.body}</p>
                {d.sessionId ? (
                  <Button size="sm" variant="ghost" onClick={() => sendComment(c)} disabled={busy !== null}>
                    {draftToChat ? 'Add to message' : 'Send to agent'}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {note ? <p className={styles.panelNote} role="status">{note}</p> : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </div>
  );
}

/** The chat dock's Checks pane: the open chat's agent (or the chat itself, read-only). */
export function ChecksDockPane({ sessionId, visible, host }: { sessionId: string | null; visible: boolean; host: { addToMessage(text: string): void } }) {
  const [cardId, setCardId] = useState<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    // The board already knows which agent owns this chat.
    apiGet<AgentBoardResponse>(VERSE_AGENTS_PATH)
      .then((b) => { if (live) setCardId(b.cards.find((c) => c.sessionId === sessionId)?.id ?? `chat:${sessionId}`); })
      .catch(() => { if (live) setCardId(`chat:${sessionId}`); });
    return () => { live = false; };
  }, [sessionId]);
  if (!sessionId) return <p className={styles.panelNote}>Open a chat to see its checks.</p>;
  if (!cardId) return <p className={styles.panelNote}>Reading…</p>;
  return (
    <div className={styles.dockPane}>
      <ChecksPanel cardId={cardId} visible={visible} draftToChat={(t) => host.addToMessage(t)} />
    </div>
  );
}

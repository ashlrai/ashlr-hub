/**
 * routes/verse/agent-tools/AgentToolsStrip.tsx — above the composer, while a
 * chat has agent tools on (3.15):
 *
 *   - a destructive command waiting for you: the command, why it asks, the
 *     seconds left, and [Allow once] [Allow for chat] [Deny] — no answer in
 *     120 s is a refusal the agent is told about;
 *   - a terminal you took over (you typed in a tab the agent was driving):
 *     [Resume agent] hands it back;
 *   - the agent's recent actions, newest first.
 *
 * Polls the chat's activity every 2 s only while tools are on and the chat is
 * visible; renders nothing otherwise. Loaded lazily.
 */
import { useCallback, useEffect, useState } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import type { VerseAgentAction, VerseAgentToolsActivity, VerseMcpConfirmAnswer } from '../../../../core/verse/verse-mcp-types.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { agentToolsApi, type AgentToolsApi } from './agent-tools-client.js';
import styles from './AgentTools.module.css';

export const AGENT_TOOLS_ACTIVITY_POLL_MS = 2_000;
export const AGENT_TOOLS_STATE_POLL_MS = 10_000;
const SHOWN_ACTIONS = 5;

export interface AgentToolsStripProps {
  sessionId: string;
  /** Opens the Agent tools sheet. */
  onOpenSheet?: () => void;
  api?: AgentToolsApi;
  now?: () => number;
}

const OUTCOME_WORD: Record<VerseAgentAction['outcome'], string> = { ok: 'done', error: 'failed', denied: 'denied', pending: 'running' };

export function AgentToolsStrip({ sessionId, onOpenSheet, api = agentToolsApi, now = Date.now }: AgentToolsStripProps) {
  const gate = useTokenGate();
  const [enabled, setEnabled] = useState(false);
  const [seat, setSeat] = useState('the agent');
  const [activity, setActivity] = useState<VerseAgentToolsActivity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const loadState = useCallback(async () => {
    try {
      const state = await api.state(sessionId);
      setEnabled(state.scopes.length > 0);
      setSeat(state.seatLabel);
    } catch { /* the strip is optional: a failed read shows nothing */ }
  }, [api, sessionId]);

  const loadActivity = useCallback(async () => {
    try {
      setActivity(await api.activity(sessionId));
    } catch { /* keep the last answer */ }
  }, [api, sessionId]);

  useEffect(() => { void loadState(); }, [loadState]);
  usePollWhileVisible(() => { void loadState(); }, AGENT_TOOLS_STATE_POLL_MS);
  useEffect(() => { if (enabled) void loadActivity(); }, [enabled, loadActivity]);
  usePollWhileVisible(() => { void loadActivity(); setTick((t) => t + 1); }, AGENT_TOOLS_ACTIVITY_POLL_MS, { enabled });

  const answer = async (id: string, value: VerseMcpConfirmAnswer) => {
    try {
      const done = await gate.run('Answer the agent\'s request', () => api.confirm(sessionId, id, value).then(() => true));
      if (done) {
        setActivity((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== id) } : prev));
        setError(null);
      }
    } catch (err) {
      setError(describeContextError(err));
    }
    void loadActivity();
  };

  const resume = async (tabId: string) => {
    try {
      await gate.run('Hand the terminal back to the agent', () => api.resume(tabId).then(() => true));
      setError(null);
    } catch (err) {
      setError(describeContextError(err));
    }
    void loadActivity();
  };

  const pending = activity?.pending ?? [];
  const takenOver = (activity?.tabs ?? []).filter((t) => t.takenOverAt !== null);
  const actions = (activity?.actions ?? []).slice(0, SHOWN_ACTIONS);
  if (!enabled && pending.length === 0) return <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />;

  return (
    <div className={styles.strip} data-testid="agent-tools-strip">
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {pending.map((p) => {
        const left = Math.max(0, Math.round((Date.parse(p.expiresAt) - now()) / 1000));
        return (
          <div key={p.id} className={styles.confirm} role="alertdialog" aria-labelledby={`${p.id}-title`} aria-describedby={`${p.id}-why`}>
            <div className={styles.confirmText}>
              <span id={`${p.id}-title`} className={styles.confirmTitle}>{seat} wants to run</span>
              <code className={styles.command}>{p.command}</code>
              <span id={`${p.id}-why`} className={styles.quiet}>{p.reason} · {left}s left</span>
            </div>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.smallButton} onClick={() => void answer(p.id, 'once')}>Allow once</button>
              <button type="button" className={styles.smallButton} onClick={() => void answer(p.id, 'chat')}
                title="Allow commands like this for the rest of this chat">Allow for chat</button>
              <button type="button" className={`${styles.smallButton} ${styles.deny}`} onClick={() => void answer(p.id, 'deny')}>Deny</button>
            </div>
          </div>
        );
      })}
      {takenOver.map((t) => (
        <div key={t.tabId} className={styles.takeover} role="status">
          <span>You took over terminal {t.tabId}. {seat} is paused there.</span>
          <button type="button" className={styles.smallButton} onClick={() => void resume(t.tabId)}>Resume agent</button>
        </div>
      ))}
      {enabled ? (
        <div className={styles.actions} aria-label={`${seat}'s recent actions`}>
          <button type="button" className={styles.toolsChip} onClick={onOpenSheet} title="Agent tools for this chat">Agent tools on</button>
          {actions.length === 0 ? <span className={styles.quiet}>No actions yet.</span> : null}
          {actions.map((a) => (
            <span key={a.id} className={styles.action} data-outcome={a.outcome} title={`${a.tool} · ${a.at}`}>
              <span className={styles.actionTool}>{a.tool.replace(/^terminal_/, '').replace(/^browser_/, 'browser ')}</span>
              <span className={styles.actionSummary}>{a.summary}</span>
              <span className={styles.actionOutcome}>{OUTCOME_WORD[a.outcome]}</span>
            </span>
          ))}
        </div>
      ) : null}
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </div>
  );
}

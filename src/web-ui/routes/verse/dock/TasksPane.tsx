/**
 * routes/verse/dock/TasksPane.tsx — what is running, and where (SPEC-310C §3
 * "Tasks", unit C2; model: chat/tasks-model.ts).
 *
 *   THIS CHAT   ● Bash  npm test                     running 1m 02s
 *               ● Task  review the auth module       running 12s  (subagent)
 *               ✓ Read  src/core/api.ts              0.4s
 *   OTHER CHATS ● Fix the login bug · claude-a       npm run build · 3m 10s
 *
 * Click a call to jump to it in the transcript (a folded group opens itself);
 * click another chat to open it. Finished calls of this turn stay listed
 * under the running ones (newest first, the last 20) so "what did it just
 * do" is answerable without scrolling the transcript.
 */
import type { VerseEngine } from '../../../data/api-types.js';
import { ENGINE_MONOGRAM } from '../../../../core/verse/workbench-types.js';
import { LiveTimer } from '../chat/LiveTimer.js';
import type { ChatTask, TurnTask } from '../chat/tasks-model.js';
import { toolAnchorId } from '../chat/tool-semantics.js';
import { requestTranscriptJump } from '../chat/transcript-jump.js';
import { formatDuration } from '../verse-model.js';
import styles from './panes.module.css';

const FINISHED_SHOWN = 20;

export interface TasksPaneProps {
  /** This chat's calls since its last ask (running first). */
  turnTasks: readonly TurnTask[];
  otherChats: readonly ChatTask[];
  /** Whether a chat is open at all. */
  hasSession: boolean;
  onOpenSession: (sessionId: string) => void;
}

const STATUS_WORD: Record<TurnTask['status'], string> = { running: 'running', done: 'done', failed: 'failed' };

export function TasksPane({ turnTasks, otherChats, hasSession, onOpenSession }: TasksPaneProps) {
  const running = turnTasks.filter((t) => t.status === 'running');
  const finished = turnTasks.filter((t) => t.status !== 'running').slice(0, FINISHED_SHOWN);

  return (
    <div className={styles.pane} aria-label="Tasks">
      <section className={styles.section} aria-labelledby="dock-tasks-turn">
        <h3 id="dock-tasks-turn" className={styles.sectionTitle}>
          This chat <span className={styles.count}>{running.length > 0 ? `${running.length} running` : ''}</span>
        </h3>
        {!hasSession ? (
          <p className={styles.muted}>Open a chat to see its tool calls here.</p>
        ) : turnTasks.length === 0 ? (
          <p className={styles.muted}>No tool calls in the latest turn.</p>
        ) : (
          <ul className={styles.taskList}>
            {[...running, ...finished].map((task) => (
              <li key={task.toolUseId}>
                <button type="button" className={styles.task} data-status={task.status}
                  onClick={() => { requestTranscriptJump(toolAnchorId(task.toolUseId)); }}
                  aria-label={`${task.kind === 'subagent' ? 'Subagent' : task.name}: ${task.detail}, ${STATUS_WORD[task.status]}. Jump to it in the chat.`}>
                  <span className={styles.taskMark} data-status={task.status} aria-hidden="true" />
                  <span className={styles.taskName}>{task.kind === 'subagent' ? 'Subagent' : task.name}</span>
                  <span className={styles.taskDetail} title={task.detail}>{task.detail}</span>
                  <span className={styles.taskTime}>
                    {task.status === 'running'
                      ? <LiveTimer since={task.startedAt} />
                      : task.status === 'failed'
                        ? 'failed'
                        : task.durationMs !== null && task.durationMs > 0 ? formatDuration(task.durationMs) : 'done'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="dock-tasks-chats">
        <h3 id="dock-tasks-chats" className={styles.sectionTitle}>
          Other chats <span className={styles.count}>{otherChats.length > 0 ? `${otherChats.length} running` : ''}</span>
        </h3>
        {otherChats.length === 0 ? (
          <p className={styles.muted}>No other chat is running.</p>
        ) : (
          <ul className={styles.taskList}>
            {otherChats.map((chat) => (
              <li key={chat.sessionId}>
                <button type="button" className={styles.task} data-status="running" onClick={() => onOpenSession(chat.sessionId)}
                  aria-label={`${chat.title || 'Untitled chat'}, running${chat.live ? `: ${chat.live}` : ''}. Open this chat.`}>
                  <EngineTick engine={chat.engine} />
                  <span className={styles.taskName}>{chat.title || 'Untitled chat'}</span>
                  <span className={styles.taskDetail} title={chat.live ?? undefined}>{chat.live ?? ''}</span>
                  <span className={styles.taskTime}>{chat.startedAt ? <LiveTimer since={chat.startedAt} /> : 'running'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Engine identity: a 2px tick plus the monogram — never a vendor logo (SPEC-310C §6). */
export function EngineTick({ engine }: { engine: VerseEngine }) {
  return <span className={styles.engineTick} data-engine={engine} aria-hidden="true">{ENGINE_MONOGRAM[engine]}</span>;
}

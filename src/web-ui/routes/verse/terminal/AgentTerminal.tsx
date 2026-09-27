/**
 * terminal/AgentTerminal.tsx — the per-chat "Agent" tab (3.15): every shell
 * command this chat's agents ran, as read-only blocks, so the operator can
 * watch exactly what ran.
 *
 * READ-ONLY, AND NOTHING RE-RUNS. The blocks are the chat transcript's own
 * tool events (useVerseTranscript reads the chat store the Chat section
 * already streams; it opens no connection of its own). "Paste in terminal"
 * types a command at one of YOUR prompts and stops there, like the
 * transcript's "Run in terminal". Commands a seat runs where Verse cannot
 * see them (a CLI's own sandboxed sub-shells it does not report) are not
 * here — only what the seat reported as a tool call.
 */
import { useMemo } from 'react';
import { useVerseTranscript } from '../useVerseTranscript.js';
import { BlockList, type BlockAction } from './BlockList.js';
import { agentBlocksFromTranscript, type BlockView } from './blocks-model.js';
import styles from './TerminalPanel.module.css';

export interface AgentTerminalProps {
  sessionId: string;
  onAction: (action: BlockAction, block: BlockView) => void;
  /** Ring this block (from the panel). */
  highlightId?: string | null;
}

export const AGENT_BLOCK_ACTIONS: readonly BlockAction[] = ['copy-output', 'copy-command', 'send', 'explain', 'paste'];

export function AgentTerminal({ sessionId, onAction, highlightId = null }: AgentTerminalProps) {
  const transcript = useVerseTranscript(sessionId);
  const blocks = useMemo(() => agentBlocksFromTranscript(transcript.items), [transcript.items]);
  const running = blocks.some((b) => b.running);
  return (
    <div className={styles.leaf} data-testid="agent-terminal">
      <div className={styles.header}>
        <span className={styles.cwd}>What the agents ran in this chat</span>
        <span className={styles.headerStatus} role="status" aria-live="polite">
          {running ? 'A command is running…' : blocks.length > 0 ? `${blocks.length} ${blocks.length === 1 ? 'command' : 'commands'}` : ''}
        </span>
      </div>
      <BlockList
        blocks={blocks}
        onAction={onAction}
        actions={AGENT_BLOCK_ACTIONS}
        highlightId={highlightId}
        label="Commands the agents ran"
        emptyTitle="No agent commands yet"
        emptyBody="When an agent in this chat runs a shell command, it appears here as a read-only block: the command, its output and how it ended."
      />
    </div>
  );
}

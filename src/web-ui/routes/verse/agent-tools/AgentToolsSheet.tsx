/**
 * routes/verse/agent-tools/AgentToolsSheet.tsx — the chat's "Agent tools"
 * sheet (3.15): what this chat's seat may do on this Mac through Verse's MCP
 * server (core/verse/verse-mcp*.ts).
 *
 *   Terminal  off / agent tabs / share my shells
 *   Browser   off / look / act on localhost / act on allowed sites (+ page scripts)
 *   Computer  off / listed apps
 *
 * Changes apply at once — a running turn loses a tool the moment it is
 * switched off. Nothing here is remembered across a Verse restart: the tools
 * start off again, like the Browser pane's agent access. Loaded lazily (the
 * chat's first paint never pays for it).
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Segmented } from '../../../components/primitives/Segmented.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { Switch } from '../../../components/primitives/Switch.js';
import type {
  VerseAgentBrowserMode,
  VerseAgentComputerMode,
  VerseAgentTerminalMode,
  VerseAgentToolsGrantRequest,
  VerseAgentToolsState,
} from '../../../../core/verse/verse-mcp-types.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { agentToolsApi, type AgentToolsApi } from './agent-tools-client.js';
import styles from './AgentTools.module.css';

export interface AgentToolsSheetProps {
  sessionId: string;
  open: boolean;
  onClose: () => void;
  api?: AgentToolsApi;
}

const TERMINAL_HELP: Record<VerseAgentTerminalMode, string> = {
  off: 'The agent cannot use Phantom terminals.',
  agent: 'The agent opens its own terminal tabs (marked Agent) and runs commands there. You can watch, type to take over, and hand back.',
  shared: 'Also lets you share one of your own shells with the agent, per tab, from the terminal\'s More menu.',
};

const BROWSER_HELP: Record<VerseAgentBrowserMode, string> = {
  off: 'The agent cannot use the Browser pane.',
  look: 'Open pages, take screenshots, read text and the console — on localhost, or sites you allowed in the Browser pane.',
  'act-localhost': 'Also click, type and fill forms — on localhost pages only.',
  'act-allowed': 'Also click, type and fill forms on sites you allowed for this chat.',
};

export function AgentToolsSheet({ sessionId, open, onClose, api = agentToolsApi }: AgentToolsSheetProps) {
  const titleId = useId();
  const gate = useTokenGate();
  const [state, setState] = useState<VerseAgentToolsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [apps, setApps] = useState('');

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    api.state(sessionId, abort.signal).then(
      (next) => { setState(next); setApps(next.grant.computerApps.join(', ')); setError(null); },
      (err: unknown) => { if (!abort.signal.aborted) setError(describeContextError(err)); },
    );
    return () => abort.abort();
  }, [api, open, sessionId]);

  const change = useCallback(async (patch: Omit<VerseAgentToolsGrantRequest, 'sessionId'>) => {
    setBusy(true);
    try {
      const next = await gate.run('Change what this chat\'s agent may do', () => api.setGrant({ sessionId, ...patch }));
      if (next) { setState(next); setError(null); }
    } catch (err) {
      setError(describeContextError(err));
    } finally {
      setBusy(false);
    }
  }, [api, gate, sessionId]);

  const grant = state?.grant ?? null;
  const seat = state?.seatLabel ?? 'the agent';
  const unsupported = state && !state.support.supported ? state.support.reason : null;
  const disabled = busy || state === null || unsupported !== null;
  const act = grant?.browser === 'act-localhost' || grant?.browser === 'act-allowed';

  return (
    <>
      <Sheet open={open} onClose={onClose} titleId={titleId} title="Agent tools"
        description={`What ${seat} may do on this Mac in this chat, through Phantom. Changes apply at once.`}
        footer={<p className={styles.footnote}>Everything starts off again when Phantom restarts. Destructive commands always ask you first.</p>}>
        <div className={styles.sheetBody} aria-busy={state === null || busy || undefined}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {unsupported ? <p className={styles.warning} role="note">{unsupported}</p> : null}
          {state && !state.desktop ? (
            <p className={styles.warning} role="note">Terminal and computer tools need the Phantom desktop app; this Phantom server has no built-in terminal.</p>
          ) : null}
          {state && state.support.supported ? <p className={styles.quiet}>{state.support.note}</p> : null}

          <section className={styles.group} aria-labelledby={`${titleId}-terminal`}>
            <h3 id={`${titleId}-terminal`} className={styles.groupTitle}>Terminal</h3>
            <Segmented<VerseAgentTerminalMode>
              aria-labelledby={`${titleId}-terminal`}
              size="sm"
              block
              value={grant?.terminal ?? 'off'}
              onChange={(terminal) => void change({ terminal })}
              options={[
                { value: 'off', label: 'Off', disabled },
                { value: 'agent', label: 'Agent tabs', disabled },
                { value: 'shared', label: 'Share my shells', disabled },
              ]}
            />
            <p className={styles.quiet}>{TERMINAL_HELP[grant?.terminal ?? 'off']}</p>
          </section>

          <section className={styles.group} aria-labelledby={`${titleId}-browser`}>
            <h3 id={`${titleId}-browser`} className={styles.groupTitle}>Browser</h3>
            <Segmented<VerseAgentBrowserMode>
              aria-labelledby={`${titleId}-browser`}
              size="sm"
              block
              value={grant?.browser ?? 'off'}
              onChange={(browser) => void change({ browser })}
              options={[
                { value: 'off', label: 'Off', disabled },
                { value: 'look', label: 'Look', disabled },
                { value: 'act-localhost', label: 'Act: localhost', disabled },
                { value: 'act-allowed', label: 'Act: allowed sites', disabled },
              ]}
            />
            <p className={styles.quiet}>{BROWSER_HELP[grant?.browser ?? 'off']}</p>
            {act ? (
              <Switch checked={grant?.browserScript === true} disabled={disabled}
                onChange={(browserScript) => void change({ browserScript })}
                label="Allow page scripts (run JavaScript in the page)" />
            ) : null}
          </section>

          <section className={styles.group} aria-labelledby={`${titleId}-computer`}>
            <h3 id={`${titleId}-computer`} className={styles.groupTitle}>Computer</h3>
            <Segmented<VerseAgentComputerMode>
              aria-labelledby={`${titleId}-computer`}
              size="sm"
              block
              value={grant?.computer ?? 'off'}
              onChange={(computer) => void change({ computer })}
              options={[
                { value: 'off', label: 'Off', disabled },
                { value: 'apps', label: 'Listed apps', disabled },
              ]}
            />
            {grant?.computer === 'apps' ? (
              <form className={styles.apps} onSubmit={(event) => {
                event.preventDefault();
                void change({ computerApps: apps.split(',').map((a) => a.trim()).filter(Boolean) });
              }}>
                <label className={styles.quiet} htmlFor={`${titleId}-apps`}>Apps the agent may see and drive (comma-separated)</label>
                <div className={styles.appsRow}>
                  <input id={`${titleId}-apps`} className={styles.input} value={apps} disabled={disabled}
                    placeholder="Simulator, Xcode" onChange={(event) => setApps(event.target.value)} />
                  <button type="submit" className={styles.smallButton} disabled={disabled}>Save</button>
                </div>
              </form>
            ) : (
              <p className={styles.quiet}>The agent cannot see or drive other apps.</p>
            )}
          </section>
        </div>
      </Sheet>
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </>
  );
}

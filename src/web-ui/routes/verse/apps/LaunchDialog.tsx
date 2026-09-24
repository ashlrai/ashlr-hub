/**
 * routes/verse/apps/LaunchDialog.tsx — the options behind [Launch ▾]: which
 * folder, the agent's own command or `ollama launch <id>`, which local model,
 * and where (a Verse terminal tab, or Terminal.app).
 *
 * The exact command is always on screen before anything opens. The plain
 * [Launch] button beside it skips this dialog with the defaults (the agent's
 * own command, your current chat or most recent project).
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { VerseAppRow } from '../../../../core/verse/workbench-types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Select } from '../../../components/primitives/Select.js';
import { launchCommand, type LaunchChoice, type LaunchProject, type LaunchVia } from './apps-model.js';
import { CopyPill } from './CopyPill.js';
import { commandText, type InVerseAvailability } from './launch.js';
import styles from './Apps.module.css';

export type LaunchTarget = 'verse' | 'terminal-app';

export interface LaunchRequest {
  choice: LaunchChoice;
  target: LaunchTarget;
  /** Terminal.app only; a Verse tab opens in the open chat's folder. */
  root: string | null;
  command: string[];
}

export function LaunchDialog({
  row,
  projects,
  models,
  inVerse,
  busy,
  error,
  onCancel,
  onLaunch,
}: {
  row: VerseAppRow | null;
  projects: readonly LaunchProject[];
  /** Ollama tags the local seats run. */
  models: readonly string[];
  inVerse: InVerseAvailability;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onLaunch: (request: LaunchRequest) => void;
}) {
  const titleId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const [via, setVia] = useState<LaunchVia>('native');
  const [model, setModel] = useState<string>('');
  const [root, setRoot] = useState<string>(projects[0]?.path ?? '');

  // A new row opens with fresh defaults.
  useEffect(() => {
    setVia('native');
    setModel('');
    setRoot(projects[0]?.path ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset per opened row only
  }, [row?.id]);

  const choice: LaunchChoice = { via, model: via === 'ollama' && model !== '' ? model : null };
  const command = useMemo(() => (row ? launchCommand(row, choice) : null), [row, choice.via, choice.model]); // eslint-disable-line react-hooks/exhaustive-deps
  if (row === null) return null;
  const nativeCommand = launchCommand(row, { via: 'native', model: null });
  const ollamaCommand = row.ollamaLaunch;
  const radioName = `${titleId}-via`;
  const canTerminalApp = root !== '';

  return (
    <Dialog
      open
      onClose={onCancel}
      titleId={titleId}
      title={`Launch ${row.name}`}
      description="Nothing starts until you choose where."
      initialFocusRef={firstRef}
    >
      <div className={styles.dialogBody}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Run</legend>
          {nativeCommand ? (
            <label className={styles.radio}>
              <input ref={firstRef} type="radio" name={radioName} checked={via === 'native'} onChange={() => setVia('native')} />
              <code className={styles.inlineCode}>{commandText(nativeCommand)}</code>
              <span className={styles.hint}>its own command</span>
            </label>
          ) : null}
          {ollamaCommand ? (
            <label className={styles.radio}>
              <input type="radio" name={radioName} checked={via === 'ollama'} onChange={() => setVia('ollama')} />
              <code className={styles.inlineCode}>{commandText(ollamaCommand)}</code>
              <span className={styles.hint}>through Ollama</span>
            </label>
          ) : null}
        </fieldset>

        {via === 'ollama' ? (
          models.length > 0 ? (
            <Select label="Local model" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">Ollama’s default</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          ) : (
            <p className={styles.hint}>No local models are known to Verse, so Ollama will ask which to use.</p>
          )
        ) : null}

        <Select
          label="Folder (Terminal.app)"
          value={root}
          onChange={(e) => setRoot(e.target.value)}
          hint={projects.length === 0 ? 'No chat folders or enrolled projects yet.' : 'A Verse tab opens in the chat you have open.'}
          disabled={projects.length === 0}
        >
          {projects.length === 0 ? <option value="">—</option> : null}
          {projects.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
        </Select>

        {command ? (
          <div className={styles.commandBlock}>
            <span className={styles.commandLabel}>Command</span>
            <CopyPill text={commandText(command)} what={`the ${row.name} launch command`} />
          </div>
        ) : null}

        {via === 'ollama' && inVerse.available ? (
          <p className={styles.hint}>In a Verse tab this runs exactly the command above — Verse builds it from what is installed, never from this page.</p>
        ) : null}
        {!inVerse.available && inVerse.reason ? <p className={styles.hint}>Verse terminal: {inVerse.reason}</p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        <div className={styles.dialogActions}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant={inVerse.available ? 'subtle' : 'primary'}
            busy={busy}
            disabled={!canTerminalApp || command === null}
            onClick={() => command && onLaunch({ choice, target: 'terminal-app', root, command })}
          >
            Open in Terminal.app
          </Button>
          {inVerse.available ? (
            <Button
              variant="primary"
              disabled={command === null}
              onClick={() => command && onLaunch({ choice, target: 'verse', root: null, command })}
            >
              Open in Verse terminal
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

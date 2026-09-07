import { useState, type FormEvent } from 'react';
import type { ResourceConsoleScope, ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import type { ConsoleWorker } from './CapacityBoard.js';
import styles from './ResourcePoolView.module.css';

export function TaskComposer({ scope, workers, enabled, unlocked, busy, onUnlock, onSubmit }: {
  scope: ResourceConsoleScope; workers: ConsoleWorker[]; enabled: boolean; unlocked: boolean; busy: boolean;
  onUnlock: () => void; onSubmit: (task: ResourceConsoleTaskInput) => Promise<boolean>;
}) {
  const [id, setId] = useState(() => `task-${crypto.randomUUID().slice(0, 12)}`);
  const [prompt, setPrompt] = useState('');
  const [allowed, setAllowed] = useState(() => workers.map((worker) => worker.id));
  const [mode, setMode] = useState<ResourceConsoleTaskInput['mode']>('read-only');
  const [seconds, setSeconds] = useState('300');
  const [tokens, setTokens] = useState('4096');
  const [error, setError] = useState<string | null>(null);
  const selected = allowed.filter((id) => workers.some((worker) => worker.id === id));

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null);
    if (!enabled || busy) return;
    if (!unlocked) { onUnlock(); return; }
    const timeoutMs = Number(seconds) * 1000; const maxOutputTokens = Number(tokens);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !prompt.trim() || prompt.includes('\0') ||
      new TextEncoder().encode(prompt).byteLength > 32_768 || selected.length === 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900_000 ||
      !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16_384) {
      setError('Use a unique lowercase task ID, a nonempty prompt up to 32 KiB, at least one worker, 1–900 seconds, and 1–16,384 output tokens.'); return;
    }
    if (await onSubmit({ id, prompt, allowedWorkerIds: selected, mode, timeoutMs, maxOutputTokens })) {
      setPrompt(''); setId(`task-${crypto.randomUUID().slice(0, 12)}`);
    }
  }

  return <section className={styles.inspector} aria-labelledby="compose-title">
    <div className={styles.sectionHeading}><div><h2 id="compose-title">Queue a task</h2><p>Choose the work. The foreground supervisor waits for eligible capacity.</p></div></div>
    {scope.readOnly ? <div className={styles.notice}><strong>Execution is disabled</strong>
      <p>Restart this console with <code>--execute --workspace /absolute/workspace</code> to enable task controls. Opening this page never starts work.</p></div>
      : <p className={styles.workspace}>Pinned workspace <code>{scope.workspace}</code></p>}
    <form className={styles.composer} onSubmit={(event) => { void submit(event); }} noValidate>
      <label>Task ID<input value={id} onChange={(event) => setId(event.target.value)} maxLength={64} autoComplete="off" spellCheck={false} disabled={scope.readOnly || busy} /></label>
      <label>What should this task do?<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5}
        placeholder="Describe a concrete task and how to check the result…" disabled={scope.readOnly || busy} /></label>
      <fieldset disabled={scope.readOnly || busy}><legend>Allowed workers</legend><p className={styles.caption}>This task stays with the worker chosen at dispatch. It never switches accounts mid-task.</p>
        <div className={styles.workerChoices}>{workers.map((worker) => <label key={worker.id}><input type="checkbox"
          checked={selected.includes(worker.id)} onChange={(event) => setAllowed((current) => event.target.checked
            ? [...current, worker.id] : current.filter((id) => id !== worker.id))} />{worker.id}</label>)}</div>
      </fieldset>
      {workers.some((worker) => worker.provider === 'local' && selected.includes(worker.id)) ? <p className={styles.caption}>Local-model workers receive your prompt only. They do not receive workspace files or tools, and their responses do not apply edits.</p> : null}
      <label>Workspace access<select value={mode} disabled={scope.readOnly || busy} onChange={(event) => setMode(event.target.value as ResourceConsoleTaskInput['mode'])}>
        <option value="read-only">Read-only</option><option value="workspace-write">Allow workspace edits</option></select></label>
      {mode === 'workspace-write' ? <p className={styles.warning}>The selected worker may edit the pinned workspace. Completion does not verify or accept those changes.</p> : null}
      <div className={styles.fieldPair}>
        <label>Timeout (seconds)<input type="number" min={1} max={900} step={1} value={seconds} onChange={(event) => setSeconds(event.target.value)} disabled={scope.readOnly || busy} /></label>
        <label>Max output tokens<input type="number" min={1} max={16384} step={1} value={tokens} onChange={(event) => setTokens(event.target.value)} disabled={scope.readOnly || busy} /></label>
      </div>
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
      <button className={styles.primaryButton} type="submit" disabled={!enabled || busy}>{busy ? 'Submitting…' : unlocked ? 'Queue task' : 'Unlock to queue task'}</button>
      <p className={styles.caption}>Prompts are stored in the private queue while needed for dispatch, not exposed in the pool snapshot. A completed task is not verified accepted work.</p>
    </form>
  </section>;
}

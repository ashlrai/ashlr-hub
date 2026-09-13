import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from 'react';
import type { ResourceConsoleOutput, ResourceConsoleProject, ResourceConsoleScope, ResourceConsoleSnapshot, ResourceConsoleTaskInput } from '../../../core/resources/console-types.js';
import { StatusBadge } from '../../components/primitives/StatusBadge.js';
import { readResourceTaskOutput } from '../../data/resource-pool-queries.js';
import { buildResourceFleet } from '../resources/fleet-model.js';
import { resourceReason, resourceTime } from '../resources/CapacityBoard.js';
import { taskTone } from '../resources/TaskInspector.js';
import { composeWorkspaceTaskPrompt, MAX_WORKSPACE_ATTACHMENTS, MAX_WORKSPACE_ATTACHMENT_BYTES, parseWorkspaceTextAttachment,
  validateWorkspaceAttachments, WORKSPACE_TEXT_ATTACHMENT_ACCEPT, type WorkspaceTextAttachment } from './workspace-attachments.js';
import styles from './WorkspaceView.module.css';
import { TaskTranscript } from './TaskTranscript.js';
import { WorkspaceFiles } from './WorkspaceFiles.js';
import { WorkspaceEngineering } from './WorkspaceEngineering.js';
import { useResourceTaskHistory } from '../../data/use-resource-task-history.js';
import { TaskHistoryNavigation } from '../resources/TaskHistoryNavigation.js';

export interface WorkspaceViewProps {
  surfaceActive?: boolean;
  engineeringControlsAvailable?: boolean;
  scope: ResourceConsoleScope; snapshot: ResourceConsoleSnapshot; historical: boolean;
  enabled: boolean; stopEnabled: boolean; busy: boolean; unlocked: boolean;
  onUnlock(): void; onSubmit(input: ResourceConsoleTaskInput): Promise<boolean>; onCancel(id: string): void;
  onDeleteHistory?(id: string): Promise<boolean>;
}
const newTaskId = () => `task-${crypto.randomUUID().slice(0, 12)}`;
const clampDock = (width: number) => Math.max(260, Math.min(520, width));
const projectLabel = (project: ResourceConsoleProject) => project.id === 'default' && project.label === 'Default workspace'
  ? project.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? project.label : project.label;

/** A host scope change cannot carry drafts or output into another workspace. */
export function WorkspaceView(props: WorkspaceViewProps) {
  const key = `${props.scope.root}:${props.scope.poolId}:${props.scope.workspace ?? ''}`;
  return props.scope.projects ? <ProjectWorkspaces key={key} {...props} /> : <WorkspaceBody key={key} {...props} active={props.surfaceActive !== false} />;
}

/** Keep only visited drafts in session memory. Hidden projects cannot initiate UI reads. */
function ProjectWorkspaces(props: WorkspaceViewProps) {
  const projects = props.scope.projects!;
  const [projectId, setProjectId] = useState('default');
  const [visited, setVisited] = useState(['default']);
  function choose(id: string) {
    if (!projects.some((project) => project.id === id)) return;
    setVisited((current) => current.includes(id) ? current : [...current, id]); setProjectId(id);
  }
  return <>{projects.filter((project) => visited.includes(project.id)).map((project) => {
    const jobs = props.snapshot.supervisor?.jobs.filter((job) => (job.projectId ?? 'default') === project.id) ?? [];
    const ids = new Set(jobs.map((job) => job.id));
    // A receipt without a supervisor binding has no proven project attribution.
    // It remains visible in Resources, never guessed into a project's history.
    const snapshot = { ...props.snapshot, activeAttempts: props.snapshot.activeAttempts.filter((row) => ids.has(row.id)),
      recentAttempts: props.snapshot.recentAttempts.filter((row) => ids.has(row.id)),
      supervisor: props.snapshot.supervisor ? { ...props.snapshot.supervisor, jobs } : null };
    return <div key={`${project.id}:${project.workspace}`} hidden={projectId !== project.id}>
      <WorkspaceBody {...props} scope={{ ...props.scope, workspace: project.workspace }} snapshot={snapshot}
        project={project} projects={projects} onSelectProject={choose} active={props.surfaceActive !== false && projectId === project.id} />
    </div>;
  })}</>;
}

function WorkspaceBody({ scope, snapshot, historical, enabled, stopEnabled, busy, unlocked, onUnlock, onSubmit, onCancel, onDeleteHistory, engineeringControlsAvailable,
  project, projects, onSelectProject, active = true }: WorkspaceViewProps & {
    project?: ResourceConsoleProject; projects?: ResourceConsoleProject[]; onSelectProject?(id: string): void; active?: boolean;
  }) {
  const [selection, setSelection] = useState<string | null>(null);
  const taskHistory = useResourceTaskHistory(snapshot, selection, active && !historical, project?.id);
  const historySnapshot = taskHistory.snapshot ?? snapshot;
  const fleet = useMemo(() => buildResourceFleet(historySnapshot, historical), [historySnapshot, historical]);
  const [engineering, setEngineering] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [taskId, setTaskId] = useState(newTaskId);
  const [workerId, setWorkerId] = useState('');
  const [mode, setMode] = useState<ResourceConsoleTaskInput['mode']>('read-only');
  const [seconds, setSeconds] = useState('300');
  const [tokens, setTokens] = useState('4096');
  const [retainHistory, setRetainHistory] = useState(false);
  const [followUp, setFollowUp] = useState<{ parent: NonNullable<ResourceConsoleTaskInput['parent']>; turns: number } | null>(null);
  const [attachments, setAttachments] = useState<WorkspaceTextAttachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const fileGeneration = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<{ key: string; value: ResourceConsoleOutput } | null>(null);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [loadingOutput, setLoadingOutput] = useState(false);
  const outputRequest = useRef<AbortController | null>(null);
  const session = snapshot.supervisor?.instanceId ?? 'external';
  const currentSession = useRef(session); currentSession.current = session;
  const retentionSeen = useRef<{ session: string; ids: Set<string> }>({ session, ids: new Set() });
  const outputKey = `${session}:${selection ?? ''}`;
  const currentOutputKey = useRef(outputKey); currentOutputKey.current = outputKey;
  const alive = useRef(true);
  const [dockTab, setDockTab] = useState<'output' | 'details' | 'files'>('details');
  const [dockWidth, setDockWidth] = useState(320);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const [mobilePane, setMobilePane] = useState<'tasks' | 'task' | 'tools'>('task');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const selected = fleet.tasks.find((row) => row.id === selection);
  const worker = snapshot.pool.workers.find((row) => row.id === workerId);
  const assigned = snapshot.pool.workers.find((row) => row.id === selected?.workerId);
  const response = selected?.job?.outputAvailable && output?.key === outputKey ? output.value : null;
  const canSend = active && project?.enabled !== false && enabled && !scope.readOnly && !!scope.workspace && !historical && snapshot.sourceState !== 'degraded';
  const lockedForm = busy || sending || readingFiles;
  const projectName = project ? projectLabel(project) : scope.workspace?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'No execution workspace';
  const domId = project && project.id !== 'default' ? `workspace-${project.id}` : 'workspace';

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; outputRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    outputRequest.current?.abort(); setOutput(null); setOutputError(null); setLoadingOutput(false);
    fileGeneration.current++; setReadingFiles(false);
  }, [outputKey]);
  useEffect(() => { setSubmitted({}); }, [session]);
  useEffect(() => {
    if (!active) {
      outputRequest.current?.abort(); setOutput(null); setOutputError(null); setLoadingOutput(false);
      fileGeneration.current++; setReadingFiles(false);
    }
  }, [active]);
  useEffect(() => {
    if (retentionSeen.current.session !== session) retentionSeen.current = { session, ids: new Set() };
    const removed = new Set<string>();
    for (const job of historySnapshot.supervisor?.jobs ?? []) {
      if (job.historyAvailable === true) retentionSeen.current.ids.add(job.id);
      else if (retentionSeen.current.ids.delete(job.id)) removed.add(job.id);
    }
    if (removed.size) {
      setSubmitted((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !removed.has(id))));
      if (selection && removed.has(selection)) {
        outputRequest.current?.abort(); setOutput(null); setOutputError(null); setLoadingOutput(false);
      }
    }
  }, [session, historySnapshot.supervisor?.jobs, selection]);

  function select(id: string | null) {
    outputRequest.current?.abort(); fileGeneration.current++; setReadingFiles(false);
    setSelection(id); setMobilePane('task'); setEngineering(false);
    if (id === null) { setFollowUp(null); setTaskId(newTaskId()); textarea.current?.focus(); }
  }

  async function addFiles(files: File[]) {
    const generation = ++fileGeneration.current;
    setError(null);
    if (files.length + attachments.length > MAX_WORKSPACE_ATTACHMENTS || files.some((file) => file.size > MAX_WORKSPACE_ATTACHMENT_BYTES)) {
      setError('Attach up to four text files, no more than 16 KiB each.'); return;
    }
    setReadingFiles(true);
    try {
      const parsed = await Promise.all(files.map(async (file) => parseWorkspaceTextAttachment(file.name, await file.arrayBuffer())));
      if (alive.current && generation === fileGeneration.current) setAttachments(validateWorkspaceAttachments([...attachments, ...parsed]));
    } catch (cause) {
      if (alive.current && generation === fileGeneration.current) setError(cause instanceof Error ? cause.message : 'The selected text files could not be read.');
    } finally { if (alive.current && generation === fileGeneration.current) setReadingFiles(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sendingRef.current || lockedForm || !canSend) return;
    setError(null); setNotice(null);
    if (!unlocked) { onUnlock(); return; }
    let composed: string;
    const timeoutMs = Number(seconds) * 1000; const maxOutputTokens = Number(tokens);
    try {
      if (attachments.some((attachment) => attachment.source && attachment.source.projectId !== (project?.id ?? 'default'))) {
        throw new Error('Attached project snapshots must belong to the selected project.');
      }
      if (!worker || !prompt.trim() || !Number.isSafeInteger(Number(seconds)) || timeoutMs < 1000 || timeoutMs > 900_000 ||
        !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16_384) {
        throw new Error('Write a task, choose an enrolled worker, and use 1–900 seconds with 1–16,384 output tokens.');
      }
      if (followUp && !scope.followUpSupported) throw new Error('Follow-ups are unavailable in this console. Start a standalone task instead.');
      composed = composeWorkspaceTaskPrompt(prompt, attachments);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Check the task before sending.'); return; }
    sendingRef.current = true; setSending(true);
    const sentId = taskId; const sentPrompt = prompt; const sentSession = session;
    try {
      const accepted = await onSubmit({ id: sentId, prompt: composed, allowedWorkerIds: [worker.id], mode, timeoutMs, maxOutputTokens,
        ...(project && project.id !== 'default' ? { projectId: project.id } : {}),
        ...(followUp ? { parent: followUp.parent } : {}),
        ...(retainHistory && scope.historySupported ? { retainHistory: true } : {}) });
      if (!alive.current || currentSession.current !== sentSession) return;
      if (!accepted) { setError('The task was not queued. Your draft is retained; check the task controls and try again.'); return; }
      setSubmitted((current) => Object.fromEntries([...Object.entries(current), [sentId, sentPrompt]].slice(-64)));
      setPrompt(''); setAttachments([]); setFollowUp(null); fileGeneration.current++; setTaskId(newTaskId());
      select(sentId); setNotice('Task queued. Its status and response appear when reported by this supervisor.');
    } catch { if (alive.current && currentSession.current === sentSession) setError('The task could not be queued. Your draft is retained.'); }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  }

  async function loadOutput() {
    if (!selected?.job?.outputAvailable || loadingOutput) return;
    outputRequest.current?.abort(); const controller = new AbortController(); outputRequest.current = controller;
    const key = outputKey; setLoadingOutput(true); setOutputError(null);
    try {
      const value = await readResourceTaskOutput(selected.id, controller.signal);
      if (!controller.signal.aborted && alive.current && currentOutputKey.current === key) setOutput({ key, value });
    } catch {
      if (!controller.signal.aborted && alive.current && currentOutputKey.current === key) setOutputError('Output could not be read from this console session. Retry when the task is available.');
    } finally { if (!controller.signal.aborted && alive.current && currentOutputKey.current === key) setLoadingOutput(false); }
  }
  async function deleteHistory(): Promise<boolean> {
    if (!selection || !onDeleteHistory) return false;
    const id = selection; const key = outputKey; const sentSession = session;
    const deleted = await onDeleteHistory(id);
    if (deleted && alive.current && currentSession.current === sentSession) {
      setSubmitted((current) => Object.fromEntries(Object.entries(current).filter(([task]) => task !== id)));
      if (currentOutputKey.current === key) {
        outputRequest.current?.abort(); setOutput(null); setOutputError(null); setLoadingOutput(false);
      }
    }
    return deleted;
  }
  function resizeKey(event: KeyboardEvent<HTMLDivElement>) {
    const next = event.key === 'ArrowLeft' ? dockWidth + 20 : event.key === 'ArrowRight' ? dockWidth - 20
      : event.key === 'Home' ? 260 : event.key === 'End' ? 520 : null;
    if (next !== null) { event.preventDefault(); setDockWidth(clampDock(next)); }
  }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const order: Array<typeof dockTab> = scope.workspaceFilesSupported ? ['output', 'details', 'files'] : ['output', 'details'];
    const current = Math.max(0, order.indexOf(dockTab));
    const next = order[event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1 :
      (current + (event.key === 'ArrowRight' ? 1 : -1) + order.length) % order.length]!;
    setDockTab(next); tabs.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  }

  const outputContent = <>
    {selected?.job?.outputAvailable ? <button type="button" className={styles.subtleButton} disabled={loadingOutput}
      onClick={() => { void loadOutput(); }}>{loadingOutput ? 'Reading response…' : response ? 'Reload response' : 'Read response'}</button>
      : <p className={styles.caption}>{selection ? 'No response is available in this console session yet.' : 'Select a task to inspect its response.'}</p>}
    {outputError ? <p role="alert" className={styles.error}>{outputError}</p> : null}
    {response ? <><p className={styles.caption}>{outputError ? 'Previous successful read. ' : ''}{response.truncated ? 'Truncated response. ' : ''}Retained by this console session; not a live stream.</p>
      <pre className={styles.responseText}>{response.text}</pre></> : null}
  </>;

  return <section className={styles.workspace} aria-label="Project task workspace" style={{ '--workspace-dock-width': `${dockWidth}px` } as CSSProperties}>
    <div className={styles.mobileNav} role="group" aria-label="Workspace panes">
      {(['tasks', 'task', 'tools'] as const).map((pane) => <button key={pane} type="button" aria-pressed={mobilePane === pane}
        onClick={() => { setMobilePane(pane); if (pane === 'tools') setEngineering(false); }}>{pane === 'tasks' ? 'Task list' : pane === 'task' ? engineering ? 'Engineering' : 'Task' : 'Tools'}</button>)}
    </div>
    <aside className={styles.rail} data-mobile-visible={mobilePane === 'tasks'} aria-label="Project and tasks">
      {projects ? <nav aria-label="Registered projects" className={styles.projectList}><h3>Projects</h3>
        {projects.map((row) => <button type="button" key={row.id} aria-label={`Switch to ${projectLabel(row)}`} aria-current={row.id === project?.id ? 'true' : undefined}
          onClick={() => onSelectProject?.(row.id)}><span>{projectLabel(row)}</span>{!row.enabled ? <small>Disabled</small> : null}</button>)}
      </nav> : null}
      <div className={styles.project}><span className={styles.projectIcon} aria-hidden="true">⌑</span><div><h2>{projectName}</h2><p>{projects ? 'Registered workspace' : 'Pinned workspace'}</p></div></div>
      {scope.workspace ? <p className={styles.projectPath} title={scope.workspace}>{scope.workspace}</p> : <p className={styles.caption}>This console has no execution workspace.</p>}
      <button type="button" className={styles.newTask} disabled={lockedForm} onClick={() => select(null)}>+ New task</button>
      {scope.engineeringSupported ? <button type="button" className={styles.engineeringLink} aria-pressed={engineering} disabled={lockedForm}
        onClick={() => { outputRequest.current?.abort(); setOutput(null); setOutputError(null); setLoadingOutput(false); setEngineering(true); setMobilePane('task'); }}>Engineering runs <span aria-hidden="true">↗</span></button> : null}
      <h3 className={styles.railHeading}>Tasks</h3>
      {fleet.tasks.length ? <ul className={styles.taskList}>{fleet.tasks.map((row) => <li key={row.id}>
        <button type="button" aria-current={!engineering && selection === row.id ? 'true' : undefined} onClick={() => select(row.id)}>
          <span>{row.id}</span><StatusBadge status={row.state} tone={taskTone(row)} />
        </button></li>)}</ul> : <p className={styles.caption}>Your queued tasks will appear here.</p>}
      <TaskHistoryNavigation history={taskHistory} disabled={!active || historical} buttonClassName={styles.subtleButton} className={styles.caption} />
      <p className={styles.railFoot}>{projects ? 'One shared account ledger. Project drafts stay separate in this browser session. Unattributed tasks remain in Resources.' : 'One confirmed workspace. Add a startup project catalog to enable project switching.'}</p>
    </aside>

    {engineering && scope.engineeringSupported ? <div className={styles.engineeringPane} data-mobile-visible={mobilePane === 'task'}>
      {active && mobilePane !== 'tasks' ? <WorkspaceEngineering key={`${session}:${project?.id ?? 'default'}:${scope.engineeringAttachmentId ?? 'legacy'}`} projectId={project?.id ?? 'default'}
        controlsAvailable={engineeringControlsAvailable}
        projectName={projectName} available={!historical && snapshot.sourceState === 'healthy'}
        supervisionSupported={scope.engineeringSupervisionSupported === true}
        successorsSupported={scope.engineeringSuccessorsSupported === true}
        outcomesSupported={scope.engineeringOutcomesSupported === true}
        preparationSupported={scope.engineeringPreparationSupported === true} preparationAvailable={project?.enabled !== false}
        autoAdmission={scope.engineeringPreparationAutoAdmission === true}
        canStart={canSend && !busy && snapshot.supervisor?.paused !== true} canStop={stopEnabled} unlocked={unlocked} onUnlock={onUnlock}
        startBlockedReason={project?.enabled === false ? 'This project is disabled. Recorded engineering evidence remains available.'
          : snapshot.supervisor?.paused ? 'The task queue is paused. New engineering launches are withheld; active engineering runs are not stopped.' : undefined} /> : null}
    </div> : <><div className={styles.center} data-mobile-visible={mobilePane === 'task'}>
      <header className={styles.heading}><div><h2>{selection ? selection : 'What would you like to work on?'}</h2>
        <p>{selection ? selected?.ownership ?? 'Waiting for the task snapshot' : 'Describe a concrete task for this workspace.'}</p></div>
        {selected ? <StatusBadge status={selected.state} tone={taskTone(selected)} /> : null}</header>
      <div className={styles.conversation}>
        {historical ? <p className={styles.notice}>Showing the last successful snapshot. Sending is paused until current evidence returns.</p> : null}
        {taskHistory.detailError ? <p role="alert" className={styles.notice}>{taskHistory.detailError}</p> : null}
        {scope.readOnly ? <p className={styles.notice}>Task execution is disabled for this console. You can inspect recorded work.</p> : null}
        {project?.enabled === false ? <p className={styles.notice}>This project is disabled. Its history remains available; new tasks cannot be sent.</p> : null}
        {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}
        {selection ? <>
          {submitted[selection] ? <section className={styles.request}><h3>Your task</h3><p>{submitted[selection]}</p></section>
            : <p className={styles.caption}>Original prompt text is not included in the task snapshot.</p>}
          {active && selected?.job?.historyAvailable === true ? <TaskTranscript key={outputKey} id={selection} projectId={project?.id ?? 'default'}
            canDelete={stopEnabled && !busy && taskHistory.selectedCurrent && !!onDeleteHistory && ['settled', 'cancelled'].includes(selected.job.state)}
            unlocked={unlocked} onUnlock={onUnlock} onDelete={deleteHistory}
            onFollowUp={scope.followUpSupported && canSend && !lockedForm && taskHistory.selectedCurrent && ['settled', 'cancelled'].includes(selected.job.state)
              ? (parent, turns) => { setFollowUp({ parent, turns }); setTaskId(newTaskId()); setError(null); textarea.current?.focus(); }
              : undefined} /> : null}
          <section className={styles.answer} aria-label="Task response"><h3>Response</h3>{outputContent}</section>
          {selected?.stateDisagreement ? <p className={styles.notice}>Supervisor and receipt states differ. Refreshing will reconcile the snapshots.</p> : null}
          {selected?.job?.cancellable ? <button type="button" className={styles.subtleButton} disabled={!active || !stopEnabled || busy || !taskHistory.selectedCurrent}
            onClick={() => onCancel(selected.id)}>{selected.job.state === 'queued' ? 'Cancel queued task' : 'Cancel owned task'}</button> : null}
        </> : <div className={styles.invitation}><span aria-hidden="true" className={styles.workMark}>⌑</span><h3>Start with the work.</h3>
          <p>Ask for an investigation, a proposed change, or a bounded implementation. Choose exactly which enrolled worker receives it.</p></div>}
      </div>
      <form className={styles.composer} onSubmit={(event) => { void submit(event); }} noValidate aria-label="Workspace task composer">
        {followUp ? <div className={styles.followUp} role="status"><div><strong>Follow-up context</strong>
          <p>{followUp.turns} prior {followUp.turns === 1 ? 'turn' : 'turns'} through <code>{followUp.parent.taskId}</code>.</p>
          <p>A new task using your selected worker and limits. Accepted context copies are independent of the original transcript.</p></div>
          <button type="button" className={styles.subtleButton} disabled={lockedForm} onClick={() => { setFollowUp(null); setTaskId(newTaskId()); }}>Start standalone</button>
        </div> : null}
        <label htmlFor={`${domId}-prompt`}>Task prompt</label>
        <textarea id={`${domId}-prompt`} ref={textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4}
          placeholder="Describe the task and how to check the result…" disabled={scope.readOnly || lockedForm} />
        {attachments.length ? <ul className={styles.attachments} aria-label="Attached text files">{attachments.map((file) => <li key={file.name}>
          <span>{file.name}</span><button type="button" aria-label={`Remove ${file.name}`} disabled={lockedForm}
            onClick={() => { fileGeneration.current++; setAttachments((current) => current.filter((item) => item.name !== file.name)); }}>×</button></li>)}</ul> : null}
        <div className={styles.composeControls}>
          <label className={styles.workerChoice}>Worker<select aria-label="Task worker" value={workerId} disabled={scope.readOnly || lockedForm} onChange={(event) => setWorkerId(event.target.value)}>
            <option value="">Choose an enrolled worker</option>{snapshot.pool.workers.map((row) => <option key={row.id} value={row.id}>{row.model} ({row.id})</option>)}</select></label>
          <label className={styles.fileButton}>Attach text<input type="file" multiple accept={WORKSPACE_TEXT_ATTACHMENT_ACCEPT} aria-label="Attach text files"
            disabled={scope.readOnly || lockedForm} onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void addFiles(files); }} /></label>
          <button className={styles.send} type="submit" disabled={!canSend || lockedForm}>{sending ? 'Sending…' : unlocked ? 'Send task' : 'Unlock to send'}</button>
        </div>
        {scope.historySupported ? <label className={styles.retention}>
          <input type="checkbox" checked={retainHistory} disabled={scope.readOnly || lockedForm}
            onChange={(event) => setRetainHistory(event.target.checked)} />
          <span>Retain this task locally<br /><small>Save prompt, attachment text, copied conversation context and captured response as local unencrypted text until deleted.</small></span>
        </label> : null}
        <details className={styles.options}><summary>Task options</summary><div>
          <label>Workspace access<select aria-label="Task workspace access" value={mode} disabled={scope.readOnly || lockedForm} onChange={(event) => setMode(event.target.value as ResourceConsoleTaskInput['mode'])}>
            <option value="read-only">Read-only</option><option value="workspace-write">Allow workspace edits</option></select></label>
          <label>Timeout in seconds<input aria-label="Task timeout in seconds" type="number" min="1" max="900" value={seconds} disabled={scope.readOnly || lockedForm} onChange={(event) => setSeconds(event.target.value)} /></label>
          <label>Output token limit<input aria-label="Task output token limit" type="number" min="1" max="16384" value={tokens} disabled={scope.readOnly || lockedForm} onChange={(event) => setTokens(event.target.value)} /></label>
        </div><p className={styles.caption}>Task ID: <code>{taskId}</code>. Text attachments become prompt content.</p></details>
        {mode === 'workspace-write' ? <p className={styles.notice}>The worker may edit this pinned workspace. Completion does not verify those changes.</p> : null}
        {worker?.provider === 'local' ? <p className={styles.caption}>This local worker receives prompt text only; it cannot read workspace files or apply edits.</p> : null}
        {readingFiles ? <p role="status" className={styles.caption}>Reading selected text files…</p> : null}
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      </form>
    </div>

    <div className={styles.resize} role="separator" tabIndex={0} aria-label="Resize tool panel" aria-orientation="vertical"
      aria-valuemin={260} aria-valuemax={520} aria-valuenow={dockWidth} onKeyDown={resizeKey}
      onPointerDown={(event) => { drag.current = { id: event.pointerId, x: event.clientX, width: dockWidth }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
      onPointerMove={(event) => { if (drag.current?.id === event.pointerId) setDockWidth(clampDock(drag.current.width + drag.current.x - event.clientX)); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
    <aside className={styles.dock} data-mobile-visible={mobilePane === 'tools'} aria-label="Task tools">
      <div className={styles.dockTabs} role="tablist" aria-label="Task tool tabs" ref={tabs}>
        {(['output', 'details', ...(scope.workspaceFilesSupported ? ['files' as const] : [])] as const).map((tab) => <button key={tab} type="button" role="tab" data-tab={tab} id={`${domId}-tab-${tab}`}
          aria-controls={`${domId}-panel-${tab}`} aria-selected={dockTab === tab} tabIndex={dockTab === tab ? 0 : -1}
          onKeyDown={tabKey} onClick={() => setDockTab(tab)}>{tab === 'output' ? 'Output' : tab === 'files' ? 'Files' : 'Task details'}</button>)}
      </div>
      <section className={styles.dockContent} role="tabpanel" id={`${domId}-panel-${dockTab}`} aria-labelledby={`${domId}-tab-${dockTab}`}>
        {dockTab === 'files' ? active && scope.workspaceFilesSupported ? <WorkspaceFiles key={`${session}:${project?.id ?? 'default'}:${mobilePane}`} projectId={project?.id ?? 'default'}
          unlocked={unlocked} available={!historical && enabled && project?.enabled !== false} canAttach={canSend && !lockedForm} onUnlock={onUnlock}
          onAttach={(attachment) => { const checked = validateWorkspaceAttachments([...attachments, attachment]); setAttachments(checked); }} /> : null
          : dockTab === 'output' ? <><h3>Response text</h3>{response ? <><p className={styles.caption}>{response.truncated ? 'Truncated. ' : ''}Console-session output.</p><pre className={styles.responseText}>{response.text}</pre></>
          : <p className={styles.caption}>Read a selected task’s response in the task pane to inspect its text here.</p>}</>
          : <><h3>{selection ? 'Task routing' : 'Next task routing'}</h3><dl className={styles.facts}>
            <div><dt>Worker</dt><dd>{selection ? selected?.workerId ?? 'No confirmed assignment' : worker?.id ?? 'Choose a worker'}</dd></div>
            <div><dt>Provider</dt><dd>{(selection ? assigned : worker)?.provider ?? 'Not assigned'}</dd></div>
            <div><dt>Model</dt><dd>{(selection ? assigned : worker)?.model ?? 'Not assigned'}</dd></div>
            <div><dt>Workspace</dt><dd>{scope.workspace ?? 'Not configured'}</dd></div>
            <div><dt>Access</dt><dd>{selection ? selected?.job?.mode ?? 'Not reported' : mode}</dd></div>
            {selected ? <><div><dt>Ownership</dt><dd>{selected.ownership}</dd></div><div><dt>Updated</dt><dd>{resourceTime(selected.job?.updatedAt ?? selected.receipt?.finishedAt)}</dd></div>
              <div><dt>Reported tokens</dt><dd>{selected.receipt?.inputTokens != null && selected.receipt.outputTokens != null ? selected.receipt.inputTokens + selected.receipt.outputTokens : 'Unknown'}</dd></div>
              <div><dt>Reason</dt><dd>{resourceReason(selected.job?.reason ?? selected.receipt?.reason ?? 'not-reported')}</dd></div></> : null}
          </dl><p className={styles.caption}>An enrolled worker is a routing choice. Current capacity is checked before dispatch; completion is not independent acceptance.</p></>}
      </section>
      <p className={styles.capabilities}>{scope.workspaceFilesSupported ? 'Project text previews and snapshot attachments are connected. Interactive terminal and browser are not connected yet.' : 'Text attachments are supported. Register a project catalog to enable file previews. Interactive terminal and browser are not connected yet.'}</p>
    </aside></>}
  </section>;
}

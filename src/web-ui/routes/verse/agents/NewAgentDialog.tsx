/**
 * routes/verse/agents/NewAgentDialog.tsx — "New agent" in one action (⌘N on
 * the board) and "Same task on several seats" (⇧⌘N): pick the repo, the
 * seat(s), say what to do. Each agent gets its own git worktree on a
 * `verse/<slug>` branch under ~/.ashlr-worktrees, the repo's setup script
 * (from `.ashlr/verse/workspace.json`) runs in a terminal tab, and the prompt
 * goes out when setup is done.
 *
 * Before anything is created the dialog says what the repo's workspace.json
 * will do (setup, run buttons, files copied, ports) — nothing runs on a
 * surprise. Options: Plan first (the seat plans; you approve), a spend cap,
 * Auto-fix CI and Auto-merge when green.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { WorkspaceConfigRead } from '../../../../core/verse/agents/types.js';
import type { VerseProject, VerseSeat } from '../../../../core/verse/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { defaultSeatChoice, SeatSelector, type SeatChoice } from '../SeatSelector.js';
import { ENGINE_LABEL } from '../verse-model.js';
import { checkSpawnForm, seatRows, titleFromPrompt, type SpawnForm } from './agents-model.js';
import { fetchWorkspaceConfig, type SpawnInput } from './agents-queries.js';
import styles from './Agents.module.css';

export interface NewAgentDialogProps {
  open: boolean;
  multi: boolean;
  projects: readonly VerseProject[];
  seats: readonly VerseSeat[];
  initialRoot: string | null;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  /** One input per seat; the board runs them (token gate, progress, errors). */
  onSpawn: (inputs: SpawnInput[]) => void;
}

function configSummary(read: WorkspaceConfigRead): string {
  const c = read.config;
  const parts: string[] = [];
  parts.push(c.setup ? `setup: ${c.setup.length > 40 ? `${c.setup.slice(0, 40)}…` : c.setup}` : 'no setup script');
  if (c.run.length > 0) parts.push(`${c.run.length} run button${c.run.length === 1 ? '' : 's'} (${c.run.map((r) => r.name).join(', ')})`);
  if (c.copy.length > 0) parts.push(`copies ${c.copy.join(', ')} if present`);
  parts.push(c.ports > 0 ? `${c.ports} ports` : 'no ports');
  return `${read.source === 'file' ? '.ashlr/verse/workspace.json' : 'No workspace.json (defaults)'}: ${parts.join(' · ')}`;
}

export function NewAgentDialog({ open, multi, projects, seats, initialRoot, busy, error, onClose, onSpawn }: NewAgentDialogProps) {
  const titleId = useId();
  const promptId = useId();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const sorted = useMemo(() => [...projects].sort((a, b) => Number(b.enrolled) - Number(a.enrolled) || a.name.localeCompare(b.name)), [projects]);
  const rows = useMemo(() => seatRows(seats), [seats]);
  const [root, setRoot] = useState('');
  const [seat, setSeat] = useState<SeatChoice | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isolate, setIsolate] = useState(true);
  const [planFirst, setPlanFirst] = useState(false);
  const [capText, setCapText] = useState('');
  const [autoFix, setAutoFix] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);
  const [local, setLocal] = useState<string | null>(null);
  const [config, setConfig] = useState<WorkspaceConfigRead | null>(null);

  // Reset on the open transition only (a roster refresh must not wipe a half-typed prompt).
  const prefill = useRef({ initialRoot, sorted, seats });
  prefill.current = { initialRoot, sorted, seats };
  useEffect(() => {
    if (!open) return;
    const p = prefill.current;
    setRoot(p.initialRoot && p.sorted.some((x) => x.path === p.initialRoot) ? p.initialRoot : p.sorted[0]?.path ?? '');
    const first = defaultSeatChoice(p.seats);
    setSeat(first);
    setPicked(new Set(first ? [first.seatId] : []));
    setTitle('');
    setPrompt('');
    setIsolate(true);
    setPlanFirst(false);
    setCapText('');
    setAutoFix(false);
    setAutoMerge(false);
    setLocal(null);
  }, [open]);

  useEffect(() => {
    if (!open || !root) return undefined;
    const ctl = new AbortController();
    setConfig(null);
    fetchWorkspaceConfig(root, ctl.signal).then((c) => setConfig(c), () => setConfig(null));
    return () => ctl.abort();
  }, [open, root]);

  const chosenSeats = useMemo(() => {
    if (!multi) return seat ? [seat] : [];
    return rows.filter((r) => picked.has(r.seatId) && r.model && !r.disabled).map((r) => ({ seatId: r.seatId, model: r.model! }));
  }, [multi, seat, rows, picked]);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const form: SpawnForm = { root, title, prompt, seats: chosenSeats, isolate: multi ? true : isolate, planFirst, capText, autoFix, autoMerge };
    const checked = checkSpawnForm(form);
    if (!checked.ok) {
      setLocal(checked.error);
      return;
    }
    setLocal(null);
    const baseTitle = title.trim() || titleFromPrompt(prompt);
    const labelOf = (seatId: string) => rows.find((r) => r.seatId === seatId)?.label ?? seatId;
    onSpawn(chosenSeats.map((s) => ({
      root,
      seatId: s.seatId,
      model: s.model,
      title: chosenSeats.length > 1 ? `${baseTitle} · ${labelOf(s.seatId)}` : baseTitle,
      prompt,
      isolate: form.isolate,
      planFirst,
      spendCapUsd: checked.cap,
      autoFix,
      autoMerge,
    })));
  };

  const onPromptKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const count = chosenSeats.length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      title={multi ? 'Same task on several seats' : 'New agent'}
      description={multi
        ? 'Each seat gets its own workspace and branch, and the same prompt. Compare what comes back.'
        : 'A chat with its own git worktree and branch, the repo’s setup, and its own ports.'}
      initialFocusRef={promptRef}
      widthClassName={styles.dialogWidth}
    >
      <form className={styles.form} onSubmit={submit}>
        <Select label="Repository" value={root} onChange={(e) => setRoot(e.target.value)} disabled={busy}>
          {sorted.length === 0 ? <option value="">No projects yet — open one in Chat first</option> : null}
          {sorted.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
        </Select>
        {config ? <p className={styles.hint}>{configSummary(config)}{config.warnings.length ? ` — ${config.warnings[0]}` : ''}</p> : null}

        {multi ? (
          <fieldset className={styles.seatList} disabled={busy}>
            <legend>Seats ({count} selected)</legend>
            {rows.map((r) => (
              <label key={r.seatId} className={styles.seatRow} data-disabled={r.disabled ? true : undefined}>
                <input
                  type="checkbox"
                  checked={picked.has(r.seatId)}
                  disabled={Boolean(r.disabled)}
                  onChange={(e) => setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(r.seatId);
                    else next.delete(r.seatId);
                    return next;
                  })}
                />
                <span>{r.label}</span>
                <span className={styles.muted}>{ENGINE_LABEL[r.engine]}{r.modelLabel ? ` · ${r.modelLabel}` : ''}</span>
                {r.disabled ? <span className={styles.muted}> — {r.disabled}</span> : null}
              </label>
            ))}
          </fieldset>
        ) : (
          <SeatSelector seats={seats} value={seat} onChange={setSeat} disabled={busy} label="Seat" />
        )}

        <div className={styles.field}>
          <label htmlFor={promptId} className={styles.fieldLabel}>What should {count > 1 ? 'they' : 'it'} do?</label>
          <textarea
            id={promptId}
            ref={promptRef}
            className={styles.textarea}
            rows={5}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onPromptKey}
            placeholder="Fix the login redirect loop and add a test for it."
            disabled={busy}
          />
        </div>
        <Input label="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={prompt ? titleFromPrompt(prompt) : 'From the prompt'} disabled={busy} />

        <details className={styles.advancedOptions}>
          <summary>Options</summary>
          <div className={styles.options}>
          {multi ? null : <Switch checked={isolate} onChange={setIsolate} label="Own workspace (worktree + branch)" disabled={busy} />}
          <Switch checked={planFirst} onChange={setPlanFirst} label="Plan first — approve before it edits" disabled={busy} />
          <Switch checked={autoFix} onChange={setAutoFix} label="Auto-fix CI" disabled={busy} />
          <Switch checked={autoMerge} onChange={setAutoMerge} label="Auto-merge when green" disabled={busy || (!multi && !isolate)} />
          <Input
            label="Spend cap (USD, at API list price)"
            value={capText}
            onChange={(e) => setCapText(e.target.value)}
            placeholder="none"
            inputMode="decimal"
            size="sm"
            hint="Warns at 80%, stops the agent at 100%."
            disabled={busy}
          />
          </div>
        </details>
        {autoMerge ? (
          <p className={styles.hint}>
            Auto-merge squash-merges only a green, mergeable PR that touches no protected path (CI, manifests, lockfiles); ashlr-hub itself only when the grant’s self-land policy allows. GitHub’s branch rules still apply.
          </p>
        ) : null}

        {local || error ? <p className={styles.formError} role="alert">{local ?? error}</p> : null}
        <div className={styles.formActions}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" type="submit" busy={busy} disabled={count === 0 || !root}>
            {count > 1 ? `Start ${count} agents` : 'Start agent'}
          </Button>
        </div>
        <p className={styles.keyHint}>⌘ Return starts {count > 1 ? 'them' : 'it'}.</p>
      </form>
    </Dialog>
  );
}

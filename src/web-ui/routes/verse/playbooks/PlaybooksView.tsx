/**
 * routes/verse/playbooks/PlaybooksView.tsx — versioned playbooks (3.15).
 *
 * A library you open, not a surface you watch (so it lives in the gear
 * tray, beside the Repo wiki): the list on the left; on the right one
 * playbook as an engine reads it, its versions with what each version's
 * runs ended as (merged / refused / reverted / failed, from retros), and
 * "Run…" — which writes its `!macro` into the chat message so the operator
 * describes the task and picks the lane (Run in cloud, Run in Devin, …).
 *
 * Editing never rewrites: Save writes the next version (the server refuses
 * if someone saved in between). Viewing an older version and choosing
 * "Edit from vN" is how a version is restored — as a new one.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { parsePlaybook, playbookTemplate } from '../../../../core/playbooks/parse.js';
import type { PlaybookDetailResponse, PlaybookSummary, PlaybookValidationIssue } from '../../../../core/playbooks/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { IconPlay, IconPlus } from '../../../components/primitives/icons.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate, type TokenGate } from '../context/use-token-gate.js';
import { renderMarkdown } from '../MessageMarkdownRenderer.js';
import { putMacroInComposer } from './playbook-composer.js';
import { getPlaybookFocus, isPlaybookFocusLive, subscribePlaybookFocus, takePlaybookFocus } from './playbook-focus.js';
import { playbookDetailQuery, playbooksQuery, savePlaybookSource } from './playbooks-queries.js';
import styles from './Playbooks.module.css';

type Notice = { tone: 'neutral' | 'danger' | 'success'; text: string } | null;
type Editing = { mode: 'new' } | { mode: 'edit'; id: string; baseVersion: number; source: string; from: number } | null;

const SELECTED_STORAGE_KEY = 'verse.playbooks.selected';

function readStored(): string | null {
  try {
    return localStorage.getItem(SELECTED_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string): void {
  try {
    localStorage.setItem(SELECTED_STORAGE_KEY, id);
  } catch {
    // private mode / quota: the choice just is not remembered
  }
}

/** Case-insensitive filter over name, id, macro and description. Pure. */
export function filterPlaybooks(rows: readonly PlaybookSummary[], query: string): PlaybookSummary[] {
  const q = query.trim().toLowerCase().replace(/^!/, '');
  if (!q) return [...rows];
  return rows.filter((r) => [r.name, r.id, r.macro, r.description].some((s) => s.toLowerCase().includes(q)));
}

export function PlaybooksView() {
  const list = useQuery(playbooksQuery, { freshMs: 30_000 });
  const refetchList = useRefetch(playbooksQuery);
  const gate = useTokenGate();
  const rows = useMemo(() => list.data?.value ?? [], [list.data]);
  const [chosen, setChosen] = useState<string | null>(() => readStored());
  const [filter, setFilter] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [runMode, setRunMode] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterPlaybooks(rows, filter), [rows, filter]);
  const selected = rows.find((r) => r.id === chosen) ?? rows[0] ?? null;

  const choose = useCallback((id: string) => {
    setChosen(id);
    writeStored(id);
    setEditing(null);
  }, []);

  // ⌘K "Run playbook…": open in "pick one to run" mode, the filter focused.
  const focus = useSyncExternalStore(subscribePlaybookFocus, getPlaybookFocus, getPlaybookFocus);
  useEffect(() => {
    if (!focus) return;
    if (isPlaybookFocusLive(focus)) {
      setRunMode(true);
      setEditing(null);
      filterRef.current?.focus();
    }
    takePlaybookFocus(focus.seq);
  }, [focus]);

  const run = useCallback(async (macro: string) => {
    setNotice(null);
    const ok = await putMacroInComposer(macro);
    if (ok) setRunMode(false);
    else setNotice({ tone: 'neutral', text: `Open a chat first, then run ${macro} from its message box.` });
  }, []);

  const unavailable = list.data && !list.data.value ? list.data.reason : null;

  return (
    <section className={styles.section} aria-label="Playbooks">
      <div className={styles.scroll}>
        <div className={styles.page}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 className={styles.title}>Playbooks</h2>
              <p className={styles.lede}>
                Reusable, versioned task templates. Type <code>!macro</code> in a goal, a Devin chat, Run in cloud or Run in Devin — and that lane
                follows the playbook (other chats send the text as written). Every edit is a new version, and each version shows how its runs ended.
              </p>
            </div>
            <Button variant="subtle" size="sm" icon={<IconPlus size={14} />} onClick={() => { setEditing({ mode: 'new' }); setNotice(null); }}>
              New playbook
            </Button>
          </header>

          {runMode ? (
            <p className={styles.banner} role="status">
              Pick a playbook and choose <strong>Run…</strong>: its macro goes into your chat message, where you describe the task and choose where it runs.
            </p>
          ) : null}
          <p className={notice ? styles.banner : styles.visuallyHidden} data-tone={notice?.tone} role="status" aria-live="polite">{notice?.text ?? ''}</p>

          {list.data === undefined && !list.error ? (
            <div aria-busy="true" aria-label="Loading playbooks">
              <SkeletonLine width="40%" />
              <SkeletonLine width="70%" />
            </div>
          ) : list.error || unavailable ? (
            <p className={styles.banner} data-tone="danger">{unavailable ?? describeContextError(list.error)}</p>
          ) : editing?.mode === 'new' ? (
            <PlaybookEditor
              key="new"
              initial={playbookTemplate('my-playbook')}
              baseVersion={null}
              title="New playbook"
              gate={gate}
              onCancel={() => setEditing(null)}
              onSaved={(id, version) => {
                setEditing(null);
                refetchList();
                choose(id);
                setNotice({ tone: 'success', text: `Saved ${id}@v${version}.` });
              }}
            />
          ) : rows.length === 0 || !selected ? (
            <EmptyState title="No playbooks" body="Create one with New playbook, or `ashlr playbook new <id>`." />
          ) : (
            <div className={styles.body}>
              <nav className={styles.list} aria-label="Playbooks">
                <input
                  ref={filterRef}
                  className={styles.filter}
                  type="search"
                  value={filter}
                  placeholder="Filter playbooks"
                  aria-label="Filter playbooks"
                  onChange={(e) => setFilter(e.target.value)}
                />
                <ul>
                  {visible.map((r) => (
                    <li key={r.id}>
                      <button type="button" aria-current={selected.id === r.id ? 'page' : undefined} onClick={() => choose(r.id)}>
                        <span className={styles.rowName}>{r.name}</span>
                        <span className={styles.rowMeta}>
                          <code>{r.macro}</code> · v{r.latest}{r.auto ? ' · auto' : ''}{r.builtin ? ' · built-in' : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                  {visible.length === 0 ? <li className={styles.meta}>No playbook matches “{filter}”.</li> : null}
                </ul>
              </nav>
              {editing?.mode === 'edit' && editing.id === selected.id ? (
                <PlaybookEditor
                  key={`edit:${editing.id}:${editing.from}`}
                  initial={editing.source}
                  baseVersion={editing.baseVersion}
                  title={editing.from === editing.baseVersion ? `Edit ${selected.name}` : `Edit ${selected.name} from v${editing.from}`}
                  gate={gate}
                  onCancel={() => setEditing(null)}
                  onSaved={(id, version) => {
                    setEditing(null);
                    refetchList();
                    setNotice({ tone: 'success', text: `Saved ${id}@v${version}.` });
                  }}
                />
              ) : (
                <PlaybookPanel
                  key={`${selected.id}:${selected.latest}`}
                  summary={selected}
                  onRun={(macro) => void run(macro)}
                  onEdit={(source, from) => setEditing({ mode: 'edit', id: selected.id, baseVersion: selected.latest, source, from })}
                />
              )}
            </div>
          )}
        </div>
      </div>
      <MutationTokenDialog
        open={gate.dialog.open}
        reason={gate.dialog.reason}
        tokenLabel="Mutation token"
        tokenHelp="the mutation token ashlr verse printed"
        onClose={gate.dialog.onClose}
        onUnlocked={gate.dialog.onUnlocked}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// One playbook
// ---------------------------------------------------------------------------

function outcomeCell(n: number) {
  return n === 0 ? <span className={styles.zero}>0</span> : n;
}

function PlaybookPanel({ summary, onRun, onEdit }: { summary: PlaybookSummary; onRun: (macro: string) => void; onEdit: (source: string, from: number) => void }) {
  const [version, setVersion] = useState<number | null>(null);
  const def = useMemo(() => playbookDetailQuery(summary.id, version), [summary.id, version]);
  const q = useQuery(def, { freshMs: 30_000 });
  const data: PlaybookDetailResponse | undefined = q.data;
  const html = useMemo(() => (data ? renderMarkdown(data.rendered) : ''), [data]);
  const shown = data?.playbook.version ?? summary.latest;
  const isLatest = shown === summary.latest;
  const macro = isLatest ? summary.macro : `${summary.macro}@v${shown}`;

  return (
    <article className={styles.detail} aria-label={summary.name}>
      <div className={styles.detailHead}>
        <div className={styles.detailTitle}>
          <h3>{summary.name}</h3>
          <p className={styles.meta}>
            <code>{summary.macro}</code> · {summary.id}@v{shown}{summary.auto ? ' · auto-matches' : ''}{summary.builtin ? ' · shipped with ashlr' : ''}
          </p>
        </div>
        <label className={styles.picker}>
          <span className={styles.visuallyHidden}>Version</span>
          <select aria-label="Version" value={shown} onChange={(e) => setVersion(Number(e.target.value) === summary.latest ? null : Number(e.target.value))}>
            {[...(data?.versions ?? [{ version: summary.latest }])].reverse().map((v) => (
              <option key={v.version} value={v.version}>v{v.version}{v.version === summary.latest ? ' (latest)' : ''}</option>
            ))}
          </select>
        </label>
        <Button variant="primary" size="sm" icon={<IconPlay size={14} />} onClick={() => onRun(macro)}>Run…</Button>
        <Button variant="subtle" size="sm" disabled={!data} onClick={() => data && onEdit(data.playbook.source, shown)}>
          {isLatest ? 'Edit' : `Edit from v${shown}`}
        </Button>
      </div>
      {summary.description ? <p className={styles.description}>{summary.description}</p> : null}

      {data === undefined && !q.error ? (
        <div aria-busy="true">
          <SkeletonLine width="40%" />
          <SkeletonLine width="90%" />
        </div>
      ) : q.error || !data ? (
        <p className={styles.banner} data-tone="danger">{q.error ? describeContextError(q.error) : 'This playbook could not be read.'}</p>
      ) : (
        <>
          <table className={styles.outcomes} aria-label="Outcomes by version">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Written</th>
                <th scope="col">Merged</th>
                <th scope="col">Refused</th>
                <th scope="col">Reverted</th>
                <th scope="col">Failed</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {[...data.versions].reverse().map((v) => (
                <tr key={v.version} aria-current={v.version === shown ? 'true' : undefined}>
                  <th scope="row">v{v.version}</th>
                  <td>{v.createdAt.slice(0, 10)}</td>
                  <td>{outcomeCell(v.outcomes.merged)}</td>
                  <td>{outcomeCell(v.outcomes.refused)}</td>
                  <td>{outcomeCell(v.outcomes.reverted)}</td>
                  <td>{outcomeCell(v.outcomes.failed)}</td>
                  <td className={styles.note}>{v.note ?? ''}{v.author ? <span className={styles.meta}> — {v.author}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.meta}>Counts come from retros of finished runs; a run still in flight counts nowhere yet.</p>
          <h4 className={styles.subhead}>As an engine reads it</h4>
          <div className={styles.markdown} aria-label="Rendered playbook" dangerouslySetInnerHTML={{ __html: html }} />
        </>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Editor (create, or the next version)
// ---------------------------------------------------------------------------

interface EditorProps {
  initial: string;
  /** null = create. */
  baseVersion: number | null;
  title: string;
  gate: TokenGate;
  onCancel: () => void;
  onSaved: (id: string, version: number) => void;
}

function PlaybookEditor({ initial, baseVersion, title, gate, onCancel, onSaved }: EditorProps) {
  const [source, setSource] = useState(initial);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverErrors, setServerErrors] = useState<PlaybookValidationIssue[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const parsed = useMemo(() => parsePlaybook(source), [source]);
  const errors = serverErrors ?? (parsed.ok ? [] : parsed.errors);
  const warnings = parsed.ok ? parsed.warnings : [];

  const save = async () => {
    setBusy(true);
    setFailure(null);
    setServerErrors(null);
    try {
      const res = await gate.run(baseVersion === null ? 'Create this playbook' : 'Save a new version of this playbook', () =>
        savePlaybookSource({ source, ...(baseVersion !== null ? { baseVersion } : {}), ...(note.trim() ? { note: note.trim() } : {}) }),
      );
      if (res === null) return;
      if (res.ok) onSaved(res.playbook.meta.id, res.playbook.version);
      else setServerErrors(res.errors);
    } catch (err) {
      setFailure(describeContextError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={styles.editor} aria-label={title} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className={styles.detailHead}>
        <div className={styles.detailTitle}>
          <h3>{title}</h3>
          <p className={styles.meta}>
            {baseVersion === null ? 'Saved as v1.' : `Saved as v${baseVersion + 1}; v${baseVersion} and earlier stay exactly as they were.`}
            {' '}Sections: Outcome, Procedure (required), Specifications, Advice, Forbidden actions, Required from user.
          </p>
        </div>
      </div>
      <textarea
        className={styles.source}
        value={source}
        spellCheck={false}
        aria-label="Playbook markdown"
        aria-invalid={errors.length > 0}
        onChange={(e) => { setSource(e.target.value); setServerErrors(null); }}
      />
      {errors.length > 0 ? (
        <ul className={styles.errors} aria-label="Problems">
          {errors.map((e, i) => <li key={`${e.field}:${i}`}>{e.message}</li>)}
        </ul>
      ) : warnings.length > 0 ? (
        <ul className={styles.warnings} aria-label="Warnings">
          {warnings.map((w, i) => <li key={`${w.field}:${i}`}>{w.message}</li>)}
        </ul>
      ) : null}
      <label className={styles.noteField}>
        <span>What changed (optional)</span>
        <input type="text" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </label>
      {failure ? <p className={styles.banner} data-tone="danger" role="alert">{failure}</p> : null}
      <div className={styles.actions}>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!parsed.ok}>
          {baseVersion === null ? 'Create' : `Save v${baseVersion + 1}`}
        </Button>
      </div>
    </form>
  );
}

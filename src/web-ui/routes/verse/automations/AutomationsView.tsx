/**
 * routes/verse/automations/AutomationsView.tsx — Automations (3.15): work
 * that arrives on its own. Labelled issues, a red default branch, a schedule,
 * a local webhook or a Telegram /task becomes one task for a lane (fleet,
 * Claude cloud, Devin, or review first) — through that lane's own gates.
 *
 * One page: the list (last fired, next run, queue, in flight, spend, success
 * rate; on/off; Run now; Dry run; Edit; Delete), a simple create/edit form
 * seeded from templates, and the recent firings with links back to their
 * sources. Every write goes through the mutation token; the server validates
 * and answers a plain sentence on a mistake.
 */
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type {
  AutomationFireResponse,
  AutomationFiringV1,
  AutomationLane,
  AutomationTemplate,
  AutomationTriggerKind,
  AutomationView,
} from '../../../../core/automations/types.js';
import { AUTOMATION_LANES, AUTOMATION_TRIGGER_KINDS } from '../../../../core/automations/types.js';
import { MutationTokenDialog } from '../../../components/auth/MutationTokenDialog.js';
import { Button } from '../../../components/primitives/Button.js';
import { EmptyState } from '../../../components/primitives/EmptyState.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { SkeletonLine } from '../../../components/primitives/Skeleton.js';
import { StatusBadge } from '../../../components/primitives/StatusBadge.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { describeContextError, useTokenGate } from '../context/use-token-gate.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { playbooksQuery } from '../playbooks/playbooks-queries.js';
import { playbookKindOf } from '../../../../core/playbooks/types.js';
import { getAutomationsFocus, isAutomationsFocusLive, subscribeAutomationsFocus, takeAutomationsFocus } from './automations-focus.js';
import {
  FIRING_LABEL,
  firingTone,
  formFrom,
  inputFromForm,
  LANE_HINT,
  LANE_LABEL,
  relativeTime,
  safeHref,
  spendLabel,
  successLabel,
  TRIGGER_LABEL,
  type AutomationForm,
} from './automations-model.js';
import {
  AUTOMATIONS_POLL_MS,
  automationsQuery,
  removeAutomation,
  runAutomation,
  saveAutomationDefinition,
  setAutomationOn,
} from './automations-queries.js';
import styles from './Automations.module.css';

type Notice = { tone: 'neutral' | 'danger'; text: string } | null;

export function AutomationsView() {
  const read = useQuery(automationsQuery);
  const refetch = useRefetch(automationsQuery);
  usePollWhileVisible(refetch, AUTOMATIONS_POLL_MS);
  const gate = useTokenGate();
  const [editing, setEditing] = useState<AutomationForm | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState<{ name: string; result: AutomationFireResponse } | null>(null);
  const templates = useMemo(() => read.data?.templates ?? [], [read.data]);
  const views = read.data?.automations ?? [];
  const now = Date.now();

  // ⌘K "New automation…" hand-off.
  const focus = useSyncExternalStore(subscribeAutomationsFocus, getAutomationsFocus, getAutomationsFocus);
  useEffect(() => {
    if (!focus || !read.data) return;
    if (isAutomationsFocusLive(focus) && focus.kind === 'new' && templates[0]) setEditing(formFrom(templates[0].input));
    takeAutomationsFocus(focus.seq);
  }, [focus, read.data, templates]);

  const act = async (key: string, why: string, run: () => Promise<string | null>) => {
    setBusy(key);
    setNotice(null);
    try {
      const message = await gate.run(why, run);
      if (message) setNotice({ tone: 'neutral', text: message });
      refetch();
    } catch (err) {
      setNotice({ tone: 'danger', text: describeContextError(err) });
    } finally {
      setBusy(null);
    }
  };

  const save = (form: AutomationForm) => {
    const shaped = inputFromForm(form);
    if (!shaped.ok) {
      setNotice({ tone: 'danger', text: shaped.error });
      return;
    }
    void act('save', form.id ? `Save ${form.name}` : `Create ${form.name}`, async () => {
      const saved = await saveAutomationDefinition(form.id, shaped.input);
      setEditing(null);
      return `${form.id ? 'Saved' : 'Created'} ${saved.name}${saved.enabled ? '' : ' (off — switch it on when ready)'}.`;
    });
  };

  const fire = (view: AutomationView, dry: boolean) =>
    act(`${dry ? 'dry' : 'run'}:${view.automation.id}`, dry ? `Dry run ${view.automation.name}` : `Run ${view.automation.name} now`, async () => {
      const result = await runAutomation(view.automation.id, dry);
      if (dry) {
        setDryRun({ name: view.automation.name, result });
        return null;
      }
      const sent = result.firings.filter((f) => f.state === 'dispatched' || f.state === 'awaiting-review').length;
      const queued = result.firings.filter((f) => f.state === 'queued').length;
      return result.firings.length === 0 && result.planned.length === 0
        ? `${view.automation.name}: nothing to do right now.`
        : `${view.automation.name}: ${sent} sent, ${queued} queued, ${result.planned.length} already handled.`;
    });

  return (
    <section className={styles.section} aria-label="Automations">
      <div className={styles.scroll}>
        <div className={styles.page}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 className={styles.title}>Automations</h2>
              <p className={styles.lede}>
                Labelled issues, a red main, schedules and webhooks become work on their own — one task per issue, within your limits, through the standing grant, Stop and each lane&apos;s budget.
              </p>
            </div>
            {!editing && templates[0] ? (
              <Button variant="primary" size="sm" onClick={() => setEditing(formFrom(templates[0]!.input))}>New automation</Button>
            ) : null}
          </header>

          {read.data?.blocked ? <p className={styles.banner} data-tone="warning" role="status">{read.data.blocked}</p> : null}
          <p className={notice ? styles.banner : styles.visuallyHidden} data-tone={notice?.tone} role="status" aria-live="polite">{notice?.text ?? ''}</p>

          {editing ? (
            <AutomationEditor
              form={editing}
              templates={editing.id ? [] : templates}
              saving={busy === 'save'}
              onChange={setEditing}
              onSave={save}
              onCancel={() => setEditing(null)}
            />
          ) : null}

          {read.data === undefined && !read.error ? (
            <div aria-busy="true" aria-label="Loading automations">
              <SkeletonLine width="50%" />
              <SkeletonLine width="80%" />
            </div>
          ) : read.error ? (
            <p className={styles.banner} data-tone="danger">{describeContextError(read.error)}</p>
          ) : views.length === 0 && !editing ? (
            <EmptyState
              title="No automations yet"
              body="Start from a template — every new automation starts switched off."
              action={
                <div className={styles.templates}>
                  {templates.map((t) => (
                    <Button key={t.id} size="sm" variant="subtle" onClick={() => setEditing(formFrom(t.input))}>{t.name}</Button>
                  ))}
                </div>
              }
            />
          ) : (
            <ul className={styles.list} aria-label="Automations">
              {views.map((view) => (
                <AutomationRow
                  key={view.automation.id}
                  view={view}
                  now={now}
                  busy={busy}
                  onToggle={(on) => void act(`toggle:${view.automation.id}`, `${on ? 'Turn on' : 'Turn off'} ${view.automation.name}`, async () => {
                    await setAutomationOn(view.automation.id, on);
                    return `${view.automation.name} is ${on ? 'on' : 'off'}.`;
                  })}
                  onRun={(dry) => void fire(view, dry)}
                  onEdit={() => setEditing(formFrom(view.automation, view.automation.id))}
                  onDelete={() => void act(`delete:${view.automation.id}`, `Delete ${view.automation.name}`, async () => {
                    await removeAutomation(view.automation.id);
                    return `Deleted ${view.automation.name} (its history stays in the journal).`;
                  })}
                />
              ))}
            </ul>
          )}

          {dryRun ? <DryRunCard name={dryRun.name} result={dryRun.result} onDismiss={() => setDryRun(null)} /> : null}

          {read.data && read.data.firings.length > 0 ? <RecentFirings firings={read.data.firings.slice(0, 25)} views={views} now={now} /> : null}
        </div>
      </div>
      <MutationTokenDialog {...gate.dialog} tokenLabel="Mutation token" tokenHelp="the mutation token ashlr verse printed" />
    </section>
  );
}

function AutomationRow(props: {
  view: AutomationView;
  now: number;
  busy: string | null;
  onToggle: (on: boolean) => void;
  onRun: (dry: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { view, now, busy } = props;
  const { automation: a, stats: s } = view;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li className={styles.row} data-automation={a.id}>
      <div className={styles.rowHead}>
        <div className={styles.rowTitle}>
          <strong>{a.name}</strong>
          <span className={styles.badge}>{LANE_LABEL[a.lane]}</span>
          {a.playbookId ? <span className={styles.badge}>playbook {a.playbookId}</span> : null}
        </div>
        <Switch checked={a.enabled} onChange={props.onToggle} aria-label={`${a.name} on`} disabled={busy === `toggle:${a.id}`} />
      </div>
      <p className={styles.meta}>{view.triggerSummary}</p>
      <dl className={styles.stats}>
        <div><dt>Last fired</dt><dd>{relativeTime(s.lastFiredAt, now)}</dd></div>
        <div><dt>Next run</dt><dd>{a.enabled ? relativeTime(s.nextRunAt, now) : 'off'}</dd></div>
        <div><dt>Queue</dt><dd>{s.queued} of {a.queueDepth}</dd></div>
        <div><dt>In flight</dt><dd>{s.active} of {a.maxConcurrent}</dd></div>
        <div><dt>Today</dt><dd>{s.firedToday} of {a.maxPerDay}</dd></div>
        <div><dt>Spend</dt><dd>{spendLabel(a, s)}</dd></div>
        <div><dt>Success</dt><dd>{successLabel(s)}</dd></div>
      </dl>
      {s.lastError ? <p className={styles.banner} data-tone="warning">{s.lastError}</p> : null}
      <div className={styles.actions}>
        <Button size="sm" variant="subtle" busy={busy === `run:${a.id}`} onClick={() => props.onRun(false)}>Run now</Button>
        <Button size="sm" variant="ghost" busy={busy === `dry:${a.id}`} onClick={() => props.onRun(true)}>Dry run</Button>
        <Button size="sm" variant="ghost" onClick={props.onEdit}>Edit</Button>
        {confirmDelete ? (
          <>
            <Button size="sm" variant="danger" busy={busy === `delete:${a.id}`} onClick={props.onDelete}>Delete {a.name}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Keep</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>Delete</Button>
        )}
      </div>
    </li>
  );
}

function AutomationEditor(props: {
  form: AutomationForm;
  templates: readonly AutomationTemplate[];
  saving: boolean;
  onChange: (next: AutomationForm) => void;
  onSave: (form: AutomationForm) => void;
  onCancel: () => void;
}) {
  const { form, onChange } = props;
  const set = <K extends keyof AutomationForm>(key: K, value: AutomationForm[K]) => onChange({ ...form, [key]: value });
  const polling = form.triggerKind === 'github-issues' || form.triggerKind === 'ci-red';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSave(form);
  };
  return (
    <form className={styles.editor} onSubmit={submit} aria-label={form.id ? `Edit ${form.name}` : 'New automation'}>
      <h3 className={styles.subtitle}>{form.id ? `Edit ${form.name}` : 'New automation'}</h3>
      {props.templates.length > 0 ? (
        <div className={styles.templates} role="group" aria-label="Templates">
          {props.templates.map((t) => (
            <Button key={t.id} type="button" size="sm" variant="subtle" title={t.blurb} onClick={() => onChange(formFrom(t.input))}>{t.name}</Button>
          ))}
        </div>
      ) : null}
      <div className={styles.grid}>
        <Input label="Name" value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} />
        <Select label="When" value={form.triggerKind} onChange={(e) => set('triggerKind', e.target.value as AutomationTriggerKind)}>
          {AUTOMATION_TRIGGER_KINDS.map((k) => <option key={k} value={k}>{TRIGGER_LABEL[k]}</option>)}
        </Select>
        {form.triggerKind === 'github-issues' ? (
          <>
            <Input label="Labels (all required)" hint="Comma separated, e.g. ashlr or ashlr:devin" value={form.labels} onChange={(e) => set('labels', e.target.value)} />
            <Input label="Search query (optional)" hint="GitHub qualifiers, e.g. no:assignee — the repos below are added" value={form.query} onChange={(e) => set('query', e.target.value)} />
          </>
        ) : null}
        {form.triggerKind === 'ci-red' ? (
          <Input label="Branch" hint="Empty = the repo's default branch" value={form.branch} onChange={(e) => set('branch', e.target.value)} />
        ) : null}
        {form.triggerKind === 'schedule' ? (
          <Input label="Schedule (RRULE, local time)" mono hint="e.g. FREQ=DAILY;BYHOUR=2 or FREQ=WEEKLY;BYDAY=MO;BYHOUR=6" value={form.rrule} onChange={(e) => set('rrule', e.target.value)} />
        ) : null}
        {polling ? <Input label="Check every (minutes)" type="number" min={5} max={1440} value={form.pollMinutes} onChange={(e) => set('pollMinutes', e.target.value)} /> : null}
        <Select label="Send to" hint={LANE_HINT[form.lane]} value={form.lane} onChange={(e) => set('lane', e.target.value as AutomationLane)}>
          {AUTOMATION_LANES.map((l) => <option key={l} value={l}>{LANE_LABEL[l]}</option>)}
        </Select>
        <Input label="Repos" hint="owner/name, comma separated — or * for every repo in the standing grant" value={form.repos} onChange={(e) => set('repos', e.target.value)} />
        <PlaybookField value={form.playbookId} onChange={(v) => set('playbookId', v)} />
        <Input label="Max in flight" type="number" min={1} value={form.maxConcurrent} onChange={(e) => set('maxConcurrent', e.target.value)} />
        <Input label="Max per day" type="number" min={1} value={form.maxPerDay} onChange={(e) => set('maxPerDay', e.target.value)} />
        <Input label="Queue depth" type="number" min={0} value={form.queueDepth} onChange={(e) => set('queueDepth', e.target.value)} />
        <Input label="Spend cap ($ per month)" type="number" min={0} prefix="$" value={form.spendCapUsd} onChange={(e) => set('spendCapUsd', e.target.value)} />
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Instructions</span>
        <textarea className={styles.textarea} rows={4} maxLength={4000} value={form.instructions} onChange={(e) => set('instructions', e.target.value)} />
      </label>
      {form.triggerKind === 'github-issues' ? (
        <Switch label="Also pull requests with these labels" checked={form.includePrs} onChange={(v) => set('includePrs', v)} />
      ) : null}
      <Switch label="On" checked={form.enabled} onChange={(v) => set('enabled', v)} />
      <div className={styles.actions}>
        <Button type="submit" variant="primary" size="sm" busy={props.saving}>{form.id ? 'Save' : 'Create'}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/**
 * The playbook every task from this automation runs under (src/core/playbooks).
 * A picker over the library; free text (`id` or `id@vN`) when the library
 * cannot be read, so a pinned version is always expressible.
 */
function PlaybookField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const read = useQuery(playbooksQuery);
  // Agent playbooks only: a command workflow is pasted into a terminal, never a task's procedure.
  const all = read.data?.value ?? null;
  const rows = all === null ? null : all.filter((p) => playbookKindOf(p) === 'agent');
  const pinned = value !== '' && rows !== null && !rows.some((p) => p.id === value);
  if (rows === null || pinned) {
    return <Input label="Playbook (optional)" hint="A playbook id, e.g. fix-issue or fix-issue@v2" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <Select label="Playbook (optional)" hint="Every task runs under this playbook's procedure" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">None</option>
      {rows.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.macro})</option>)}
    </Select>
  );
}

function DryRunCard({ name, result, onDismiss }: { name: string; result: AutomationFireResponse; onDismiss: () => void }) {
  return (
    <section className={styles.card} aria-label={`Dry run: ${name}`}>
      <div className={styles.rowHead}>
        <h3 className={styles.subtitle}>Dry run · {name}</h3>
        <Button size="sm" variant="ghost" onClick={onDismiss}>Dismiss</Button>
      </div>
      {result.planned.length === 0 ? (
        <p className={styles.meta}>Nothing would fire right now.</p>
      ) : (
        <ul className={styles.plain}>
          {result.planned.map((p) => (
            <li key={p.dedupeKey}><strong>{p.title}</strong> <span className={styles.meta}>({p.repo})</span> → {p.verdict}</li>
          ))}
        </ul>
      )}
      <p className={styles.meta}>Nothing was sent or recorded.</p>
    </section>
  );
}

function RecentFirings({ firings, views, now }: { firings: readonly AutomationFiringV1[]; views: readonly AutomationView[]; now: number }) {
  const names = new Map(views.map((v) => [v.automation.id, v.automation.name]));
  return (
    <section aria-label="Recent firings" className={styles.card}>
      <h3 className={styles.subtitle}>Recent firings</h3>
      <ul className={styles.firings}>
        {firings.map((f) => {
          const source = safeHref(f.source.url);
          const lane = safeHref(f.laneRef?.url);
          return (
            <li key={f.id} data-firing={f.id}>
              <StatusBadge status={f.state} tone={firingTone(f.state)}>{FIRING_LABEL[f.state]}</StatusBadge>
              <span className={styles.firingTitle}>
                {source ? <a href={source} target="_blank" rel="noopener noreferrer">{f.title}</a> : f.title}
              </span>
              <span className={styles.meta}>
                {names.get(f.automationId) ?? f.automationId} · {f.repo} · {LANE_LABEL[f.lane]} · {relativeTime(f.createdAt, now)}
                {lane ? <> · <a href={lane} target="_blank" rel="noopener noreferrer">open task</a></> : null}
              </span>
              {f.reason ? <span className={styles.meta}>{f.reason}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

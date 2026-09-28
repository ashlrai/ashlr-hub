/**
 * routes/verse/playbooks/CommandWorkflowForm.tsx — fill a command workflow's
 * holes and paste it (3.15).
 *
 * One labelled field per `{{param}}`, prefilled with its default; a live
 * preview of the command; "Paste in terminal". The filling is
 * command-template.ts's — each value becomes ONE shell word (single-quoted
 * unless it is a simple word) and a value with a line break or control
 * character is refused, never stripped — so the preview shows exactly what
 * reaches the prompt. Nothing here runs anything: the caller pastes, and the
 * operator presses Enter.
 *
 * Shared by the Playbooks section (Use…) and CommandWorkflowPicker (the
 * terminal panel's menu).
 */
import { useId, useMemo, useState } from 'react';
import { commandValueIssues, fillCommandTemplate, previewCommandTemplate, type CommandParam } from '../../../../core/playbooks/command-template.js';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import styles from './Playbooks.module.css';

export interface CommandWorkflowFormProps {
  name: string;
  template: string;
  params: readonly CommandParam[];
  /** Receives the filled command (no trailing newline). Only called with a command that filled cleanly. */
  onPaste: (text: string) => void;
  /** Why pasting is not possible right now (e.g. no chat open); null = it is. */
  pasteDisabledReason?: string | null;
  onCancel?: () => void;
  cancelLabel?: string;
}

function initialValues(params: readonly CommandParam[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of params) out[p.name] = p.default ?? '';
  return out;
}

/** Messages carry `name` in backticks for the markdown-ish core; the form shows plain text. */
const plain = (message: string) => message.replace(/`/g, '');

export function CommandWorkflowForm({ name, template, params, onPaste, pasteDisabledReason = null, onCancel, cancelLabel = 'Cancel' }: CommandWorkflowFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(params));
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const previewId = useId();
  const reasonId = useId();

  const issues = useMemo(() => commandValueIssues(params, values), [params, values]);
  const preview = useMemo(() => previewCommandTemplate(template, values), [template, values]);
  const blocked = pasteDisabledReason ?? (issues[0] ? plain(issues[0].message) : null);

  const paste = () => {
    if (blocked) {
      setTouched(Object.fromEntries(params.map((p) => [p.name, true])));
      return;
    }
    let filled: string;
    try {
      filled = fillCommandTemplate(template, values);
    } catch {
      return; // unreachable when there are no issues; never paste a command that did not fill
    }
    onPaste(filled);
  };

  return (
    <form className={styles.workflowForm} aria-label={`Fill ${name}`} onSubmit={(e) => { e.preventDefault(); paste(); }}>
      {params.length === 0 ? <p className={styles.meta}>This command has no parameters.</p> : null}
      {params.map((p, index) => {
        const issue = issues.find((i) => i.name === p.name);
        const shown = issue && (!issue.required || touched[p.name]) ? plain(issue.message) : undefined;
        return (
          <Input
            key={p.name}
            label={p.name}
            size="sm"
            mono
            value={values[p.name] ?? ''}
            placeholder={p.default === null ? 'required' : p.default === '' ? 'optional' : undefined}
            error={shown}
            autoFocus={index === 0}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              const next = e.target.value;
              setValues((v) => ({ ...v, [p.name]: next }));
            }}
            onBlur={() => setTouched((t) => ({ ...t, [p.name]: true }))}
          />
        );
      })}
      <div className={styles.workflowPreview}>
        <span id={previewId} className={styles.meta}>Pasted at the prompt — you press Enter</span>
        <pre aria-labelledby={previewId} className={styles.commandBlock}><code>{preview}</code></pre>
      </div>
      {blocked ? <p id={reasonId} className={styles.meta} role="status">{blocked}</p> : null}
      <div className={styles.actions}>
        {onCancel ? <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button> : null}
        <Button type="submit" variant="primary" size="sm" disabled={blocked !== null} aria-describedby={blocked ? reasonId : undefined}>
          Paste in terminal
        </Button>
      </div>
    </form>
  );
}

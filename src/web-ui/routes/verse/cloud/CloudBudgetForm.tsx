/**
 * routes/verse/cloud/CloudBudgetForm.tsx — the cloud budget's fields, shared
 * by Command's "Edit budget" popover and the Usage "Cloud credits" panel
 * (3.11 unit C3), so both edit the same numbers the same way.
 *
 * Save sends ONE update with only the fields that changed (cloud-model
 * budgetPatch). The form re-seeds from the server's budget whenever that
 * budget changes and nothing has been typed, so a save elsewhere (the CLI,
 * the other surface) shows up instead of being silently overwritten.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CloudBudgetUpdate, CloudBudgetV1 } from '../../../../core/cloud/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Input } from '../../../components/primitives/Input.js';
import { Switch } from '../../../components/primitives/Switch.js';
import { BUDGET_FIELDS, budgetFormFrom, budgetPatch, type BudgetErrors, type BudgetForm } from './cloud-model.js';
import styles from './cloud.module.css';

export interface CloudBudgetFormProps {
  budget: CloudBudgetV1;
  /** Runs the save (through the caller's token gate); the form keeps its values until the new budget lands. */
  onSave: (update: CloudBudgetUpdate) => void;
  onCancel?: () => void;
  busy: boolean;
  disabled?: boolean;
  /** The id prefix, so two forms on one page never share field ids. */
  idPrefix: string;
}

export function CloudBudgetForm({ budget, onSave, onCancel, busy, disabled = false, idPrefix }: CloudBudgetFormProps) {
  const [form, setForm] = useState<BudgetForm>(() => budgetFormFrom(budget));
  const [errors, setErrors] = useState<BudgetErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const dirty = useRef(false);

  // A newer budget from the server replaces the fields only while the
  // operator has not started typing — never under their fingers.
  useEffect(() => {
    if (!dirty.current) setForm(budgetFormFrom(budget));
  }, [budget]);

  const edit = (patch: Partial<BudgetForm>) => {
    dirty.current = true;
    setNote(null);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = budgetPatch(form, budget);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (!result.changed) {
      setNote('Nothing changed.');
      return;
    }
    dirty.current = false;
    onSave(result.update);
  };

  return (
    <form className={styles.form} onSubmit={submit} noValidate aria-label="Cloud budget">
      <div className={styles.fieldGrid}>
        {BUDGET_FIELDS.map((spec) => (
          <Input
            key={spec.field}
            id={`${idPrefix}-${spec.field}`}
            label={spec.label}
            hint={spec.hint}
            error={errors[spec.field]}
            size="sm"
            inputMode={spec.integer ? 'numeric' : 'decimal'}
            prefix={spec.money ? '$' : undefined}
            value={form[spec.field]}
            disabled={disabled || busy}
            onChange={(e) => edit({ [spec.field]: e.target.value } as Partial<BudgetForm>)}
          />
        ))}
      </div>
      <Switch
        checked={form.selfImprove}
        onChange={(next) => edit({ selfImprove: next })}
        label="Verse may launch self-improvement tasks on its own"
        disabled={disabled || busy}
      />
      {note ? <p className={styles.muted} role="status">{note}</p> : null}
      <div className={styles.formActions}>
        {onCancel ? (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={disabled}>
          Save budget
        </Button>
      </div>
    </form>
  );
}

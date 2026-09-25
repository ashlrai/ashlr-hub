/**
 * routes/verse/cloud/CloudLaunchDialog.tsx — "New cloud task" (3.11 unit C3):
 * repo (default ashlrai/ashlr-hub), base branch, the task, Launch.
 *
 * Validation runs on Launch, field by field, in the words the service would
 * use (cloud-model validateLaunch) — the server re-checks everything. The
 * request goes through the surface's guarded action (token first when none
 * is held); a refusal (budget, seat, a CLI that printed no session) stays IN
 * the dialog in the server's own sentence, with the draft intact, so the
 * operator can fix the one thing and press Launch again.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CLOUD_PROMPT_MAX_CHARS, type CloudTaskV1 } from '../../../../core/cloud/types.js';
import { Button } from '../../../components/primitives/Button.js';
import { Dialog } from '../../../components/primitives/Dialog.js';
import { Input } from '../../../components/primitives/Input.js';
import { DispatchDisabledError } from '../../../data/client.js';
import { describeControlError } from '../autonomy/use-guarded-action.js';
import type { SurfaceActions } from '../command/actions.js';
import { launchCloudTask } from './cloud-queries.js';
import { CLOUD_DEFAULT_REPO, formatDollars, validateLaunch, type LaunchDraft, type LaunchErrors } from './cloud-model.js';
import styles from './cloud.module.css';

export interface CloudLaunchDialogProps {
  open: boolean;
  onClose: () => void;
  actions: Pick<SurfaceActions, 'act' | 'busy'>;
  /** The flat per-session estimate, for the "Estimated at $3" line. */
  estimatePerSessionUsd: number | null;
  onLaunched: (task: CloudTaskV1) => void;
  defaultRepo?: string;
}

const COUNT = new Intl.NumberFormat('en-US');

export function CloudLaunchDialog({ open, onClose, actions, estimatePerSessionUsd, onLaunched, defaultRepo = CLOUD_DEFAULT_REPO }: CloudLaunchDialogProps) {
  const titleId = useId();
  const promptId = useId();
  const promptErrorId = useId();
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<LaunchDraft>({ repo: defaultRepo, baseBranch: '', prompt: '' });
  const [errors, setErrors] = useState<LaunchErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  // Each opening starts clean except for the repo, which is usually the same.
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setRefusal(null);
  }, [open]);

  const edit = (patch: Partial<LaunchDraft>) => {
    setRefusal(null);
    setDraft((prev) => ({ ...prev, ...patch }));
    setErrors((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(patch) as Array<keyof LaunchDraft>) delete next[key];
      return next;
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateLaunch(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setRefusal(null);
    actions.act(async () => {
      try {
        const response = await launchCloudTask({ ...result.request, origin: 'operator' });
        setDraft((prev) => ({ ...prev, prompt: '' }));
        onLaunched(response.task);
        onClose();
      } catch (err) {
        // A read-only server is the surface's state (its ActionStatus line);
        // every other refusal belongs next to the Launch button.
        if (err instanceof DispatchDisabledError) throw err;
        setRefusal(describeControlError(err));
      }
    }, 'Launch a Claude Code cloud session with this task.');
  };

  const length = draft.prompt.trim().length;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      titleId={titleId}
      title="New cloud task"
      description="Runs as a Claude Code cloud session on your Claude account. It delivers a draft PR; nothing merges on its own."
      widthClassName={styles.dialogWidth}
      initialFocusRef={taskRef}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.fieldGrid}>
          <Input
            label="Repository"
            hint="GitHub owner/name"
            mono
            value={draft.repo}
            error={errors.repo}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => edit({ repo: e.target.value })}
          />
          <Input
            label="Base branch"
            hint="Must be pushed. Empty uses the default branch."
            mono
            value={draft.baseBranch}
            placeholder="default branch"
            error={errors.baseBranch}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => edit({ baseBranch: e.target.value })}
          />
        </div>
        <div className={styles.textareaField}>
          <label className={styles.label} htmlFor={promptId}>Task</label>
          <textarea
            ref={taskRef}
            id={promptId}
            className={styles.textarea}
            value={draft.prompt}
            placeholder="What should the cloud session do? It reads the repo's own guidance and opens a draft PR."
            aria-invalid={errors.prompt ? true : undefined}
            aria-describedby={errors.prompt ? promptErrorId : undefined}
            onChange={(e) => edit({ prompt: e.target.value })}
          />
          {errors.prompt ? <p id={promptErrorId} className={styles.fieldError} role="alert">{errors.prompt}</p> : null}
          <p className={styles.muted}>
            {COUNT.format(length)} of {COUNT.format(CLOUD_PROMPT_MAX_CHARS)} characters
            {estimatePerSessionUsd !== null ? ` · estimated at ${formatDollars(estimatePerSessionUsd)} per session` : ''}
          </p>
        </div>
        {refusal ? <p className={styles.notice} data-tone="danger" role="alert">{refusal}</p> : null}
        <div className={styles.formActions}>
          <Button variant="ghost" onClick={onClose} disabled={actions.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={actions.busy}>
            Launch
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

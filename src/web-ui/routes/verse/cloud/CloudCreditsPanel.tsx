/**
 * routes/verse/cloud/CloudCreditsPanel.tsx — "Cloud credits" in Usage (3.11
 * unit C3; mounted by sections/UsageSection.tsx). The same estimate and the
 * same budget fields as Command's Cloud card (CloudBudgetForm), laid out as
 * a Usage panel: this is where the operator calibrates the estimate after
 * checking the real balance on claude.ai.
 *
 * Renders nothing while the first read is out and nothing on a server
 * without the cloud lane (404) — Usage has many panels, and "not in this
 * build" is not worth one of them. Any other failure says so in the panel.
 */
import { CLOUD_BALANCE_URL, type CloudBudgetUpdate } from '../../../../core/cloud/types.js';
import { IconExternalLink } from '../../../components/primitives/icons.js';
import { Meter } from '../../../components/primitives/Meter.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { tidyProse } from '../autonomy/format.js';
import { ActionStatus, useSurfaceActions } from '../command/actions.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import usage from '../usage/usage.module.css';
import { CloudBudgetForm } from './CloudBudgetForm.js';
import { creditsMeter, gateText, sessionsLine } from './cloud-model.js';
import { CLOUD_POLL_MS, cloudQuery, updateCloudBudget } from './cloud-queries.js';
import styles from './cloud.module.css';

export function CloudCreditsPanel({ now = Date.now() }: { now?: number }) {
  const read = useQuery(cloudQuery, { freshMs: 15_000 });
  const refetch = useRefetch(cloudQuery);
  usePollWhileVisible(refetch, CLOUD_POLL_MS);
  const actions = useSurfaceActions();

  if (!read.data) return null;
  if (!read.data.available) return null;
  const overview = read.data.value;
  const view = overview?.budget ?? null;
  const meter = view ? creditsMeter(view) : null;
  const refused = view ? gateText(view.canLaunch, 'The cloud budget does not allow another launch right now.') : null;

  const save = (update: CloudBudgetUpdate) => actions.act(() => updateCloudBudget(update), 'Change the cloud budget.');

  return (
    <section className={usage.panel} aria-labelledby="verse-usage-cloud-credits">
      <div className={usage.panelHead}>
        <h3 id="verse-usage-cloud-credits" className={usage.panelTitle}>
          Cloud credits
        </h3>
        <p className={usage.panelNote}>
          What Claude Code cloud sessions launched by Verse have cost, as an estimate, and the limits Verse keeps them inside.
        </p>
      </div>
      {!view || !meter ? (
        <p className={styles.muted}>{read.data.reason ?? 'The cloud lane did not answer.'}</p>
      ) : (
        <div className={styles.body}>
          <ActionStatus actions={actions} />
          <Meter
            value={meter.value}
            max={meter.max}
            label="Credits remaining"
            valueText={meter.text}
            tone={meter.tone}
            aria-label={`Estimated cloud credits remaining: ${meter.text}, ${meter.usedText}`}
          />
          <p className={styles.estimateNote}>
            {tidyProse(view.estimateNote, now)}{' '}
            <a className={styles.link} href={CLOUD_BALANCE_URL} target="_blank" rel="noreferrer noopener" aria-label="Check the real balance on claude.ai">
              Check usage on claude.ai <IconExternalLink width={12} height={12} aria-hidden="true" />
            </a>
          </p>
          {meter.warning ? <p className={styles.notice} data-tone="warning" role="note">{meter.warning}</p> : null}
          <p className={styles.facts}>{sessionsLine(view, now)}</p>
          {refused ? <p className={styles.notice} data-tone="warning" role="note">New launches are paused: {refused}</p> : null}
          <CloudBudgetForm idPrefix="usage-cloud-budget" budget={view.budget} busy={actions.busy} disabled={actions.readOnly} onSave={save} />
        </div>
      )}
      {actions.dialogs}
    </section>
  );
}

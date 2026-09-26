/**
 * routes/verse/resources/LocalResources.tsx — local compute in the Resources
 * drawer (unit 3.11 C6): the local seat's readiness (the shared capacity
 * projection's word), the serving runtime (llama-server / Ollama: state,
 * loaded model, per-agent context, slots) with Start / Stop when THIS server
 * supervises it, and the installed models with the context each one really
 * runs at.
 *
 * Reads are the owners' own QueryDefs — `/api/verse/local-models`
 * (usage-queries, with its burst retry) and `/api/verse/runtime`
 * (autonomy/fleet-queries) — polled only while the drawer is mounted, which
 * is only while it is open. Start / Stop go through the shell's guard (Stop
 * confirms first, both ask for the token), with the same words as the Fleet
 * runtime panel.
 */
import { useState } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { runRuntimeAction, servingRuntimeQuery } from '../autonomy/fleet-queries.js';
import { MonogramTile } from '../apps/MonogramTile.js';
import { tidyProse } from '../autonomy/format.js';
import { requestGuarded } from '../shell/guarded-action.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import type { AccountStatus } from '../usage/capacity-strip-model.js';
import { buildLocalModelsView } from '../usage/local-model.js';
import { projectLocalModels } from '../usage/usage-contract.js';
import { verseLocalModelsQuery } from '../usage/usage-queries.js';
import { LOCAL_MODELS_SHOWN, modelContextText, runtimeView } from './resources-model.js';
import { RESOURCES_POLL_MS } from './resources-queries.js';
import { StatusLine } from './ResourceCard.js';
import styles from './ResourcesDrawer.module.css';

const STOP_BODY =
  'Every local agent turn in flight is answered by this process. Stopping it ends those turns — nothing in flight is rolled back, and no local seat can take a new turn until it is running again.';

export function LocalResources({ status, onOpenUsage, now }: { status: AccountStatus | null; onOpenUsage: () => void; now: number }) {
  const models = useQuery(verseLocalModelsQuery);
  const runtimeRead = useQuery(servingRuntimeQuery);
  const refetchModels = useRefetch(verseLocalModelsQuery);
  const refetchRuntime = useRefetch(servingRuntimeQuery);
  usePollWhileVisible(refetchModels, RESOURCES_POLL_MS.local);
  usePollWhileVisible(refetchRuntime, RESOURCES_POLL_MS.runtime);
  const [note, setNote] = useState<{ tone: 'neutral' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);

  const view = models.data?.available ? buildLocalModelsView(projectLocalModels(models.data.raw), now) : null;
  const runtime = runtimeView(runtimeRead.data?.value ?? null);
  const modelsLoading = models.data === undefined && models.status !== 'error';
  const rows = view?.rows ?? [];
  const shown = rows.slice(0, LOCAL_MODELS_SHOWN);
  const more = rows.length - shown.length;

  const act = (action: 'start' | 'stop') => {
    const label = action === 'start' ? 'Start' : 'Stop';
    setNote(null);
    requestGuarded({
      title: 'Stop the serving runtime?',
      body: STOP_BODY,
      confirmLabel: 'Stop runtime',
      destructive: true,
      skipConfirm: action === 'start',
      token: true,
      tokenReason: `${label === 'Start' ? 'Starting' : 'Stopping'} the serving runtime requires the dispatch token.`,
      run: async () => {
        setBusy(action);
        try {
          const result = await runRuntimeAction(action);
          setNote({ tone: 'neutral', text: (result.note ? tidyProse(result.note) : '') || (action === 'start' ? 'Runtime starting.' : 'Runtime stopped.') });
        } finally {
          setBusy(null);
        }
      },
      onError: (message) => setNote({ tone: 'danger', text: message }),
    });
  };

  return (
    <li className={styles.card} data-resource="local" data-status={status?.kind}>
      <div className={styles.cardHead}>
        <MonogramTile monogram="L" engine="local" size="sm" />
        <h4 className={styles.cardName}>
          <span>Local models</span>
          <span className={styles.plan}>this machine</span>
        </h4>
      </div>
      {status !== null ? (
        <StatusLine status={status} />
      ) : view !== null && !view.reachable ? (
        <p className={styles.status} data-tone="neutral"><span className={styles.statusDot} aria-hidden="true" /><span className={styles.statusLabel}>No local runtime answering</span></p>
      ) : null}

      {runtime !== null ? (
        <div className={styles.runtime} data-runtime-state={runtime.state}>
          <p className={styles.runtimeHead}>
            <span className={styles.runtimeName}>{runtime.name}</span>
            <span className={styles.pill} data-tone={runtime.tone}>{runtime.word}</span>
          </p>
          {runtime.detail !== null ? <p className={styles.subtle} title={runtime.detail}>{runtime.detail}</p> : null}
          {runtime.canStart || runtime.canStop ? (
            <div className={styles.cardActions}>
              {runtime.canStart ? (
                <Button size="sm" variant="primary" busy={busy === 'start'} aria-label={`Start ${runtime.name}`} onClick={() => act('start')}>Start</Button>
              ) : null}
              {runtime.canStop ? (
                <Button size="sm" variant="subtle" busy={busy === 'stop'} aria-label={`Stop ${runtime.name}`} onClick={() => act('stop')}>Stop</Button>
              ) : null}
            </div>
          ) : runtime.managedElsewhere ? (
            <p className={styles.subtle}>Started and stopped outside Verse.</p>
          ) : null}
        </div>
      ) : null}

      {modelsLoading ? (
        <p className={styles.subtle} aria-busy="true">Reading local models…</p>
      ) : !models.data?.available ? (
        <p className={styles.subtle}>Local model details are not available from this server yet.</p>
      ) : view === null || rows.length === 0 ? (
        <p className={styles.subtle}>
          {view?.reachable ? 'No models installed.' : 'Start Ollama or llama-server to use local models.'}
        </p>
      ) : (
        <ul className={styles.models} aria-label="Local models">
          {shown.map((m) => {
            const context = modelContextText(m);
            return (
              <li key={`${m.runtime ?? 'local'}:${m.name}`} className={styles.model} data-resident={m.resident || undefined}>
                <span className={styles.modelName} title={m.name}>
                  {m.displayName}
                  {m.nameDetail ? <span className={styles.modelDetail}> {m.nameDetail}</span> : null}
                </span>
                <span className={styles.modelFacts}>
                  {m.resident ? <span className={styles.pill} data-tone="success">Loaded</span> : null}
                  {context !== null ? <span title={m.contextTruncated ? 'Configured below the model’s native window' : undefined}>{context}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 ? (
        <button type="button" className={styles.linkButton} onClick={onOpenUsage}>
          {`${more} more in Usage`}
        </button>
      ) : null}
      <p className={note ? styles.note : styles.visuallyHidden} data-tone={note?.tone} role="status" aria-live="polite">{note?.text ?? ''}</p>
    </li>
  );
}

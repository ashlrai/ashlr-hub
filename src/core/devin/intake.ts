/**
 * Devin PRs into the standing gates (3.15): the cloud intake
 * (fleet/cloud-intake.ts) with the Devin lane as its source — the same
 * selection, the same GitHub identity checks (pinned PR, head exactly
 * `ashlr-devin/<taskId>`, same repository, base unchanged, diff pinned to the
 * head and re-read after download), the same UNVERIFIED report, the same
 * caps. Nothing here is a second copy of those rules.
 *
 * Identity the host vouches for: `devin:<devin_mode>` (tier frontier), family
 * `devin` (fleet/reviewer-independence.ts). G6 then needs a frontier judge of
 * another family, and the standing pass never merges `devin` work on its own
 * (producerMergeWithheld → a would-merge record; the App PR waits for Mason).
 *
 * Kept deliberately lean (types + store + the intake): the daemon tick
 * imports this module, so everything it imports is Tier-1 authority surface.
 */
import type { EffectivePolicy } from '../authority/types.js';
import { ingestCloudPrs, type CloudIntakeMirror, type CloudIntakeResult, type CloudIntakeSource, type IngestCloudPrsOptions } from '../fleet/cloud-intake.js';
import type { AshlrConfig } from '../types.js';
import { listDevinTasks, readDevinTask, writeDevinTask } from './store.js';
import { DEVIN_BRANCH_PREFIX, DEVIN_REPORT_FENCE, type DevinTaskV1 } from './types.js';

/** The engine prefix every Devin proposal is signed with. */
export const DEVIN_INTAKE_ENGINE = 'devin' as const;

export const DEVIN_INTAKE_SOURCE: CloudIntakeSource<DevinTaskV1> = Object.freeze({
  kind: 'devin',
  branchPrefix: DEVIN_BRANCH_PREFIX,
  reportFence: DEVIN_REPORT_FENCE,
  engineModel: (task: DevinTaskV1) => `${DEVIN_INTAKE_ENGINE}:${task.devinMode}`,
  engineTier: 'frontier',
  titlePrefix: '[devin]',
  taskNoun: 'Devin task',
  producerPhrase: 'a Devin (Cognition) session',
  reportLabel: 'Devin session',
});

/** Only when Mason turned the lane on: a disabled lane's PRs stay with Needs-you. */
export async function ingestDevinPrs(
  cfg: AshlrConfig,
  policy: EffectivePolicy,
  options: { mirrors?: readonly CloudIntakeMirror[]; deps?: IngestCloudPrsOptions<DevinTaskV1>['deps'] } = {},
): Promise<CloudIntakeResult> {
  if (cfg.devin?.enabled !== true) {
    return { checked: 0, ingested: 0, superseded: 0, refused: 0, deferred: 0, killed: false, outcomes: [] };
  }
  return ingestCloudPrs<DevinTaskV1>(cfg, policy, {
    ...(options.mirrors ? { mirrors: options.mirrors } : {}),
    source: DEVIN_INTAKE_SOURCE,
    deps: {
      listTasks: () => listDevinTasks(Number.MAX_SAFE_INTEGER),
      readTask: (id) => readDevinTask(id),
      writeTask: (task) => writeDevinTask(task),
      ...options.deps,
    },
  });
}

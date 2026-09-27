/**
 * routes/verse/shell/cloud-triage.ts — the Needs-you drawer's cloud PR
 * triage (3.13): each cloud PR's gate preview (GET /api/verse/cloud/previews,
 * core/cloud/pr-preview.ts), the chip a row shows for it, and running one
 * action kind over several items at once ("Land all clean", or A / R / E on a
 * multi-selection).
 *
 * 3.15 — Devin PRs are triaged the same way: their previews come from GET
 * /api/verse/devin/previews (same shape; the server's shared pr-actions.ts
 * computes both) and are merged with the cloud lane's. Each lane's endpoint
 * may only speak for its own rows (`cloud-ct_…` / `devin-dv_…` item ids), and
 * one lane failing — a 404 while Devin is off — never costs the other its
 * chips.
 *
 * The actions themselves are the items' own (cloud-api.ts triageActions maps
 * Land / Close / Update branch onto approve / reject / fix), so nothing here
 * builds a route: a batch POSTs each item's own request, pinned by the server
 * to the head SHA its preview judged.
 *
 * Loads with the drawer (VerseApp imports the drawer with import()), never
 * at first paint; pr-preview.ts is imported for its TYPES only — its value
 * graph is the server's merge gates.
 */
import type { CloudPrCheck, CloudPrPreview, CloudPrPreviewsResponse } from '../../../../core/cloud/pr-preview.js';
import { CLOUD_TASK_ID_PATTERN, VERSE_CLOUD_PATH } from '../../../../core/cloud/types.js';
import { DEVIN_TASK_ID_PATTERN, VERSE_DEVIN_PATH } from '../../../../core/devin/types.js';
import { isSafeApiRoute, type NeedsYouActionKind, type NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { requestGuarded, describeActionError } from './guarded-action.js';
import { markResolved } from './needs-you-actions.js';
import { actionOf, readableItemTitle } from './needs-you-model.js';
import { refreshActivity } from './useActivity.js';

export const CLOUD_PREVIEWS_KEY = 'verse-cloud-previews';
const PREVIEWS_PATH = `${VERSE_CLOUD_PATH}/previews`;
/** core/devin/devin-api.ts VERSE_DEVIN_PREVIEWS_PATH (that module is server-only). */
const DEVIN_PREVIEWS_PATH = `${VERSE_DEVIN_PATH}/previews`;

export type DeliveryLane = 'cloud' | 'devin';

/** Needs-you item id prefix of each lane's PR rows (cloud-api.ts / devin-api.ts). */
export const PR_ITEM_PREFIX: Readonly<Record<DeliveryLane, string>> = {
  cloud: 'fleet:owner-lane-pr:cloud-',
  devin: 'fleet:owner-lane-pr:devin-',
};

/** A PR row of either lane — the only rows with a gate preview. */
export function isDeliveryPrItem(id: string): boolean {
  return id.startsWith(PR_ITEM_PREFIX.cloud) || id.startsWith(PR_ITEM_PREFIX.devin);
}

const ITEM_TASK_RE = /^(?:fleet:owner-lane-pr|chats:chat-failed):(cloud|devin)-([^:]+)$/;

/**
 * The lane and task behind a cloud or Devin item (its PR, its failed launch,
 * a waiting Devin session) — for its evidence. Null unless the id carries a
 * task id OF THAT LANE's own format, so no other id is ever spliced into a
 * request path (`cloud-dv_…` or `devin-ct_…` are refused).
 */
export function deliveryTaskOfItem(id: string): { lane: DeliveryLane; taskId: string } | null {
  const match = ITEM_TASK_RE.exec(id);
  if (!match) return null;
  const lane = match[1] as DeliveryLane;
  const taskId = match[2]!;
  const pattern = lane === 'cloud' ? CLOUD_TASK_ID_PATTERN : DEVIN_TASK_ID_PATTERN;
  return pattern.test(taskId) ? { lane, taskId } : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isCheck(value: unknown): value is CloudPrCheck {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['ok'] === 'boolean' && typeof value['text'] === 'string';
}

function isPreview(value: unknown): value is CloudPrPreview {
  return isRecord(value)
    && typeof value['itemId'] === 'string'
    && typeof value['headSha'] === 'string'
    && typeof value['wouldAutoLand'] === 'boolean'
    && typeof value['reason'] === 'string'
    && Array.isArray(value['checks']) && value['checks'].every(isCheck);
}

/**
 * Previews by Needs-you item id. A malformed entry is dropped, never guessed
 * at. With `lane`, only that lane's rows are kept: a lane's endpoint cannot
 * vouch for the other lane's pull requests.
 */
export function narrowPreviews(raw: unknown, lane?: DeliveryLane): ReadonlyMap<string, CloudPrPreview> {
  const out = new Map<string, CloudPrPreview>();
  const list = isRecord(raw) ? (raw as Partial<CloudPrPreviewsResponse>).previews : undefined;
  if (!Array.isArray(list)) return out;
  for (const entry of list) {
    if (!isPreview(entry)) continue;
    if (lane && !entry.itemId.startsWith(PR_ITEM_PREFIX[lane])) continue;
    out.set(entry.itemId, entry);
  }
  return out;
}

const NONE: ReadonlyMap<string, CloudPrPreview> = new Map();

/** One lane's previews; a 404 (Devin off, an older server) or any failed read is no chips for that lane. */
async function lanePreviews(path: string, lane: DeliveryLane, signal: AbortSignal | undefined): Promise<ReadonlyMap<string, CloudPrPreview>> {
  try {
    return narrowPreviews(await apiGet<unknown>(path, signal), lane);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return NONE;
  }
}

/**
 * Optional read of both lanes' previews, merged. A server without a route
 * (404) or a failed read shows no chips for that lane — the items and their
 * own actions still work, and the other lane is unaffected. 401 propagates
 * (the whole app's read session expired).
 */
export const cloudPreviewsQuery: QueryDef<ReadonlyMap<string, CloudPrPreview>> = {
  key: CLOUD_PREVIEWS_KEY,
  fetch: async (signal) => {
    const [cloud, devin] = await Promise.all([
      lanePreviews(PREVIEWS_PATH, 'cloud', signal),
      lanePreviews(DEVIN_PREVIEWS_PATH, 'devin', signal),
    ]);
    if (devin.size === 0) return cloud;
    if (cloud.size === 0) return devin;
    return new Map([...cloud, ...devin]);
  },
};

// ---------------------------------------------------------------------------
// What a row shows
// ---------------------------------------------------------------------------

export interface TriageChip {
  tone: 'clean' | 'held';
  /** "Clean" / "Held". */
  label: string;
  /** The first failing check, in its own words ("2 commits behind"); null when clean. */
  why: string | null;
  /** The whole verdict sentence, for a tooltip. */
  title: string;
}

/** The chip for an item's preview, when the preview is for the head its actions are pinned to. */
export function triageChip(item: NeedsYouItem, preview: CloudPrPreview | undefined): TriageChip | null {
  if (!preview || !previewMatchesItem(item, preview)) return null;
  if (preview.wouldAutoLand) return { tone: 'clean', label: 'Clean', why: null, title: preview.reason };
  const failing = preview.checks.find((c) => !c.ok);
  return { tone: 'held', label: 'Held', why: failing?.text ?? null, title: preview.reason };
}

/**
 * A preview only speaks for an item whose actions are pinned to the same
 * head. Between a push and the next rebuild the two can disagree; the chip
 * then waits rather than vouch for a commit the Land button will not merge.
 */
export function previewMatchesItem(item: NeedsYouItem, preview: CloudPrPreview): boolean {
  const pinned = item.actions.find((a) => a.request !== null && typeof a.request.body['headSha'] === 'string');
  return pinned ? pinned.request!.body['headSha'] === preview.headSha : false;
}

/** Items "Land all clean" would land: previewed clean, pinned to that head, and carrying a Land action. */
export function cleanLandable(items: readonly NeedsYouItem[], previews: ReadonlyMap<string, CloudPrPreview>): NeedsYouItem[] {
  return items.filter((item) => {
    const preview = previews.get(item.id);
    return preview !== undefined && preview.wouldAutoLand && previewMatchesItem(item, preview) && actionOf(item, 'approve') !== null;
  });
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface BatchContext {
  toast: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
  /** Called with the ids that succeeded (the drawer clears them from its selection). */
  onSettled?: (succeeded: readonly string[]) => void;
}

/** The verb a batch dialog uses for `kind` over `n` items ("Land 3 pull requests?"). */
function batchCopy(kind: NeedsYouActionKind, items: readonly NeedsYouItem[]): { title: string; confirmLabel: string; verb: string } {
  const label = actionOf(items[0]!, kind)?.label ?? kind;
  const n = items.length;
  const noun = items.every((i) => i.subject.pr !== null) ? (n === 1 ? 'pull request' : 'pull requests') : n === 1 ? 'item' : 'items';
  return { title: `${label} ${n} ${noun}?`, confirmLabel: `${label} ${n}`, verb: label };
}

/**
 * One confirmation, one token, then each item's own `kind` request in turn
 * (sequential: GitHub merges into one base branch, and a second merge must
 * see the first). A refusal does not stop the rest; the toast names what
 * landed and why anything did not. Items without that action are skipped.
 */
export function runBatch(items: readonly NeedsYouItem[], kind: NeedsYouActionKind, ctx: BatchContext): boolean {
  const eligible = items.filter((item) => {
    const action = actionOf(item, kind);
    return action?.request != null && isSafeApiRoute(action.request.path);
  });
  if (eligible.length === 0) {
    ctx.toast('None of the selected items can do that.', 'neutral');
    return false;
  }
  const copy = batchCopy(kind, eligible);
  const named = eligible.slice(0, 3).map((item) => (item.subject.pr ? `#${item.subject.pr}` : `“${readableItemTitle(item).text}”`));
  const list = eligible.length > 3 ? `${named.join(', ')} and ${eligible.length - 3} more` : named.join(', ');
  const destructive = eligible.some((item) => actionOf(item, kind)?.destructive === true);
  const succeeded = new Set<string>();
  let failures: string[] = [];
  return requestGuarded({
    title: copy.title,
    body: `${list}. Each runs on the exact commit it was checked on; one that moved since is refused, not changed.`,
    confirmLabel: copy.confirmLabel,
    destructive,
    token: true,
    tokenReason: `${copy.verb} changes pull requests on GitHub and requires the dispatch token.`,
    run: async () => {
      const token = getMutationToken();
      if (!token) throw new ApiError('Mutation token was rejected.', 401, PREVIEWS_PATH);
      // A retry from the dialog re-runs only what has not gone through yet.
      failures = [];
      for (const item of eligible) {
        if (succeeded.has(item.id)) continue;
        const request = actionOf(item, kind)!.request!;
        try {
          await apiPost<unknown>(request.path, request.body, token);
          succeeded.add(item.id);
          markResolved(item.id);
        } catch (err) {
          // A rejected token stops the batch: every later POST would fail the same way.
          if (err instanceof ApiError && err.status === 401) throw err;
          failures.push(`${item.subject.pr ? `#${item.subject.pr}` : readableItemTitle(item).text}: ${describeActionError(err)}`);
        }
      }
      touchMutationHold();
      if (succeeded.size === 0) throw new Error(failures.length === 1 ? failures[0]! : `None went through. ${failures[0]!}`);
    },
    onDone: () => {
      void refreshActivity();
      ctx.onSettled?.([...succeeded]);
      const done = `${copy.verb}: ${succeeded.size} of ${eligible.length} done.`;
      ctx.toast(
        failures.length === 0 ? done : `${done} ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ''}`,
        failures.length === 0 ? 'success' : 'neutral',
      );
    },
  });
}

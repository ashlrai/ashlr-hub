/**
 * routes/verse/shell/needs-you-actions.ts — doing what a Needs-you item asks
 * (unit C1). One path for a drawer key (A / R / V / E), a drawer button and
 * the palette:
 *
 *   1. the action's route must be a same-origin `/api/` route
 *      (isSafeApiRoute — checked again here, not only at the server's
 *      producer boundary, because this is where the mutation token is sent);
 *   2. approve / reject / veto always confirm (the item's own copy, else a
 *      generic one); other kinds only when the item carries copy;
 *   3. then the token, then the POST (guarded-action.tsx owns 2–3's order);
 *   4. on success the item is hidden at once (optimistic) and activity is
 *      re-polled; it stays hidden until a poll no longer lists it, or 60 s.
 *
 * An action with no route (it needs Touch ID or a terminal) opens the item's
 * target instead — that is where the flow lives.
 *
 * 3.15: a cloud / Devin PR's Close confirms with an optional one-line reason
 * (close-reason.tsx) that rides in the POST body as `reason` — only for that
 * one route, and only when something was typed.
 */
import { isSafeApiRoute, type NeedsYouAction, type NeedsYouItem } from '../../../../core/verse/workbench-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate, invalidatePrefix } from '../../../data/cache.js';
import { ApiError, apiPost } from '../../../data/client.js';
import { closeReasonBody, isCloseTriageAction, withCloseReason, type CloseReasonHolder } from './close-reason.js';
import { requestGuarded } from './guard-store.js';
import { ALWAYS_CONFIRM, confirmCopy, readableItemTitle } from './needs-you-model.js';
import { markResolved } from './resolved-store.js';
import { refreshActivity } from './useActivity.js';

export { markResolved, pruneResolved, resetResolvedForTest, RESOLVED_HIDE_MS, useResolvedIds } from './resolved-store.js';

export interface ActionContext {
  /** Open the item's target (for an action with no route). */
  openTarget: (item: NeedsYouItem) => void;
  toast: (message: string, tone?: 'neutral' | 'success' | 'danger') => void;
}

function afterSuccess(item: NeedsYouItem): void {
  markResolved(item.id);
  if (item.source === 'approvals') {
    // The approvals list, the inbox badge and the proposal detail all read
    // these keys (data/mutations.ts approveProposal does the same).
    invalidate('inbox');
    invalidate('dashboard-snapshot');
    invalidatePrefix('inbox-list:');
    if (item.target.kind === 'approval') invalidate(`proposal-detail-${item.target.proposalId}`);
  }
  void refreshActivity();
}

/** Run `action` on `item` through confirm → token → POST. */
export function runNeedsYouAction(item: NeedsYouItem, action: NeedsYouAction, ctx: ActionContext): void {
  const request = action.request;
  if (!request) {
    ctx.openTarget(item);
    return;
  }
  if (!isSafeApiRoute(request.path)) {
    ctx.toast('That action points outside this app and was not sent.', 'danger');
    return;
  }
  const copy = confirmCopy(item, action);
  // The operator-facing title ("fix the flaky snapshot test"), not the raw
  // producer string ("PR: fix the flaky snapshot test") — same text the row shows.
  const title = readableItemTitle(item).text;
  // Read at click time, so a retry after an error sends what is typed now.
  const reason: CloseReasonHolder | null = isCloseTriageAction(action) ? { value: '' } : null;
  const run = async () => {
    const token = getMutationToken();
    if (!token) throw new ApiError('Mutation token was rejected.', 401, request.path);
    await apiPost<unknown>(request.path, reason ? withCloseReason(request.body, reason.value) : request.body, token);
    touchMutationHold();
  };
  const mustConfirm = ALWAYS_CONFIRM.has(action.kind) || copy !== null;
  const bodyText = copy?.body ?? title;
  requestGuarded({
    title: copy?.title ?? action.label,
    body: reason ? closeReasonBody(bodyText, reason) : bodyText,
    confirmLabel: copy?.confirmLabel ?? action.label,
    destructive: action.destructive,
    token: true,
    tokenReason: `${action.label} changes state on this machine and requires the dispatch token.`,
    skipConfirm: !mustConfirm,
    run,
    onDone: () => {
      afterSuccess(item);
      ctx.toast(`${action.label}: ${title}`, 'success');
    },
    onError: mustConfirm ? undefined : (message) => ctx.toast(message, 'danger'),
  });
}

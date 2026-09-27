/**
 * routes/verse/shell/close-reason.tsx — the optional "why" on a single
 * Needs-you Close (3.15).
 *
 * Closing a cloud or Devin PR from Needs-you used to record only "Closed in
 * Verse without landing.", which the retro sweep rightly treats as no lesson.
 * The Close confirmation now carries one short, optional line; the server
 * (core/cloud/cloud-api.ts parseCloudPrCloseBody → pr-actions.ts closeCloudPr)
 * stores it as `Closed in Verse: <reason>`, puts it in the GitHub close
 * comment, and the next retro learns from it.
 *
 * Deliberately small: one labelled field inside the existing confirm dialog
 * (guarded-action.tsx renders `body` as a ReactNode), optional, single line,
 * capped at the server's limit. The confirm button keeps the initial focus,
 * so Close → Enter still closes without a reason; batch Close (cloud-triage.ts
 * runBatch) sends none. The field is uncontrolled from the dialog's point of
 * view: it writes into a holder the action's `run` reads at click time, so a
 * retry after an error re-sends what is typed now.
 */
import { useState, type ReactNode } from 'react';
import type { NeedsYouAction } from '../../../../core/verse/workbench-types.js';
import { Input } from '../../../components/primitives/Input.js';

/** Mirrors core/cloud/pr-actions.ts CLOUD_CLOSE_REASON_MAX (that module is server-only). */
export const CLOSE_REASON_MAX = 200;

/** `/api/verse/cloud/tasks/<id>/close` or `/api/verse/devin/tasks/<id>/close` — the only routes that take a reason. */
const CLOSE_ROUTE_RE = /^\/api\/verse\/(?:cloud|devin)\/tasks\/[^/]+\/close$/;

/** A cloud or Devin PR's Close (cloud-api.ts triageActions), pinned to a head commit. */
export function isCloseTriageAction(action: Pick<NeedsYouAction, 'kind' | 'request'>): boolean {
  const request = action.request;
  return action.kind === 'reject'
    && request !== null
    && request.method === 'POST'
    && CLOSE_ROUTE_RE.test(request.path)
    && typeof request.body['headSha'] === 'string';
}

/**
 * The reason as the server will accept it: one line, trimmed, at most
 * CLOSE_REASON_MAX characters; null when blank. (The server normalises and
 * secret-scrubs it again — this only keeps the request within its bounds.)
 */
export function cleanCloseReason(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.slice(0, CLOSE_REASON_MAX).trim() || null;
}

/** The close request's body, plus the reason when there is one (never an empty `reason` key). */
export function withCloseReason(body: Readonly<Record<string, unknown>>, text: string): Record<string, unknown> {
  const reason = cleanCloseReason(text);
  return reason ? { ...body, reason } : { ...body };
}

export interface CloseReasonHolder {
  value: string;
}

function CloseReasonField({ holder }: { holder: CloseReasonHolder }) {
  const [value, setValue] = useState(holder.value);
  return (
    <Input
      size="sm"
      label="Why? (optional)"
      hint="Saved on the task and in the GitHub comment, so the next attempt learns from it."
      value={value}
      maxLength={CLOSE_REASON_MAX}
      autoComplete="off"
      spellCheck
      onChange={(event) => {
        setValue(event.target.value);
        holder.value = event.target.value;
      }}
    />
  );
}

/** The confirm body for a Close: the item's own sentence, then the reason field. */
export function closeReasonBody(text: ReactNode, holder: CloseReasonHolder): ReactNode {
  return (
    <>
      <p style={{ margin: '0 0 var(--space-3)' }}>{text}</p>
      <CloseReasonField holder={holder} />
    </>
  );
}

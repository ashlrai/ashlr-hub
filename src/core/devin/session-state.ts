/** Pure provider session facts → local bookkeeping state; no storage, clock or provider effects. */
import type { DevinSession } from './client.js';
import type { DevinTaskState, DevinTaskV1 } from './types.js';

const WAITING_DETAILS = new Set(['waiting_for_user', 'waiting_for_approval']);
const SUSPEND_REASONS: Readonly<Record<string, string>> = {
  inactivity: 'Devin went to sleep after a quiet spell. Reply to wake it.',
  user_request: 'The session was paused from Devin. Reply to resume it.',
  usage_limit_exceeded: 'Devin stopped: a usage limit was reached.',
  out_of_credits: 'Devin stopped: the account is out of credits.',
  out_of_quota: 'Devin stopped: the plan quota is used up.',
  no_quota_allocation: 'Devin stopped: this user has no quota allocation.',
  payment_declined: 'Devin stopped: a payment was declined.',
  org_usage_limit_exceeded: "Devin stopped: the organization's usage limit was reached.",
  user_usage_limit_exceeded: "Devin stopped: this user's usage limit was reached.",
  total_session_limit_exceeded: 'Devin stopped: the session hit its ACU cap.',
  contract_expired: 'Devin stopped: the contract has expired.',
  error: 'Devin suspended the session after an error.',
};

/** Session facts → the state the task would have with no PR. Null: leave the state alone. */
export function stateFromSession(task: DevinTaskV1, session: DevinSession): { state: DevinTaskState; reason: string; failure: DevinTaskV1['failure'] } | null {
  const detail = session.statusDetail ?? '';
  switch (session.status) {
    case 'new':
    case 'claimed':
    case 'resuming':
      return { state: 'running', reason: 'Devin is starting up.', failure: null };
    case 'running':
      if (WAITING_DETAILS.has(detail)) {
        return {
          state: 'blocked',
          reason: detail === 'waiting_for_approval' ? 'Devin is waiting for an approval in the session.' : 'Devin is waiting for your reply.',
          failure: null,
        };
      }
      if (detail === 'finished') {
        return { state: 'expired', reason: `Devin finished; no pull request on ${task.branch} has been verified yet. The session link still works.`, failure: null };
      }
      return { state: 'running', reason: 'Devin is working. Its pull request will appear here.', failure: null };
    case 'suspended':
      return { state: 'blocked', reason: Object.hasOwn(SUSPEND_REASONS, detail) ? SUSPEND_REASONS[detail]! : 'Devin paused the session.', failure: null };
    case 'exit':
      return { state: 'expired', reason: `Devin finished; no pull request on ${task.branch} has been verified yet. The session link still works.`, failure: null };
    case 'error':
      return { state: 'failed', reason: 'The Devin session ended in an error.', failure: 'session-error' };
    default:
      return null;
  }
}

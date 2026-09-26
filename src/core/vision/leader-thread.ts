/**
 * STUB — REPLACE WITH THE REAL MODULE.
 *
 * The Leader thread (Mason ↔ Leader conversation store) is implemented by the
 * vision/core work stream in parallel. This file exists only so the comms
 * layer (src/core/comms/telegram-channel.ts) type-checks and runs against the
 * agreed contract before that module lands on master. When the real
 * src/core/vision/leader-thread.ts lands, take ITS version wholesale and
 * delete this one — nothing in comms depends on anything here beyond the
 * exported signatures below.
 *
 * Behaviour of the stub is deliberately inert and safe:
 *   - pendingOutbound() returns nothing, markDelivered() is a no-op;
 *   - appendMasonMessage()/answerLeaderQuestion() record nothing and return
 *     reply:null (comms then acknowledges Mason's message honestly);
 *   - approveLeaderAction() refuses (ok:false) — it never raises autonomy.
 */

export type LeaderThreadChannel = 'telegram' | 'verse' | 'cli';

export interface LeaderThreadMessage {
  id: string;
  at: string;
  from: 'mason' | 'leader';
  channel: LeaderThreadChannel | string;
  kind: 'message' | 'question' | 'answer' | 'memo' | 'directive' | 'update' | 'action';
  text: string;
  replyTo?: string;
  memoId?: string;
  questionId?: string;
  actionIds?: string[];
  delivery?: Record<string, unknown>;
}

export interface AppendMasonMessageResult {
  message: LeaderThreadMessage;
  reply: LeaderThreadMessage | null;
  directive?: unknown;
}

export interface LeaderApproveResult {
  ok: boolean;
  message: string;
}

function stubMessage(text: string, channel: string, replyTo?: string): LeaderThreadMessage {
  return {
    id: `lt-stub-${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    from: 'mason',
    channel,
    kind: 'message',
    text,
    ...(replyTo ? { replyTo } : {}),
  };
}

export async function appendMasonMessage(
  text: string,
  opts: { channel: LeaderThreadChannel; replyTo?: string },
): Promise<AppendMasonMessageResult> {
  return { message: stubMessage(text, opts.channel, opts.replyTo), reply: null };
}

export async function answerLeaderQuestion(
  questionId: string,
  text: string,
  opts: { channel: LeaderThreadChannel },
): Promise<{ message: LeaderThreadMessage; reply: LeaderThreadMessage | null }> {
  return { message: { ...stubMessage(text, opts.channel), kind: 'answer', questionId }, reply: null };
}

export async function approveLeaderAction(
  _actionId: string,
  _opts: { channel: LeaderThreadChannel },
): Promise<LeaderApproveResult> {
  return { ok: false, message: 'Approving Leader actions from a message is not available in this build.' };
}

export function pendingOutbound(_channel: LeaderThreadChannel): LeaderThreadMessage[] {
  return [];
}

export function markDelivered(_id: string, _channel: LeaderThreadChannel, _ok: boolean): void {
  // no-op in the stub
}

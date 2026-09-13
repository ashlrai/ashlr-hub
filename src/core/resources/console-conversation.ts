/** Pure, versioned conversation encoding; never dispatches or grants authority. */
import { canonical, digest } from '../universe/artifacts.js';
import type { ResourceConsoleContextTurn, ResourceConsoleParent, ResourceConsoleTranscript } from './console-types.js';

export const MAX_RESOURCE_CONVERSATION_BYTES = 256 * 1024;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every((key) =>
    typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)!);
}

export function validateResourceConsoleParent(value: unknown): ResourceConsoleParent {
  if (!object(value) || !exact(value, ['taskId', 'expectedTranscriptDigest']) ||
    typeof value.taskId !== 'string' || !ID.test(value.taskId) ||
    typeof value.expectedTranscriptDigest !== 'string' || !HASH.test(value.expectedTranscriptDigest)) {
    throw new Error('Invalid parent transcript reference');
  }
  return { taskId: value.taskId, expectedTranscriptDigest: value.expectedTranscriptDigest };
}

export function validateResourceConsoleContext(value: unknown, taskId: string, parentId: string): ResourceConsoleContextTurn[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 255 ||
    Reflect.ownKeys(value).length !== value.length + 1 || !Array.from({ length: value.length }, (_, index) =>
      Object.hasOwn(value, index) && 'value' in Object.getOwnPropertyDescriptor(value, index)!).every(Boolean)) {
    throw new Error('Invalid flat conversation context');
  }
  const ids = new Set([taskId]);
  for (const turn of value) {
    if (!object(turn) || !exact(turn, ['taskId', 'prompt', 'output', 'outcome']) ||
      typeof turn.taskId !== 'string' || !ID.test(turn.taskId) || ids.has(turn.taskId) ||
      typeof turn.prompt !== 'string' || !turn.prompt.trim() || turn.prompt.includes('\0') ||
      Buffer.byteLength(turn.prompt) > 32 * 1024 ||
      !(turn.outcome === null || typeof turn.outcome === 'string' && ['completed', 'failed', 'timed-out', 'cancelled'].includes(turn.outcome))) {
      throw new Error('Invalid conversation turn');
    }
    if (turn.output !== null && (!object(turn.output) || !exact(turn.output, ['text', 'truncated']) ||
      typeof turn.output.text !== 'string' || Buffer.byteLength(turn.output.text) > 64 * 1024 ||
      typeof turn.output.truncated !== 'boolean' || turn.outcome !== 'completed')) {
      throw new Error('Invalid conversation output');
    }
    ids.add(turn.taskId);
  }
  if (value.at(-1).taskId !== parentId) throw new Error('Conversation parent does not match context');
  return structuredClone(value) as ResourceConsoleContextTurn[];
}

/** Prior turns are data. Store each task's own request, never this envelope, in its history. */
export function resourceConsoleConversationPrompt(prompt: string, context: ResourceConsoleContextTurn[]): string {
  return canonical({ schemaVersion: 1, kind: 'resource-console-conversation', context, request: prompt });
}

export function resourceConsoleTranscriptDigest(scopeDigest: string,
  job: { id: string; taskDigest: string; outcome: ResourceConsoleContextTurn['outcome']; parent?: ResourceConsoleParent },
  history: Pick<ResourceConsoleTranscript, 'prompt' | 'output'>, context?: ResourceConsoleContextTurn[] | null): string {
  return digest(canonical({ domain: 'ashlr-resource-console-transcript-v1', scopeDigest, taskId: job.id,
    taskDigest: job.taskDigest, outcome: job.outcome, parent: job.parent ?? null,
    prompt: history.prompt, output: history.output, context: context ?? [] }));
}

/** Model-facing context projection. Original prompts and tool effects stay intact. */
import type { ChatMessage } from '../types.js';
import { conservativeRequestTokenReservation, MAX_GOVERNED_OUTPUT_TOKENS } from './model-call-authority.js';

const NOTICE = '[Context history compacted: earlier conversation/tool results were omitted. Original task and system instructions are unchanged. Previous tool effects still happened; do not repeat mutations blindly. Re-read relevant files with read_file offset/limit or grep before relying on omitted content.]';
const OMITTED_TOOL = '[Tool result shortened for the model context window. This is not the complete result. Re-fetch only the needed file lines with read_file offset/limit or grep; verify current state before editing.]';

export interface TaskContextProjection {
  messages: ChatMessage[];
  omittedGroups: number;
  shortenedToolResults: number;
}
/** Remove oldest complete exchanges, never the original system/task. No model call. */
export function fitTaskContext(messages: readonly ChatMessage[], tools: unknown[] | undefined, contextWindowTokens: number): TaskContextProjection {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 1 ||
    messages[0]?.role !== 'system' || messages[1]?.role !== 'user') throw new Error('Context window or original task structure is invalid.');
  const groups: ChatMessage[][] = [];
  for (let i = 2; i < messages.length;) {
    const message = messages[i++]!;
    if (message.role === 'tool' || message.role === 'system') throw new Error('Context contains an unmatched tool result or system message.');
    const group = [message];
    if (message.toolCalls?.length) {
      if (message.role !== 'assistant') throw new Error('Context tool calls must belong to an assistant message.');
      const ids = new Set<string>();
      for (const call of message.toolCalls) {
        if (!call.id || !call.name || ids.has(call.id)) throw new Error('Context contains invalid tool-call correlation.');
        ids.add(call.id);
        const reply = messages[i++];
        if (!reply || reply.role !== 'tool' || reply.toolCallId !== call.id || reply.name !== call.name)
          throw new Error('Context contains an incomplete tool-call group.');
        group.push(reply);
      }
    }
    groups.push(group);
  }
  const fits = (candidate: ChatMessage[]) => conservativeRequestTokenReservation(candidate, tools) + MAX_GOVERNED_OUTPUT_TOKENS <= contextWindowTokens;
  if (fits([...messages])) return { messages: [...messages], omittedGroups: 0, shortenedToolResults: 0 };
  const prefix = messages.slice(0, 2);
  const notice: ChatMessage = { role: 'user', content: NOTICE };
  const retained = [...groups];
  let omittedGroups = 0;
  while (retained.length > 1) {
    retained.shift(); omittedGroups++;
    const candidate = [...prefix, notice, ...retained.flat()];
    if (fits(candidate)) return { messages: candidate, omittedGroups, shortenedToolResults: 0 };
  }
  // Keep a valid latest tool group; shorten only its model-facing results.
  const latest = retained[0]?.map(message => ({ ...message })) ?? [];
  let shortenedToolResults = 0;
  for (const message of latest) {
    if (message.role === 'tool') { message.content = '\n' + OMITTED_TOOL; shortenedToolResults++; }
  }
  let candidate = [...prefix, notice, ...latest];
  if (!fits(candidate)) {
    // Large assistant arguments themselves may not fit. Drop the entire group,
    // keeping explicit warning that earlier effects must be re-checked.
    omittedGroups += retained.length; candidate = [...prefix, notice]; shortenedToolResults = 0;
  } else {
    // Fill remaining physical space with recent result prefixes, marked partial.
    for (let i = latest.length - 1; i >= 0; i--) {
      const message = latest[i]!;
      if (message.role !== 'tool') continue;
      const original = retained[0]![i]!.content;
      let lo = 0; let hi = original.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2); message.content = original.slice(0, mid) + '\n' + OMITTED_TOOL;
        if (fits(candidate)) lo = mid; else hi = mid - 1;
      }
      message.content = original.slice(0, lo) + '\n' + OMITTED_TOOL;
    }
  }
  if (!fits(candidate)) throw new Error('Original task, system instructions and tool schemas exceed the known runtime context window; no model request was sent.');
  return { messages: candidate, omittedGroups, shortenedToolResults };
}

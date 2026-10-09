import { createHash, randomUUID } from 'node:crypto';
import type { AshlrConfig, ChatMessage, ChatResult, ModelCallLimits, ProviderClient, ApiBillingSummary } from '../types.js';
import type { ClaudeApiGrantAdmission, ClaudeApiGrantBinding, ClaudeApiGrantReservation, ReadFreshClaudeApiGrantProof } from '../resources/claude-api-grant-types.js';
import { createClaudeApiGrantAdmission, reserveClaudeApiGrantRequest, markClaudeApiGrantRequestSent, releaseClaudeApiGrantBeforeContact, retainClaudeApiGrantUnknown, settleClaudeApiGrantRequest } from '../resources/claude-api-grant.js';
import { resolveProviderKey } from '../integrations/secrets.js';
import { assertPermitted, cloudSubjectPermitted } from '../policy/local-only.js';
import { ENFORCED_PROVIDER_AUTHORITY, MAX_GOVERNED_OUTPUT_TOKENS } from './model-call-authority.js';

/** Internal host binding, never an HTTP/CLI DTO or a serialized admission. */
export interface ClaudeApiExecutionBinding {
  readonly ledgerRoot: string;
  readonly admission: ClaudeApiGrantAdmission;
  readonly expectedBinding: ClaudeApiGrantBinding;
  readonly readFreshProof: ReadFreshClaudeApiGrantProof;
}

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
// Reserve the entire supported context, not an optimistic tokenizer estimate.
// Payload is text/client tools only, <=64KiB, with no caching or paid server tools.
// Standard global first-party Messages prices, independently verified 2026-10-09:
// https://platform.claude.com/docs/en/about-claude/pricing
// Integers are microUSD per token (equivalent to USD per million tokens).
const PRICES: Readonly<Record<string, { input: bigint; output: bigint; maxInputTokens: number }>> = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({ input: 3n, output: 15n, maxInputTokens: 1_000_000 }),
  'claude-opus-4-8': Object.freeze({ input: 5n, output: 25n, maxInputTokens: 1_000_000 }),
  'claude-haiku-4-5-20251001': Object.freeze({ input: 1n, output: 5n, maxInputTokens: 200_000 }),
});
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function refuse(reason: string): never { throw new ClaudeApiRequestError(reason, false); }

/** Closed diagnostics: provider bodies, keys, prompts and transport errors never escape. */
export class ClaudeApiRequestError extends Error {
  readonly usageKnown: boolean;
  readonly usage?: { tokensIn: number; tokensOut: number };
  constructor(reason: string, contacted: boolean) {
    super(`Claude API held: ${reason}`);
    this.name = 'ClaudeApiRequestError';
    this.usageKnown = !contacted;
    if (!contacted) this.usage = { tokensIn: 0, tokensOut: 0 };
  }
}

function requestBody(model: string, messages: ChatMessage[], tools: unknown[] | undefined, limits: ModelCallLimits | undefined): { body: string; names: Set<string>; replayIds: Set<string>; maxOutput: number } {
  if (!limits || !integer(limits.maxOutputTokens) || limits.maxOutputTokens < 1 || limits.maxOutputTokens > MAX_GOVERNED_OUTPUT_TOKENS) refuse('output-limit-required');
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 128 || (tools?.length ?? 0) > 64) refuse('request-invalid');
  const names = new Set<string>();
  const definitions = (tools ?? []).map(tool => {
    if (!record(tool) || tool.type !== 'function' || !record(tool.function)) refuse('tool-unsupported');
    const fn = tool.function;
    if (typeof fn.name !== 'string' || !NAME.test(fn.name) || names.has(fn.name) || !record(fn.parameters) || (fn.description !== undefined && typeof fn.description !== 'string')) refuse('tool-unsupported');
    names.add(fn.name);
    return { name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), input_schema: fn.parameters };
  });
  const system: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  const outstanding = new Set<string>();
  const replayIds = new Set<string>();
  for (const message of messages) {
    if (!record(message) || typeof message.content !== 'string') refuse('request-invalid');
    if (message.role === 'system') {
      if (turns.length || message.toolCalls || message.toolCallId) refuse('request-invalid');
      system.push(message.content); continue;
    }
    const blocks: unknown[] = [];
    let role: 'user' | 'assistant';
    if (message.role === 'tool') {
      if (typeof message.toolCallId !== 'string' || !outstanding.delete(message.toolCallId) || message.toolCalls) refuse('tool-replay-invalid');
      role = 'user'; blocks.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content });
    } else {
      if ((message.role !== 'user' && message.role !== 'assistant') || outstanding.size) refuse('tool-replay-invalid');
      role = message.role;
      if (message.content) blocks.push({ type: 'text', text: message.content });
      if (message.toolCalls?.length) {
        if (role !== 'assistant' || message.toolCalls.length > 64) refuse('tool-replay-invalid');
        for (const call of message.toolCalls) {
          if (!record(call) || typeof call.id !== 'string' || !ID.test(call.id) || replayIds.has(call.id) || !names.has(call.name) || !record(call.arguments)) refuse('tool-replay-invalid');
          replayIds.add(call.id);
          outstanding.add(call.id); blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
        }
      }
    }
    if (!blocks.length) refuse('request-invalid');
    const previous = turns.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else turns.push({ role, content: blocks });
  }
  if (!turns.length || turns[0].role !== 'user' || turns.at(-1)?.role !== 'user' || outstanding.size) refuse('tool-replay-invalid');
  let body: string;
  try { body = JSON.stringify({ model, max_tokens: limits.maxOutputTokens, messages: turns, ...(system.length ? { system: system.join('\n\n') } : {}), ...(definitions.length ? { tools: definitions } : {}), service_tier: 'standard_only', inference_geo: 'global', stream: false }); }
  catch { refuse('request-invalid'); }
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) refuse('request-too-large');
  return { body, names, replayIds, maxOutput: limits.maxOutputTokens };
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || response.redirected || !response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(next.value);
    }
    if (signal.aborted) throw new Error();
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    // Never wait on a misbehaving transport's cancellation during failure cleanup.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseResponse(value: unknown, model: string, names: Set<string>, replayIds: Set<string>, maxOutput: number, maxInput: number): Omit<ChatResult, 'billing'> & { requestId: string } {
  if (!record(value) || value.type !== 'message' || value.role !== 'assistant' || value.model !== model || typeof value.id !== 'string' || !/^msg_[A-Za-z0-9_-]{1,120}$/.test(value.id) || !Array.isArray(value.content) || value.content.length > 64 || !['end_turn', 'tool_use'].includes(value.stop_reason as string) || value.stop_sequence != null || value.container != null) throw new Error();
  const usage = value.usage;
  if (!record(usage) || !integer(usage.input_tokens) || usage.input_tokens > maxInput || !integer(usage.output_tokens) || usage.output_tokens > maxOutput) throw new Error();
  const allowedUsage = new Set(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'cache_creation', 'server_tool_use', 'service_tier', 'inference_geo', 'output_tokens_details']);
  if (Object.keys(usage).some(key => !allowedUsage.has(key)) || (usage.service_tier !== undefined && usage.service_tier !== 'standard') || (usage.inference_geo !== undefined && usage.inference_geo !== 'global')) throw new Error();
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens']) if (usage[key] !== undefined && usage[key] !== 0) throw new Error();
  for (const [key, allowed] of [
    ['cache_creation', ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']],
    ['server_tool_use', ['web_search_requests', 'web_fetch_requests']],
    ['output_tokens_details', ['thinking_tokens']],
  ] as const) {
    const part = usage[key];
    if (part !== undefined && (!record(part) || Object.keys(part).some(field => !(allowed as readonly string[]).includes(field) || part[field] !== 0))) throw new Error();
  }
  const texts: string[] = []; const calls: NonNullable<ChatResult['toolCalls']> = []; const ids = new Set<string>();
  for (const block of value.content) {
    if (!record(block)) throw new Error();
    if (block.type === 'text' && typeof block.text === 'string' && Object.keys(block).every(key => ['type', 'text'].includes(key))) texts.push(block.text);
    else if (block.type === 'tool_use' && typeof block.id === 'string' && ID.test(block.id) && typeof block.name === 'string' && names.has(block.name) && record(block.input) && !ids.has(block.id) && !replayIds.has(block.id) && Object.keys(block).every(key => ['type', 'id', 'name', 'input'].includes(key))) {
      ids.add(block.id); calls.push({ id: block.id, name: block.name, arguments: block.input });
    } else throw new Error();
  }
  if ((value.stop_reason === 'tool_use') !== (calls.length > 0) || (!texts.length && !calls.length)) throw new Error();
  return { content: texts.join(''), ...(calls.length ? { toolCalls: calls } : {}), usage: { tokensIn: usage.input_tokens, tokensOut: usage.output_tokens }, usageKnown: true, requestId: value.id };
}

/** Fixed first-party transport, one contact per call. No streaming retry or endpoint override. */
export function buildAnthropicMessagesClient(cfg: AshlrConfig, model: string, binding: ClaudeApiExecutionBinding, hooks?: { beforeRequest?: () => void; onRequestStart?: () => void }): ProviderClient {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) refuse('pricing-unknown');
  if (!cfg.foundry?.allowedBackends?.includes('claude-api')) refuse('engine-disabled');
  assertPermitted(cloudSubjectPermitted('provider', 'anthropic', cfg));
  if (!binding || !HASH.test(binding.expectedBinding?.credentialDigest ?? '') || typeof binding.readFreshProof !== 'function') refuse('proof-missing');
  const host = Object.freeze({ ...binding, expectedBinding: Object.freeze({ ...binding.expectedBinding }) });
  const pricingDigest = createHash('sha256').update(JSON.stringify({ v: 1, model, serviceTier: 'standard', geography: 'global', input: price.input.toString(), output: price.output.toString(), maxInputTokens: price.maxInputTokens, maxRequestBytes: MAX_REQUEST_BYTES, cache: 'unsupported', source: 'anthropic-pricing/2026-10-09' })).digest('hex');
  let settled = 0n; let unknown = 0n; let settledRequests = 0; let unknownRequests = 0;
  const summary = (): ApiBillingSummary => ({ provider: 'anthropic', settledUsdMicros: settled.toString(), unknownExposureUsdMicros: unknown.toString(), settledRequests, unknownRequests });
  return {
    id: 'claude-api', model, supportsTools: true, authority: ENFORCED_PROVIDER_AUTHORITY,
    getContextWindowTokens: async () => price.maxInputTokens,
    getApiBillingSummary: summary,
    async chat(messages, tools, signal, limits) {
      const request = requestBody(model, messages, tools, limits);
      if (signal?.aborted) refuse('cancelled-before-contact');
      assertPermitted(cloudSubjectPermitted('provider', 'anthropic', cfg));
      if (!cfg.foundry?.allowedBackends?.includes('claude-api')) refuse('engine-disabled');
      // Validate the key's expected scope against the same trusted fresh reader.
      // A copied admission still fails reserve, and a different expected key
      // cannot borrow an admission minted for another credential generation.
      const checkedBinding = createClaudeApiGrantAdmission({ readFreshProof: host.readFreshProof, expectedBinding: host.expectedBinding });
      if (!checkedBinding.ok) refuse(checkedBinding.reason);
      const maxCost = BigInt(price.maxInputTokens) * price.input + BigInt(request.maxOutput) * price.output;
      const reserved = reserveClaudeApiGrantRequest({ root: host.ledgerRoot, admission: host.admission, requestId: `messages-${randomUUID()}`, maxUsdMicros: maxCost.toString(), pricingDigest, readFreshProof: host.readFreshProof });
      if (!reserved.ok) refuse(reserved.reason);
      const reservation: ClaudeApiGrantReservation = reserved.value;
      let sent = false; let accounted = false;
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const key = resolveProviderKey('ANTHROPIC_API_KEY', cfg)?.trim();
        if (!key || createHash('sha256').update(key).digest('hex') !== host.expectedBinding.credentialDigest) refuse('credential-binding-changed');
        if (signal?.aborted || controller.signal.aborted) refuse('cancelled-before-contact');
        hooks?.beforeRequest?.();
        if (signal?.aborted || controller.signal.aborted) refuse('cancelled-before-contact');
        const marked = markClaudeApiGrantRequestSent(reservation);
        if (!marked.ok) refuse(marked.reason);
        sent = true;
        const contacted = fetch(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: request.body });
        // The notification can throw after contact. Attach rejection handling
        // before invoking it so cleanup never leaves an unhandled fetch promise.
        void contacted.catch(() => {});
        hooks?.onRequestStart?.();
        const response = await contacted;
        const parsed = parseResponse(await readResponse(response, controller.signal), model, request.names, request.replayIds, request.maxOutput, price.maxInputTokens);
        const actual = BigInt(parsed.usage.tokensIn) * price.input + BigInt(parsed.usage.tokensOut) * price.output;
        const result = settleClaudeApiGrantRequest(reservation, parsed.requestId, actual.toString());
        if (!result.ok) throw new Error();
        accounted = true; settled += actual; settledRequests++;
        const { requestId, ...chat } = parsed;
        return { ...chat, billing: { provider: 'anthropic', requestId, model, pricingDigest, serviceTier: 'standard', inputTokens: parsed.usage.tokensIn, outputTokens: parsed.usage.tokensOut, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, actualUsdMicros: actual.toString() } };
      } catch (error) {
        controller.abort();
        if (sent && !accounted) { retainClaudeApiGrantUnknown(reservation); unknown += maxCost; unknownRequests++; }
        if (!sent) releaseClaudeApiGrantBeforeContact(reservation);
        if (!sent && error instanceof ClaudeApiRequestError) throw error;
        throw new ClaudeApiRequestError(sent ? 'contact-unconfirmed' : 'admission-refused', sent);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    // Deliberately absent chatStream: existing agent-loop emits only a complete
    // final response, with no second request after partial/ambiguous contact.
  };
}

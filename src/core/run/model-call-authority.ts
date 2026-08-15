import type { ChatMessage, ProviderClient, ProviderClientAuthority } from '../types.js';

/** Maximum output reservation granted to one governed provider request. */
export const MAX_GOVERNED_OUTPUT_TOKENS = 4_096;

/** Capability declaration used by adapters that enforce limits and exact usage. */
export const ENFORCED_PROVIDER_AUTHORITY: ProviderClientAuthority = Object.freeze({
  requestLimits: 'enforced',
  usageAccounting: 'exact-provider-counters',
});

/**
 * Conservative reservation for serialized request input.
 *
 * This is deliberately a reservation, not a claim about the provider's exact
 * tokenizer. UTF-8 bytes upper-bound ordinary encoded content tokens and the
 * fixed/per-record allowance covers chat-template framing not present in JSON.
 */
export function conservativeRequestTokenReservation(
  messages: ChatMessage[],
  tools?: unknown[],
): number {
  const serializedBytes = Buffer.byteLength(JSON.stringify({ messages, tools: tools ?? [] }), 'utf8');
  return serializedBytes + 256 + (messages.length * 16) + ((tools?.length ?? 0) * 32);
}

/** True only for clients that explicitly opt into both governed guarantees. */
export function supportsGovernedModelCalls(client: ProviderClient): boolean {
  return client.authority?.requestLimits === 'enforced'
    && client.authority.usageAccounting === 'exact-provider-counters';
}

import type { ProviderClient } from '../types.js';

/** Caller-owned outcome revision fence. Never persisted or sent to a provider. */
export class SelectedOutcomeAdmissionRefusal extends Error {
  /** Known no-contact accounting; not a provider-reported usage sample. */
  readonly usageKnown: boolean;
  readonly usage?: { tokensIn: number; tokensOut: number };
  constructor(contactMayHaveOccurred = false) {
    super('Selected outcome is no longer current; execution cancelled.');
    this.name = 'SelectedOutcomeAdmissionRefusal';
    this.usageKnown = !contactMayHaveOccurred;
    if (!contactMayHaveOccurred) this.usage = { tokensIn: 0, tokensOut: 0 };
  }
}

export function selectedOutcomeAdmissionCurrent(admission?: () => boolean): boolean {
  if (admission === undefined) return true;
  try { return admission() === true; } catch { return false; }
}

export function assertSelectedOutcomeAdmission(admission?: () => boolean): void {
  if (!selectedOutcomeAdmissionCurrent(admission)) throw new SelectedOutcomeAdmissionRefusal();
}

/** Preserve client identity when absent; recheck every direct/stream/fallback contact. */
export function withSelectedOutcomeAdmission(client: ProviderClient, admission?: () => boolean): ProviderClient {
  if (admission === undefined) return client;
  const prototype = Object.getPrototypeOf(client);
  const plainReceiver = prototype === Object.prototype || prototype === null;
  const guarded: ProviderClient = {
    ...client,
    id: client.id,
    supportsTools: client.supportsTools,
    ...(client.model !== undefined ? { model: client.model } : {}),
    ...(client.authority !== undefined ? { authority: client.authority } : {}),
    chat: async (...args) => {
      assertSelectedOutcomeAdmission(admission);
      return client.chat.call(plainReceiver ? guarded : client, ...args);
    },
  };
  if (client.getContextWindowTokens) guarded.getContextWindowTokens = client.getContextWindowTokens.bind(client);
  if (client.chatStream) {
    guarded.chatStream = async (...args) => {
      assertSelectedOutcomeAdmission(admission);
      // A failed stream may already have contacted the provider. A cancelled
      // fallback proves no SECOND request, not zero usage for the first one.
      // This receiver is per invocation, so parallel tasks cannot mix evidence.
      const streamReceiver: ProviderClient = {
        ...guarded,
        chat: async (...fallbackArgs) => {
          if (!selectedOutcomeAdmissionCurrent(admission)) throw new SelectedOutcomeAdmissionRefusal(true);
          return client.chat.call(streamReceiver, ...fallbackArgs);
        },
      };
      // Shipped plain-object clients use this.chat for streaming fallback.
      // Opaque adapters keep their original receiver/private fields. Their
      // hidden retries require an adapter-owned request hook to fence.
      return client.chatStream!.call(plainReceiver ? streamReceiver : client, ...args);
    };
  }
  return guarded;
}

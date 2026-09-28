import type { VerseTerminalAssistMode } from '../../../data/api-types.js';

/** Shown before the request is sent from either terminal command entry point. */
export function assistDisclosure(mode: VerseTerminalAssistMode): string {
  if (mode === 'auto') {
    return 'Local model first. If it is unavailable, your request, current folder, and recent command/output may be sent to Grok.';
  }
  if (mode === 'off') return 'Plain-English commands are off.';
  return 'Your request, current folder, and recent command/output go only to the configured local model.';
}

export function assistLoadingLabel(mode: VerseTerminalAssistMode): string {
  return mode === 'auto' ? 'Asking the local model; Grok may answer if it is unavailable…' : 'Asking the local model…';
}

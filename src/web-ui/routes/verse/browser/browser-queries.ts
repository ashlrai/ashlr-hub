/**
 * routes/verse/browser/browser-queries.ts — the Browser pane's calls to the
 * sidecar (core/verse/browser-api.ts). Same conventions as the composer's:
 * writes pull the held mutation token and throw `VerseMutationLockedError`
 * when none is held; reads carry the read-client proof.
 *
 * Everything is injectable (`BrowserApi`) so the panel's tests run on fakes.
 */
import { getMutationToken, hasMutationHold, touchMutationHold } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import {
  VERSE_BROWSER_ACCESS_PATH,
  VERSE_BROWSER_ALLOWANCE_PATH,
  VERSE_BROWSER_ALLOW_PATH,
  VERSE_BROWSER_COMMANDS_PATH,
  VERSE_BROWSER_POLICY_PATH,
  VERSE_BROWSER_RESULT_PATH,
  type VerseBrowserCommandResult,
  type VerseBrowserCommandsResponse,
  type VerseBrowserPolicy,
  type VerseBrowserScope,
} from '../../../../core/verse/browser-types.js';
import type { VersePreviewTargetsResponse } from '../../../../core/verse/workbench-types.js';
import { VERSE_PREVIEW_TARGETS_PATH } from '../../../../core/verse/workbench-types.js';
import type { VerseAttachment, VerseAttachmentUpload } from '../../../../core/verse/workbench-types.js';
import { uploadAttachment } from '../composer/composer-queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export interface BrowserApi {
  policy(sessionId: string, signal?: AbortSignal): Promise<VerseBrowserPolicy>;
  /** Switch agent access (scope `browser`, the whole grant) or one of its parts. */
  setAccess(sessionId: string, enabled: boolean, scope?: VerseBrowserScope): Promise<VerseBrowserPolicy>;
  /** Forget one "Allow for this chat" answer. */
  revokeAllowance(sessionId: string, key: string): Promise<VerseBrowserPolicy>;
  allowOrigin(sessionId: string, origin: string, allowed: boolean): Promise<VerseBrowserPolicy>;
  /** The long-poll. Resolves [] after the server's wait. */
  commands(sessionId: string, signal?: AbortSignal): Promise<VerseBrowserCommandsResponse>;
  result(sessionId: string, result: VerseBrowserCommandResult): Promise<void>;
  /** Dev servers found for the chat's folders (the Preview pane's discovery). */
  targets(sessionId: string, signal?: AbortSignal): Promise<VersePreviewTargetsResponse>;
  attach(sessionId: string, upload: VerseAttachmentUpload): Promise<VerseAttachment>;
  /** True when a mutation token is held (agent commands can be answered). */
  canWrite(): boolean;
}

const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token, signal);
  touchMutationHold();
  return result;
}

export const browserApi: BrowserApi = {
  policy: (sessionId, signal) => apiGet(`${VERSE_BROWSER_POLICY_PATH}?${q({ sessionId })}`, signal),
  setAccess: (sessionId, enabled, scope) => post(VERSE_BROWSER_ACCESS_PATH, { sessionId, enabled, ...(scope && scope !== 'browser' ? { scope } : {}) }),
  revokeAllowance: (sessionId, key) => post(VERSE_BROWSER_ALLOWANCE_PATH, { sessionId, key }),
  allowOrigin: (sessionId, origin, allowed) => post(VERSE_BROWSER_ALLOW_PATH, { sessionId, origin, allowed }),
  commands: (sessionId, signal) => apiGet(`${VERSE_BROWSER_COMMANDS_PATH}?${q({ sessionId })}`, signal),
  result: async (sessionId, result) => {
    await post(VERSE_BROWSER_RESULT_PATH, { sessionId, ...result });
  },
  targets: (sessionId, signal) => apiGet(`${VERSE_PREVIEW_TARGETS_PATH}?${q({ sessionId })}`, signal),
  attach: (sessionId, upload) => uploadAttachment(sessionId, upload),
  canWrite: () => hasMutationHold(),
};

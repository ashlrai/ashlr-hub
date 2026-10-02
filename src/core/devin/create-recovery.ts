/** Read-only ambiguous-create reconciliation. Never treats provider absence as zero spend. */
import type { DevinClient, DevinSession } from './client.js';
import { devinSessionTaskTag } from './service.js';
import { DEVIN_ORG_ID_PATTERN, type DevinTaskV1 } from './types.js';

export function hasAmbiguousDevinCreate(task: DevinTaskV1): boolean {
  return task.sessionId === null && task.session === null && (task.state === 'failed' || task.state === 'closed')
    && (task.failure === 'network' || task.failure === 'unparsed');
}

export type DevinCreateRecoveryPreview =
  | { kind: 'match'; session: DevinSession; launchAccountBound: boolean; pages: number }
  | { kind: 'held'; reason: 'not-ambiguous' | 'account-context' | 'incomplete' | 'duplicate-session' | 'cursor-loop' | 'multiple-matches' | 'no-match' | 'read-failed' | 'changed-match'; pages: number };

/**
 * A finite GET request budget, not a fleet/session ceiling. Reaching it is
 * incomplete evidence: retain exposure. Legacy records can be previewed under
 * today's organization but cannot be silently bound to it for settlement.
 */
export async function previewDevinCreateRecovery(
  task: DevinTaskV1,
  api: { client: Pick<DevinClient, 'listSessions' | 'getSession'>; orgId: string },
  options: { maxPages?: number } = {},
): Promise<DevinCreateRecoveryPreview> {
  let pages = 0;
  const held = (reason: Extract<DevinCreateRecoveryPreview, { kind: 'held' }>['reason']): DevinCreateRecoveryPreview => ({ kind: 'held', reason, pages });
  if (!hasAmbiguousDevinCreate(task)) return held('not-ambiguous');
  if (!DEVIN_ORG_ID_PATTERN.test(api.orgId) || (task.launchOrgId !== undefined && task.launchOrgId !== api.orgId)) return held('account-context');
  const maxPages = options.maxPages ?? 20;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) return held('incomplete');
  const tag = devinSessionTaskTag(task.id);
  const cursors = new Set<string>();
  const ids = new Set<string>();
  let match: DevinSession | null = null;
  let after: string | undefined;
  try {
    while (pages < maxPages) {
      const page = await api.client.listSessions(api.orgId, { first: 200, ...(after ? { after } : {}) });
      pages += 1;
      if (page.complete !== true) return held('incomplete');
      for (const session of page.items) {
        if (session.orgId !== api.orgId) return held('account-context');
        if (ids.has(session.sessionId)) return held('duplicate-session');
        ids.add(session.sessionId);
        if (session.tags.includes(tag)) {
          if (match) return held('multiple-matches');
          match = session;
        }
      }
      if (!page.hasNextPage) {
        if (!match) return held('no-match');
        const exact = await api.client.getSession(api.orgId, match.sessionId);
        if (exact.sessionId !== match.sessionId || exact.orgId !== api.orgId || !exact.tags.includes(tag)) return held('changed-match');
        return { kind: 'match', session: exact, launchAccountBound: task.launchOrgId === api.orgId, pages };
      }
      const cursor = page.endCursor;
      if (!cursor || cursor.length > 512) return held('incomplete');
      if (cursors.has(cursor)) return held('cursor-loop');
      cursors.add(cursor);
      after = cursor;
    }
    return held('incomplete');
  } catch {
    // Never expose provider bodies, auth headers or credentials in diagnostics.
    return held('read-failed');
  }
}

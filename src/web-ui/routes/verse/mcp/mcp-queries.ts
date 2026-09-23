/**
 * routes/verse/mcp/mcp-queries.ts — the reads and writes behind the MCP panel.
 *
 * Reads use the non-throwing `optionalGet` shape the Usage section
 * established: a server without these routes answers 404, and a 404 means
 * "this panel is degraded", not "Verse is broken". 401 still propagates,
 * because an expired read session is an unauthorized state for the whole
 * surface, not a degraded one.
 *
 * Writes pull the held mutation token from auth-store and touch the hold on
 * success, exactly like `autonomy/control-queries.ts`. There is one addition
 * this surface needs that the others do not: `applyMcpServer` CANNOT be
 * called without a digest that `proposeMcpServer` returned, because the
 * server refuses without it. That is deliberate and it is why there is no
 * single `installMcpServer()` helper here — a one-call install is exactly the
 * shape docs/VERSE-WORKSPACES.md §3 rules out, and it should be impossible to
 * write by accident at this layer too.
 */
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { invalidate } from '../../../data/cache.js';
import type { QueryDef } from '../../../data/queries.js';

export const MCP_SNAPSHOT_KEY = 'verse-mcp-snapshot';
export const MCP_CLI_HEALTH_KEY = 'verse-mcp-cli-health';

/** A read that is allowed to be absent. `raw` is null when it was. */
export interface OptionalRead {
  raw: unknown;
  available: boolean;
  reason: string | null;
}

function describeFailure(path: string, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) {
      return `This server does not expose ${path}, so this panel has no source.`;
    }
    return `${path} answered HTTP ${err.status}.`;
  }
  return `${path} could not be reached.`;
}

function optionalGet(path: string): (signal?: AbortSignal) => Promise<OptionalRead> {
  return async (signal) => {
    try {
      const raw = await apiGet<unknown>(path, signal);
      return { raw, available: true, reason: null };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) throw err;
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return { raw: null, available: false, reason: describeFailure(path, err) };
    }
  };
}

/** GET /api/verse/mcp — which servers each seat would load. */
export const mcpSnapshotQuery: QueryDef<OptionalRead> = {
  key: MCP_SNAPSHOT_KEY,
  fetch: optionalGet('/api/verse/mcp'),
};

/** GET /api/verse/mcp/cli-health — auth, plan and version drift per account. */
export const mcpCliHealthQuery: QueryDef<OptionalRead> = {
  key: MCP_CLI_HEALTH_KEY,
  fetch: optionalGet('/api/verse/mcp/cli-health'),
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export class McpLockedError extends Error {
  constructor() {
    super('Unlock actions with the mutation token before changing MCP configuration.');
    this.name = 'McpLockedError';
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new McpLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  return result;
}

/** The spec an operator typed. Env VALUES are real here and only here. */
export interface McpServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * POST /api/verse/mcp/proposal — validate and disclose. Writes nothing.
 *
 * The response carries the digest `applyMcpServer` demands back. A refusal is
 * a 409 with a full body, which `apiPost` surfaces as an ApiError whose
 * detail carries the `note`.
 */
export function proposeMcpServer(target: string, server: McpServerInput): Promise<unknown> {
  return post<unknown>('/api/verse/mcp/proposal', { target, server });
}

/**
 * POST /api/verse/mcp/apply — perform the write the digest confirms.
 *
 * `digest` is not optional and has no default. It must come from a proposal
 * the operator actually saw.
 */
export async function applyMcpServer(
  target: string,
  server: McpServerInput,
  digest: string,
): Promise<unknown> {
  const result = await post<unknown>('/api/verse/mcp/apply', {
    target,
    server,
    digest,
    confirm: true,
  });
  invalidate(MCP_SNAPSHOT_KEY);
  return result;
}

/**
 * POST /api/verse/mcp/cli-probe — read the installed CLI versions.
 *
 * A POST because it launches the provider CLIs. Nothing about it is a read.
 */
export async function probeCliVersions(): Promise<unknown> {
  const result = await post<unknown>('/api/verse/mcp/cli-probe', {});
  invalidate(MCP_CLI_HEALTH_KEY);
  return result;
}

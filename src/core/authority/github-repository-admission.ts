/** Fresh effect admission for the reviewed same-repository rename. No cached authority or alias fallback. */
import type { GithubReply, GithubTransport } from '../fleet/host-merge.js';
import { isHubRepositoryLabel, requireHubRepositoryMetadata } from './repository-binding.js';

export function isHubRepositoryApiPath(path: string): boolean {
  const match = /^\/repos\/([^/]+\/[^/?#]+)(?:[/?#]|$)/.exec(path);
  return match !== null && isHubRepositoryLabel(match[1]!);
}

/** The caller must run its last-contact Stop/lease/epoch guard AFTER this await. */
export async function hubRepositoryEffectRefusal(repo: string, transport: GithubTransport, token: string): Promise<GithubReply | null> {
  if (!isHubRepositoryLabel(repo)) return null;
  const reply = await transport({ method: 'GET', path: `/repos/${repo}`, token });
  if (reply.status !== 200) return { status: reply.status, body: { message: 'Fresh exact repository metadata is unavailable.' } };
  try { requireHubRepositoryMetadata(repo, reply.body); }
  catch { return { status: 409, body: { message: 'Repository metadata does not match the reviewed exact Hub identity.' } }; }
  return null;
}

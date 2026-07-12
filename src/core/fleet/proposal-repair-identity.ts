import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

export function proposalRepairId(repo: string, proposalId: string): string {
  const canonicalRepo = resolve(repo);
  const hash = createHash('sha1')
    .update(`${canonicalRepo}\0${proposalId}\0proposal-repair`)
    .digest('hex')
    .slice(0, 12);
  return `${basename(canonicalRepo)}:proposal-repair:${hash}`;
}

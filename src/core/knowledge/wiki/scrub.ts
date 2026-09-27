/**
 * wiki/scrub.ts — the secret scrub for everything the wiki stores or renders.
 *
 * Two passes, strongest of both: the shared scrubber (util/scrub.ts — PEM,
 * provider keys, env assignments, webhooks …) and the knowledge index's
 * stricter set (knowledge/index.ts — bare Stripe keys, 32+ hex, long base64).
 *
 * The strict set would also redact long, slash-separated FILE PATHS (a
 * 40-character `src/…/somethingLong` is base64-shaped), which would break the
 * citations the wiki exists to provide. So verified citation links, page links
 * and inline-code spans that name a KNOWN repo path or module are held aside
 * during the strict pass. They are safe to hold: a verified citation names a
 * file listed from the repo, never a value from inside one.
 */

import { scrubSecrets as scrubShared } from '../../util/scrub.js';
import { scrubSecrets as scrubStrict } from '../index.js';

const LINK_RE = /\[[^\]\n]{1,300}\]\(#(?:cite|page):[^)\s]{1,400}\)/g;
const CODE_SPAN_RE = /`([^`\n]{1,300})`/g;

export function scrubWikiText(text: string, known: ReadonlySet<string> = new Set()): string {
  const held: string[] = [];
  const hold = (s: string): string => {
    held.push(s);
    return `\u0001${held.length - 1}\u0001`;
  };
  let masked = scrubShared(text).replace(LINK_RE, (m) => hold(m));
  masked = masked.replace(CODE_SPAN_RE, (m, inner: string) => (known.has(inner) ? hold(m) : m));
  // eslint-disable-next-line no-control-regex
  return scrubStrict(masked).replace(/\u0001(\d+)\u0001/g, (_s, i: string) => held[Number(i)] ?? '');
}

import { homedir } from 'node:os';
import { scrubSecrets } from './scrub.js';

function homeCandidates(): string[] {
  const homes = [homedir(), process.env.HOME, process.env.USERPROFILE]
    .filter((value): value is string => typeof value === 'string' && value.length > 1);
  return Array.from(new Set(homes)).sort((a, b) => b.length - a.length);
}

function scrubPublicString(input: string, homes: string[]): string {
  let out = input;
  for (const home of homes) {
    out = out.split(home).join('~');
  }
  out = scrubSecrets(out);
  for (const home of homes) {
    out = out.split(home).join('~');
  }
  return out;
}

/**
 * Convert arbitrary local read-model data into a public dashboard/API payload.
 *
 * This preserves structure for operator review while scrubbing secret-shaped
 * strings and concrete home-directory paths from every nested string/key.
 */
export function sanitizePublicJson(value: unknown): unknown {
  const homes = homeCandidates();
  const seen = new WeakSet<object>();

  function visit(current: unknown): unknown {
    if (typeof current === 'string') return scrubPublicString(current, homes);
    if (typeof current === 'bigint') return current.toString();
    if (
      current === null ||
      current === undefined ||
      typeof current === 'number' ||
      typeof current === 'boolean'
    ) {
      return current;
    }
    if (current instanceof Date) return current.toISOString();
    if (typeof current !== 'object') return undefined;
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    if (Array.isArray(current)) return current.map((item) => visit(item));

    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      out[scrubPublicString(key, homes)] = visit(nested);
    }
    return out;
  }

  return visit(value);
}

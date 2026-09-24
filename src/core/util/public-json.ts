import { homedir } from 'node:os';
import { scrubSecrets } from './scrub.js';

/** Case-insensitive filesystems (macOS APFS default, Windows) name one home many ways. */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function homeCandidates(): string[] {
  const homes: string[] = [];
  try {
    homes.push(homedir());
  } catch {
    // homedir() can throw when no home is resolvable; env fallbacks below.
  }
  for (const value of [process.env.HOME, process.env.USERPROFILE]) {
    if (typeof value === 'string') homes.push(value);
  }
  // macOS: /var, /tmp and /etc are symlinks into /private, so a realpath'd
  // path under a home there (tmp HOMEs, sandboxes) spells it `/private/var/…`.
  // Name that spelling explicitly so it collapses to a `~` that still
  // round-trips, instead of leaking or becoming `/private~/…`.
  if (process.platform === 'darwin') {
    for (const home of [...homes]) {
      if (/^\/(?:var|tmp|etc)(?:\/|$)/.test(home)) homes.push(`/private${home}`);
    }
  }
  return Array.from(
    new Set(
      homes
        .map((home) => home.replace(/[\\/]+$/, ''))
        // A bare root ("/", "C:") would collapse every absolute path.
        .filter((home) => home.length > 1 && !/^[A-Za-z]:$/.test(home)),
    ),
  ).sort((a, b) => b.length - a.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One matcher for THIS user's home directories. The END of a match is
 * boundary-checked like scrub.ts `redactHomePaths`: `/Users/me/x` → `~/x`, but
 * `/Users/meagan` is never split into `~agan` (the old
 * `split(home).join('~')` did that). The START is deliberately NOT checked:
 * a home embedded after other text (`/opt/Users/me`) still names the user,
 * and this surface's contract is that this user's home path never leaves.
 *
 * WHY NOT `redactHomePaths` itself: it also collapses OTHER users' homes
 * (`/Users/<anyone>`) to `~`. On this surface `~` is a contract, not just
 * redaction — `expandHomePrefix` (verse/path-guard.ts) turns a `~/…` the UI
 * sends back into the CURRENT user's home, so `/Users/alice/proj` → `~/proj`
 * would round-trip into `/Users/<me>/proj`, a different directory.
 *
 * A trailing `.` is sentence punctuation unless it continues a segment name
 * (`/Users/me.` is redacted, `/Users/me.old` is not) — so a home at the end
 * of a sentence cannot slip through.
 *
 * Compiled once per sanitizePublicJson() call (not per string): payloads can
 * carry thousands of strings and every API response and SSE frame pays this.
 */
function homeMatcher(homes: readonly string[]): RegExp | null {
  if (homes.length === 0) return null;
  const alternation = homes.map(escapeRegExp).join('|');
  return new RegExp(
    `(?:${alternation})(?![\\w-]|\\.[\\w-])`,
    CASE_INSENSITIVE_FS ? 'gi' : 'g',
  );
}

function redactOwnHome(input: string, matcher: RegExp | null): string {
  if (matcher === null) return input;
  matcher.lastIndex = 0;
  return input.replace(matcher, '~');
}

function scrubPublicString(input: string, matcher: RegExp | null): string {
  // Home first so a secret-shaped rule never sees (or splits) the username,
  // then again in case scrubbing re-joined text around a home path.
  return redactOwnHome(scrubSecrets(redactOwnHome(input, matcher)), matcher);
}

/**
 * Convert arbitrary local read-model data into a public dashboard/API payload.
 *
 * This preserves structure for operator review while scrubbing secret-shaped
 * strings and this user's home-directory paths (→ `~`) from every nested
 * string/key.
 */
export function sanitizePublicJson(value: unknown): unknown {
  const matcher = homeMatcher(homeCandidates());
  const active = new WeakSet<object>();

  function visit(current: unknown): unknown {
    if (typeof current === 'string') return scrubPublicString(current, matcher);
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
    if (active.has(current)) return '[Circular]';
    active.add(current);
    try {
      if (Array.isArray(current)) return current.map((item) => visit(item));

      const out: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        out[scrubPublicString(key, matcher)] = visit(nested);
      }
      return out;
    } finally {
      active.delete(current);
    }
  }

  return visit(value);
}

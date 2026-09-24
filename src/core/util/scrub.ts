/**
 * src/core/util/scrub.ts — THE shared secret-scrub utility (single source of truth).
 *
 * Extracted from judge-trace.ts (stripSecrets) and extended to cover all
 * patterns previously missing from handlers.ts (scrubDiffSecrets). Since 3.10
 * the two historical duplicates delegate here instead of drifting:
 *   - src/core/generative/invent.ts   re-exports `scrubSecrets` verbatim.
 *   - src/core/knowledge/index.ts     runs this scrub FIRST, then its own
 *     stricter corpus patterns (32-hex, `/`-bearing base64, Stripe) that
 *     `ashlr verify-safety` pins by array length. Knowledge chunks are never
 *     identity-checked, so the stricter pass is safe there and must not leak
 *     into this default (see "IDENTITY CALLERS" below).
 *
 * Patterns covered by `scrubSecrets`:
 *   0. PEM/private-key blocks
 *   1. sk-  API keys (Anthropic, OpenAI, etc.)
 *   2. GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, gha_, github_pat_ (classic
 *      and fine-grained `github_pat_<22>_<59>`)
 *   3. Bearer / Token / Authorization header values
 *   4. Generic key=value secrets: api_key, secret, token, password, passwd,
 *      auth, credential, client_secret, private_key, refresh_token,
 *      access_token, connection_string (including ASHLR_* env vars)
 *   5. Slack tokens: xox[baprs]-…
 *   6. AWS access key IDs: AKIA…
 *   7. JWTs: eyJ….<sig>
 *   8. Bare hex-64 (SHA-256 / API key hex form)
 *   9. GitLab/HuggingFace/npm/Google token prefixes
 *  10. URL authority passwords and long base64 blobs
 *  11. (3.10) Telegram bot tokens `<bot id>:<33–35 chars>` — bare, in
 *      `api.telegram.org/bot<token>/…` URLs, and under any key name
 *  12. (3.10) xAI API keys `xai-…`
 *  13. (3.10) Suffix-named assignments the generic rule's `\b` anchor misses:
 *      SCREAMING env vars (`GROQ_API_KEY=…`, `DB_PASSWORD=…`), snake_case
 *      (`bot_token: …`) and camelCase (`githubToken: …`) names
 *  14. (3.10) Quoted JSON/YAML keys (`"password": "…"`, `\"botToken\":\"…\"`),
 *      which rule 4 never matched because the closing quote sits between the
 *      name and the colon
 *  15. (3.10) Slack / Discord incoming-webhook URL paths
 *
 * `scrubPrivateText` layers two PRIVACY redactions on top for free text that
 * is persisted or exported (reasoning store, session export, logs):
 *   - home-directory paths → `~` (on by default)
 *   - email addresses → `[REDACTED]` (opt-in)
 *
 * IDENTITY CALLERS (why home paths/emails are NOT in `scrubSecrets`): many
 * ledgers validate values with `scrubSecrets(v) === v` (dispatch manifests,
 * worked/dispatch-production ledgers, best-of-n, generated-repair) and several
 * of those values are absolute repo paths or git author identities. Rewriting
 * `/Users/<me>/repo` → `~/repo` in the default scrub would make every such
 * record look "secret-bearing" and be rejected, and would corrupt functional
 * paths. Privacy redaction is therefore an explicit, separate call.
 *
 * IDEMPOTENCE is load-bearing: records persisted after scrubbing are later
 * re-validated with `scrubSecrets(v) === v`, and `canonicalizeProposalDiff`
 * iterates to a fixed point. Every rule's output is a fixed point of every
 * rule (pinned by test/scrub-310.test.ts).
 *
 * PURITY: no I/O, no side-effects. `scrubPrivateText` reads the home directory
 * from the environment (no filesystem access) unless `homes` is supplied.
 */

import { homedir } from 'node:os';

const REDACTED = '[REDACTED]';

function scrubLongBase64Like(match: string): string {
  // Preserve ordinary Git SHA-1 commit ids for forensic audit trails. The
  // explicit hex-64 rule above still redacts longer raw-key shapes.
  if (/^[0-9a-fA-F]{40}$/.test(match)) return match;
  // Avoid erasing obvious low-entropy test/log filler such as xxxxx...; real
  // token-like blobs still have mixed character content and are redacted below.
  const repeatedCandidate = match.replace(/^\+/, '').replace(/=+$/, '');
  if (/^(.)\1{39,}$/.test(repeatedCandidate)) return match;
  return REDACTED;
}

// ---------------------------------------------------------------------------
// 3.10 additions
// ---------------------------------------------------------------------------

/**
 * Telegram bot token: numeric bot id (8–10 digits today; 6–12 tolerated) +
 * ':' + a 33–35 char url-safe secret (35 for issued tokens; Telegram's own
 * documentation example is 34). The optional `bot` prefix covers the Bot API
 * URL form (`https://api.telegram.org/bot<id>:<secret>/sendMessage`), where a
 * plain `\b` anchor fails because `t` and the first digit are both word chars.
 * The narrow secret length plus the non-word lookarounds keep
 * `<epoch-seconds>:<uuid|hex32|sha1>` style ids (36 / 32 / 40 chars) intact —
 * several ledgers identity-check such ids.
 */
const TELEGRAM_BOT_TOKEN = /\d{6,12}:[A-Za-z0-9_-]{33,35}(?![A-Za-z0-9_-])/g;

/**
 * Left-boundary check for a Telegram candidate, done in the replacer instead of
 * a leading lookbehind: a regex that starts with `\d` lets V8 skip ahead to
 * digits, which measured ~3x cheaper on 1 MB of prose than testing a
 * lookbehind at every offset. Accept when the id starts the string, follows a
 * non-word char, or follows a `bot` that itself follows a non-word char.
 */
function redactTelegram(match: string, offset: number, whole: string): string {
  const boundary = (i: number): boolean => i < 0 || !/[A-Za-z0-9_]/.test(whole[i]!);
  if (boundary(offset - 1)) return REDACTED;
  if (whole.slice(offset - 3, offset) === 'bot' && boundary(offset - 4)) return REDACTED;
  return match;
}

/**
 * Incoming-webhook URLs are bearer credentials in their path (anyone holding
 * the URL can post). Host + fixed path prefix are kept for forensics.
 */
const WEBHOOK_URL =
  /(https?:\/\/(?:hooks\.slack\.com\/(?:services|workflows|triggers)|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks)\/)[A-Za-z0-9_/-]{8,}/gi;

/** xAI (Grok) API keys: `xai-` + ≥20 alphanumerics (80 in practice). */
const XAI_API_KEY = /(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{20,}/g;

/**
 * Value shape shared by the suffix-name rules: optional quote, ≥8 chars that
 * are not whitespace/separators/quotes, optional closing quote. Mirrors rule 4.
 */
const ASSIGNED_VALUE = String.raw`\s*[=:]\s*["']?[^\s,;'"]{8,}["']?`;

/**
 * SCREAMING_SNAKE env-var names ending in a secret noun. Rule 4's `\b(token|…)`
 * never fires inside `GROQ_API_KEY` / `TELEGRAM_BOT_TOKEN` because `_` is a
 * word char, so the whole `.env` idiom slipped through. Case-SENSITIVE on
 * purpose: `sort_key=…` in prose/code must not match.
 */
const ENV_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])([A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH|DSN))` +
    ASSIGNED_VALUE,
  'g',
);

/** snake_case names with a secret suffix (`bot_token`, `db_password`). */
const SNAKE_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])([a-z][a-z0-9_]*_(?:api_key|token|secret|password|passwd|pwd|credentials?|private_key|access_key|secret_key|signing_key))` +
    ASSIGNED_VALUE,
  'g',
);

/**
 * Cheap literal-led prefilters for the snake/camel rules. Those two regexes
 * start at every lowercase word, which measured ~3–4.5 ms per MB; the
 * prefilters cost <1 ms and skip them on the common text that has no
 * `…Token =` / `…_password:` assignment at all.
 */
const SNAKE_PREFILTER = /_(?:api_key|token|secret|password|passwd|pwd|credentials?|private_key|access_key|secret_key|signing_key)\s*[=:]/;
const CAMEL_PREFILTER = /(?:Token|Secret|Password|Passwd|ApiKey|PrivateKey|AccessKey|SecretKey|SigningKey|Credentials?)\s*[=:]/;

/** camelCase names with a secret suffix (`githubToken`, `clientSecret`). */
const CAMEL_SECRET_ASSIGNMENT = new RegExp(
  String.raw`(?<![A-Za-z0-9_$])([a-z][A-Za-z0-9]*(?:Token|Secret|Password|Passwd|ApiKey|PrivateKey|AccessKey|SecretKey|SigningKey|Credentials?))` +
    ASSIGNED_VALUE,
  'g',
);

/**
 * Quoted keys (JSON, YAML, JS object literals), including JSON-escaped quotes
 * inside a serialized string (`\"password\":\"…\"`). The name must END in a
 * secret noun (`max_tokens`, `tokenizer`, `author` do not). Structure is kept —
 * only the value becomes `[REDACTED]` — so a scrubbed JSON line stays parseable.
 */
const QUOTED_SECRET_KEY =
  /(\\?["'])([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd|pwd|credentials?|private[_-]?key|access[_-]?key|secret[_-]?key|signing[_-]?key|auth|connection[_-]?string))\1(\s*:\s*)(\\?["'])([^"'\s\\]{8,})\4/gi;

/**
 * Values in CODE that merely reference a secret (a member chain, call, template
 * or env interpolation) rather than contain one. Scrubbed diffs are persisted
 * and applied as proposals, so turning `const GITHUB_TOKEN = process.env.GITHUB_TOKEN`
 * into `GITHUB_TOKEN=[REDACTED]` would corrupt a legitimate change. Applies to
 * the 3.10 suffix rules only — rule 4's historical behaviour is unchanged.
 */
function isCodeReference(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, '');
  return (
    /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+[)\]]*$/.test(v) || // process.env.X, opts.apiToken
    /^[A-Za-z_$][\w$.]*\(/.test(v) || // getToken(), cfg.read(
    /^(?:\$\{|\$[A-Za-z_]|`|<)/.test(v) // ${VAR}, $VAR, `template`, <placeholder>
  );
}

/**
 * Type annotations and identifier-only right-hand sides (`refreshToken: RefreshTokenRecord`,
 * `botToken: undefined`) carry no digits; real tokens essentially always do.
 * Only the camel/snake rules use this skip (they fire inside ordinary TS code);
 * the SCREAMING env rule still redacts a letters-only `.env` password.
 */
function isIdentifierOnly(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, '');
  return !/\d/.test(v) && /^[A-Za-z_$][A-Za-z_$.<>[\]|&?!()]*$/.test(v);
}

/** A value an earlier rule (or an earlier pass) already replaced. */
function isAlreadyRedacted(value: string): boolean {
  return value.replace(/^["']|["']$/g, '') === REDACTED;
}

function redactAssignment(name: string, match: string, value: string, allowIdentifiers: boolean): string {
  // Idempotence: `NAME = "[REDACTED]"` must stay byte-identical on a re-scrub.
  if (isAlreadyRedacted(value)) return match;
  if (isCodeReference(value)) return match;
  if (allowIdentifiers && isIdentifierOnly(value)) return match;
  return `${name}=${REDACTED}`;
}

function valueOf(match: string, name: string): string {
  return match.slice(name.length).replace(/^\s*[=:]\s*/, '');
}

/**
 * Scrub recognised secret patterns from `text`.
 * Returns the scrubbed string with secrets replaced by `[REDACTED]`.
 * Never throws. Idempotent: `scrubSecrets(scrubSecrets(x)) === scrubSecrets(x)`.
 */
export function scrubSecrets(text: string): string {
  try {
    let out = text
      // 0. PEM/private-key blocks. Run before generic/base64 redaction so
      // BEGIN/END markers do not survive with only the body removed.
      .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, REDACTED)
      .replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[^\n]*/g, REDACTED)
      // 11. Telegram bot tokens — before rule 4 so a `botToken: <id>:<secret>`
      // value is removed whole even when its key name is not recognised.
      .replace(TELEGRAM_BOT_TOKEN, redactTelegram)
      // 15. Slack / Discord incoming-webhook URLs (credential in the path).
      .replace(WEBHOOK_URL, '$1[REDACTED]')
      // 12. xAI keys — before rule 10 so the `xai-` prefix does not survive
      // next to a base64-redacted tail.
      .replace(XAI_API_KEY, REDACTED)
      // 1. sk- API keys (Anthropic, OpenAI, etc.)
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED)
      // 2. GitHub tokens (classic prefixes + fine-grained github_pat_<22>_<59>)
      .replace(/\bgh[poursa]_[A-Za-z0-9]{16,}/g, REDACTED)
      .replace(/\bgithub_pat_[A-Za-z0-9_]{22,}/g, REDACTED)
      // 3. Bearer / Token / Authorization header values
      .replace(/\b(Bearer|Token|Authorization)\s+[A-Za-z0-9\-._~+/]+=*/gi, '$1 [REDACTED]')
      // 4. Generic key=value secret patterns. ASHLR_* env vars are only
      // redacted when they look like assignments, not plain audit metadata
      // such as "keys=query".
      .replace(
        /\b(api[_-]?key|api[_-]?token|secret|secret[_-]?key|token|password|passwd|pwd|auth|credential|client[_-]?secret|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|connection[_-]?string|conn[_-]?str|_?auth[_-]?token|ASHLR_[A-Z_]+)\s*[=:]\s*["']?[^\s,;'"]{8,}["']?/gi,
        '$1=[REDACTED]',
      )
      // 5. Slack tokens
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/gi, REDACTED)
      // 6. AWS access key IDs
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
      // 7. JWTs (eyJ header.payload.sig)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
      // 8. Bare hex-64 strings (SHA-256 / hex API keys)
      .replace(/\b[0-9a-fA-F]{64,}\b/g, REDACTED)
      // 9. Other common provider token prefixes.
      .replace(/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED)
      .replace(/\bhf_[A-Za-z0-9]{16,}\b/g, REDACTED)
      .replace(/\bnpm_[A-Za-z0-9]{16,}\b/g, REDACTED)
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED)
      // 10. URL passwords and long base64-ish blobs.
      .replace(/(:\/\/[^:\s/@]*:)[^@\s]+(@)/g, '$1[REDACTED]$2')
      .replace(/(?<![/\w])[A-Za-z0-9+]{40,}={0,2}(?![/\w])/g, scrubLongBase64Like)
      // 13. Suffix-named assignments rule 4's `\b` anchor cannot see. LAST, so
      // every token-shape rule above has already turned a JWT/AKIA/hex value
      // into [REDACTED]; that marker is left untouched below. Running these
      // earlier broke idempotence: a dotted JWT reads like a member chain
      // (skipped as a code reference), then pass 2 rewrote `NAME = "[REDACTED]"`.
      .replace(ENV_SECRET_ASSIGNMENT, (m: string, name: string) => redactAssignment(name, m, valueOf(m, name), false));
    if (SNAKE_PREFILTER.test(out)) {
      out = out.replace(SNAKE_SECRET_ASSIGNMENT, (m: string, name: string) => redactAssignment(name, m, valueOf(m, name), true));
    }
    if (CAMEL_PREFILTER.test(out)) {
      out = out.replace(CAMEL_SECRET_ASSIGNMENT, (m: string, name: string) => redactAssignment(name, m, valueOf(m, name), true));
    }
    // 14. Quoted keys: keep the JSON/YAML structure, replace the value only.
    return out.replace(
      QUOTED_SECRET_KEY,
      (m: string, q: string, name: string, sep: string, vq: string, value: string) =>
        isAlreadyRedacted(value) || isCodeReference(value) ? m : `${q}${name}${q}${sep}${vq}${REDACTED}${vq}`,
    );
  } catch {
    // Never throws — return original text on unexpected error.
    return text;
  }
}

// ---------------------------------------------------------------------------
// Privacy redaction for persisted / exported free text
// ---------------------------------------------------------------------------

export interface PrivateScrubOptions {
  /** Rewrite home-directory paths to `~`. Default: true. */
  readonly homePaths?: boolean;
  /** Replace email addresses with `[REDACTED]`. Default: false (opt-in). */
  readonly emails?: boolean;
  /**
   * Home directories to collapse. Default: `os.homedir()`, `$HOME`,
   * `$USERPROFILE`. Supplied explicitly by callers that already resolved them
   * (and by tests).
   */
  readonly homes?: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defaultHomes(): string[] {
  const out: string[] = [];
  try {
    out.push(homedir());
  } catch {
    // homedir() can throw when no home is resolvable; env fallbacks below.
  }
  for (const key of ['HOME', 'USERPROFILE'] as const) {
    const v = process.env[key];
    if (v) out.push(v);
  }
  return out;
}

/** Case-insensitive filesystems (macOS APFS default, Windows) name one home many ways. */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Other users' home roots (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`):
 * the username is the PII, so the whole root collapses to `~` too. macOS's
 * `/Users/Shared` is a system directory, not a person.
 */
const GENERIC_HOME_ROOT =
  /(?<![\w.-])(?:\/(?:Users|home)\/(?!Shared(?![\w.-]))[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)(?![\w.-])/g;

/**
 * Collapse home-directory paths to `~`. A home only matches as a whole path
 * prefix on segment boundaries: `/Users/me/x` → `~/x`; `/opt/Users/me` is left
 * alone, and `/Users/meagan` is never split into `~agan` (it is another
 * person's home, collapsed whole by the generic rule). Never throws.
 */
export function redactHomePaths(text: string, homes: readonly string[] = defaultHomes()): string {
  try {
    let out = text;
    const unique = Array.from(
      new Set(
        homes
          .map((h) => h.replace(/[\\/]+$/, ''))
          // A bare root ("/", "C:") would collapse every absolute path.
          .filter((h) => h.length > 1 && !/^[A-Za-z]:$/.test(h)),
      ),
    ).sort((a, b) => b.length - a.length);
    for (const home of unique) {
      const re = new RegExp(`(?<![\\w.-])${escapeRegExp(home)}(?![\\w.-])`, CASE_INSENSITIVE_FS ? 'gi' : 'g');
      out = out.replace(re, '~');
    }
    return out.replace(GENERIC_HOME_ROOT, '~');
  } catch {
    return text;
  }
}

/**
 * Email addresses in free text. `git@host:org/repo` SSH remotes are not
 * personal addresses and stay intact; `pkg@1.2.3` version pins never match
 * because the final label must be alphabetic.
 */
const EMAIL = /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])/g;

/** Replace email addresses with `[REDACTED]`. Never throws. */
export function redactEmails(text: string): string {
  try {
    return text.replace(EMAIL, (m: string, local: string) => (local === 'git' ? m : REDACTED));
  } catch {
    return text;
  }
}

/**
 * Secrets + privacy scrub for free text that is persisted or exported
 * (reasoning steps, session exports, crash logs). Runs `scrubSecrets`, then
 * collapses home paths (default on) and, when asked, emails. Home paths are
 * collapsed on both sides of the secret scrub so a secret rule can never split
 * a home prefix into an unrecognisable remainder (same idiom as
 * `sanitizePublicJson`). Never throws. Idempotent.
 */
export function scrubPrivateText(text: string, options: PrivateScrubOptions = {}): string {
  const homePaths = options.homePaths !== false;
  const homes = homePaths ? (options.homes ?? defaultHomes()) : [];
  let out = homePaths ? redactHomePaths(text, homes) : text;
  out = scrubSecrets(out);
  if (homePaths) out = redactHomePaths(out, homes);
  if (options.emails === true) out = redactEmails(out);
  return out;
}

/** Stable bytes for proposal persistence, hashing, and provenance signing. */
export function canonicalizeProposalDiff(text: string): string {
  let current = text;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = scrubSecrets(current)
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9_]{16,}\b/g, REDACTED)
      .replace(/\b(?:AKIA|ASIA|AROA)[0-9A-Z]{16}\b/g, REDACTED)
      .replace(/\b[0-9a-fA-F]{32,}\b/g, REDACTED);
    if (next === current) return current;
    current = next;
  }
  throw new Error('proposal diff canonicalization did not converge');
}

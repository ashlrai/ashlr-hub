/**
 * 3.10 safety floor — shared scrubber coverage, idempotence, privacy layer,
 * and the "one scrubber" delegation of the two historical duplicates.
 *
 * Every secret below is a SYNTHETIC, provider-shaped fake. Pure functions only:
 * nothing here touches the filesystem or network.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  canonicalizeProposalDiff,
  redactEmails,
  redactHomePaths,
  scrubPrivateText,
  scrubSecrets,
} from '../src/core/util/scrub.js';
import { scrubSecrets as inventScrub } from '../src/core/generative/invent.js';
import { SECRET_PATTERNS, scrubSecrets as knowledgeScrub } from '../src/core/knowledge/index.js';

// --- synthetic secrets ---------------------------------------------------------
const TELEGRAM = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ'; // 35-char secret (issued shape)
const TELEGRAM_DOC = '110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'; // 34-char (Telegram docs example)
const XAI = `xai-${'Ab3Cd4Ef5Gh6'.repeat(6)}AbCdEfGh`;
const GH_FINE = `github_pat_11ABCDEFG0123456789abc_${'aB3dE6gH9j'.repeat(5)}KlMnOpQrS`;
const SLACK_HOOK = 'https://hooks.slack.com/services/T0000AAAA/B0000BBBB/XXxxYYyyZZzz00112233';
const DISCORD_HOOK = 'https://discord.com/api/webhooks/123456789012345678/aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';

const SAFE_SHA = 'deadbeefcafef00ddeadbeefcafef00ddeadbeef';

function expectGone(out: string, ...raws: string[]): void {
  for (const raw of raws) expect(out).not.toContain(raw);
  expect(out).toContain('[REDACTED]');
}

describe('scrubSecrets — 3.10 patterns', () => {
  it('redacts Telegram bot tokens bare, in Bot API URLs, and under any key', () => {
    expectGone(scrubSecrets(`token is ${TELEGRAM} ok`), TELEGRAM);
    expectGone(scrubSecrets(`id ${TELEGRAM_DOC}`), TELEGRAM_DOC);
    const url = scrubSecrets(`GET https://api.telegram.org/bot${TELEGRAM}/sendMessage?chat_id=1`);
    expectGone(url, TELEGRAM, 'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ');
    expect(url).toContain('https://api.telegram.org/');
    expect(url).toContain('/sendMessage');
    expectGone(scrubSecrets(`TELEGRAM_BOT_TOKEN=${TELEGRAM}`), TELEGRAM);
    expectGone(scrubSecrets(`{"comms":{"telegram":{"botToken":"${TELEGRAM}"}}}`), TELEGRAM);
  });

  it('redacts xAI keys whole (no surviving xai- prefix fragment)', () => {
    const out = scrubSecrets(`XAI_API_KEY=${XAI} and bare ${XAI}.`);
    expectGone(out, XAI, 'xai-Ab3');
    expect(out).not.toMatch(/xai-/);
  });

  it('redacts GitHub fine-grained and classic tokens', () => {
    expectGone(scrubSecrets(`GH=${GH_FINE}`), GH_FINE);
    expectGone(scrubSecrets(`push with ${GH_FINE} now`), GH_FINE);
    expectGone(scrubSecrets('ghp_AbCdEf0123456789GhIjKlMnOpQr'), 'ghp_AbCdEf0123456789GhIjKlMnOpQr');
  });

  it('redacts SCREAMING env-var, snake_case and camelCase secret assignments', () => {
    const cases: Array<[string, string]> = [
      ['GROQ_API_KEY=gsk_abcdefghijklmnop1234', 'gsk_abcdefghijklmnop1234'],
      ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
      ['DB_PASSWORD=correcthorsebattery', 'correcthorsebattery'], // letters-only still redacted in env form
      ['SENTRY_DSN="https://abc123def456@o1.ingest.sentry.io/1"', 'abc123def456'],
      ['bot_token: 9f8e7d6c5b4a', '9f8e7d6c5b4a'],
      ['db_password = s3cretpassw0rd', 's3cretpassw0rd'],
      ['githubToken: abcdefgh12345', 'abcdefgh12345'],
      ["clientSecret: 's3cr3t-value-123'", 's3cr3t-value-123'],
      ['webhookSigningKey=whsec_0123456789abcdef', 'whsec_0123456789abcdef'],
    ];
    for (const [input, raw] of cases) expectGone(scrubSecrets(input), raw);
  });

  it('redacts quoted JSON/YAML keys and keeps the document parseable', () => {
    const doc = {
      password: 'hunter2hunter2',
      nested: { apiKey: 'k3y-0123456789', refresh_token: 'rt-0123456789ab' },
      max_tokens: 12345678901,
      tokenizer: 'cl100k_base_tokenizer',
      author: 'someone-important',
    };
    const out = scrubSecrets(JSON.stringify(doc));
    const parsed = JSON.parse(out) as typeof doc;
    expect(parsed.password).toBe('[REDACTED]');
    expect(parsed.nested.apiKey).toBe('[REDACTED]');
    expect(parsed.nested.refresh_token).toBe('[REDACTED]');
    expect(parsed.max_tokens).toBe(12345678901);
    expect(parsed.tokenizer).toBe('cl100k_base_tokenizer');
    expect(parsed.author).toBe('someone-important');

    // JSON serialized inside another JSON string (escaped quotes).
    const wrapped = JSON.stringify({ raw: JSON.stringify({ botToken: 'abcdef123456' }) });
    const unwrapped = JSON.parse(scrubSecrets(wrapped)) as { raw: string };
    expect(JSON.parse(unwrapped.raw)).toEqual({ botToken: '[REDACTED]' });
  });

  it('redacts Slack and Discord incoming-webhook URL credentials', () => {
    const out = scrubSecrets(`SLACK_WEBHOOK=${SLACK_HOOK}\nnotify ${DISCORD_HOOK}`);
    expectGone(out, 'XXxxYYyyZZzz00112233', 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345');
    expect(scrubSecrets(`post to ${DISCORD_HOOK}`)).toBe('post to https://discord.com/api/webhooks/[REDACTED]');
  });

  it('does not corrupt code that merely REFERENCES a secret (scrubbed diffs are applied)', () => {
    const preserved = [
      'const GITHUB_TOKEN = process.env.GITHUB_TOKEN;',
      'const GROQ_TOKEN = getToken(cfg);',
      'export XAI_API_KEY="${XAI_API_KEY}"',
      '  githubToken: GithubTokenRecord;',
      '  botToken: undefined,',
      'const botToken = cfg.comms.telegram.botToken;',
      'SIGNING_KEY=<your-signing-key>',
    ];
    for (const line of preserved) expect(scrubSecrets(line)).toBe(line);
  });

  it('leaves ordinary text, ids and git SHAs alone', () => {
    const preserved = [
      `commit ${SAFE_SHA}`,
      'sort key: createdAt',
      'maxTokens: 12345678',
      '"max_tokens": 4096',
      'run 1695000000:0123456789abcdef0123456789abcdef01234567', // epoch:sha1
      'run 1695000000:123e4567-e89b-42d3-a456-426614174011', // epoch:uuid
      'run 1695000000:0123456789abcdef0123456789abcdef', // epoch:hex32
      'ssh git@github.com:ashlrai/ashlr-hub.git',
      'the quick brown fox jumps over 7 lazy dogs',
      'https://hooks.slack.com/services/', // no credential path
    ];
    for (const line of preserved) expect(scrubSecrets(line)).toBe(line);
  });

  it('is idempotent over a mixed corpus (identity-check callers depend on it)', () => {
    const corpus = [
      `TELEGRAM_BOT_TOKEN=${TELEGRAM}`,
      `https://api.telegram.org/bot${TELEGRAM}/getMe`,
      `XAI_API_KEY=${XAI}`,
      GH_FINE,
      'DB_PASSWORD=hunter2hunter2 githubToken: abcdefgh12345',
      JSON.stringify({ password: 'hunter2hunter2', botToken: 'abc123456789' }),
      JSON.stringify({ raw: JSON.stringify({ secret: 'abcdef1234567' }) }),
      SLACK_HOOK,
      'Authorization: Bearer abc.def.ghi api_key=0123456789abcdef',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
    ];
    // Every pairwise join of the corpus with code-shaped fragments — the m107
    // regression was a JWT inside `const JWT_TOKEN = "…"` that only a 2nd pass hit.
    const fragments = [
      'const JWT_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV";',
      'const STRIPE_KEY = "sk_live_4eC39HqLyjWDarjtT1zdp7dc";',
      `AWS_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE'`,
      `apiToken: '${'ab12'.repeat(12)}'`,
      'const GITHUB_TOKEN = process.env.GITHUB_TOKEN;',
      `{"refreshToken":"${'f0'.repeat(32)}"}`,
    ];
    for (const a of [...corpus, ...fragments]) {
      for (const b of fragments) {
        const joined = `${a}\n+${b}`;
        const once = scrubSecrets(joined);
        expect(scrubSecrets(once), joined).toBe(once);
      }
    }
    for (const input of corpus) {
      const once = scrubSecrets(input);
      expect(scrubSecrets(once)).toBe(once);
      const canonical = canonicalizeProposalDiff(input);
      expect(canonicalizeProposalDiff(canonical)).toBe(canonical);
    }
  });

  it('never throws and stays fast on large and pathological input', () => {
    const line =
      'Running npm test in /Users/someone/repo — const apiToken = opts.apiToken; DB_URL=postgres://u:p@h/db ok\n';
    const prose = line.repeat(Math.ceil(1_000_000 / line.length));
    const alnumRun = 'bC9'.repeat(40_000);
    const identRun = 'someVeryLongIdentifierName'.repeat(5_000);
    const envRun = `${'A_'.repeat(50_000)}KEY`;
    // Generous CI bounds; measured locally at ~20 ms (1 MB) and ~1 ms (runs).
    let t = performance.now();
    scrubSecrets(prose);
    expect(performance.now() - t).toBeLessThan(1_000);
    for (const run of [alnumRun, identRun, envRun]) {
      t = performance.now();
      expect(typeof scrubSecrets(run)).toBe('string');
      expect(performance.now() - t).toBeLessThan(250);
    }
  });
});

describe('one scrubber — the historical duplicates delegate', () => {
  it('generative/invent re-exports the shared scrubSecrets verbatim', () => {
    expect(inventScrub).toBe(scrubSecrets);
    const src = readFileSync(join(__dirname, '..', 'src', 'core', 'generative', 'invent.ts'), 'utf8');
    expect(src).not.toMatch(/const SECRET_PATTERNS/);
    expect(src).toMatch(/from '\.\.\/util\/scrub\.js'/);
  });

  it('knowledge/index is a superset: shared coverage plus its stricter corpus patterns', () => {
    const shared = [
      `bot ${TELEGRAM}`,
      `key ${XAI}`,
      `pat ${GH_FINE}`,
      'GROQ_API_KEY=gsk_abcdefghijklmnop1234',
      JSON.stringify({ password: 'hunter2hunter2' }),
      SLACK_HOOK,
    ];
    for (const input of shared) {
      const out = knowledgeScrub(input);
      expect(out).toContain('[REDACTED]');
      for (const raw of [TELEGRAM, XAI, GH_FINE, 'gsk_abcdefghijklmnop1234', 'hunter2hunter2', 'XXxxYYyyZZzz00112233']) {
        expect(out).not.toContain(raw);
      }
    }
    // Stricter-than-shared shapes the knowledge corpus keeps redacting.
    const hex32 = '0123456789abcdef0123456789abcdef';
    expect(scrubSecrets(`h ${hex32}`)).toContain(hex32);
    expect(knowledgeScrub(`h ${hex32}`)).not.toContain(hex32);
    expect(knowledgeScrub('stripe sk_live_4eC39HqLyjWDarjtT1zdp7dc')).not.toContain('sk_live_4eC39HqLyjWDarjtT1zdp7dc');
    // verify-safety CHECK 4 pins this array (>= 6) and h6 pins exactly 7.
    expect(SECRET_PATTERNS).toHaveLength(7);
  });
});

describe('scrubPrivateText — privacy layer for persisted free text', () => {
  const homes = ['/Users/me'];

  it('collapses the home directory to ~ on a path-segment boundary', () => {
    expect(redactHomePaths('open /Users/me/code/app.ts', homes)).toBe('open ~/code/app.ts');
    expect(redactHomePaths('cwd=/Users/me', homes)).toBe('cwd=~');
    expect(redactHomePaths('file:///Users/me/x.md', homes)).toBe('file://~/x.md');
    // A sibling that shares the home's prefix is a DIFFERENT home: it is never
    // split into "~.bak" / "~agan" — the generic rule collapses the whole root
    // (another person's username is PII too).
    expect(redactHomePaths('/Users/me.bak/x', homes)).toBe('~/x');
    expect(redactHomePaths('/Users/meagan/x', homes)).toBe('~/x');
    // Only a path that STARTS at the home: `/opt/Users/me` is another tree.
    expect(redactHomePaths('/opt/Users/me/x', homes)).toBe('/opt/Users/me/x');
    expect(redactHomePaths('/home/runner/work/x', homes)).toBe('~/work/x');
    expect(redactHomePaths('C:\\Users\\Bob\\proj', homes)).toBe('~\\proj');
    // System dirs and look-alikes stay.
    expect(redactHomePaths('/Users/Shared/cache and https://x.com/home/about', homes)).toBe(
      '/Users/Shared/cache and https://x.com/home/about',
    );
  });

  it('never treats a filesystem root as a home', () => {
    expect(redactHomePaths('/etc/hosts and C:\\Windows', ['/', 'C:', 'C:\\'])).toBe('/etc/hosts and C:\\Windows');
  });

  it('defaults to the process home (the isolated worker HOME under vitest)', () => {
    const home = process.env['HOME']!;
    expect(scrubPrivateText(`log at ${home}/.ashlr/verse/x.jsonl`)).toBe('log at ~/.ashlr/verse/x.jsonl');
  });

  it('matches the home case-insensitively on case-insensitive filesystems', () => {
    const out = redactHomePaths('/users/ME/notes', homes);
    if (process.platform === 'darwin' || process.platform === 'win32') expect(out).toBe('~/notes');
    else expect(out).toBe('/users/ME/notes'); // case-sensitive fs: a different directory
  });

  it('redacts emails only when asked, sparing ssh remotes and version pins', () => {
    const text = 'ping mason.w+ci@example.co.uk; remote git@github.com:ashlrai/x.git; dep lodash@4.17.21';
    expect(scrubPrivateText(text, { homes })).toBe(text);
    expect(redactEmails(text)).toBe('ping [REDACTED]; remote git@github.com:ashlrai/x.git; dep lodash@4.17.21');
    expect(scrubPrivateText(text, { homes, emails: true })).toBe(redactEmails(text));
  });

  it('scrubs secrets, collapses homes, and is idempotent', () => {
    const text = `thinking: read /Users/me/.env → GROQ_API_KEY=gsk_abcdefghijklmnop1234, mail a@b.io, tg ${TELEGRAM}`;
    const once = scrubPrivateText(text, { homes, emails: true });
    expect(once).toBe('thinking: read ~/.env → GROQ_API_KEY=[REDACTED], mail [REDACTED], tg [REDACTED]');
    expect(scrubPrivateText(once, { homes, emails: true })).toBe(once);
  });

  it('can leave paths untouched when a caller needs them functional', () => {
    expect(scrubPrivateText('/Users/me/repo DB_PASSWORD=hunter2hunter2', { homes, homePaths: false })).toBe(
      '/Users/me/repo DB_PASSWORD=[REDACTED]',
    );
  });

  it('keeps the default scrubSecrets path-preserving (identity-check callers)', () => {
    const repo = '/Users/me/Desktop/github/dev-tools/ashlr-hub';
    expect(scrubSecrets(repo)).toBe(repo);
    expect(scrubSecrets('author mason@ashlr.ai')).toBe('author mason@ashlr.ai');
  });
});

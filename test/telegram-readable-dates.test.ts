import { describe, expect, it } from 'vitest';
import { formatProductDisplayText } from '../src/core/vision/leader-display-text.js';
import { escapeTelegramHtml, leaderDisplayText, telegramInstant } from '../src/core/integrations/telegram-format.js';

const AT = '2026-10-09T06:15:00.123Z';
const NEXT_DAY = Date.parse('2026-10-10T12:00:00Z');
describe('Telegram operator-clock display', () => {
  it('renders useful historical instants without seconds, milliseconds or raw ISO prefixes', () => {
    expect(telegramInstant(AT, NEXT_DAY, 'America/New_York')).toBe('Oct 9, 2:15 AM');
    expect(telegramInstant(AT, NEXT_DAY, 'Asia/Tokyo')).toBe('Oct 9, 3:15 PM');
    expect(telegramInstant(AT, Date.parse(AT), 'America/New_York')).toBe('today 2:15 AM');
    expect(telegramInstant(AT, Date.parse('2027-01-01T12:00:00Z'), 'America/New_York')).toBe('Oct 9, 2026, 2:15 AM');
  });
  it('decides today in the configured timezone and respects daylight saving transitions', () => {
    const midnight = '2026-10-09T02:15:00Z';
    expect(telegramInstant(midnight, Date.parse('2026-10-09T06:15:00Z'), 'America/New_York')).toBe('Oct 8, 10:15 PM');
    expect(telegramInstant('2026-11-01T05:30:00Z', NEXT_DAY, 'America/New_York')).toBe('Nov 1, 1:30 AM');
    expect(telegramInstant('2026-11-01T06:30:00Z', NEXT_DAY, 'America/New_York')).toBe('Nov 1, 1:30 AM');
  });
  it('uses the existing New York fallback for an invalid timezone and refuses unknown instants', () => {
    expect(telegramInstant(AT, NEXT_DAY, 'invalid/zone')).toBe('Oct 9, 2:15 AM');
    for (const invalid of ['', 'not a date', '1234567890', '2026-02-30T06:15:00Z', '2026-13-01T06:15:00Z']) {
      expect(telegramInstant(invalid, NEXT_DAY)).toBeNull();
    }
    for (const invalidNow of [NaN, Infinity, 1e20]) expect(telegramInstant(AT, invalidNow)).toBeNull();
  });
  it('uses Phantom for generated product wording without renaming CLI commands or quoted history', () => {
    expect(leaderDisplayText('Ashlrverse fleet; Ashlr Verse chat; ashlrverse manager.')).toBe('Phantom fleet; Phantom chat; Phantom manager.');
    const literal = '`Ashlrverse` "Ashlr Verse" https://example.com/Ashlrverse';
    expect(leaderDisplayText(`Ashlrverse next. Run ashlr verse. ${literal}`)).toBe(`Phantom next. Run ashlr verse. ${literal}`);
  });
  it('formats only generated prose and leaves exact answer literals, URLs, numbers and IDs intact', () => {
    const memo = 'lm-20261009061500-abcdef';
    const literals = `\`${AT}\` https://example.com/${AT} "${AT}"`;
    const raw = `Leader memo ${memo} — ${AT}\n${literals}\n12345678901234567890, $200 & <status>`;
    const display = leaderDisplayText(raw, NEXT_DAY, 'America/New_York');
    expect(display).toBe(`Leader memo — Oct 9, 2:15 AM\n${literals}\n12345678901234567890, $200 & <status>`);
    expect(escapeTelegramHtml(display)).toContain('$200 &amp; &lt;status&gt;');
    expect(memo).toBe('lm-20261009061500-abcdef');
  });
});


describe('saved product name display', () => {
  it('projects recognized legacy names without rewriting identifiers or exact literals', () => {
    const raw = 'Build Ashlrverse and Ashlr Verse; Ashlr Hub; ashlrverse.';
    expect(formatProductDisplayText(raw)).toBe('Build Phantom and Phantom; Phantom; Phantom.');
    expect(raw).toBe('Build Ashlrverse and Ashlr Verse; Ashlr Hub; ashlrverse.');
    const exact = ["'Ashlr Verse'", '“Ashlrverse”', '‘Ashlr Hub’', '"Ashlr Verse"', '`Ashlrverse`',
      '```text\nAshlr Verse\n```', 'https://example.com/Ashlrverse', '/repo/Ashlrverse',
      'Ashlrverse.ts', 'Ashlrverse-id', 'Ashlrverse:tool', 'ashlr verse', String.raw`C:\Ashlrverse`, 'account@Ashlrverse',
      'task 01234567-89ab-cdef-0123-456789abcdef', 'commit ' + 'a'.repeat(40), '2026-10-09T06:15:00.123Z'];
    for (const value of exact) expect(formatProductDisplayText(value)).toBe(value);
    expect(formatProductDisplayText('Ashlrverse: UI. Ashlr Verse!')).toBe('Phantom: UI. Phantom!');
    expect(formatProductDisplayText("Ashlrverse’s tools and Ashlr Verse's fleet")).toBe("Phantom’s tools and Phantom's fleet");
  });
});

import { describe, expect, it } from 'vitest';
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

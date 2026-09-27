/**
 * 3.15 — `ashlr director` is retired (core/comms/director.ts's model cycle is a
 * no-op; the Leader is the one strategic brain). The help row no longer
 * advertises the "Elon Director … sending Telegram", and the command says it
 * is retired and points to `ashlr leader` on every run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/config.js')>()),
  // Stop before any real config / fleet read: the notice must already be out.
  loadConfig: () => { throw new Error('no config in this test'); },
}));

import { HELP_ENTRIES } from '../src/cli/help.js';
import { DIRECTOR_RETIRED_NOTICE, cmdDirector } from '../src/cli/director.js';

afterEach(() => vi.restoreAllMocks());

describe('ashlr director (retired)', () => {
  it('the help row says retired and points to `ashlr leader`', () => {
    const row = HELP_ENTRIES.find((e) => e.cmd.split(' ')[0] === 'director');
    expect(row).toBeDefined();
    expect(row!.desc).toMatch(/^Retired — the Leader handles this \(see `ashlr leader`\)/);
    expect(row!.desc).not.toMatch(/Elon|sending Telegram/);
    expect(HELP_ENTRIES.some((e) => /Elon Director/.test(e.desc))).toBe(false);
  });

  it('every run prints the retired notice (stderr) pointing to `ashlr leader`', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const code = await cmdDirector([]);
    expect(code).toBe(1); // config load failed (mocked) — after the notice
    expect(err.mock.calls[0]![0]).toBe(DIRECTOR_RETIRED_NOTICE);
    expect(DIRECTOR_RETIRED_NOTICE).toMatch(/retired — the Leader handles this\. See `ashlr leader`/);
  });
});

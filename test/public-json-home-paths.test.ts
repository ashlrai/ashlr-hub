/**
 * sanitizePublicJson home-path rule (src/core/util/public-json.ts, V3.10).
 *
 * `~` on the public API is a round-trip contract: expandHomePrefix
 * (verse/path-guard.ts) maps a `~/…` the UI sends back to THIS user's home.
 * So the rule must (1) collapse this user's home on path-segment boundaries
 * only, and (2) never collapse another user's home into `~`.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { sanitizePublicJson } from '../src/core/util/public-json.js';
import { expandHomePrefix } from '../src/core/verse/path-guard.js';

const home = homedir();
const s = (value: string): string => sanitizePublicJson(value) as string;

describe('sanitizePublicJson — home paths', () => {
  it('collapses this home as a whole path prefix, in values and keys', () => {
    expect(s(`${home}/code/proj`)).toBe('~/code/proj');
    expect(s(home)).toBe('~');
    expect(s(`cwd=${home}/x, then ${home}/y`)).toBe('cwd=~/x, then ~/y');
    expect(sanitizePublicJson({ [`${home}/k`]: 1 })).toEqual({ '~/k': 1 });
  });

  it('never splits a longer sibling name (the old split/join made `~agan`)', () => {
    expect(s(`${home}agan/code`)).toBe(`${home}agan/code`);
    expect(s(`${home}.old/code`)).toBe(`${home}.old/code`);
    expect(s(`${home}-backup`)).toBe(`${home}-backup`);
  });

  it('never lets the home string out, even embedded after other path text', () => {
    expect(s(`/opt${home}/x`)).not.toContain(home);
  });

  it.runIf(process.platform === 'darwin')('collapses the /private realpath spelling of a /var home to a round-trippable ~', () => {
    const saved = process.env.HOME;
    try {
      process.env.HOME = '/var/folders/zz/ashlr-fixture-home';
      expect(s('/private/var/folders/zz/ashlr-fixture-home/repo')).toBe('~/repo');
      expect(s('/var/folders/zz/ashlr-fixture-home/repo')).toBe('~/repo');
    } finally {
      process.env.HOME = saved;
    }
  });

  it('still redacts a home that ends a sentence', () => {
    expect(s(`saved under ${home}.`)).toBe('saved under ~.');
    expect(s(`"${home}"`)).toBe('"~"');
  });

  it("leaves another user's home alone so `~` always round-trips to THIS home", () => {
    const other = '/Users/someone-else-entirely/proj';
    expect(s(other)).toBe(other);
    const ours = s(`${home}/code/proj`);
    expect(expandHomePrefix(ours)).toBe(`${home}/code/proj`);
  });

  it.runIf(process.platform === 'darwin')('matches the home case-insensitively on APFS', () => {
    expect(s(`${home.toUpperCase()}/x`)).toBe('~/x');
  });

  it('still scrubs secrets next to a home path', () => {
    const secret = 'sk-abcdefghijklmnop1234567890';
    expect(s(`${home}/${secret}`)).toBe('~/[REDACTED]');
  });
});

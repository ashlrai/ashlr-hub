import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { sanitizePublicJson } from '../src/core/util/public-json.js';

describe('M477 public JSON graph readiness', () => {
  it('serializes repeated object aliases at every non-recursive location', () => {
    const shared = { readiness: 'ready', nested: { count: 2 } };

    expect(sanitizePublicJson({ primary: shared, secondary: shared })).toEqual({
      primary: { readiness: 'ready', nested: { count: 2 } },
      secondary: { readiness: 'ready', nested: { count: 2 } },
    });
  });

  it('replaces true recursive object edges with the circular sentinel', () => {
    const root: Record<string, unknown> = { name: 'root' };
    const child: Record<string, unknown> = { name: 'child', parent: root };
    root['child'] = child;
    root['self'] = root;

    expect(sanitizePublicJson(root)).toEqual({
      name: 'root',
      child: { name: 'child', parent: '[Circular]' },
      self: '[Circular]',
    });
  });

  it('distinguishes repeated array aliases from recursive array edges', () => {
    const shared = ['ready', { count: 2 }];
    const recursive: unknown[] = ['root'];
    recursive.push(recursive);

    expect(sanitizePublicJson([shared, shared, recursive])).toEqual([
      ['ready', { count: 2 }],
      ['ready', { count: 2 }],
      ['root', '[Circular]'],
    ]);
  });

  it('continues scrubbing home paths and secret-shaped strings in keys and values', () => {
    const home = homedir();
    const secret = 'sk-abcdefghijklmnop1234567890';

    expect(
      sanitizePublicJson({
        [`${home}/${secret}`]: `workspace=${home}/src credential=${secret}`,
      }),
    ).toEqual({
      '~/[REDACTED]': 'workspace=~/src credential=[REDACTED]',
    });
  });
});

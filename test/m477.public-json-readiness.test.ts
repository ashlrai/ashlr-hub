import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { buildFleetLaneLocks } from '../src/core/fleet/lane-lock.js';
import type { Proposal } from '../src/core/types.js';
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

  it('scrubs hostile lane metadata without adding raw work content', () => {
    const home = homedir();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    const sanitized = sanitizePublicJson({
      laneLocks: {
        sourceQuality: {
          sourceState: 'degraded',
          complete: false,
          reasons: ['goals-unreadable'],
        },
        samples: [{
          repo: 'ashlr-hub',
          lane: 'ashlr-hub#goal:goal-one',
          title: `Inspect ${secret} at ${home}/private`,
          reason: 'stale-in-progress',
          ageMs: 1000,
        }],
      },
    });
    const encoded = JSON.stringify(sanitized);

    expect(encoded).toContain('"repo":"ashlr-hub"');
    expect(encoded).toContain('[REDACTED]');
    expect(encoded).toContain('~/private');
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain(home);
    expect(encoded).not.toMatch(/"(prompt|diff|stdout|stderr|output|env|files)"/);
  });

  it('keeps raw persisted lane IDs and ambiguous metadata out of sanitized public snapshots', () => {
    const secret = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    const proposal: Proposal = {
      id: `proposal-${secret}`,
      repo: `/private/workspace/${secret}`,
      origin: 'agent',
      kind: 'patch',
      title: `Inspect ${secret} under /Volumes/Client Data`,
      summary: 'public projection fixture',
      status: 'awaiting-host-merge',
      createdAt: '2026-07-03T00:00:00.000Z',
    };
    const laneLocks = buildFleetLaneLocks({ goals: [], proposals: [proposal], visibleQueueItems: [] });
    const sanitized = sanitizePublicJson({ laneLocks });
    const encoded = JSON.stringify(sanitized);

    expect(laneLocks.samples[0]).toMatchObject({
      lane: expect.stringMatching(/^unknown#proposal:p_[0-9a-f]{16}$/),
      proposalId: expect.stringMatching(/^p_[0-9a-f]{16}$/),
      repo: null,
    });
    expect(laneLocks.samples[0]).not.toHaveProperty('title');
    expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain('Client Data');
    expect(encoded).not.toContain(`proposal-${secret}`);
  });
});

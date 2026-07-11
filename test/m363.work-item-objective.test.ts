import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { workItemObjectiveHash } from '../src/core/fleet/work-item-objective.js';
import { provenanceKeyPath } from '../src/core/foundry/provenance.js';
import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

const base = {
  repo: '/tmp/ashlr-objective-repo',
  id: 'repo:goal:stable',
  source: 'goal' as const,
  title: 'Implement durable lease recovery',
  detail: 'Reclaim expired leases without disturbing active workers.',
};

describe('M363 work item objective fingerprints', () => {
  it('is stable across irrelevant whitespace while remaining objective-sensitive', () => {
    const hash = workItemObjectiveHash(base);

    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(workItemObjectiveHash({
      ...base,
      title: '  Implement   durable lease recovery  ',
      detail: 'Reclaim expired leases\nwithout disturbing active workers.',
    })).toBe(hash);
    expect(workItemObjectiveHash({ ...base, detail: 'Use different acceptance criteria.' })).not.toBe(hash);
    expect(workItemObjectiveHash({ ...base, source: 'todo' })).not.toBe(hash);
    expect(workItemObjectiveHash({ ...base, id: 'repo:goal:other' })).not.toBe(hash);
    expect(workItemObjectiveHash({ ...base, title: 'Caf\u0065\u0301 recovery' })).toBe(
      workItemObjectiveHash({ ...base, title: 'Caf\u00e9 recovery' }),
    );
  });

  it('hashes scrubbed metadata without persisting secret text', () => {
    const firstSecret = 'github_pat_1234567890abcdefghijklmnop';
    const secondSecret = 'github_pat_0987654321ponmlkjihgfedcba';
    const first = workItemObjectiveHash({ ...base, detail: `Rotate token ${firstSecret}` });
    const second = workItemObjectiveHash({ ...base, detail: `Rotate token ${secondSecret}` });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(first).not.toContain('github_pat_');
  });

  it('refuses to mint authority from a truncated persistent key', () => {
    const path = provenanceKeyPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from([1]), { mode: 0o600 });

    expect(workItemObjectiveHash(base)).toBeNull();
  });
});

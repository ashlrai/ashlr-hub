import { describe, expect, it } from 'vitest';
import { websiteStageArgs } from '../src/core/website/host-adapter.js';
import type { WebsiteOperation } from '../src/core/website/host-release.js';

const merge = 'a'.repeat(40);
function operation(): Pick<WebsiteOperation, 'revision' | 'source'> {
  return { revision: merge, source: { merge, head: 'b'.repeat(40), base: 'c'.repeat(40),
    tree: 'd'.repeat(40), pr: 123, rulesDigest: 'e'.repeat(64) } };
}

describe('prebuilt website stage source binding', () => {
  it('binds runtime and receipt metadata to the qualified operation merge', () => {
    expect(websiteStageArgs(operation())).toEqual([
      'deploy', '--prebuilt', '--prod', '--skip-domain', '--yes',
      '--env', `VERCEL_GIT_COMMIT_SHA=${merge}`, '--meta', `phantomSourceSha=${merge}`,
    ]);
  });

  it('selects each qualified merge instead of a fixed SHA or the PR head/base/tree', () => {
    const op = operation();
    op.revision = 'f'.repeat(40); op.source!.merge = op.revision;
    const args = websiteStageArgs(op);
    expect(args).toContain(`VERCEL_GIT_COMMIT_SHA=${op.revision}`);
    expect(args).toContain(`phantomSourceSha=${op.revision}`);
    for (const other of [merge, op.source!.head, op.source!.base, op.source!.tree]) {
      expect(args.some((arg) => arg.includes(other))).toBe(false);
    }
  });

  it('refuses missing qualification and a source that differs from the queued revision', () => {
    expect(() => websiteStageArgs({ revision: merge })).toThrow();
    const op = operation(); op.source!.merge = 'b'.repeat(40);
    expect(() => websiteStageArgs(op)).toThrow('does not match operation revision');
  });

  it.each(['main', 'a'.repeat(7), 'A'.repeat(40), 'g'.repeat(40),
    `${merge} --env OTHER=value`, `${merge}\n`, ''])('refuses invalid selected source %j', (invalid) => {
    const op = operation(); op.revision = invalid; op.source!.merge = invalid;
    expect(() => websiteStageArgs(op)).toThrow();
    op.revision = merge;
    expect(() => websiteStageArgs(op)).toThrow();
  });
});

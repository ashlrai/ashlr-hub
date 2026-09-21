/**
 * Guards the shared single-file-binary predicate.
 *
 * Inside a Bun-compiled binary every bundled module's `import.meta.url` and
 * `process.argv[1]` collapse to a virtual `/$bunfs/root/...` path. Two separate
 * places re-exec the binary and both got this wrong independently: the account
 * probes resolved a sibling `.js` that does not exist on disk, and the cutoff
 * checkpoint compared argv[1] to execPath. The account-probe symptom was the
 * visible one — Codex and Grok usage was missing from the shipping app while
 * present when run from source.
 */
import { describe, expect, it } from 'vitest';
import {
  bundledIntoSingleFileBinary,
  insideSingleFileBinaryRoot,
} from '../src/core/resources/probe-helper-invocation.js';

describe('single-file-binary detection is shared, not re-derived', () => {
  it('treats a bunfs argv[1] as compiled so the child is not given a virtual path', () => {
    // The account-probe helper and the cutoff-checkpoint supervisor both
    // re-exec the binary. The cutoff path detected "compiled" by comparing
    // argv[1] to execPath, which is false inside a Bun binary because argv[1]
    // is `/$bunfs/root/_entry.js`. The child was then spawned as
    // `<binary> /$bunfs/root/_entry.js --flag …` and rejected as an unknown
    // command. Both now ask the same predicate.
    expect(insideSingleFileBinaryRoot('/$bunfs/root/_entry.js')).toBe(true);
    expect(insideSingleFileBinaryRoot('B:\\~BUN\\root\\_entry.js')).toBe(true);
    expect(insideSingleFileBinaryRoot('/Users/someone/repo/dist/cli/index.js')).toBe(false);
    expect(insideSingleFileBinaryRoot('')).toBe(false);
  });

  it('agrees with the URL-shaped check it backs', () => {
    expect(bundledIntoSingleFileBinary('file:///$bunfs/root/ashlr')).toBe(true);
    expect(bundledIntoSingleFileBinary('file:///Users/someone/dist/core/x.js')).toBe(false);
    expect(bundledIntoSingleFileBinary('not a url')).toBe(false);
  });
});

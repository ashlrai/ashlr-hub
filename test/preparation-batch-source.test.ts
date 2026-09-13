/** Tiny real-Git source-lineage controls; no evaluator, bridge, or provider runs. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREPARATION_BATCH_TARGET, PREPARATION_BATCH_CURRENT_BLOB, PREPARATION_BATCH_BASELINE_BLOB,
  preparationSourceBlob, reconstructPreparationBatchBaseline } from './helpers/preparation-batch-source.js';

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const current = readFileSync(join(repository, PREPARATION_BATCH_TARGET), 'utf8');
const patch = readFileSync(join(repository, 'artifacts/hub-verification-batch-candidate.patch'));
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function realPatch() {
  const root = mkdtempSync(join(tmpdir(), 'ashlr-batch-source-')); roots.push(root);
  mkdirSync(join(root, dirname(PREPARATION_BATCH_TARGET)), { recursive: true, mode: 0o700 });
  return (source: string, reverse: boolean) => {
    const file = join(root, PREPARATION_BATCH_TARGET);
    writeFileSync(file, source, { mode: 0o600 });
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'apply', ...(reverse ? ['--reverse'] : []), '-'], {
      cwd: root, input: patch, timeout: 10000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    });
    return readFileSync(file, 'utf8');
  };
}

describe('adopted preparation batching source lineage', () => {
  it('reconstructs the exact safer baseline and round-trips the retained patch to current source', () => {
    const apply = vi.fn(realPatch());
    const baseline = reconstructPreparationBatchBaseline(current, patch, apply);
    expect(preparationSourceBlob(current)).toBe(PREPARATION_BATCH_CURRENT_BLOB);
    expect(preparationSourceBlob(baseline)).toBe(PREPARATION_BATCH_BASELINE_BLOB);
    expect(baseline).toContain('overlaps(runtime.workspace, row.workspace)');
    expect(current).toContain('overlaps(runtime.workspace, row.workspace)');
    expect(apply.mock.calls).toEqual([[current, true], [baseline, false]]);
    expect(readFileSync(join(repository, PREPARATION_BATCH_TARGET), 'utf8')).toBe(current);
  });

  it('refuses changed current source before invoking patch application', () => {
    const apply = vi.fn();
    expect(() => reconstructPreparationBatchBaseline(`${current}\n`, patch, apply)).toThrow('BATCH_CURRENT_SOURCE_MISMATCH');
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses changed patch bytes before invoking patch application', () => {
    const apply = vi.fn();
    expect(() => reconstructPreparationBatchBaseline(current, Buffer.concat([patch, Buffer.from('\n')]), apply)).toThrow('BATCH_PATCH_DIGEST_MISMATCH');
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses multi-target patches before invoking patch application', () => {
    const apply = vi.fn();
    const changed = Buffer.concat([patch, Buffer.from('\ndiff --git a/other.ts b/other.ts\n')]);
    expect(() => reconstructPreparationBatchBaseline(current, changed, apply)).toThrow('BATCH_PATCH_TARGET_MISMATCH');
    expect(apply).not.toHaveBeenCalled();
  });

  it('refuses an incorrect reconstructed baseline without attempting the forward patch', () => {
    const apply = vi.fn(() => current);
    expect(() => reconstructPreparationBatchBaseline(current, patch, apply)).toThrow('BATCH_BASELINE_SOURCE_MISMATCH');
    expect(apply.mock.calls).toEqual([[current, true]]);
  });

  it('refuses a nonidentical forward round-trip after a genuine reverse application', () => {
    const apply = realPatch();
    const observed = vi.fn((source: string, reverse: boolean) => reverse ? apply(source, reverse) : `${current}\n`);
    expect(() => reconstructPreparationBatchBaseline(current, patch, observed)).toThrow('BATCH_SOURCE_ROUNDTRIP_MISMATCH');
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it('propagates patch refusal without retrying or supplying a synthetic baseline', () => {
    const apply = vi.fn(() => { throw new Error('private patch refused'); });
    expect(() => reconstructPreparationBatchBaseline(current, patch, apply)).toThrow('private patch refused');
    expect(apply).toHaveBeenCalledOnce();
  });
});

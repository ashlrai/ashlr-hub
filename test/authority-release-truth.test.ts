/**
 * Release-truth regressions for the fail-closed authority salvage.
 *
 * These checks bind the public 3.3.0 record and documented configuration
 * surface to the production boundary: protected PR handoff is terminal, and
 * rejected local activation/host-merge authority is not shipped.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

function releaseBlock(version: string): string {
  const changelog = read('CHANGELOG.md');
  const start = changelog.indexOf(`## [${version}]`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = changelog.indexOf('\n## [', start + 1);
  return changelog.slice(start, next === -1 ? undefined : next);
}

describe('3.3.0 authority release truth', () => {
  it('describes dormant authority and protected handoff without removed surfaces', () => {
    const release = releaseBlock('3.3.0');

    expect(release).toMatch(/dormant and fail closed/i);
    expect(release).toContain('awaiting-host-merge');
    expect(release).toMatch(/does not run `gh pr merge`/i);
    expect(release).toContain('RUNTIME_ACTIVATION_AUTHORITY.md');

    for (const removedClaim of [
      'RUNTIME-FLEET-ACTIVATION.md',
      'ashlr activation init',
      'ashlr activation grant',
      'test/m470.activation-authority.test.ts',
      'test/m505.host-auto-merge.test.ts',
      'on-machine standing grants',
    ]) {
      expect(release).not.toContain(removedClaim);
    }
  });

  it('does not ship the rejected authority surfaces', () => {
    for (const removedPath of [
      'docs/RUNTIME-FLEET-ACTIVATION.md',
      'src/cli/activation.ts',
      'test/m470.activation-authority.test.ts',
      'test/m505.host-auto-merge.test.ts',
      'test/m506.host-auto-merge-e2e.test.ts',
      'test/m520.full-chain-merge-e2e.test.ts',
    ]) {
      expect(existsSync(join(ROOT, removedPath)), removedPath).toBe(false);
    }
  });
});

describe('pushToRemote public contract', () => {
  it('documents a protected PR handoff in the type and schema', () => {
    const types = read('src/core/types.ts');
    const schema = JSON.parse(read('schema/config.schema.json'));
    const description = schema.properties.foundry.properties.autoMerge
      .properties.pushToRemote.description as string;

    expect(types).toMatch(/protected PR handoff; never merges the hosted PR[\s\S]{0,100}pushToRemote/);
    expect(description).toMatch(/protected PR handoff; never merges the hosted PR/i);
    expect(description).not.toMatch(/gh pr merge|host auto-merge/i);
  });

  it('documents the same terminal handoff in the operator guide', () => {
    const row = read('docs/FOUNDRY-CONFIG.md')
      .split('\n')
      .find((line) => line.includes('`pushToRemote`'));

    expect(row).toMatch(/protected PR handoff; never merge the hosted PR/i);
    expect(row).not.toMatch(/gh pr merge|host auto-merge/i);
  });

  it('keeps the M56 contract at protected PR handoff with no hosted merge claim', () => {
    const contract = read('docs/contracts/CONTRACT-M56.md');

    expect(contract).toMatch(/protection-checked PR[\s\S]{0,100}awaiting-host-merge/i);
    expect(contract).toMatch(/hosted merge is outside this module/i);
    expect(contract).not.toMatch(/gh pr merge|squash-merge to main/i);
  });

  it('keeps milestone cross-references aligned with the fail-closed release heading', () => {
    const milestones = read('docs/MILESTONE-INDEX.md');

    expect(milestones).toContain('CHANGELOG\'s "Fail-closed runtime boundaries"');
    expect(milestones).not.toContain('CHANGELOG\'s "Fleet activation unblocked"');
  });

  it('contains no host merge effect, caller, or configuration key', () => {
    const merge = read('src/core/inbox/merge.ts');
    const types = read('src/core/types.ts');
    const schema = read('schema/config.schema.json');

    expect(merge).not.toContain('attemptHostAutoMerge');
    expect(merge).not.toContain('hostMergeGhPrMerge');
    expect(merge).not.toMatch(/["']pr["']\s*,\s*["']merge["']/);
    expect(types).not.toContain('hostAutoMerge');
    expect(schema).not.toContain('hostAutoMerge');
  });
});

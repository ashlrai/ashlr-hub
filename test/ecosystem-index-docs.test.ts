import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface EcosystemIndex {
  source: {
    includedRepoCount: number;
    excluded: Array<{ directory: string; reason: string }>;
  };
  coverage: {
    standaloneDetailedProfiles: number;
    compositionOnlyProfiles: number;
    inventoryOnlyProfiles: number;
  };
  repositories: Array<{
    id: string;
    directory: string;
    displayName: string;
    profileState: 'expanded' | 'composition-only' | 'inventory-only';
  }>;
}

function readIndex(): EcosystemIndex {
  return JSON.parse(readFileSync(join(process.cwd(), 'docs', 'ecosystem-index.json'), 'utf8')) as EcosystemIndex;
}

function readMap(): string {
  return readFileSync(join(process.cwd(), 'docs', 'ECOSYSTEM-MAP.md'), 'utf8');
}

describe('ecosystem docs inventory', () => {
  it('keeps the machine-readable ecosystem index aligned to the 21 active dev-tools repos', () => {
    const index = readIndex();
    const directories = index.repositories.map((repo) => repo.directory);

    expect(index.source.includedRepoCount).toBe(21);
    expect(index.repositories).toHaveLength(21);
    expect(new Set(directories).size).toBe(21);
    expect(directories).not.toContain('binshield-internal-backup');
    expect(index.source.excluded.some((entry) => entry.directory === 'binshield-internal-backup')).toBe(true);
    expect(directories).toEqual([
      'ashlr-auth',
      'ashlr-cli-common',
      'ashlr-config',
      'ashlr-core-efficiency',
      'ashlr-cost',
      'ashlr-hub',
      'ashlr-mcp-kit',
      'ashlr-md',
      'ashlr-plugin',
      'ashlr-pulse',
      'ashlr-workbench',
      'ashlrcode',
      'binshield',
      'homebrew-ashlr',
      'homebrew-phantom',
      'morphkit',
      'openclaw-setup',
      'phantom-secrets',
      'prompt-trackr',
      'stack',
      'webfetch',
    ]);
  });

  it('keeps the Markdown inventory table and JSON profile coverage in sync', () => {
    const index = readIndex();
    const map = readMap();

    expect(map).toContain('## Current 21-repo inventory');
    expect(map).toContain('[`docs/ecosystem-index.json`](./ecosystem-index.json)');

    for (const repo of index.repositories) {
      expect(map).toContain(`| ${repo.displayName} |`);
    }

    const expanded = index.repositories.filter((repo) => repo.profileState === 'expanded').length;
    const compositionOnly = index.repositories.filter((repo) => repo.profileState === 'composition-only').length;
    const inventoryOnly = index.repositories.filter((repo) => repo.profileState === 'inventory-only').length;
    expect(index.coverage).toEqual({
      standaloneDetailedProfiles: expanded,
      compositionOnlyProfiles: compositionOnly,
      inventoryOnlyProfiles: inventoryOnly,
    });
  });
});

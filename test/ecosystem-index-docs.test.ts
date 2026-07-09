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
  strategicFocus: {
    coreFleetRepos: string[];
    externalCoreCandidates: Array<{ id: string; status: string; owner: string }>;
    forceMultiplierRepos: string[];
    supportingRepos: string[];
  };
  ownershipBoundaries: {
    principle: string;
    boundaries: Array<{
      id: string;
      label: string;
      owner: string;
      scope: 'local-repositories' | 'external-repositories';
      repoIds: string[];
      externalRepoIds: string[];
      directive: string;
    }>;
  };
  repositories: Array<{
    id: string;
    directory: string;
    displayName: string;
    profileState: 'expanded' | 'composition-only' | 'inventory-only';
    strategicTier: 'core-fleet' | 'force-multiplier' | 'supporting' | 'inventory';
  }>;
}

function readIndex(): EcosystemIndex {
  return JSON.parse(readFileSync(join(process.cwd(), 'docs', 'ecosystem-index.json'), 'utf8')) as EcosystemIndex;
}

function readMap(): string {
  return readFileSync(join(process.cwd(), 'docs', 'ECOSYSTEM-MAP.md'), 'utf8');
}

function displayNamesForBoundary(index: EcosystemIndex, boundary: EcosystemIndex['ownershipBoundaries']['boundaries'][number]): string {
  const repoNamesById = new Map(index.repositories.map((repo) => [repo.id, repo.displayName]));
  const localNames = boundary.repoIds.map((id) => repoNamesById.get(id) ?? id);
  return [...localNames, ...boundary.externalRepoIds].join(', ');
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

  it('keeps the core fleet spine explicit without counting unavailable external repos', () => {
    const index = readIndex();
    const map = readMap();
    const repoIds = new Set(index.repositories.map((repo) => repo.id));
    const coreFleetRepos = [
      'ashlr-hub',
      'phantom-secrets',
      'ashlr-plugin',
      'binshield',
      'ashlr-md',
      'stack',
      'ashlr-pulse',
      'ashlrcode',
      'ashlr-workbench',
    ];

    expect(index.strategicFocus.coreFleetRepos).toEqual(coreFleetRepos);
    expect(new Set(index.strategicFocus.coreFleetRepos).size).toBe(coreFleetRepos.length);
    for (const id of coreFleetRepos) {
      expect(repoIds.has(id), id).toBe(true);
      expect(index.repositories.find((repo) => repo.id === id)?.strategicTier, id).toBe('core-fleet');
    }

    expect(repoIds.has('ashlr-mux')).toBe(false);
    expect(index.strategicFocus.externalCoreCandidates).toContainEqual(
      expect.objectContaining({
        id: 'ashlr-mux',
        status: 'not-in-local-dev-tools-inventory',
        owner: 'cofounder',
      }),
    );

    expect(map).toContain('### Strategic focus tiers');
    expect(map).toContain('| **Core fleet spine** | ashlr-hub, phantom-secrets, ashlr-plugin, binshield, ashlr-md, ashlr-stack, ashlr-pulse, ashlrcode, ashlr-workbench |');
    expect(map).toContain('| **Core-adjacent candidate** | ashlr-mux |');
  });

  it('keeps ownership boundaries complete, disjoint, and aligned with the Markdown map', () => {
    const index = readIndex();
    const map = readMap();
    const repoIds = new Set(index.repositories.map((repo) => repo.id));
    const externalCandidateIds = new Set(index.strategicFocus.externalCoreCandidates.map((candidate) => candidate.id));
    const boundaryLocalRepoIds = index.ownershipBoundaries.boundaries.flatMap((boundary) => boundary.repoIds);
    const boundaryExternalRepoIds = index.ownershipBoundaries.boundaries.flatMap((boundary) => boundary.externalRepoIds);

    expect(index.ownershipBoundaries.principle).toContain('ownership');
    expect(index.ownershipBoundaries.boundaries.map((boundary) => boundary.id)).toEqual([
      'local-core-fleet-spine',
      'local-force-multipliers',
      'local-supporting-substrate',
      'standalone-consumer-product',
      'external-core-adjacent-candidate',
    ]);

    expect(new Set(boundaryLocalRepoIds).size).toBe(boundaryLocalRepoIds.length);
    expect([...boundaryLocalRepoIds].sort()).toEqual([...repoIds].sort());
    for (const externalRepoId of boundaryExternalRepoIds) {
      expect(repoIds.has(externalRepoId), externalRepoId).toBe(false);
      expect(externalCandidateIds.has(externalRepoId), externalRepoId).toBe(true);
    }

    expect(map).toContain('### Ownership boundaries');
    expect(map).toContain('top-level `ownershipBoundaries` section');
    for (const boundary of index.ownershipBoundaries.boundaries) {
      expect(boundary.id).toMatch(/^[a-z0-9-]+$/);
      expect(boundary.label.length, boundary.id).toBeGreaterThan(0);
      expect(boundary.owner.length, boundary.id).toBeGreaterThan(0);
      expect(boundary.directive.length, boundary.id).toBeGreaterThan(0);
      expect(boundary.repoIds.length + boundary.externalRepoIds.length, boundary.id).toBeGreaterThan(0);

      if (boundary.scope === 'local-repositories') {
        expect(boundary.externalRepoIds, boundary.id).toEqual([]);
      } else {
        expect(boundary.repoIds, boundary.id).toEqual([]);
      }

      for (const repoId of boundary.repoIds) {
        expect(repoIds.has(repoId), `${boundary.id}:${repoId}`).toBe(true);
      }

      const repos = displayNamesForBoundary(index, boundary);
      expect(map).toContain(`| ${boundary.label} | ${boundary.owner} | ${repos} | ${boundary.directive} |`);
    }
  });
});

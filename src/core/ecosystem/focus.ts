/**
 * Strategic ecosystem focus.
 *
 * Reads docs/ecosystem-index.json as a read-only product/strategy input so the
 * runtime can prioritize the few repos that compound the autonomous fleet.
 * Never throws; unknown repos fall back to neutral inventory treatment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StrategicTier = 'core-fleet' | 'force-multiplier' | 'supporting' | 'inventory';

export interface EcosystemFocus {
  coreFleetRepos: string[];
  forceMultiplierRepos: string[];
  supportingRepos: string[];
  externalCoreCandidates: Array<{ id: string; status: string; owner?: string }>;
}

interface EcosystemIndexRepo {
  id?: unknown;
  directory?: unknown;
  displayName?: unknown;
  strategicTier?: unknown;
}

interface EcosystemIndexShape {
  strategicFocus?: {
    coreFleetRepos?: unknown;
    forceMultiplierRepos?: unknown;
    supportingRepos?: unknown;
    externalCoreCandidates?: unknown;
  };
  repositories?: unknown;
}

export const DEFAULT_ECOSYSTEM_FOCUS: EcosystemFocus = {
  coreFleetRepos: [
    'ashlr-hub',
    'phantom-secrets',
    'ashlr-plugin',
    'binshield',
    'ashlr-md',
    'stack',
    'ashlr-pulse',
    'ashlrcode',
    'ashlr-workbench',
  ],
  forceMultiplierRepos: [
    'ashlr-core-efficiency',
    'morphkit',
    'webfetch',
    'prompt-trackr',
  ],
  supportingRepos: [
    'ashlr-auth',
    'ashlr-cli-common',
    'ashlr-config',
    'ashlr-cost',
    'ashlr-mcp-kit',
    'homebrew-ashlr',
    'homebrew-phantom',
    'openclaw-setup',
  ],
  externalCoreCandidates: [{
    id: 'ashlr-mux',
    status: 'not-in-local-dev-tools-inventory',
    owner: 'cofounder',
  }],
};

const TIER_RANK: Record<StrategicTier, number> = {
  'core-fleet': 0,
  'force-multiplier': 1,
  inventory: 2,
  supporting: 3,
};

const TIER_MULTIPLIER: Record<StrategicTier, number> = {
  'core-fleet': 1.35,
  'force-multiplier': 1.12,
  inventory: 1.0,
  supporting: 0.85,
};

let focusCache: {
  focus: EcosystemFocus;
  byName: Map<string, StrategicTier>;
} | null = null;

function findRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = resolve('/');
  while (dir !== root) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return existsSync(join(root, 'package.json')) ? root : null;
}

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

function ecosystemIndexPath(): string | null {
  try {
    const repoRoot = findRepoRoot(moduleDir()) ?? process.cwd();
    const candidate = join(repoRoot, 'docs', 'ecosystem-index.json');
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function externalCandidates(value: unknown): EcosystemFocus['externalCoreCandidates'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || typeof record['status'] !== 'string') return [];
    return [{
      id: record['id'],
      status: record['status'],
      ...(typeof record['owner'] === 'string' ? { owner: record['owner'] } : {}),
    }];
  });
}

function isStrategicTier(value: unknown): value is StrategicTier {
  return value === 'core-fleet' ||
    value === 'force-multiplier' ||
    value === 'supporting' ||
    value === 'inventory';
}

function addAliases(byName: Map<string, StrategicTier>, name: unknown, tier: StrategicTier): void {
  if (typeof name !== 'string' || name.length === 0) return;
  byName.set(name, tier);
  if (name.startsWith('ashlr-')) byName.set(name.slice('ashlr-'.length), tier);
  else byName.set(`ashlr-${name}`, tier);
  if (name.startsWith('@ashlr/')) byName.set(name.slice('@ashlr/'.length), tier);
}

function buildFromDefault(): { focus: EcosystemFocus; byName: Map<string, StrategicTier> } {
  const byName = new Map<string, StrategicTier>();
  for (const id of DEFAULT_ECOSYSTEM_FOCUS.coreFleetRepos) addAliases(byName, id, 'core-fleet');
  for (const id of DEFAULT_ECOSYSTEM_FOCUS.forceMultiplierRepos) addAliases(byName, id, 'force-multiplier');
  for (const id of DEFAULT_ECOSYSTEM_FOCUS.supportingRepos) addAliases(byName, id, 'supporting');
  return { focus: DEFAULT_ECOSYSTEM_FOCUS, byName };
}

function loadFocus(): { focus: EcosystemFocus; byName: Map<string, StrategicTier> } {
  if (focusCache) return focusCache;
  const fallback = buildFromDefault();
  try {
    const path = ecosystemIndexPath();
    if (!path) {
      focusCache = fallback;
      return focusCache;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as EcosystemIndexShape;
    const rawFocus = parsed.strategicFocus ?? {};
    const focus: EcosystemFocus = {
      coreFleetRepos: stringArray(rawFocus.coreFleetRepos),
      forceMultiplierRepos: stringArray(rawFocus.forceMultiplierRepos),
      supportingRepos: stringArray(rawFocus.supportingRepos),
      externalCoreCandidates: externalCandidates(rawFocus.externalCoreCandidates),
    };
    if (focus.coreFleetRepos.length === 0) focus.coreFleetRepos = fallback.focus.coreFleetRepos;
    if (focus.forceMultiplierRepos.length === 0) focus.forceMultiplierRepos = fallback.focus.forceMultiplierRepos;
    if (focus.supportingRepos.length === 0) focus.supportingRepos = fallback.focus.supportingRepos;
    if (focus.externalCoreCandidates.length === 0) focus.externalCoreCandidates = fallback.focus.externalCoreCandidates;

    const byName = new Map<string, StrategicTier>();
    for (const id of focus.coreFleetRepos) addAliases(byName, id, 'core-fleet');
    for (const id of focus.forceMultiplierRepos) addAliases(byName, id, 'force-multiplier');
    for (const id of focus.supportingRepos) addAliases(byName, id, 'supporting');
    const repos = Array.isArray(parsed.repositories) ? parsed.repositories as EcosystemIndexRepo[] : [];
    for (const repo of repos) {
      const tier = isStrategicTier(repo.strategicTier) ? repo.strategicTier : 'inventory';
      addAliases(byName, repo.id, tier);
      addAliases(byName, repo.directory, tier);
      addAliases(byName, repo.displayName, tier);
    }

    focusCache = { focus, byName };
    return focusCache;
  } catch {
    focusCache = fallback;
    return focusCache;
  }
}

export function resetEcosystemFocusCacheForTests(): void {
  focusCache = null;
}

export function loadEcosystemFocus(): EcosystemFocus {
  return loadFocus().focus;
}

export function strategicTierOfRepo(repo: string): StrategicTier {
  try {
    const base = basename(resolve(repo));
    return loadFocus().byName.get(base) ?? 'inventory';
  } catch {
    return 'inventory';
  }
}

export function strategicTierMultiplier(tier: StrategicTier): number {
  return TIER_MULTIPLIER[tier] ?? 1.0;
}

export function strategicRepoMultiplier(repo: string): number {
  return strategicTierMultiplier(strategicTierOfRepo(repo));
}

export function compareReposByStrategicFocus(a: string, b: string): number {
  return TIER_RANK[strategicTierOfRepo(a)] - TIER_RANK[strategicTierOfRepo(b)];
}

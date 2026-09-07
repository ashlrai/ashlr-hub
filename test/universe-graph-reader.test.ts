import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initUniverse, initUniverseCampaign, readUniverseGraph, type UniverseManifest } from '../src/core/universe/index.js';

const roots: string[] = [];
afterEach(() => {
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) writable(join(path, name));
  };
  for (const root of roots.splice(0)) { writable(root); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), 'universe-graph-reader-')));
  roots.push(outer);
  const root = join(outer, 'store');
  const repo = join(outer, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  writeFileSync(join(repo, 'never-run.mjs'), "throw new Error('Graph inspection must not execute work');\n");
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' } }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Graph Fixture', '-c', 'user.email=graph@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed');
  const manifest: UniverseManifest = { schemaVersion: 1, id: 'target', name: 'Graph fixture', objective: 'Inspect without running',
    seed: { repo, revision: git('rev-parse', 'HEAD') }, metric: { name: 'score', direction: 'maximize', minImprovement: 0 },
    budget: { maxTrials: 1, maxDurationMs: 1000, trialTimeoutMs: 1000, maxParallel: 1 },
    evaluation: { command: [process.execPath, 'never-run.mjs'], timeoutMs: 1000 },
    variants: [{ id: 'never-run', niche: 'quality', hypothesis: 'Only inspect', command: [process.execPath, 'never-run.mjs'] }] };
  const init = (id = 'target') => initUniverse({ ...manifest, id }, { root });
  const campaign = (id: string, universeId = 'target') => initUniverseCampaign({ schemaVersion: 1, id, universeId, feedback: false,
    budget: { maxGenerations: 1, maxDurationMs: 1000, maxModelRequests: 0, maxStagnantGenerations: 1, maxReportedTokens: null } }, { root });
  return { root, outer, repo, init, campaign, git };
}

describe('targeted Universe graph observation', () => {
  it('does not create a missing root and validates the id before reading', () => {
    const f = fixture();
    expect(readUniverseGraph('target', { root: f.root })).toMatchObject({ sourceState: 'missing', nodes: [] });
    expect(() => readUniverseGraph('../escape', { root: f.root })).toThrow('Invalid Universe id');
    expect(existsSync(f.root)).toBe(false);
  });

  it('projects an unrun experiment and matching campaign without changing source or ledger bytes', () => {
    const f = fixture(); f.init(); f.campaign('target-search');
    const ledger = join(f.root, 'universes', 'target', 'ledger', 'records');
    const before = readdirSync(ledger).map((name) => [name, readFileSync(join(ledger, name), 'utf8')]);
    const head = f.git('rev-parse', 'HEAD');
    const graph = readUniverseGraph('target', { root: f.root });
    expect(graph).toMatchObject({ sourceState: 'healthy', complete: true, authority: 'observation-only' });
    expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(['universe', 'seed', 'comparator', 'campaign']));
    expect(graph.nodes.some((node) => node.kind === 'run' || node.kind === 'trial')).toBe(false);
    expect(readdirSync(ledger).map((name) => [name, readFileSync(join(ledger, name), 'utf8')])).toEqual(before);
    expect(f.git('rev-parse', 'HEAD')).toBe(head);
    expect(f.git('status', '--porcelain')).toBe('');
  });

  it('does not inspect an unrelated broken experiment or its campaign history', () => {
    const f = fixture(); f.init(); f.init('other'); f.campaign('other-search', 'other');
    // The creation point remains readable, but unrelated history and Universe are damaged.
    writeFileSync(join(f.root, 'campaigns', 'other-search', 'ledger', 'records', '00000001.json'), '{broken', { mode: 0o600 });
    writeFileSync(join(f.root, 'universes', 'other', 'ledger', 'records', 'manifest.json'), '{broken', { mode: 0o600 });
    const graph = readUniverseGraph('target', { root: f.root });
    expect(graph).toMatchObject({ sourceState: 'healthy', complete: true });
    expect(graph.nodes.some((node) => node.kind === 'campaign')).toBe(false);
  });

  it('does not silently skip a matching campaign with corrupt history', () => {
    const f = fixture(); f.init(); f.campaign('target-search');
    writeFileSync(join(f.root, 'campaigns', 'target-search', 'ledger', 'records', '00000001.json'), '{broken', { mode: 0o600 });
    const graph = readUniverseGraph('target', { root: f.root });
    expect(graph.sourceState).toBe('degraded');
    expect(graph.complete).toBe(false);
    expect(graph.issues.length).toBeGreaterThan(0);
  });

  it('treats unattributable campaign identities as an incomplete inventory', () => {
    const f = fixture(); f.init(); f.init('other'); f.campaign('other-search', 'other');
    writeFileSync(join(f.root, 'campaigns', 'other-search', 'ledger', 'records', '00000000.json'), '{broken', { mode: 0o600 });
    expect(readUniverseGraph('target', { root: f.root })).toMatchObject({ sourceState: 'degraded', complete: false });
  });

  it('distinguishes an absent selected experiment from corrupt selected evidence', () => {
    const f = fixture(); f.init();
    expect(readUniverseGraph('absent', { root: f.root }).sourceState).toBe('missing');
    writeFileSync(join(f.root, 'universes', 'target', 'ledger', 'records', 'manifest.json'), '{broken', { mode: 0o600 });
    expect(readUniverseGraph('target', { root: f.root })).toMatchObject({ sourceState: 'degraded', complete: false, nodes: [] });
  });

  it('rejects a symlinked store without traversing or replacing it', () => {
    const f = fixture(); f.init();
    const link = join(f.outer, 'alias'); symlinkSync(f.root, link);
    expect(readUniverseGraph('target', { root: link })).toMatchObject({ sourceState: 'degraded', complete: false });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readUniverseGraph('target', { root: f.root }).sourceState).toBe('healthy');
  });
});

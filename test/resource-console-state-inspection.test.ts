/** Shared startup codecs; inspection itself never starts an owner or publishes state. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { decodeResourceConsoleState, previewResourceConsoleProjects, createResourcePoolSupervisor,
  type ResourceConsoleDurableState } from '../src/core/resources/pool-supervisor.js';
import { readResourceJson } from '../src/core/resources/pool-runtime.js';
import { validateResourcePool } from '../src/core/resources/pool-policy.js';
import { validateResourceBindings } from '../src/core/resources/worker.js';

let base: string; let workspace: string; let extra: string;
const pool = validateResourcePool({ schemaVersion: 1, id: 'inspection', workers: [{ id: 'local', provider: 'local', model: 'fixture',
  maxConcurrent: 1, maxTasksPerWindow: 4, taskWindowMs: 60_000, priority: 1, reservePercent: 10 }] });
const bindings = validateResourceBindings([{ workerId: 'local', capacityKey: 'local', kind: 'local-chat', endpoint: 'http://127.0.0.1:1/v1' }], pool);
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'console-state-inspection-')));
  workspace = join(base, 'default'); extra = join(base, 'extra');
  mkdirSync(workspace); mkdirSync(extra);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const state = (schemaVersion: 1 | 2 | 3 = 1): ResourceConsoleDurableState => ({
  schemaVersion, scopeDigest: digest(canonical({ pool, bindings, workspace })), paused: true, jobs: [],
});
const options = () => ({ pool, bindings, workspace });
const projects = () => [{ id: 'extra', label: 'Extra', workspace: extra }];

describe('strict read-only console state inspection', () => {
  it.each([1, 2, 3] as const)('decodes complete legacy schema%i without upgrading or mutating it', (version) => {
    const source = state(version); const before = canonical(source); const files = readdirSync(base);
    const parsed = decodeResourceConsoleState(source, options());
    expect(parsed).toEqual(source); expect(parsed).not.toBe(source);
    parsed.paused = false; expect(canonical(source)).toBe(before); expect(readdirSync(base)).toEqual(files);
  });
  it('rejects malformed full jobs, foreign scope and accessor input without invoking getters', () => {
    const valid = state();
    expect(() => decodeResourceConsoleState({ ...valid, jobs: [{ id: 'invalid' }] }, options())).toThrow();
    expect(() => decodeResourceConsoleState({ ...valid, scopeDigest: 'a'.repeat(64) }, options())).toThrow();
    let invoked = false;
    const accessor = { ...valid, get schemaVersion() { invoked = true; return 4; } };
    expect(() => decodeResourceConsoleState(accessor, options())).toThrow(); expect(invoked).toBe(false);
    const jobs: unknown[] = []; Object.defineProperty(jobs, '0', { enumerable: true, get() { invoked = true; return {}; } });
    expect(() => decodeResourceConsoleState({ ...valid, jobs }, options())).toThrow(); expect(invoked).toBe(false);
    expect(readdirSync(base).sort()).toEqual(['default', 'extra']);
  });
  it('labels missing and legacy registration honestly and does not create accounting storage', () => {
    expect(previewResourceConsoleProjects({ workspace })).toMatchObject({ registration: 'not-configured', changed: false });
    for (const prior of [undefined, state(1), state(2), state(3)]) {
      const preview = previewResourceConsoleProjects({ workspace, projects: projects(), state: prior });
      expect(preview).toMatchObject({ registration: 'would-register', changed: true });
      expect(preview.bindings).toHaveLength(2);
      expect(preview.projects?.map((project) => project.enabled)).toEqual([true, true]);
    }
    expect(readdirSync(base).sort()).toEqual(['default', 'extra']);
  });
  it('preserves historical inode pins across drift, omission and display relabeling', () => {
    const first = previewResourceConsoleProjects({ workspace, projects: projects() });
    const persisted: ResourceConsoleDurableState = { ...state(), schemaVersion: 4, projects: first.bindings };
    const before = canonical(persisted); renameSync(extra, join(base, 'original-extra')); mkdirSync(extra);
    const decoded = decodeResourceConsoleState(persisted, options());
    const disabled = previewResourceConsoleProjects({ workspace, projects: [], state: decoded });
    expect(disabled).toMatchObject({ registration: 'persisted', changed: false });
    expect(disabled.projects?.[1]?.enabled).toBe(false); expect(disabled.bindings).toEqual(first.bindings);
    const renamed = previewResourceConsoleProjects({ workspace, projects: [{ ...projects()[0]!, label: 'Relabeled' }], state: decoded });
    expect(renamed).toMatchObject({ registration: 'persisted', changed: true });
    expect(renamed.bindings?.[1]?.ino).toBe(first.bindings?.[1]?.ino); expect(canonical(persisted)).toBe(before);
    expect(() => previewResourceConsoleProjects({ workspace, projects: [{ ...projects()[0]!, workspace: join(base, 'original-extra') }], state: decoded })).toThrow('cannot be changed');
  });
  it('marks appended bindings as proposed and matches the actual startup migration exactly', async () => {
    const first = previewResourceConsoleProjects({ workspace, projects: [] });
    const source: ResourceConsoleDurableState = { ...state(), schemaVersion: 4, projects: first.bindings };
    expect(previewResourceConsoleProjects({ workspace, projects: projects(), state: source }).registration).toBe('would-register');
    const projected = previewResourceConsoleProjects({ workspace, projects: projects() });
    // Only fixture setup starts a supervisor, with no tasks or usable transport.
    const root = join(base, 'accounting');
    const owner = await createResourcePoolSupervisor({ root, ...options(), projects: projects(), readObservations: () => [], pollIntervalMs: 60_000 });
    try {
      const persisted = decodeResourceConsoleState(readResourceJson(join(root, 'resource-console-state.json')), options());
      expect(persisted.projects).toEqual(projected.bindings); expect(owner.projects()).toEqual(projected.projects);
      expect(previewResourceConsoleProjects({ workspace, projects: projects(), state: persisted })).toMatchObject({ registration: 'persisted', changed: false });
    } finally { await owner.close(); }
  });
});

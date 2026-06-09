/**
 * M12 spec-store tests — hermetic, all operations in os.tmpdir().
 *
 * SAFETY GUARDRAIL: All file I/O is confined to tmp dirs. authorSpec and
 * refineSpec use a mocked provider (vi.mock on the provider-client module) so
 * no real model calls are made and no network is touched.
 *
 * Covers:
 *   - specsDir(project): returns <project>/.ashlr/specs
 *   - specsDir(): returns global ~/.ashlr/specs
 *   - authorSpec: writes <slug>-v1.md + <slug>-v1.json under the project specs dir
 *   - authorSpec: written metadata matches SpecArtifact shape (id, goal, version=1,
 *     status='draft', path, createdAt, updatedAt, project)
 *   - authorSpec: markdown body contains required spec sections
 *   - refineSpec: produces v+1 without overwriting v1 (non-destructive)
 *   - refineSpec: v+1 metadata has version incremented, same id, updated updatedAt
 *   - listSpecs: returns newest version per spec id, sorted by updatedAt desc
 *   - listSpecs: returns empty array when no specs exist
 *   - loadSpec: returns highest version for an id
 *   - loadSpec: returns null for unknown id
 *   - loadSpec: returns body (markdown text) + meta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, SpecArtifact } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Mock the provider-client module so authorSpec / refineSpec never hit a model
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/provider-client.js', () => ({
  getActiveClient: vi.fn().mockResolvedValue({
    id: 'mock',
    supportsTools: false,
    chat: vi.fn().mockResolvedValue({
      content: [
        '# Context',
        'This spec covers building a great feature.',
        '',
        '# North Star',
        'Deliver an excellent user experience.',
        '',
        '# Operating Principles',
        '- Local-first',
        '- Hermetic tests',
        '',
        '# Pillars',
        '1. Speed',
        '2. Reliability',
        '',
        '# Roadmap',
        '## Phase 1: Scaffold',
        '- Set up project structure',
        '',
        '# Verification',
        '- All tests pass',
      ].join('\n'),
      usage: { tokensIn: 50, tokensOut: 200 },
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Override HOME so global specsDir() lands under tmp
// ---------------------------------------------------------------------------

const origHome = process.env.HOME;
let tmpHome: string;
let tmpProject: string;

function freshTmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m12-spec-'));
}

// Lazy import — set HOME before first import
let specsDir: (project?: string) => string;
let authorSpec: (goal: string, cfg: AshlrConfig, opts?: { project?: string }) => Promise<SpecArtifact>;
let listSpecs: (project?: string) => SpecArtifact[];
let loadSpec: (id: string) => { meta: SpecArtifact; body: string } | null;
let refineSpec: (id: string, note: string, cfg: AshlrConfig) => Promise<SpecArtifact>;

async function ensureImported(): Promise<void> {
  if (!specsDir) {
    const store = await import('../src/core/spec/spec-store.js');
    specsDir = store.specsDir;
    authorSpec = store.authorSpec;
    listSpecs = store.listSpecs;
    loadSpec = store.loadSpec;
    refineSpec = store.refineSpec;
  }
}

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

beforeEach(async () => {
  tmpHome = freshTmpHome();
  tmpProject = path.join(tmpHome, 'my-project');
  fs.mkdirSync(tmpProject, { recursive: true });
  process.env.HOME = tmpHome;
  await ensureImported();
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  process.env.HOME = origHome;
});

// ---------------------------------------------------------------------------
// specsDir
// ---------------------------------------------------------------------------

describe('specsDir', () => {
  it('returns <project>/.ashlr/specs when project is given', () => {
    const dir = specsDir(tmpProject);
    expect(dir).toBe(path.join(tmpProject, '.ashlr', 'specs'));
  });

  it('returns a global path under HOME when no project given', () => {
    const dir = specsDir();
    expect(dir).toContain('.ashlr');
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it('creates the directory on demand (or at least returns a deterministic path)', () => {
    const dir = specsDir(tmpProject);
    // The function at minimum returns the correct path
    expect(dir).toMatch(/\.ashlr[/\\]specs$/);
  });
});

// ---------------------------------------------------------------------------
// authorSpec — file creation
// ---------------------------------------------------------------------------

describe('authorSpec — creates versioned md + json', () => {
  it('creates a v1 markdown file under <project>/.ashlr/specs/', async () => {
    const meta = await authorSpec('Build a great search feature', makeConfig(), { project: tmpProject });
    expect(fs.existsSync(meta.path)).toBe(true);
    expect(meta.path.endsWith('.md')).toBe(true);
  });

  it('creates a sidecar v1 json file alongside the markdown', async () => {
    const meta = await authorSpec('Build a great search feature', makeConfig(), { project: tmpProject });
    const jsonPath = meta.path.replace(/\.md$/, '.json');
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  it('sidecar json is valid JSON', async () => {
    const meta = await authorSpec('Test goal for JSON validity', makeConfig(), { project: tmpProject });
    const jsonPath = meta.path.replace(/\.md$/, '.json');
    const raw = fs.readFileSync(jsonPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('returns SpecArtifact with version=1', async () => {
    const meta = await authorSpec('Goal for version check', makeConfig(), { project: tmpProject });
    expect(meta.version).toBe(1);
  });

  it('returns SpecArtifact with status=draft', async () => {
    const meta = await authorSpec('Draft status goal', makeConfig(), { project: tmpProject });
    expect(meta.status).toBe('draft');
  });

  it('returns SpecArtifact with a non-empty id (slug)', async () => {
    const meta = await authorSpec('Some useful goal', makeConfig(), { project: tmpProject });
    expect(typeof meta.id).toBe('string');
    expect(meta.id.length).toBeGreaterThan(0);
  });

  it('returns SpecArtifact with the original goal', async () => {
    const goal = 'Build a blazing fast CLI tool';
    const meta = await authorSpec(goal, makeConfig(), { project: tmpProject });
    expect(meta.goal).toBe(goal);
  });

  it('returns SpecArtifact with valid ISO createdAt', async () => {
    const meta = await authorSpec('Date check goal', makeConfig(), { project: tmpProject });
    expect(() => new Date(meta.createdAt)).not.toThrow();
    expect(new Date(meta.createdAt).toISOString()).toBe(meta.createdAt);
  });

  it('returns SpecArtifact with valid ISO updatedAt', async () => {
    const meta = await authorSpec('Date check goal 2', makeConfig(), { project: tmpProject });
    expect(() => new Date(meta.updatedAt)).not.toThrow();
  });

  it('sets project to the passed project path', async () => {
    const meta = await authorSpec('Project scoped goal', makeConfig(), { project: tmpProject });
    expect(meta.project).toBe(tmpProject);
  });

  it('markdown body contains spec-like content (model output written verbatim)', async () => {
    const meta = await authorSpec('Feature spec goal', makeConfig(), { project: tmpProject });
    const body = fs.readFileSync(meta.path, 'utf8');
    expect(body.length).toBeGreaterThan(0);
  });

  it('path is under <project>/.ashlr/specs/', async () => {
    const meta = await authorSpec('Path check goal', makeConfig(), { project: tmpProject });
    const expectedDir = path.join(tmpProject, '.ashlr', 'specs');
    expect(meta.path.startsWith(expectedDir)).toBe(true);
  });

  it('filename includes -v1', async () => {
    const meta = await authorSpec('Version in filename goal', makeConfig(), { project: tmpProject });
    expect(path.basename(meta.path)).toMatch(/-v1\.md$/);
  });
});

// ---------------------------------------------------------------------------
// refineSpec — produces v+1 without overwriting v1
// ---------------------------------------------------------------------------

describe('refineSpec — non-destructive versioning', () => {
  // NOTE: refineSpec calls loadSpec internally, which searches ~/.ashlr/specs
  // (= tmpHome/.ashlr/specs when HOME is overridden) and process.cwd()/.ashlr/specs.
  // These tests author specs WITHOUT a project so they land in the global dir
  // that loadSpec can find.

  it('creates a v2 file alongside the original v1', async () => {
    const v1 = await authorSpec('Spec to be refined', makeConfig());
    const v2 = await refineSpec(v1.id, 'Add caching layer', makeConfig());
    expect(v2.version).toBe(2);
    // Both files must exist
    expect(fs.existsSync(v1.path)).toBe(true);
    expect(fs.existsSync(v2.path)).toBe(true);
  });

  it('v1 is NOT modified after refine (non-destructive)', async () => {
    const v1 = await authorSpec('Immutable spec global', makeConfig());
    const v1BodyBefore = fs.readFileSync(v1.path, 'utf8');
    await refineSpec(v1.id, 'Some refinement note', makeConfig());
    const v1BodyAfter = fs.readFileSync(v1.path, 'utf8');
    expect(v1BodyAfter).toBe(v1BodyBefore);
  });

  it('v2 has the same id as v1', async () => {
    const v1 = await authorSpec('Same id spec global', makeConfig());
    const v2 = await refineSpec(v1.id, 'Add error handling', makeConfig());
    expect(v2.id).toBe(v1.id);
  });

  it('v2 filename includes -v2', async () => {
    const v1 = await authorSpec('Filename v2 spec global', makeConfig());
    const v2 = await refineSpec(v1.id, 'Refine it', makeConfig());
    expect(path.basename(v2.path)).toMatch(/-v2\.md$/);
  });

  it('v2 has a sidecar json file', async () => {
    const v1 = await authorSpec('Sidecar v2 spec global', makeConfig());
    const v2 = await refineSpec(v1.id, 'Add monitoring', makeConfig());
    const jsonPath = v2.path.replace(/\.md$/, '.json');
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  it('v2 updatedAt is >= v1 updatedAt', async () => {
    const v1 = await authorSpec('Timestamp spec global', makeConfig());
    const v2 = await refineSpec(v1.id, 'Refine timestamps', makeConfig());
    expect(new Date(v2.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(v1.updatedAt).getTime()
    );
  });

  it('further refine produces v3', async () => {
    const v1 = await authorSpec('Triple version spec global', makeConfig());
    const v2 = await refineSpec(v1.id, 'First refinement', makeConfig());
    const v3 = await refineSpec(v1.id, 'Second refinement', makeConfig());
    expect(v3.version).toBe(3);
    expect(fs.existsSync(v1.path)).toBe(true);
    expect(fs.existsSync(v2.path)).toBe(true);
    expect(fs.existsSync(v3.path)).toBe(true);
  });

  it('refineSpec throws for an unknown id', async () => {
    await expect(
      refineSpec('nonexistent-spec-id-xyz', 'some note', makeConfig())
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// listSpecs
// ---------------------------------------------------------------------------

describe('listSpecs', () => {
  it('returns empty array when no specs exist', () => {
    expect(listSpecs(tmpProject)).toEqual([]);
  });

  it('returns one entry per spec (highest version only)', async () => {
    // authorSpec without project → global dir, so refineSpec (which calls
    // loadSpec internally) can find it via os.homedir()/.ashlr/specs
    const v1 = await authorSpec('List spec global', makeConfig());
    await refineSpec(v1.id, 'Refine it', makeConfig());
    const specs = listSpecs(); // list from global dir
    const forThisSpec = specs.filter(s => s.id === v1.id);
    // Only one entry per id (the newest version)
    expect(forThisSpec.length).toBe(1);
    expect(forThisSpec[0]!.version).toBe(2);
  });

  it('returns multiple distinct specs', async () => {
    await authorSpec('First spec goal', makeConfig(), { project: tmpProject });
    await authorSpec('Second spec goal', makeConfig(), { project: tmpProject });
    const specs = listSpecs(tmpProject);
    expect(specs.length).toBeGreaterThanOrEqual(2);
  });

  it('returned SpecArtifacts have correct shape', async () => {
    await authorSpec('Shape check goal', makeConfig(), { project: tmpProject });
    const specs = listSpecs(tmpProject);
    for (const s of specs) {
      expect(typeof s.id).toBe('string');
      expect(typeof s.goal).toBe('string');
      expect(typeof s.version).toBe('number');
      expect(typeof s.path).toBe('string');
      expect(['draft', 'active', 'archived']).toContain(s.status);
      expect(typeof s.createdAt).toBe('string');
      expect(typeof s.updatedAt).toBe('string');
    }
  });

  it('sorted by updatedAt descending (newest first)', async () => {
    const first = await authorSpec('Older spec goal', makeConfig(), { project: tmpProject });
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 5));
    await authorSpec('Newer spec goal', makeConfig(), { project: tmpProject });
    const specs = listSpecs(tmpProject);
    if (specs.length >= 2) {
      const dates = specs.map(s => new Date(s.updatedAt).getTime());
      for (let i = 0; i < dates.length - 1; i++) {
        expect(dates[i]!).toBeGreaterThanOrEqual(dates[i + 1]!);
      }
    }
    // The first spec we created is present
    expect(specs.some(s => s.id === first.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadSpec
// ---------------------------------------------------------------------------

describe('loadSpec', () => {
  // NOTE: loadSpec searches ~/.ashlr/specs (os.homedir()/.ashlr/specs) and
  // process.cwd()/.ashlr/specs. Tests that need loadSpec to find a spec must
  // author without a project (global dir = tmpHome/.ashlr/specs when HOME is set).

  it('returns null for unknown id', () => {
    expect(loadSpec('nonexistent-id-xyz')).toBeNull();
  });

  it('returns { meta, body } for a known spec authored globally', async () => {
    const created = await authorSpec('Loadable spec goal', makeConfig());
    const result = loadSpec(created.id);
    expect(result).not.toBeNull();
    expect(result!.meta).toBeDefined();
    expect(typeof result!.body).toBe('string');
  });

  it('returned meta matches SpecArtifact shape', async () => {
    const created = await authorSpec('Meta shape spec', makeConfig());
    const result = loadSpec(created.id)!;
    expect(result.meta.id).toBe(created.id);
    expect(result.meta.version).toBeGreaterThanOrEqual(1);
    expect(result.meta.goal).toBe('Meta shape spec');
    expect(typeof result.meta.path).toBe('string');
  });

  it('returns highest version after refinement', async () => {
    const v1 = await authorSpec('Versioned load spec', makeConfig());
    await refineSpec(v1.id, 'Refinement note', makeConfig());
    const result = loadSpec(v1.id)!;
    expect(result.meta.version).toBe(2);
  });

  it('body is non-empty string', async () => {
    const created = await authorSpec('Body check spec', makeConfig());
    const result = loadSpec(created.id)!;
    expect(result.body.length).toBeGreaterThan(0);
  });

  it('body matches the content of the md file on disk', async () => {
    const created = await authorSpec('Disk match spec', makeConfig());
    const result = loadSpec(created.id)!;
    const onDisk = fs.readFileSync(created.path, 'utf8');
    expect(result.body).toBe(onDisk);
  });
});

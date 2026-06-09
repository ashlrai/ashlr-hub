/**
 * M6 scaffold tests — hermetic, all operations in os.tmpdir().
 *
 * SAFETY GUARDRAIL: ALL writes go to tmp dirs. NEVER writes under
 * ~/Desktop/github or any real project path.
 *
 * Covers:
 *   - scaffoldProject writes all expected files into spec.dir (tmp)
 *   - scaffoldProject returns ok:true and populated filesWritten[]
 *   - scaffoldProject REFUSES (ok:false, writes nothing) if spec.dir already exists
 *   - gitInitialized reflects whether git init ran (mocked)
 *   - mcpWired is true when .mcp.json was written
 *   - registered reports index-registration outcome (mocked)
 *   - warnings is always an array (may be empty)
 *   - error is set on refusal / failure; absent on success
 *   - defaultCategory() returns 'side-projects'
 *   - targetDir(name, category) returns path under ~/Desktop/github
 *   - stackRecipe warning when stack not installed
 *   - never throws (all errors surface via ScaffoldResult)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Mock child_process so git init / stack never actually run
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
  spawnSync: vi.fn(() => ({ status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') })),
}));

// ---------------------------------------------------------------------------
// Mock the index-engine so no real ~/.ashlr/index.json is read or written
// ---------------------------------------------------------------------------

// NOTE: scaffoldProject registers the project in the index via a SYNCHRONOUS
// createRequire load of index-engine. vitest's `vi.mock` only intercepts
// dynamic import(), not createRequire, so the real index-engine would run (and
// write ~/.ashlr) during tests. To keep tests hermetic AND deterministic, every
// scaffoldProject call injects a stub registrar (see `stubRegistrar` below) so
// no real index work ever happens.
vi.mock('../src/core/index-engine.js', () => ({
  loadIndex: vi.fn(() => null),
  buildIndex: vi.fn(() => ({
    version: 1,
    generatedAt: new Date().toISOString(),
    root: '/tmp',
    items: [],
  })),
  writeIndex: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks so vitest hoists correctly)
// ---------------------------------------------------------------------------

import {
  scaffoldProject as scaffoldProjectRaw,
  defaultCategory,
  targetDir,
} from '../src/core/lifecycle/scaffold.js';
import type { ScaffoldSpec } from '../src/core/types.js';

// Hermetic stub registrar: reports success without touching the real index.
// Used as the default for every scaffold call in this suite so no real
// ~/.ashlr write ever occurs (createRequire bypasses vi.mock).
const stubRegistrar = () => ({ registered: true });

/** Wrapper that injects the hermetic registrar into every scaffold call. */
function scaffoldProject(spec: ScaffoldSpec) {
  return scaffoldProjectRaw(spec, stubRegistrar);
}

// ---------------------------------------------------------------------------
// Safety helper — verify we never write to real Desktop paths
// ---------------------------------------------------------------------------

const REAL_GITHUB = path.join(os.homedir(), 'Desktop', 'github');

function assertNotRealDesktop(p: string): void {
  const resolved = path.resolve(p);
  if (resolved.startsWith(REAL_GITHUB)) {
    throw new Error(`SAFETY VIOLATION: test attempted to write to real Desktop path: ${resolved}`);
  }
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const createdDirs: string[] = [];

function freshTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-m6-scaffold-'));
  createdDirs.push(d);
  return d;
}

function tmpProjectDir(name = 'test-project'): string {
  const base = freshTmpDir();
  const dir = path.join(base, name);
  assertNotRealDesktop(dir);
  return dir;
}

beforeEach(() => {
  freshTmpDir();
});

afterEach(() => {
  for (const d of createdDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: minimal spec pointing at a tmp dir
// ---------------------------------------------------------------------------

function makeSpec(overrides: Partial<ScaffoldSpec> = {}): ScaffoldSpec {
  const dir = tmpProjectDir();
  assertNotRealDesktop(dir);
  return {
    name: 'test-project',
    category: 'side-projects',
    templateId: 'minimal',
    dir,
    git: false,
    // Hermetic tests scaffold into os.tmpdir(); opt out of the in-tree guard
    // that otherwise confines writes to ~/Desktop/github.
    allowAnyRoot: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// defaultCategory
// ---------------------------------------------------------------------------

describe('defaultCategory', () => {
  it('returns "side-projects"', () => {
    expect(defaultCategory()).toBe('side-projects');
  });
});

// ---------------------------------------------------------------------------
// targetDir
// ---------------------------------------------------------------------------

describe('targetDir', () => {
  it('returns an absolute path', () => {
    const p = targetDir('my-app', 'dev-tools');
    expect(path.isAbsolute(p)).toBe(true);
  });

  it('ends with <category>/<name>', () => {
    const p = targetDir('my-app', 'dev-tools');
    expect(p.endsWith(path.join('dev-tools', 'my-app'))).toBe(true);
  });

  it('is under ~/Desktop/github', () => {
    const p = targetDir('foo', 'bar');
    const githubRoot = path.join(os.homedir(), 'Desktop', 'github');
    expect(p.startsWith(githubRoot)).toBe(true);
  });

  it('uses the provided name and category', () => {
    const p = targetDir('cool-tool', 'professional-tools');
    expect(p).toContain('professional-tools');
    expect(p).toContain('cool-tool');
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — success path with minimal template
// ---------------------------------------------------------------------------

describe('scaffoldProject — success (minimal template)', () => {
  it('returns ok:true', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    expect(result.ok).toBe(true);
  });

  it('returns the correct dir', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    expect(result.dir).toBe(spec.dir);
  });

  it('creates the target directory', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    expect(fs.existsSync(spec.dir)).toBe(true);
    expect(fs.statSync(spec.dir).isDirectory()).toBe(true);
  });

  it('filesWritten is a non-empty array', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    expect(Array.isArray(result.filesWritten)).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });

  it('all filesWritten are absolute paths', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    for (const f of result.filesWritten) {
      expect(path.isAbsolute(f)).toBe(true);
    }
  });

  it('all filesWritten paths are under spec.dir', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    for (const f of result.filesWritten) {
      expect(f.startsWith(spec.dir)).toBe(true);
    }
  });

  it('all listed files actually exist on disk', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    for (const f of result.filesWritten) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it('writes .mcp.json', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const mcpPath = path.join(spec.dir, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);
  });

  it('mcpWired is true', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    expect(result.mcpWired).toBe(true);
  });

  it('warnings is an array', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('error is absent on success', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    expect(result.error).toBeUndefined();
  });

  it('registered is true (synchronous index registration succeeded)', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    // registration runs synchronously and the result reflects the real outcome
    expect(result.registered).toBe(true);
  });

  it('writes CLAUDE.md', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const claudePath = path.join(spec.dir, 'CLAUDE.md');
    expect(fs.existsSync(claudePath)).toBe(true);
  });

  it('writes package.json', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const pkgPath = path.join(spec.dir, 'package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);
  });

  it('writes README.md', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const readmePath = path.join(spec.dir, 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
  });

  it('writes .gitignore', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const giPath = path.join(spec.dir, '.gitignore');
    expect(fs.existsSync(giPath)).toBe(true);
  });

  it('.mcp.json written is valid JSON with "ashlr" in mcpServers', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const raw = fs.readFileSync(path.join(spec.dir, '.mcp.json'), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    expect(parsed.mcpServers).toBeDefined();
    expect('ashlr' in (parsed.mcpServers ?? {})).toBe(true);
  });

  it('package.json is valid JSON', () => {
    const spec = makeSpec();
    scaffoldProject(spec);
    const raw = fs.readFileSync(path.join(spec.dir, 'package.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('package.json name matches project name', () => {
    const spec = makeSpec({ name: 'alpha-project' });
    scaffoldProject(spec);
    const pkg = JSON.parse(fs.readFileSync(path.join(spec.dir, 'package.json'), 'utf8')) as { name?: string };
    expect(pkg.name).toContain('alpha-project');
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — REFUSAL when target dir already exists
// ---------------------------------------------------------------------------

describe('scaffoldProject — REFUSES to overwrite existing directory', () => {
  it('returns ok:false when dir already exists', () => {
    const spec = makeSpec();
    // Pre-create the directory
    fs.mkdirSync(spec.dir, { recursive: true });
    const result = scaffoldProject(spec);
    expect(result.ok).toBe(false);
  });

  it('sets error when dir already exists', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    const result = scaffoldProject(spec);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('writes NOTHING when dir already exists (filesWritten is empty)', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    const result = scaffoldProject(spec);
    expect(result.filesWritten).toHaveLength(0);
  });

  it('does not add any files inside the pre-existing dir', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    const beforeContents = fs.readdirSync(spec.dir);
    scaffoldProject(spec);
    const afterContents = fs.readdirSync(spec.dir);
    expect(afterContents).toEqual(beforeContents);
  });

  it('returns ok:false even when the existing dir has files in it', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    fs.writeFileSync(path.join(spec.dir, 'existing-file.txt'), 'keep me');
    const result = scaffoldProject(spec);
    expect(result.ok).toBe(false);
    // The pre-existing file must still be there unchanged
    expect(fs.readFileSync(path.join(spec.dir, 'existing-file.txt'), 'utf8')).toBe('keep me');
  });

  it('mcpWired is false on refusal', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    const result = scaffoldProject(spec);
    expect(result.mcpWired).toBe(false);
  });

  it('gitInitialized is false on refusal', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    const result = scaffoldProject(spec);
    expect(result.gitInitialized).toBe(false);
  });

  it('dir in result matches spec.dir even on refusal', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    const result = scaffoldProject(spec);
    expect(result.dir).toBe(spec.dir);
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — git integration
// ---------------------------------------------------------------------------

describe('scaffoldProject — git init', () => {
  it('gitInitialized is false when spec.git = false', () => {
    const spec = makeSpec({ git: false });
    const result = scaffoldProject(spec);
    expect(result.gitInitialized).toBe(false);
  });

  it('gitInitialized is true when spec.git = true and git succeeds', () => {
    // execSync is already mocked to return '' (success)
    const spec = makeSpec({ git: true });
    const result = scaffoldProject(spec);
    expect(result.gitInitialized).toBe(true);
  });

  it('does not throw when git init fails (mock error)', async () => {
    const { execSync } = await import('node:child_process');
    const mockExec = execSync as ReturnType<typeof vi.fn>;
    mockExec.mockImplementationOnce(() => { throw new Error('git not found'); });

    const spec = makeSpec({ git: true });
    expect(() => scaffoldProject(spec)).not.toThrow();
  });

  it('gitInitialized is false when git init throws', async () => {
    const { execSync } = await import('node:child_process');
    const mockExec = execSync as ReturnType<typeof vi.fn>;
    mockExec.mockImplementationOnce(() => { throw new Error('git not found'); });

    const spec = makeSpec({ git: true });
    const result = scaffoldProject(spec);
    expect(result.gitInitialized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — template selection
// ---------------------------------------------------------------------------

describe('scaffoldProject — template selection', () => {
  it.each(['minimal', 'node-cli', 'mcp-server', 'next-app'] as const)(
    'scaffolds "%s" template without throwing',
    (templateId) => {
      const spec = makeSpec({ templateId });
      expect(() => scaffoldProject(spec)).not.toThrow();
    }
  );

  it.each(['minimal', 'node-cli', 'mcp-server', 'next-app'] as const)(
    '"%s" template produces ok:true',
    (templateId) => {
      const spec = makeSpec({ templateId });
      const result = scaffoldProject(spec);
      expect(result.ok).toBe(true);
    }
  );

  it('returns ok:false when templateId is unknown', () => {
    const spec = makeSpec({ templateId: 'nonexistent-template' });
    const result = scaffoldProject(spec);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('writes zero files for unknown templateId', () => {
    const spec = makeSpec({ templateId: 'nonexistent-template' });
    const result = scaffoldProject(spec);
    expect(result.filesWritten).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — stackRecipe warning when stack not installed
// ---------------------------------------------------------------------------

describe('scaffoldProject — stackRecipe', () => {
  it('adds a warning when stackRecipe is set and stack is not installed (mocked which)', async () => {
    // We mock child_process execSync to throw "not found" for `which stack`
    const { execSync } = await import('node:child_process');
    const mockExec = execSync as ReturnType<typeof vi.fn>;

    // Any call to execSync that is a "which stack" check should throw
    mockExec.mockImplementation((cmd: string) => {
      if (String(cmd).includes('which stack') || String(cmd).includes('stack')) {
        throw new Error('stack: command not found');
      }
      return '';
    });

    const spec = makeSpec({ stackRecipe: 'node-api', git: false });
    const result = scaffoldProject(spec);
    // warnings array should contain a mention of stack
    const hasStackWarning = result.warnings.some(w => w.toLowerCase().includes('stack'));
    expect(hasStackWarning).toBe(true);
  });

  it('no stackRecipe → no stack-related warnings', () => {
    const spec = makeSpec({ git: false });
    // spec has no stackRecipe
    const result = scaffoldProject(spec);
    const stackWarnings = result.warnings.filter(w => w.toLowerCase().includes('stack recipe'));
    expect(stackWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — never throws
// ---------------------------------------------------------------------------

describe('scaffoldProject — never throws', () => {
  it('does not throw on valid spec', () => {
    const spec = makeSpec();
    expect(() => scaffoldProject(spec)).not.toThrow();
  });

  it('does not throw when dir already exists', () => {
    const spec = makeSpec();
    fs.mkdirSync(spec.dir, { recursive: true });
    expect(() => scaffoldProject(spec)).not.toThrow();
  });

  it('does not throw with unknown template', () => {
    const spec = makeSpec({ templateId: 'unknown' });
    expect(() => scaffoldProject(spec)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// scaffoldProject — writes only inside spec.dir (safety)
// ---------------------------------------------------------------------------

describe('scaffoldProject — writes only under spec.dir', () => {
  it('all filesWritten are strictly under spec.dir', () => {
    const spec = makeSpec();
    const result = scaffoldProject(spec);
    for (const f of result.filesWritten) {
      const relative = path.relative(spec.dir, f);
      // relative path must not start with '..' (outside spec.dir)
      expect(relative.startsWith('..')).toBe(false);
    }
  });
});

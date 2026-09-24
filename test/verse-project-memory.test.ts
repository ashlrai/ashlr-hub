/**
 * test/verse-project-memory.test.ts — shared project memory
 * (`<verse root>/memory/<slug>-<hash12>/MEMORY.md`, docs/VERSE-CONTEXT.md).
 *
 * Defended here:
 *  1. LOCATION. One directory per canonical project path, never inside the
 *     repository, never shared by two projects that merely share a basename.
 *  2. THE BLOCK. Deterministic (the prompt prefix must stay byte-identical for
 *     the provider cache), ≤ 6 KB, secrets scrubbed, truncated with a marker,
 *     and it tells the agent the rules (read first, ≤ 200 lines, reasons,
 *     milestones, no secrets; read-only seats told so).
 *  3. PRIVACY. 0700 directories, 0600 files, atomic writes, and a symlinked
 *     MEMORY.md is never followed (it would leak its target to the UI and into
 *     every future system prompt).
 *  4. LIMITS. Writes over VERSE_MEMORY_MAX_BYTES are rejected, not truncated.
 *
 * Every test uses its own tmp root; HOME is relocated by test/setup/home.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  VERSE_MEMORY_BLOCK_MAX_BYTES,
  VERSE_MEMORY_TRUNCATION_MARKER,
  prepareProjectMemory,
  projectMemoryDir,
  readProjectMemory,
  renderMemoryBlock,
  stripUnsafeControlChars,
  writeProjectMemory,
} from '../src/core/verse/project-memory.js';
import { VerseServiceError, updateVersePreferences } from '../src/core/verse/preferences.js';
import { VERSE_MEMORY_MAX_BYTES } from '../src/core/verse/types.js';

let tmp: string;
let root: string;
let project: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'verse-mem-')));
  root = join(tmp, 'verse');
  project = join(tmp, 'work', 'My Service!');
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(VerseServiceError);
    return (err as VerseServiceError).code;
  }
}

describe('projectMemoryDir', () => {
  it('is <root>/memory/<slug>-<sha256(realpath)[0:12]>', () => {
    const hash = createHash('sha256').update(project).digest('hex').slice(0, 12);
    expect(projectMemoryDir(project, root)).toBe(join(root, 'memory', `my-service-${hash}`));
  });

  it('resolves symlinks so every spelling of a project shares one memory', () => {
    const alias = join(tmp, 'alias');
    symlinkSync(project, alias);
    expect(projectMemoryDir(alias, root)).toBe(projectMemoryDir(project, root));
  });

  it('separates two projects with the same basename', () => {
    const twin = join(tmp, 'elsewhere', 'My Service!');
    mkdirSync(twin, { recursive: true });
    expect(projectMemoryDir(twin, root)).not.toBe(projectMemoryDir(project, root));
    expect(basename(projectMemoryDir(twin, root)).startsWith('my-service-')).toBe(true);
  });

  it('falls back to "project" for names with no slug characters and caps long names', () => {
    const odd = join(tmp, '日本語');
    mkdirSync(odd);
    expect(basename(projectMemoryDir(odd, root))).toMatch(/^project-[0-9a-f]{12}$/);
    const long = join(tmp, 'a'.repeat(120));
    mkdirSync(long);
    const name = basename(projectMemoryDir(long, root));
    expect(name).toMatch(/^a{40}-[0-9a-f]{12}$/);
  });

  it('is a pure computation (creates nothing) and rejects relative paths', () => {
    projectMemoryDir(project, root);
    expect(existsSync(root)).toBe(false);
    expect(codeOf(() => projectMemoryDir('relative/repo', root))).toBe('VERSE_INVALID');
  });
});

describe('prepareProjectMemory', () => {
  it('creates the directory 0700 and returns the block, writable as asked', () => {
    const prepared = prepareProjectMemory(project, { writable: true, root });
    expect(prepared.dir).toBe(projectMemoryDir(project, root));
    expect(prepared.writable).toBe(true);
    expect(statSync(prepared.dir).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(prepared.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, 'memory')).mode & 0o777).toBe(0o700);
    }
    // Memory lives outside the repository — nothing lands in a diff.
    expect(readdirSync(project)).toEqual([]);
  });

  it('writes the rules the agent must follow into the block', () => {
    const { block, dir } = prepareProjectMemory(project, { writable: true, root });
    expect(block).toContain(dir);
    expect(block).toContain(join(dir, 'MEMORY.md'));
    expect(block).toContain('Before substantial work, read MEMORY.md');
    expect(block).toMatch(/at most 200 lines/);
    expect(block).toMatch(/each with its reason/);
    expect(block).toMatch(/decisions.*conventions.*gotchas.*plan/);
    expect(block).toMatch(/Update it at milestones/);
    expect(block).toMatch(/Never store secrets/);
    expect(block).toContain('(empty — nothing recorded yet)');
    expect(block).not.toMatch(/may only READ/);
  });

  it('tells a read-only seat that it may only read', () => {
    const { block, writable } = prepareProjectMemory(project, { writable: false, root });
    expect(writable).toBe(false);
    expect(block).toMatch(/may only READ the memory/);
    expect(block).toMatch(/Do not try to write there/);
    expect(block).not.toMatch(/Update it at milestones/);
  });

  it('snapshots the current MEMORY.md into the block', () => {
    writeProjectMemory(project, '# Decisions\n- Use pnpm, because the lockfile is pnpm.\n', root);
    const { block } = prepareProjectMemory(project, { writable: true, root });
    expect(block).toContain('- Use pnpm, because the lockfile is pnpm.');
    expect(block).not.toContain('nothing recorded yet');
  });

  it('is deterministic: the same memory yields byte-identical blocks (cache-stable)', () => {
    writeProjectMemory(project, 'fact one\nfact two', root);
    const a = prepareProjectMemory(project, { writable: true, root });
    const b = prepareProjectMemory(project, { writable: true, root });
    expect(a.block).toBe(b.block);
    expect(a).toEqual(b);
  });

  it('renders an argv-safe block from a MEMORY.md an agent wrote with a NUL in it', () => {
    // Agents write the file directly (--add-dir / writable_roots), bypassing
    // writeProjectMemory's NUL check; the pinned block must still launch.
    const dir = projectMemoryDir(project, root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'MEMORY.md'), 'decision: use webhooks v2\u0000\u0000 because retries\n', { mode: 0o600 });
    const { block } = prepareProjectMemory(project, { writable: true, root });
    expect(block).not.toContain('\u0000');
    expect(block).toContain('decision: use webhooks v2 because retries');
  });

  it('scrubs secrets from the snapshot', () => {
    writeProjectMemory(project, 'deploy key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\npassword=hunter2hunter2', root);
    const { block } = prepareProjectMemory(project, { writable: true, root });
    expect(block).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    expect(block).not.toContain('hunter2hunter2');
    expect(block).toContain('[REDACTED]');
  });

  it('caps the block at 6 KB and marks the cut', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `- fact ${i}: ${'détail '.repeat(4)}`);
    writeProjectMemory(project, lines.join('\n'), root);
    const { block } = prepareProjectMemory(project, { writable: true, root });
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(VERSE_MEMORY_BLOCK_MAX_BYTES);
    expect(block.endsWith(VERSE_MEMORY_TRUNCATION_MARKER)).toBe(true);
    expect(block).toContain('- fact 0:');
    expect(block).not.toContain('- fact 399:');
    // Cut on a line boundary: the line before the marker is a whole fact.
    const beforeMarker = block.slice(0, -VERSE_MEMORY_TRUNCATION_MARKER.length).trimEnd().split('\n').pop() ?? '';
    expect(beforeMarker).toMatch(/^- fact \d+: (détail ){3}détail$/);
    expect(block).not.toContain('�');
  });

  it('never follows a symlinked MEMORY.md', () => {
    const secret = join(tmp, 'id_ed25519');
    writeFileSync(secret, 'PRIVATE KEY MATERIAL');
    const dir = prepareProjectMemory(project, { writable: true, root }).dir;
    symlinkSync(secret, join(dir, 'MEMORY.md'));
    const { block } = prepareProjectMemory(project, { writable: true, root });
    expect(block).not.toContain('PRIVATE KEY MATERIAL');
    expect(readProjectMemory(project, true, root).content).toBe('');
  });

  it('refuses a memory directory that is a symlink', () => {
    const dir = projectMemoryDir(project, root);
    mkdirSync(join(root, 'memory'), { recursive: true });
    const elsewhere = join(tmp, 'elsewhere-dir');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, dir);
    expect(() => prepareProjectMemory(project, { writable: true, root })).toThrow(/not a real directory/);
    expect(() => writeProjectMemory(project, 'x', root)).toThrow(/not a real directory/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe('renderMemoryBlock', () => {
  it('normalises line endings and trims, so equivalent files render identically', () => {
    const a = renderMemoryBlock({ dir: '/m', projectName: 'p', content: 'a\r\nb\r\n\r\n', writable: true });
    const b = renderMemoryBlock({ dir: '/m', projectName: 'p', content: '\na\nb', writable: true });
    expect(a).toBe(b);
  });

  it('is argv-safe: NUL and other C0/C1 controls are stripped, tabs and newlines kept', () => {
    const block = renderMemoryBlock({
      dir: '/m',
      projectName: 'p\u0000roj',
      content: 'fact one\u0000fact two\n\tindented\u0007 \u001b[1mbold\u0085 end\r\n',
      writable: true,
    });
    // eslint-disable-next-line no-control-regex
    expect(block).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/);
    expect(block).toContain('"proj"');
    expect(block).toContain('fact onefact two\n\tindented [1mbold end');
    // What the claude adapter and grok actually do with it: an argv element.
    // spawn throws ERR_INVALID_ARG_VALUE synchronously on a NUL; this must not.
    const run = spawnSync(process.execPath, ['-e', '', '--', `--append-system-prompt=${block}`], { stdio: 'ignore' });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
  });

  it('stripUnsafeControlChars normalises CRLF and removes every unsafe control', () => {
    expect(stripUnsafeControlChars('a\r\nb\rc\u0000d\u007fe\u009ff\tg\nh')).toBe('a\nb\ncdef\tg\nh');
    expect(stripUnsafeControlChars('plain — ünïcode ✓')).toBe('plain — ünïcode ✓');
  });

  it('never exceeds the cap even for a single enormous line of multibyte text', () => {
    const block = renderMemoryBlock({ dir: '/m', projectName: 'p', content: '字'.repeat(10_000), writable: false });
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(VERSE_MEMORY_BLOCK_MAX_BYTES);
    expect(block).toContain(VERSE_MEMORY_TRUNCATION_MARKER);
    expect(block).not.toContain('�');
  });
});

describe('readProjectMemory / writeProjectMemory', () => {
  it('reads an absent memory as empty without creating anything', () => {
    const memory = readProjectMemory(project, true, root);
    expect(memory).toEqual({ projectPath: project, enabled: true, content: '', bytes: 0, updatedAt: null, files: [] });
    expect(existsSync(root)).toBe(false);
  });

  it('round-trips content with bytes, updatedAt and a 0600 file', () => {
    const content = 'Décisions:\n- keep it small\n';
    const written = writeProjectMemory(project, content, root);
    expect(written.content).toBe(content);
    expect(written.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(written.enabled).toBe(true);
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const file = join(projectMemoryDir(project, root), 'MEMORY.md');
    expect(readFileSync(file, 'utf8')).toBe(content);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readProjectMemory(project, false, root)).toEqual({ ...written, enabled: false });
  });

  it('clears with an empty string', () => {
    writeProjectMemory(project, 'something', root);
    const cleared = writeProjectMemory(project, '', root);
    expect(cleared.content).toBe('');
    expect(cleared.bytes).toBe(0);
  });

  it('reports enabled from preferences (a project opt-out still allows editing)', () => {
    updateVersePreferences({ projectPath: project, memoryEnabled: false }, root);
    const written = writeProjectMemory(project, 'still mine', root);
    expect(written.enabled).toBe(false);
    expect(written.content).toBe('still mine');
  });

  it('rejects oversize content instead of truncating it', () => {
    expect(codeOf(() => writeProjectMemory(project, 'x'.repeat(VERSE_MEMORY_MAX_BYTES + 1), root))).toBe('VERSE_TOO_LARGE');
    // Multibyte: 64 KB of bytes, not characters.
    expect(codeOf(() => writeProjectMemory(project, 'é'.repeat(VERSE_MEMORY_MAX_BYTES / 2 + 1), root))).toBe('VERSE_TOO_LARGE');
    expect(() => writeProjectMemory(project, 'x'.repeat(VERSE_MEMORY_MAX_BYTES), root)).not.toThrow();
  });

  it('rejects NUL bytes, non-strings and relative paths', () => {
    expect(codeOf(() => writeProjectMemory(project, 'a\0b', root))).toBe('VERSE_INVALID');
    expect(codeOf(() => writeProjectMemory(project, 42 as unknown as string, root))).toBe('VERSE_INVALID');
    expect(codeOf(() => writeProjectMemory('repo', 'x', root))).toBe('VERSE_INVALID');
    expect(codeOf(() => readProjectMemory('repo', true, root))).toBe('VERSE_INVALID');
  });

  it('lists the other files agents keep beside MEMORY.md (names only, no temps, no links)', () => {
    writeProjectMemory(project, 'index', root);
    const dir = projectMemoryDir(project, root);
    writeFileSync(join(dir, 'decisions.md'), 'why');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, '.MEMORY.md.123.abc.tmp'), 'orphan');
    symlinkSync('/etc/hosts', join(dir, 'hosts-link'));
    expect(readProjectMemory(project, true, root).files).toEqual(['decisions.md', 'notes/']);
  });

  it('leaves no temp files behind after a write', () => {
    writeProjectMemory(project, 'one', root);
    writeProjectMemory(project, 'two', root);
    expect(readdirSync(projectMemoryDir(project, root))).toEqual(['MEMORY.md']);
  });
});

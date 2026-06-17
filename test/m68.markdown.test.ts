/**
 * M68 — ashlr-md rendering integration tests.
 *
 * Coverage:
 *   1. renderToTempMarkdown writes a file with the expected content, then cleans up.
 *   2. ashlrMdInstalled() returns a boolean and never throws.
 *   3. openInAshlrMd on a bogus path (or when mdopen absent) returns ok:false, never throws.
 *   4. presentMarkdown degrades gracefully (rendered:false) when ashlr-md is absent.
 *
 * CI safety contract:
 *   - No GUI is launched in CI. Tests that exercise openInAshlrMd / presentMarkdown
 *     guard the real spawn behind ashlrMdInstalled() — when mdopen is absent (all CI),
 *     these paths return ok:false / rendered:false without spawning anything.
 *   - renderToTempMarkdown writes to os.tmpdir() (the temp file is removed after each test).
 *   - No mocks required: the degrade path is the real code path in CI.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';

import {
  ashlrMdInstalled,
  openInAshlrMd,
  presentMarkdown,
  renderToTempMarkdown,
} from '../src/core/integrations/markdown.js';

/** Paths written during a test, to clean up in afterEach. */
const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── renderToTempMarkdown ──────────────────────────────────────────────────────

describe('renderToTempMarkdown', () => {
  it('returns a non-null path for a valid title + body', () => {
    const path = renderToTempMarkdown('Test Title', 'Hello world');
    expect(path).not.toBeNull();
    if (path) tempPaths.push(path);
  });

  it('writes a file that physically exists on disk', () => {
    const path = renderToTempMarkdown('Disk Check', 'some body text');
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      expect(existsSync(path)).toBe(true);
    }
  });

  it('written file begins with the title as an H1 heading', () => {
    const title = 'My Proposal Title';
    const body = 'Proposal body content here.';
    const path = renderToTempMarkdown(title, body);
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(`# ${title}`);
    }
  });

  it('written file contains the body text', () => {
    const body = 'This is a unique body string for M68 test.';
    const path = renderToTempMarkdown('Body Check', body);
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(body);
    }
  });

  it('generated filename has .md extension', () => {
    const path = renderToTempMarkdown('Extension Test', 'body');
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      expect(path.endsWith('.md')).toBe(true);
    }
  });

  it('two calls with same title produce distinct files (timestamp-based names)', () => {
    const p1 = renderToTempMarkdown('Distinct', 'first');
    const p2 = renderToTempMarkdown('Distinct', 'second');
    if (p1) tempPaths.push(p1);
    if (p2) tempPaths.push(p2);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1).not.toBe(p2);
  });

  it('handles an empty title without throwing', () => {
    expect(() => {
      const path = renderToTempMarkdown('', 'body');
      if (path) tempPaths.push(path);
    }).not.toThrow();
  });

  it('handles special characters in title without throwing', () => {
    expect(() => {
      const path = renderToTempMarkdown('Hello / World: <test> & "more"', 'body');
      if (path) tempPaths.push(path);
    }).not.toThrow();
  });
});

// ── ashlrMdInstalled ──────────────────────────────────────────────────────────

describe('ashlrMdInstalled', () => {
  it('returns a boolean (true or false) — never throws', () => {
    let result: boolean | undefined;
    expect(() => {
      result = ashlrMdInstalled();
    }).not.toThrow();
    expect(typeof result).toBe('boolean');
  });

  it('does not throw when called multiple times in succession', () => {
    expect(() => {
      ashlrMdInstalled();
      ashlrMdInstalled();
      ashlrMdInstalled();
    }).not.toThrow();
  });
});

// ── openInAshlrMd ─────────────────────────────────────────────────────────────

describe('openInAshlrMd', () => {
  it('never throws — always returns { ok, detail }', () => {
    let result: { ok: boolean; detail: string } | undefined;
    expect(() => {
      result = openInAshlrMd('/nonexistent/bogus/path/file.md');
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result!.ok).toBe('boolean');
    expect(typeof result!.detail).toBe('string');
  });

  it('returns ok:false when mdopen is not installed (or bogus path in CI)', () => {
    // If mdopen is absent (all CI), this is the degrade path — ok must be false.
    // If mdopen IS installed (developer machine), we still pass a nonexistent file
    // — the spawn starts (ok:true) but the viewer handles the missing file.
    // Either way: never throws; ok is a boolean.
    const installed = ashlrMdInstalled();
    const result = openInAshlrMd('/nonexistent/bogus/m68-test-file.md');
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.detail).toBe('string');
    if (!installed) {
      // Hard guarantee when not installed: must be ok:false.
      expect(result.ok).toBe(false);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('returns a non-empty detail string in all cases', () => {
    const result = openInAshlrMd('/some/file.md');
    expect(result.detail.length).toBeGreaterThan(0);
  });
});

// ── presentMarkdown ───────────────────────────────────────────────────────────

describe('presentMarkdown', () => {
  it('never throws — always returns { rendered, detail }', () => {
    let result: { rendered: boolean; path?: string; detail: string } | undefined;
    expect(() => {
      result = presentMarkdown('Test', 'body content');
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result!.rendered).toBe('boolean');
    expect(typeof result!.detail).toBe('string');
    if (result!.path) tempPaths.push(result!.path);
  });

  it('always includes a non-empty detail string', () => {
    const result = presentMarkdown('Detail Check', 'body');
    if (result.path) tempPaths.push(result.path);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('degrades gracefully (rendered:false) when ashlr-md is absent', () => {
    if (ashlrMdInstalled()) {
      // On a machine with mdopen, rendered may be true — skip this assertion.
      const result = presentMarkdown('Skip Check', 'body');
      if (result.path) tempPaths.push(result.path);
      expect(typeof result.rendered).toBe('boolean');
      return;
    }
    const result = presentMarkdown('Degrade Test', 'body content for degrade');
    if (result.path) tempPaths.push(result.path);
    // Hard guarantee: rendered is false when mdopen is absent.
    expect(result.rendered).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('still writes a temp file and includes path even when viewer is absent', () => {
    if (ashlrMdInstalled()) return; // only relevant in CI / no-mdopen machines
    const result = presentMarkdown('Path Even Without Viewer', 'body');
    if (result.path) tempPaths.push(result.path);
    // The temp file is written even when ashlr-md is not installed —
    // callers can still read it for terminal fallback.
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
  });

  it('written temp file contains the expected title and body', () => {
    const title = 'Proposal: Add Feature X';
    const body = 'This proposal adds Feature X to the system.';
    const result = presentMarkdown(title, body);
    if (result.path) {
      tempPaths.push(result.path);
      const content = readFileSync(result.path, 'utf8');
      expect(content).toContain(`# ${title}`);
      expect(content).toContain(body);
    }
    expect(result.rendered !== undefined).toBe(true);
  });
});

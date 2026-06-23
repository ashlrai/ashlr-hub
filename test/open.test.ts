/**
 * Tests for src/cli/open.ts
 *
 * Focus: the editor deep-link URL must be properly percent-encoded so paths
 * containing spaces and reserved URI characters (e.g. "Keys & Recovery",
 * "Rent Application.pdf") produce a valid URL rather than a garbled one — and
 * it must do so identically on any host OS.
 *
 * We assert the pure `editorDeepLink` builder directly (no spawn, no platform
 * launcher), so the test is platform-agnostic: a POSIX input yields a POSIX
 * URL and a Windows input yields a valid Windows URL regardless of where the
 * test runs.
 */

import { describe, it, expect } from 'vitest';

import { editorDeepLink } from '../src/cli/open.js';

describe('editorDeepLink — deep link URL encoding', () => {
  it('percent-encodes spaces in the path (cursor)', () => {
    const url = editorDeepLink('/Users/m/Desktop/Rent Application.pdf', 'cursor');
    expect(url).toBe('cursor://file/Users/m/Desktop/Rent%20Application.pdf');
    expect(url).not.toContain(' ');
  });

  it('percent-encodes ampersands and spaces (cursor)', () => {
    const url = editorDeepLink('/Users/m/Desktop/Keys & Recovery', 'cursor');
    expect(url).toBe('cursor://file/Users/m/Desktop/Keys%20%26%20Recovery');
    expect(url).not.toContain(' ');
    // The reserved '&' must be escaped.
    expect(url).not.toMatch(/[^%]&/);
  });

  it('percent-encodes for vscode too and preserves path separators', () => {
    const url = editorDeepLink('/Users/m/Desktop/tts agents', 'vscode');
    expect(url).toBe('vscode://file/Users/m/Desktop/tts%20agents');
    expect(url.startsWith('vscode://file/Users/m/Desktop/')).toBe(true);
  });

  it('leaves a plain path with no special chars unchanged in shape', () => {
    const url = editorDeepLink('/Users/m/Desktop/github/dev-tools/ashlr-hub', 'cursor');
    expect(url).toBe('cursor://file/Users/m/Desktop/github/dev-tools/ashlr-hub');
  });

  it('builds a valid URL from a Windows path: backslashes → slashes, drive colon preserved', () => {
    const url = editorDeepLink('C:\\Users\\m\\Desktop\\Rent Application.pdf', 'vscode');
    // Leading slash before the drive, literal "C:", encoded space, no backslashes.
    expect(url).toBe('vscode://file/C:/Users/m/Desktop/Rent%20Application.pdf');
    expect(url).not.toContain('\\');
    expect(url).not.toContain('%5C');
    expect(url).not.toContain('%3A'); // drive colon must stay literal
  });

  it('encodes reserved chars in a Windows path segment', () => {
    const url = editorDeepLink('C:\\Users\\m\\Keys & Recovery', 'cursor');
    expect(url).toBe('cursor://file/C:/Users/m/Keys%20%26%20Recovery');
  });
});

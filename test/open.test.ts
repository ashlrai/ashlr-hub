/**
 * Tests for src/cli/open.ts
 *
 * Focus: editor deep links must be properly percent-encoded so paths
 * containing spaces and reserved URI characters (e.g. "Keys & Recovery",
 * "Rent Application.pdf") produce a valid URL rather than a garbled one.
 *
 * We stub child_process.spawn so no real `open` process is launched and we
 * can capture the exact URL argument that openInEditor builds.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the args passed to spawn.
const spawnCalls: { cmd: string; args: string[] }[] = [];

vi.mock('node:child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push({ cmd, args });
    // Return a minimal fake ChildProcess with unref().
    return { unref: () => undefined };
  },
}));

// Import AFTER the mock is registered.
import { openInEditor } from '../src/cli/open.js';
import type { AshlrConfig } from '../src/core/types.js';

function makeConfig(editor: 'cursor' | 'vscode'): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor,
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: { lmstudio: '', ollama: '', providerChain: [] },
    telemetry: {},
    tools: {},
  };
}

describe('openInEditor — deep link URL encoding', () => {
  beforeEach(() => { spawnCalls.length = 0; });
  afterEach(() => { spawnCalls.length = 0; });

  it('percent-encodes spaces in the path (cursor)', () => {
    openInEditor('/Users/m/Desktop/Rent Application.pdf', makeConfig('cursor'));
    expect(spawnCalls).toHaveLength(1);
    const [url] = spawnCalls[0].args;
    expect(url).toBe('cursor://file/Users/m/Desktop/Rent%20Application.pdf');
    // No raw spaces leaked into the URL.
    expect(url).not.toContain(' ');
  });

  it('percent-encodes ampersands and spaces (cursor)', () => {
    openInEditor('/Users/m/Desktop/Keys & Recovery', makeConfig('cursor'));
    const [url] = spawnCalls[0].args;
    expect(url).toBe('cursor://file/Users/m/Desktop/Keys%20%26%20Recovery');
    expect(url).not.toContain(' ');
    // The reserved '&' must be escaped.
    expect(url).not.toMatch(/[^%]&/);
  });

  it('percent-encodes for vscode too and preserves path separators', () => {
    openInEditor('/Users/m/Desktop/tts agents', makeConfig('vscode'));
    const [url] = spawnCalls[0].args;
    expect(url).toBe('vscode://file/Users/m/Desktop/tts%20agents');
    // Slashes between segments must survive encoding.
    expect(url.startsWith('vscode://file/Users/m/Desktop/')).toBe(true);
  });

  it('leaves a plain path with no special chars unchanged in shape', () => {
    openInEditor('/Users/m/Desktop/github/dev-tools/ashlr-hub', makeConfig('cursor'));
    const [url] = spawnCalls[0].args;
    expect(url).toBe('cursor://file/Users/m/Desktop/github/dev-tools/ashlr-hub');
  });
});

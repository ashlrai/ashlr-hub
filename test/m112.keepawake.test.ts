/**
 * M112 — keepAwake plist generation tests (no service mock).
 *
 * Tests the pure generateServiceDefinition() output for the caffeinate wrap.
 * This file intentionally does NOT mock ../src/core/daemon/service.js so the
 * real implementation is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hermetic HOME + prevent OS side-effects
// ---------------------------------------------------------------------------

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-m112-ka-'));
  vi.stubEnv('HOME', tmpHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
  execFileSync: vi.fn(() => ''),
}));

import * as fsModule from 'node:fs';
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsModule>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

import { generateServiceDefinition } from '../src/core/daemon/service.js';

describe('M112 — service.ts keepAwake plist generation', () => {
  it('keepAwake: true → caffeinate -i -s prepended in ProgramArguments', () => {
    const def = generateServiceDefinition({
      platform: 'darwin',
      nodePath: '/usr/local/bin/node',
      binPath: '/usr/local/bin/ashlr',
      homeDir: tmpHome,
      keepAwake: true,
    });

    expect(def.content).toContain('<string>caffeinate</string>');
    expect(def.content).toContain('<string>-i</string>');
    expect(def.content).toContain('<string>-s</string>');
    // caffeinate must appear BEFORE node in the plist
    const cafIdx  = def.content.indexOf('<string>caffeinate</string>');
    const nodeIdx = def.content.indexOf('<string>/usr/local/bin/node</string>');
    expect(cafIdx).toBeLessThan(nodeIdx);
  });

  it('keepAwake: false → no caffeinate in ProgramArguments', () => {
    const def = generateServiceDefinition({
      platform: 'darwin',
      nodePath: '/usr/local/bin/node',
      binPath: '/usr/local/bin/ashlr',
      homeDir: tmpHome,
      keepAwake: false,
    });

    expect(def.content).not.toContain('<string>caffeinate</string>');
  });

  it('keepAwake omitted (default) → no caffeinate', () => {
    const def = generateServiceDefinition({
      platform: 'darwin',
      nodePath: '/usr/local/bin/node',
      binPath: '/usr/local/bin/ashlr',
      homeDir: tmpHome,
    });

    expect(def.content).not.toContain('<string>caffeinate</string>');
  });

  it('linux platform is unaffected by keepAwake', () => {
    const def = generateServiceDefinition({
      platform: 'linux',
      nodePath: '/usr/local/bin/node',
      binPath: '/usr/local/bin/ashlr',
      homeDir: tmpHome,
      keepAwake: true, // ignored for linux — documented caveat
    });

    // systemd unit file does NOT contain caffeinate
    expect(def.content).not.toContain('caffeinate');
  });
});

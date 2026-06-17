/**
 * M69 — stack integration detection (read-only/advisory).
 *
 * Hermetic + portable: works whether or not `stack` is installed. Never hits a
 * provider; only PATH probe + filesystem checks + a guarded status read.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stackInstalled, stackProjectConfigured, stackStatus } from '../src/core/integrations/stack.js';

describe('M69 — stack integration', () => {
  it('stackInstalled returns a boolean and never throws', () => {
    expect(typeof stackInstalled()).toBe('boolean');
  });

  it('stackStatus never throws; ok:false with a detail when stack is absent', () => {
    const s = stackStatus();
    expect(typeof s.ok).toBe('boolean');
    expect(typeof s.detail).toBe('string');
    if (!stackInstalled()) {
      expect(s.ok).toBe(false);
      expect(s.detail).toMatch(/not installed/i);
    }
  });

  it('stackProjectConfigured detects .stack.toml presence/absence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-m69-'));
    try {
      expect(stackProjectConfigured(dir)).toBe(false);
      writeFileSync(join(dir, '.stack.toml'), '[stack]\n', 'utf8');
      expect(stackProjectConfigured(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

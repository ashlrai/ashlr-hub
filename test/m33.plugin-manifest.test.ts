/**
 * M33 — Plugin manifest reader + validator tests.
 *
 * Hermetic: tmp HOME per test (h1-fixture). Tests cover:
 *  - name/basename mismatch
 *  - bad name pattern
 *  - traversal entry paths (../ and absolute)
 *  - oversized manifest (>64 KB)
 *  - proto-pollution keys (__proto__, constructor, prototype)
 *  - apiVersion semver matching
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { readManifest } from '../src/core/plugins/manifest.js';

let fx: H1Fixture;

beforeEach(() => {
  expect.hasAssertions();
  fx = makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

/** Write a minimal valid manifest.json in a plugin dir under the fixture's plugins dir. */
function writeManifest(
  pluginName: string,
  manifest: Record<string, unknown>,
): string {
  const dir = join(fx.ashlrDir, 'plugins', pluginName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

function validManifest(pluginName = 'my-plugin'): Record<string, unknown> {
  return {
    name: pluginName,
    version: '0.1.0',
    apiVersion: '1.0.0',
    entry: './index.js',
    capabilities: ['scanner'],
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('returns ok:true for a fully valid manifest', () => {
    const dir = writeManifest('my-plugin', validManifest('my-plugin'));
    const result = readManifest(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('my-plugin');
      expect(result.manifest.version).toBe('0.1.0');
      expect(result.manifest.capabilities).toContain('scanner');
    }
  });
});

// ---------------------------------------------------------------------------
// name / basename mismatch
// ---------------------------------------------------------------------------

describe('name validation', () => {
  it('rejects when name !== basename(dir)', () => {
    // dir is named "my-plugin" but manifest.name is "other-plugin"
    const dir = writeManifest('my-plugin', validManifest('other-plugin'));
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('basename');
    }
  });

  it('rejects name with uppercase letters', () => {
    const dir = writeManifest('MyPlugin', { ...validManifest('MyPlugin') });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects name starting with a digit', () => {
    const dir = writeManifest('1plugin', { ...validManifest('1plugin') });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects name with special characters', () => {
    const dir = writeManifest('my_plugin', { ...validManifest('my_plugin') });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects name longer than 40 characters', () => {
    const longName = 'a' + 'b'.repeat(40); // 41 chars
    const dir = writeManifest(longName, { ...validManifest(longName) });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('accepts a valid 40-char name', () => {
    const name = 'a' + 'b'.repeat(39); // exactly 40 chars
    const dir = writeManifest(name, validManifest(name));
    const result = readManifest(dir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// entry path traversal / absolute
// ---------------------------------------------------------------------------

describe('entry path validation', () => {
  it('rejects traversal entry (../x.js)', () => {
    const dir = writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      entry: '../x.js',
    });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/resolves outside|traversal|outside plugin/i);
    }
  });

  it('rejects absolute entry path (/abs.js)', () => {
    const dir = writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      entry: '/abs.js',
    });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/relative|absolute/i);
    }
  });

  it('rejects deep traversal (./sub/../../etc/passwd)', () => {
    const dir = writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      entry: './sub/../../etc/passwd',
    });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('accepts a nested relative entry inside the dir (./dist/index.js)', () => {
    const dir = writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      entry: './dist/index.js',
    });
    const result = readManifest(dir);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Oversized manifest
// ---------------------------------------------------------------------------

describe('oversized manifest', () => {
  it('rejects manifests larger than 64 KB', () => {
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    // Create a manifest that is > 64 KB by padding the description field.
    const big = {
      ...validManifest('my-plugin'),
      description: 'x'.repeat(64 * 1024 + 1),
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(big), 'utf8');
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/64 KB|64KB|limit/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Proto-pollution keys
// ---------------------------------------------------------------------------

describe('proto-pollution guard', () => {
  it('rejects manifest with __proto__ key', () => {
    const raw = `{"name":"my-plugin","version":"0.1.0","apiVersion":"1.0.0","entry":"./index.js","capabilities":["scanner"],"__proto__":{"x":1}}`;
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), raw, 'utf8');
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/forbidden|proto|pollution/i);
    }
  });

  it('rejects manifest with constructor key', () => {
    const raw = `{"name":"my-plugin","version":"0.1.0","apiVersion":"1.0.0","entry":"./index.js","capabilities":["scanner"],"constructor":{"x":1}}`;
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), raw, 'utf8');
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects manifest with prototype key', () => {
    const raw = `{"name":"my-plugin","version":"0.1.0","apiVersion":"1.0.0","entry":"./index.js","capabilities":["scanner"],"prototype":{"x":1}}`;
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), raw, 'utf8');
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('rejects manifest with __proto__ nested inside another key', () => {
    const raw = `{"name":"my-plugin","version":"0.1.0","apiVersion":"1.0.0","entry":"./index.js","capabilities":["scanner"],"settings":{"__proto__":{"bad":true}}}`;
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), raw, 'utf8');
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// apiVersion semver matching
// ---------------------------------------------------------------------------

describe('apiVersion semver matching', () => {
  function makeDir(apiVersion: string): string {
    return writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      apiVersion,
    });
  }

  // Should PASS (compatible with host 1.0.0)
  it('accepts exact "1.0.0"', () => {
    const result = readManifest(makeDir('1.0.0'));
    expect(result.ok).toBe(true);
  });

  it('accepts caret "^1.0.0"', () => {
    const result = readManifest(makeDir('^1.0.0'));
    expect(result.ok).toBe(true);
  });

  it('accepts wildcard "1.x"', () => {
    const result = readManifest(makeDir('1.x'));
    expect(result.ok).toBe(true);
  });

  it('accepts wildcard "1.0.x"', () => {
    const result = readManifest(makeDir('1.0.x'));
    expect(result.ok).toBe(true);
  });

  it('accepts tilde "~1.0.0"', () => {
    const result = readManifest(makeDir('~1.0.0'));
    expect(result.ok).toBe(true);
  });

  // Should FAIL (incompatible)
  it('rejects caret "^2.0.0" (major mismatch)', () => {
    const result = readManifest(makeDir('^2.0.0'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/apiVersion|compatible|satisfied/i);
    }
  });

  it('rejects exact "0.9.0" (older major)', () => {
    const result = readManifest(makeDir('0.9.0'));
    expect(result.ok).toBe(false);
  });

  it('rejects exact "2.0.0" (newer major)', () => {
    const result = readManifest(makeDir('2.0.0'));
    expect(result.ok).toBe(false);
  });

  it('rejects "^1.1.0" (minor ahead of host 1.0.0)', () => {
    const result = readManifest(makeDir('^1.1.0'));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing / malformed manifest
// ---------------------------------------------------------------------------

describe('missing or malformed manifest', () => {
  it('returns ok:false when manifest.json is absent', () => {
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false for invalid JSON', () => {
    const dir = join(fx.ashlrDir, 'plugins', 'my-plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), '{ invalid json }', 'utf8');
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when capabilities is empty', () => {
    const dir = writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      capabilities: [],
    });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  it('returns ok:false when capabilities contains an invalid value', () => {
    const dir = writeManifest('my-plugin', {
      ...validManifest('my-plugin'),
      capabilities: ['scanner', 'does-not-exist'],
    });
    const result = readManifest(dir);
    expect(result.ok).toBe(false);
  });

  // readManifest must never throw regardless of input
  it('never throws for any input', () => {
    const dir = join(fx.ashlrDir, 'plugins', 'bad-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), 'null', 'utf8');
    expect(() => readManifest(dir)).not.toThrow();

    // Non-existent dir also must not throw
    const ghost = join(fx.ashlrDir, 'plugins', 'ghost');
    expect(() => readManifest(ghost)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integrity hash smoke test (hashEntry)
// ---------------------------------------------------------------------------

describe('hashEntry', () => {
  it('produces a sha256: prefixed hash for a readable file', async () => {
    const { hashEntry } = await import('../src/core/plugins/integrity.js');
    const dir = join(fx.ashlrDir, 'tmp');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'entry.mjs');
    writeFileSync(filePath, 'export default {};\n', 'utf8');
    const hash = hashEntry(filePath);
    expect(hash).not.toBeNull();
    expect(hash!).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('returns null for a non-existent file', async () => {
    const { hashEntry } = await import('../src/core/plugins/integrity.js');
    const hash = hashEntry(join(fx.ashlrDir, 'does-not-exist.mjs'));
    expect(hash).toBeNull();
  });

  it('produces a hash consistent with node:crypto sha256', async () => {
    const { hashEntry } = await import('../src/core/plugins/integrity.js');
    const dir = join(fx.ashlrDir, 'tmp2');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'entry.mjs');
    const content = 'export default { activate() { return {}; } };\n';
    writeFileSync(filePath, content, 'utf8');
    const hash = hashEntry(filePath);
    const expected = 'sha256:' + createHash('sha256').update(content).digest('hex');
    expect(hash).toBe(expected);
  });
});

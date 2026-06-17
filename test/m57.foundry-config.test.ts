/**
 * M57 — foundry config example: structural validation.
 *
 * Loads docs/examples/foundry.config.json and asserts the key safety properties
 * of the polyglot backend roster:
 *
 *   1. The file parses as valid JSON.
 *   2. mergeAuthority contains ONLY frontier engines (claude, codex) — mid/local
 *      backends must never appear here (the core trust-tier invariant).
 *   3. Every cfg.foundry.engines entry has a valid shape:
 *        id   — string
 *        kind — 'cli-agent' | 'api-model' | 'builtin'
 *        tier — 'local' | 'mid' | 'frontier'
 *   4. autoMerge.enabled is false (DEFAULT OFF — the kill-switch must be explicit).
 *
 * Schema note: schema/config.schema.json does not define a `foundry` block
 * (foundry is opt-in / additive and intentionally absent from the JSON Schema).
 * We do structural asserts instead of AJV validation.
 *
 * Hermetic: no network, no spawn, no fs writes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Load the example
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_PATH = resolve(__dirname, '../docs/examples/foundry.config.json');

// Raw text so we can test parse independently.
const RAW = readFileSync(EXAMPLE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set(['builtin', 'cli-agent', 'api-model']);
const VALID_TIERS = new Set(['local', 'mid', 'frontier']);

// The ONLY engine ids that carry merge-to-main authority.
// Mid-tier and local backends must never appear in mergeAuthority.
const FRONTIER_ENGINE_IDS = new Set(['claude', 'codex']);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('M57 foundry config example — parse', () => {
  it('docs/examples/foundry.config.json is valid JSON', () => {
    expect(() => JSON.parse(RAW)).not.toThrow();
  });

  it('top-level object has a "foundry" key', () => {
    const cfg = JSON.parse(RAW) as Record<string, unknown>;
    expect(cfg).toHaveProperty('foundry');
    expect(typeof cfg['foundry']).toBe('object');
  });
});

describe('M57 foundry config example — mergeAuthority (trust-tier invariant)', () => {
  const cfg = JSON.parse(RAW) as { foundry: Record<string, unknown> };
  const foundry = cfg.foundry;

  it('mergeAuthority is present and is an array', () => {
    expect(Array.isArray(foundry['mergeAuthority'])).toBe(true);
  });

  it('mergeAuthority is non-empty (the example must list at least one authority)', () => {
    const ma = foundry['mergeAuthority'] as unknown[];
    expect(ma.length).toBeGreaterThan(0);
  });

  it('every mergeAuthority entry has engine + model string fields', () => {
    const ma = foundry['mergeAuthority'] as Array<Record<string, unknown>>;
    for (const entry of ma) {
      expect(typeof entry['engine'], `engine field missing in ${JSON.stringify(entry)}`).toBe('string');
      expect(typeof entry['model'], `model field missing in ${JSON.stringify(entry)}`).toBe('string');
    }
  });

  it('mergeAuthority contains ONLY frontier engines (claude, codex) — mid/local must be absent', () => {
    const ma = foundry['mergeAuthority'] as Array<{ engine: string; model: string }>;
    for (const entry of ma) {
      expect(
        FRONTIER_ENGINE_IDS.has(entry.engine),
        `Non-frontier engine "${entry.engine}" must not appear in mergeAuthority. ` +
          `Mid and local backends (hermes, kimi, opencode, builtin, aw) cannot reach main.`,
      ).toBe(true);
    }
  });

  it('hermes is NOT in mergeAuthority (tier mid — branch-only)', () => {
    const ma = foundry['mergeAuthority'] as Array<{ engine: string }>;
    expect(ma.some((e) => e.engine === 'hermes')).toBe(false);
  });
});

describe('M57 foundry config example — engines (config-only additions)', () => {
  const cfg = JSON.parse(RAW) as { foundry: Record<string, unknown> };
  const foundry = cfg.foundry;

  it('engines block is present and is an object', () => {
    expect(foundry['engines']).toBeDefined();
    expect(typeof foundry['engines']).toBe('object');
    expect(!Array.isArray(foundry['engines'])).toBe(true);
  });

  it('engines block has at least one api-model and one cli-agent entry (proving config-only extension)', () => {
    const engines = foundry['engines'] as Record<string, Record<string, unknown>>;
    const kinds = Object.values(engines).map((e) => e['kind']);
    expect(kinds).toContain('api-model');
    expect(kinds).toContain('cli-agent');
  });

  it('every engines entry has a valid id, kind, and tier', () => {
    const engines = foundry['engines'] as Record<string, Record<string, unknown>>;
    for (const [key, spec] of Object.entries(engines)) {
      // id
      expect(
        typeof spec['id'] === 'string' || spec['id'] === undefined,
        `engines.${key}.id must be a string or absent`,
      ).toBe(true);
      // kind — must be one of the three valid kinds
      expect(
        VALID_KINDS.has(spec['kind'] as string),
        `engines.${key}.kind "${spec['kind']}" is not a valid EngineKind`,
      ).toBe(true);
      // tier — REQUIRED; absence causes the entry to be dropped by the registry
      expect(
        VALID_TIERS.has(spec['tier'] as string),
        `engines.${key}.tier "${spec['tier']}" is not a valid EngineTier (missing tier would cause silent drop)`,
      ).toBe(true);
    }
  });

  it('kimi engine has kind api-model with the expected api.envKey', () => {
    const engines = foundry['engines'] as Record<string, Record<string, unknown>>;
    const kimi = engines['kimi'];
    expect(kimi).toBeDefined();
    expect(kimi['kind']).toBe('api-model');
    const api = kimi['api'] as Record<string, unknown>;
    expect(api).toBeDefined();
    expect(api['envKey']).toBe('MOONSHOT_API_KEY');
    expect(api['protocol']).toBe('openai');
  });

  it('opencode engine has kind cli-agent', () => {
    const engines = foundry['engines'] as Record<string, Record<string, unknown>>;
    const opencode = engines['opencode'];
    expect(opencode).toBeDefined();
    expect(opencode['kind']).toBe('cli-agent');
  });

  it('no engine in the engines block declares tier frontier (additions must be mid or local)', () => {
    // The builtin roster already covers the frontier engines (claude, codex).
    // Config-only additions should only ever be mid or local — granting frontier
    // in an addition is a trust escalation that requires explicit code review.
    const engines = foundry['engines'] as Record<string, Record<string, unknown>>;
    for (const [key, spec] of Object.entries(engines)) {
      expect(
        spec['tier'] !== 'frontier',
        `engines.${key} has tier "frontier". Config-only additions should not self-grant frontier. ` +
          `Frontier engines belong in the builtin registry (engine-registry.ts) where they are code-reviewed.`,
      ).toBe(true);
    }
  });
});

describe('M57 foundry config example — autoMerge (kill switch)', () => {
  const cfg = JSON.parse(RAW) as { foundry: Record<string, unknown> };
  const foundry = cfg.foundry;

  it('autoMerge block is present', () => {
    expect(foundry['autoMerge']).toBeDefined();
  });

  it('autoMerge.enabled is false — default OFF, never auto-merges without explicit opt-in', () => {
    const autoMerge = foundry['autoMerge'] as Record<string, unknown>;
    expect(autoMerge['enabled']).toBe(false);
  });
});

describe('M57 foundry config example — supporting fields', () => {
  const cfg = JSON.parse(RAW) as { foundry: Record<string, unknown> };
  const foundry = cfg.foundry;

  it('allowedBackends is an array of strings', () => {
    const ab = foundry['allowedBackends'];
    expect(Array.isArray(ab)).toBe(true);
    for (const id of ab as unknown[]) {
      expect(typeof id).toBe('string');
    }
  });

  it('models is an object with string values', () => {
    const models = foundry['models'] as Record<string, unknown>;
    expect(typeof models).toBe('object');
    for (const v of Object.values(models)) {
      expect(typeof v).toBe('string');
    }
  });

  it('limits is an object with window+max entries', () => {
    const limits = foundry['limits'] as Record<string, Record<string, unknown>>;
    expect(typeof limits).toBe('object');
    for (const [engine, lim] of Object.entries(limits)) {
      expect(typeof lim['window'], `limits.${engine}.window must be a string`).toBe('string');
      expect(typeof lim['max'], `limits.${engine}.max must be a number`).toBe('number');
    }
  });

  it('confinement has a * default with mode os and networkEgress false', () => {
    const conf = foundry['confinement'] as Record<string, Record<string, unknown>>;
    expect(conf['*']).toBeDefined();
    expect(conf['*']['mode']).toBe('os');
    expect(conf['*']['networkEgress']).toBe(false);
  });
});

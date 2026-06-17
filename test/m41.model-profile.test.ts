/**
 * M41 model-profile tests — pure, deterministic, no I/O.
 *
 * Covers resolveModelProfile band detection (small / coder / general / default),
 * per-id overrides, immutability of the shared profile constants, and the
 * adaptivePromptsEnabled feature gate (default OFF; env overrides config).
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveModelProfile,
  adaptivePromptsEnabled,
} from '../src/core/run/model-profile.js';
import type { AshlrConfig } from '../src/core/types.js';

describe('M41 resolveModelProfile', () => {
  it('returns the default profile for undefined/empty names', () => {
    expect(resolveModelProfile().id).toBe('default');
    expect(resolveModelProfile('').id).toBe('default');
    expect(resolveModelProfile('   ').id).toBe('default');
  });

  it('detects small models → terse, json tool format, tight caps', () => {
    for (const m of ['qwen2.5:1.5b', 'tinyllama', 'gemma:2b', 'phi3:mini', 'llama3.2:3b']) {
      const p = resolveModelProfile(m);
      expect(p.id, m).toBe('small');
      expect(p.verbosity, m).toBe('terse');
      expect(p.toolFormat, m).toBe('json');
      expect(p.promptCharCap, m).toBeLessThan(1500);
      expect(p.stepCap, m).toBeLessThan(20);
    }
  });

  it('detects coder/large models → rich, native, low temperature', () => {
    for (const m of [
      'qwen2.5-coder:7b',
      'deepseek-coder:6.7b',
      'codellama:13b',
      'codestral:22b',
      'llama3.1:70b',
    ]) {
      const p = resolveModelProfile(m);
      expect(p.id, m).toBe('coder');
      expect(p.verbosity, m).toBe('rich');
      expect(p.toolFormat, m).toBe('native');
      expect(p.temperature, m).toBeLessThanOrEqual(0.2);
    }
  });

  it('detects mid-size known chat models → general/standard/native', () => {
    for (const m of ['llama3.1:8b', 'mistral:7b', 'qwen2.5:7b', 'command-r']) {
      const p = resolveModelProfile(m);
      expect(p.id, m).toBe('general');
      expect(p.verbosity, m).toBe('standard');
      expect(p.toolFormat, m).toBe('native');
    }
  });

  it('falls back to the general band for unknown names', () => {
    expect(resolveModelProfile('some-random-model').id).toBe('general');
  });

  it('applies per-id overrides without changing identity', () => {
    const p = resolveModelProfile('llama3.1:8b', { general: { temperature: 0.9, stepCap: 5 } });
    expect(p.id).toBe('general');
    expect(p.temperature).toBe(0.9);
    expect(p.stepCap).toBe(5);
  });

  it('never mutates the shared profile constants across calls', () => {
    const a = resolveModelProfile('llama3.1:8b');
    a.stepCap = 999;
    a.verbosity = 'terse';
    const b = resolveModelProfile('llama3.1:8b');
    expect(b.stepCap).not.toBe(999);
    expect(b.verbosity).toBe('standard');
  });
});

describe('M41 adaptivePromptsEnabled', () => {
  const ORIG = process.env.ASHLR_ADAPTIVE_PROMPTS;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    else process.env.ASHLR_ADAPTIVE_PROMPTS = ORIG;
  });

  const cfg = (v?: boolean): AshlrConfig =>
    ({ models: { adaptivePrompts: v } } as unknown as AshlrConfig);

  it('defaults OFF (no env, no/false config)', () => {
    delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    expect(adaptivePromptsEnabled(cfg(undefined))).toBe(false);
    expect(adaptivePromptsEnabled(cfg(false))).toBe(false);
    expect(adaptivePromptsEnabled(undefined)).toBe(false);
  });

  it('config true enables', () => {
    delete process.env.ASHLR_ADAPTIVE_PROMPTS;
    expect(adaptivePromptsEnabled(cfg(true))).toBe(true);
  });

  it('env overrides config in both directions', () => {
    process.env.ASHLR_ADAPTIVE_PROMPTS = '0';
    expect(adaptivePromptsEnabled(cfg(true))).toBe(false);
    process.env.ASHLR_ADAPTIVE_PROMPTS = '1';
    expect(adaptivePromptsEnabled(cfg(false))).toBe(true);
  });
});

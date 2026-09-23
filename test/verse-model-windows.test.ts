/**
 * test/verse-model-windows.test.ts — the per-model context budgets every
 * Verse seat is built from (src/core/verse/model-windows.ts, Verse 3.9).
 *
 * Every expected number here is the ground truth recorded in
 * docs/VERSE-CONTEXT.md §1 (read from the CLIs and seat catalogs on
 * 2026-09-23). The catalog fixtures are the REAL on-disk shapes, trimmed:
 * codex `models_cache.json` is `{ models: [{slug, visibility, context_window,
 * max_context_window, effective_context_window_percent, …}] }`; grok's is
 * `{ models: { <id>: { info: {…}, api_key, env_key, api_base_url } } }`.
 *
 * Hermetic: every file lives under a fresh tmp dir and HOME is relocated, so
 * nothing here can read a real seat profile or the real Claude install.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  budgetFor,
  claudeAutocompactFlag,
  fitVerdict,
  hasExpansiveMode,
} from '../src/core/verse/context-math.js';
import {
  claudeModelOptions,
  claudeModelsNeedingNewerCli,
  claudeSpecFor,
  cliVersionFromExecutable,
  codexModelOptions,
  compareCliVersions,
  grokModelOptions,
  joinClaudeLabels,
  localModelOption,
  newestInstalledClaudeVersion,
  readCodexCatalog,
  readGrokCatalog,
  resetModelWindowCaches,
  VERSE_CATALOG_MAX_BYTES,
  VERSE_CLAUDE_MODEL_SPECS,
} from '../src/core/verse/model-windows.js';

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-verse-model-windows-'));
  prevHome = process.env.HOME;
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  resetModelWindowCaches();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
  resetModelWindowCaches();
});

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

describe('Claude model table', () => {
  it('carries the windows the CLI actually runs, not the 200k unknown-model fallback', () => {
    const byId = Object.fromEntries(VERSE_CLAUDE_MODEL_SPECS.map((s) => [s.id, s]));
    expect(VERSE_CLAUDE_MODEL_SPECS.map((s) => s.id)).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
    for (const id of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']) {
      expect(byId[id]!.contextWindow, id).toBe(1_000_000);
      expect(byId[id]!.native1m, id).toBe(true);
    }
    for (const id of ['claude-opus-4-5', 'claude-haiku-4-5-20251001']) {
      expect(byId[id]!.contextWindow, id).toBe(200_000);
      expect(byId[id]!.native1m, id).toBe(false);
    }
    // Catalog `max_output_tokens.default` from the 2.1.280 binary.
    expect(byId['claude-opus-5-5']!.maxOutputTokens).toBe(128_000);
    expect(byId['claude-fable-5-1']!.maxOutputTokens).toBe(64_000);
    expect(byId['claude-haiku-4-5-20251001']!.maxOutputTokens).toBe(32_000);
    // Only Opus 5.5 is gated: 2.1.257 does not contain the id at all.
    expect(VERSE_CLAUDE_MODEL_SPECS.filter((s) => s.minCliVersion !== null).map((s) => [s.id, s.minCliVersion]))
      .toEqual([['claude-opus-5-5', '2.1.280']]);
  });

  it('never offers the dotted Opus 5.5 id, which every binary resolves to Opus 5', () => {
    expect(VERSE_CLAUDE_MODEL_SPECS.map((s) => s.id)).not.toContain('claude-opus-5.5');
    expect(claudeModelOptions(null).map((m) => m.id)).not.toContain('claude-opus-5.5');
  });

  it('claudeSpecFor resolves aliases and [1m] suffixes, and knows nothing it was not told', () => {
    expect(claudeSpecFor('claude-opus-5.5')?.id).toBe('claude-opus-5-5');
    expect(claudeSpecFor('claude-opus-5-5')?.id).toBe('claude-opus-5-5');
    expect(claudeSpecFor('claude-opus-4-8[1m]')?.id).toBe('claude-opus-4-8');
    expect(claudeSpecFor('claude-sonnet-4-8')).toBeNull();
    expect(claudeSpecFor('')).toBeNull();
    expect(claudeSpecFor('qwen3.8:27b-ctx64k')).toBeNull();
  });

  it('builds standard and expansive budgets through context-math', () => {
    const options = claudeModelOptions(null);
    const fable = options.find((m) => m.id === 'claude-fable-5-1')!;
    // Standard: --autocompact 400000 → 400k − min(64k, 20k) − 13k.
    expect(budgetFor(fable, 'standard')).toEqual({ contextWindow: 1_000_000, autoCompactAt: 367_000 });
    // Expansive: the CLI's own `auto` — the 967k observed as `pre_tokens`.
    expect(budgetFor(fable, 'expansive')).toEqual({ contextWindow: 1_000_000, autoCompactAt: 967_000 });
    expect(hasExpansiveMode(fable)).toBe(true);
    expect(claudeAutocompactFlag(fable, 'standard')).toBe(400_000);
    expect(claudeAutocompactFlag(fable, 'expansive')).toBeNull();
    expect(fable.windowSource).toBe('cli-catalog');
    expect(fable.maxOutputTokens).toBe(64_000);

    const opus45 = options.find((m) => m.id === 'claude-opus-4-5')!;
    expect(budgetFor(opus45, 'standard')).toEqual({ contextWindow: 200_000, autoCompactAt: 167_000 });
    expect(budgetFor(opus45, 'expansive')).toBeNull();
    expect('expansive' in opus45).toBe(false);
    expect(hasExpansiveMode(opus45)).toBe(false);
    // A 200k model already compacts at 167k natively: no flag at all.
    expect(claudeAutocompactFlag(opus45, 'standard')).toBeNull();

    const haiku = options.find((m) => m.id === 'claude-haiku-4-5-20251001')!;
    expect(budgetFor(haiku, 'standard')).toEqual({ contextWindow: 200_000, autoCompactAt: 167_000 });

    // Fit verdicts come out of the same numbers.
    expect(fitVerdict(100_000, fable)).toBe('fits');
    expect(fitVerdict(600_000, fable)).toBe('expansive');
    expect(fitVerdict(2_000_000, fable)).toBe('split');
  });

  it('marks Opus 5.5 unavailable on a binary too old to know it, and only then', () => {
    const old = claudeModelOptions('2.1.257').find((m) => m.id === 'claude-opus-5-5')!;
    expect(old.unavailableReason).toBe('needs Claude Code 2.1.280; this seat runs 2.1.257');
    expect(old.minCliVersion).toBe('2.1.280');

    for (const version of ['2.1.280', '2.1.300', '2.2.0', '3.0.0']) {
      expect(claudeModelOptions(version).every((m) => !m.unavailableReason), version).toBe(true);
    }
    // Unknown is not "too old": no model is marked unavailable on a guess.
    expect(claudeModelOptions(null).every((m) => !m.unavailableReason)).toBe(true);
    // An unparseable version can never unlock a gated model.
    expect(claudeModelOptions('dev-build').find((m) => m.id === 'claude-opus-5-5')!.unavailableReason)
      .toContain('needs Claude Code 2.1.280');
    // Every other model stays runnable on the old binary.
    expect(claudeModelOptions('2.1.257').filter((m) => m.unavailableReason).map((m) => m.id)).toEqual(['claude-opus-5-5']);
  });

  it('names the gated models for a seat note', () => {
    expect(claudeModelsNeedingNewerCli('2.1.257').map((s) => s.id)).toEqual(['claude-opus-5-5']);
    expect(claudeModelsNeedingNewerCli('2.1.280')).toEqual([]);
    expect(claudeModelsNeedingNewerCli(null)).toEqual([]);
    expect(joinClaudeLabels(claudeModelsNeedingNewerCli('2.1.257'))).toBe('Opus 5.5');
    expect(joinClaudeLabels(VERSE_CLAUDE_MODEL_SPECS.slice(0, 3))).toBe('Fable 5.1, Opus 5.5 and Fable 5');
    expect(joinClaudeLabels([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// CLI versions
// ---------------------------------------------------------------------------

describe('CLI versions', () => {
  it('compares numerically per segment, pre-releases before releases', () => {
    expect(compareCliVersions('2.1.280', '2.1.257')).toBe(1);
    expect(compareCliVersions('2.1.257', '2.1.280')).toBe(-1);
    expect(compareCliVersions('2.1.99', '2.1.100')).toBe(-1);
    expect(compareCliVersions('2.1.280', '2.1.280')).toBe(0);
    expect(compareCliVersions('0.155.0-alpha.9.2', '0.155.0')).toBe(-1);
    expect(compareCliVersions('0.155.0', '0.155.0-alpha.9.2')).toBe(1);
    expect(compareCliVersions('0.155.0-alpha.10', '0.155.0-alpha.9')).toBe(1);
    // Unparseable sorts below any real version and equal to itself.
    expect(compareCliVersions('nightly', '0.0.1')).toBe(-1);
    expect(compareCliVersions('nightly', 'dev')).toBe(0);
  });

  it('reads the pinned version from the executable path without running it', () => {
    expect(cliVersionFromExecutable('/Users/x/.local/share/claude/versions/2.1.257')).toBe('2.1.257');
    expect(cliVersionFromExecutable('/Users/x/.grok/downloads/grok-0.2.118-macos-aarch64')).toBe('0.2.118');
    expect(cliVersionFromExecutable('/Applications/ChatGPT.app/Contents/Resources/codex')).toBeNull();
    expect(cliVersionFromExecutable('')).toBeNull();
    expect(cliVersionFromExecutable('/usr/local/bin/claude')).toBeNull();
  });

  it('reads the npm codex wrapper version from its own package.json', () => {
    const pkg = path.join(tmp, 'node_modules', '@openai', 'codex');
    fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'bin', 'codex.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.136.0' }));
    expect(cliVersionFromExecutable(path.join(pkg, 'bin', 'codex.js'))).toBe('0.136.0');

    // A package.json that belongs to something else is not evidence.
    const other = path.join(tmp, 'other');
    fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'not-codex', version: '9.9.9' }));
    expect(cliVersionFromExecutable(path.join(other, 'bin', 'codex.js'))).toBeNull();
  });

  it('finds the newest installed Claude Code, ignoring locks, dirs and partials', () => {
    const root = path.join(tmp, 'versions');
    fs.mkdirSync(root, { recursive: true });
    for (const name of ['2.1.243', '2.1.257', '2.1.280', '2.1.300.lock', '2.1.99']) {
      fs.writeFileSync(path.join(root, name), 'bin');
    }
    fs.mkdirSync(path.join(root, '2.1.999'));
    expect(newestInstalledClaudeVersion(root)).toBe('2.1.280');
    expect(newestInstalledClaudeVersion(path.join(tmp, 'missing'))).toBeNull();
    fs.mkdirSync(path.join(tmp, 'empty'));
    expect(newestInstalledClaudeVersion(path.join(tmp, 'empty'))).toBeNull();
  });

  it('defaults to ~/.local/share/claude/versions under HOME', () => {
    const root = path.join(process.env.HOME!, '.local', 'share', 'claude', 'versions');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, '2.1.280'), 'bin');
    expect(newestInstalledClaudeVersion()).toBe('2.1.280');
  });
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexRow(slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug,
    display_name: slug.toUpperCase(),
    visibility: 'list',
    context_window: 272_000,
    max_context_window: 872_000,
    effective_context_window_percent: 95,
    auto_compact_token_limit: null,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    ...over,
  };
}

function writeCodexCatalog(dir: string, models: unknown[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'models_cache.json');
  fs.writeFileSync(file, JSON.stringify({ client_version: '0.155.0', fetched_at: '2026-09-23T21:44:07Z', models }));
  return file;
}

describe('codex catalog', () => {
  it('reads the seat catalog and computes effective windows and compaction points', () => {
    const state = path.join(tmp, 'codex-b', 'native-state');
    writeCodexCatalog(state, [
      codexRow('gpt-6-astra', { display_name: 'GPT-6-Astra', priority: 1 }),
      codexRow('gpt-reserve', { visibility: 'hide', priority: 3 }),
      codexRow('gpt-5.5', { display_name: 'GPT-5.5', max_context_window: 272_000, priority: 12 }),
      codexRow('gpt-6-sol', { display_name: 'GPT-6-Sol', priority: 2 }),
      codexRow('codex-auto-review', { visibility: 'hide', priority: 43 }),
    ]);
    const catalog = readCodexCatalog(state);
    expect(catalog).not.toBeNull();
    const options = codexModelOptions(catalog);
    // Hidden slugs are never offered; order is the provider's priority.
    expect(options.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.5']);

    const astra = options[0]!;
    expect(astra.label).toBe('GPT-6-Astra');
    expect(astra.windowSource).toBe('provider-catalog');
    // 272k × 95% — what codex's own rollouts report as model_context_window.
    expect(astra.contextWindow).toBe(258_400);
    // 90% of the RAW window.
    expect(astra.autoCompactAt).toBe(244_800);
    expect(astra.expansive).toEqual({ contextWindow: 828_400, autoCompactAt: 784_800, providerWindow: 872_000 });
    expect(hasExpansiveMode(astra)).toBe(true);

    const gpt55 = options.find((m) => m.id === 'gpt-5.5')!;
    expect(gpt55.contextWindow).toBe(258_400);
    expect('expansive' in gpt55).toBe(false);
    expect(budgetFor(gpt55, 'expansive')).toBeNull();
  });

  it('honours an explicit auto_compact_token_limit and a non-default percent', () => {
    const state = path.join(tmp, 'state');
    writeCodexCatalog(state, [
      codexRow('gpt-x', { auto_compact_token_limit: 200_000, effective_context_window_percent: 90 }),
    ]);
    const [opt] = codexModelOptions(readCodexCatalog(state));
    expect(opt!.contextWindow).toBe(244_800);
    expect(opt!.autoCompactAt).toBe(200_000);
    expect(opt!.expansive?.contextWindow).toBe(784_800);
  });

  it('falls back to the documented list when the seat has no catalog yet', () => {
    expect(readCodexCatalog(path.join(tmp, 'codex-a', 'native-state'))).toBeNull();
    const options = codexModelOptions(null);
    expect(options.map((m) => m.id)).toEqual([
      'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5',
    ]);
    expect(options.map((m) => m.id)).not.toContain('gpt-reserve');
    for (const m of options) {
      expect(m.windowSource).toBe('documented');
      expect(m.contextWindow).toBe(258_400);
      expect(m.autoCompactAt).toBe(244_800);
    }
    expect(options[0]!.expansive).toEqual({ contextWindow: 828_400, autoCompactAt: 784_800, providerWindow: 872_000 });
    expect(options.find((m) => m.id === 'gpt-5.5')!.expansive).toBeUndefined();
    // A catalog whose every row is hidden is no better than none.
    expect(codexModelOptions([{ slug: 'x', displayName: null, visibility: 'hide', contextWindow: 1, maxContextWindow: null, effectiveContextWindowPercent: null, autoCompactTokenLimit: null, priority: null }])[0]!.windowSource)
      .toBe('documented');
  });

  it('rejects corrupt, empty, oversized, symlinked and unsafe-id catalogs', () => {
    const state = path.join(tmp, 's');
    fs.mkdirSync(state, { recursive: true });
    const file = path.join(state, 'models_cache.json');

    fs.writeFileSync(file, '{ not json');
    expect(readCodexCatalog(state)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ models: [] }));
    expect(readCodexCatalog(state)).toBeNull();

    fs.writeFileSync(file, JSON.stringify({ models: [codexRow('ok'), ' '.repeat(VERSE_CATALOG_MAX_BYTES)] }));
    expect(readCodexCatalog(state)).toBeNull();

    // Rows with unusable slugs or windows are skipped, not sanitised.
    fs.writeFileSync(file, JSON.stringify({ models: [
      codexRow('--dangerously-bypass'),
      codexRow('has space'),
      codexRow('no-window', { context_window: 0 }),
      codexRow('good'),
    ] }));
    expect(readCodexCatalog(state)!.map((e) => e.slug)).toEqual(['good']);

    const real = path.join(tmp, 'real');
    writeCodexCatalog(real, [codexRow('gpt-6-astra')]);
    const linked = path.join(tmp, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(real, 'models_cache.json'), path.join(linked, 'models_cache.json'));
    expect(readCodexCatalog(linked)).toBeNull();
    expect(readCodexCatalog('')).toBeNull();
  });

  it('caches by path + mtime + size and re-reads when the CLI refreshes the file', () => {
    const state = path.join(tmp, 'cache');
    const file = writeCodexCatalog(state, [codexRow('gpt-6-astra')]);
    expect(readCodexCatalog(state)!.map((e) => e.slug)).toEqual(['gpt-6-astra']);
    // Same content length and mtime → served from cache (same array instance).
    expect(readCodexCatalog(state)).toBe(readCodexCatalog(state));

    writeCodexCatalog(state, [codexRow('gpt-6-astra'), codexRow('gpt-7-nova')]);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    expect(readCodexCatalog(state)!.map((e) => e.slug)).toEqual(['gpt-6-astra', 'gpt-7-nova']);
  });
});

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

const GROK_SECRET = 'xai-THIS-MUST-NEVER-BE-READ-0123456789';

function grokEntry(id: string, info: Record<string, unknown>): Record<string, unknown> {
  return {
    info: {
      id,
      model: id,
      base_url: 'https://cli-chat-proxy.grok.com/v1',
      context_window: 500_000,
      auto_compact_threshold_percent: 80,
      max_completion_tokens: null,
      hidden: false,
      supported_in_api: true,
      compactions_remaining: 1,
      ...info,
    },
    api_key: GROK_SECRET,
    env_key: 'XAI_API_KEY',
    api_base_url: null,
  };
}

function writeGrokCatalog(dir: string, models: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-09-23T21:41:39Z',
    grok_version: '0.2.118',
    origin: 'https://cli-chat-proxy.grok.com/v1/models',
    auth_method: 'session',
    models,
  }));
}

describe('grok catalog', () => {
  it('reads ONLY .info: windows, labels and compaction percent, never the credential slots', () => {
    const state = path.join(tmp, 'grok-a', 'native-state');
    writeGrokCatalog(state, {
      'grok-4.7': grokEntry('grok-4.7', { name: 'Grok 4.7' }),
      'grok-4.7-build-fast': grokEntry('grok-4.7-build-fast', { name: 'Grok 4.7 Fast' }),
      'grok-internal': grokEntry('grok-internal', { name: 'Internal', hidden: true }),
      'grok-cli-only': grokEntry('grok-cli-only', { name: 'CLI only', supported_in_api: false }),
      'grok-4.5': grokEntry('grok-4.5', { name: 'Grok 4.5', max_completion_tokens: 32_000, auto_compact_threshold_percent: 85 }),
    });
    const catalog = readGrokCatalog(state);
    expect(JSON.stringify(catalog)).not.toContain(GROK_SECRET);
    expect(JSON.stringify(catalog)).not.toContain('XAI_API_KEY');

    const options = grokModelOptions(catalog);
    expect(JSON.stringify(options)).not.toContain(GROK_SECRET);
    // Catalog order, hidden and unsupported rows dropped.
    expect(options.map((m) => m.id)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.5']);
    expect(options[1]!.label).toBe('Grok 4.7 Fast');
    expect(options[0]).toMatchObject({ contextWindow: 500_000, autoCompactAt: 400_000, windowSource: 'provider-catalog' });
    expect('expansive' in options[0]!).toBe(false);
    expect('maxOutputTokens' in options[0]!).toBe(false);
    const g45 = options.find((m) => m.id === 'grok-4.5')!;
    expect(g45.autoCompactAt).toBe(425_000);
    expect(g45.maxOutputTokens).toBe(32_000);
  });

  it('marks a row without a window as a fallback rather than inventing a source', () => {
    const state = path.join(tmp, 'g');
    writeGrokCatalog(state, { 'grok-9': grokEntry('grok-9', { name: 'Grok 9', context_window: null }) });
    const [opt] = grokModelOptions(readGrokCatalog(state));
    expect(opt).toMatchObject({ contextWindow: 500_000, autoCompactAt: 400_000, windowSource: 'fallback' });
  });

  it('falls back to the documented 0.2.118 list when the seat has none', () => {
    expect(readGrokCatalog(path.join(tmp, 'none'))).toBeNull();
    const options = grokModelOptions(null);
    expect(options.map((m) => [m.id, m.label])).toEqual([
      ['grok-4.7', 'Grok 4.7'],
      ['grok-4.7-build-fast', 'Grok 4.7 Fast'],
      ['grok-4.6', 'Grok 4.6'],
      ['grok-4.5', 'Grok 4.5'],
    ]);
    for (const m of options) expect(m).toMatchObject({ contextWindow: 500_000, autoCompactAt: 400_000, windowSource: 'documented' });
  });

  it('rejects a catalog whose models is not a dict', () => {
    const state = path.join(tmp, 'bad');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'models_cache.json'), JSON.stringify({ models: [grokEntry('x', {})] }));
    expect(readGrokCatalog(state)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Local
// ---------------------------------------------------------------------------

describe('local model options', () => {
  it('compacts by the Claude formula over the window Verse resolved', () => {
    // 65536 − min(unknown→20k cap) − 13k: what the CLI does with
    // CLAUDE_CODE_MAX_CONTEXT_TOKENS=65536.
    expect(localModelOption('qwen3.8:27b-ctx64k', 'Qwen3.8 27b-ctx64k', 65_536, 'provider-catalog')).toEqual({
      id: 'qwen3.8:27b-ctx64k',
      label: 'Qwen3.8 27b-ctx64k',
      contextWindow: 65_536,
      autoCompactAt: 32_536,
      windowSource: 'provider-catalog',
    });
    const opt = localModelOption('x', 'x', 262_144, 'runtime');
    expect(opt.autoCompactAt).toBe(229_144);
    // Reserve + buffer (33k) swallow a small window: unknown, never 0.
    expect(localModelOption('x', 'x', 32_768, 'fallback').autoCompactAt).toBeNull();
    expect(localModelOption('x', 'x', 4_096, 'fallback').autoCompactAt).toBeNull();
    expect(hasExpansiveMode(opt)).toBe(false);
  });
});

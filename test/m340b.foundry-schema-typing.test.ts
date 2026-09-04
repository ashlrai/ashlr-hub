/**
 * M340b: close the unvalidated `foundry` config surface.
 *
 * Covers:
 *  1. schema/config.schema.json's `foundry` block is declared exhaustively
 *     against AshlrConfig['foundry'] (src/core/types.ts) instead of the prior
 *     zero-properties / additionalProperties:true stub.
 *  2. The four previously-untyped-cast-only flags (specContract, repoMap,
 *     edvVerify, ashlrcodeExecutor) plus a fifth discovered live
 *     (proposalRepair) and kimi.tier (M270) are present in both the schema
 *     and the type.
 *  3. loadConfig()/loadConfigReadOnly() now warn (never throw) at
 *     config-load time when the persisted config's `foundry` block has a key
 *     this version does not recognize — closing the gap where a typo'd
 *     autonomy flag silently no-ops with zero operator feedback.
 *  4. A config shaped like the real operator config (~/.ashlr/config.json,
 *     `foundry` block copied verbatim — no secrets live under `foundry`)
 *     round-trips through the new warning check with zero false positives,
 *     and the auto-merge scope caps declared in the schema are pinned to the
 *     real hard-enforced ceiling in automerge-scope-policy.ts.
 *
 * NOTE: schema/config.schema.json is NOT loaded/enforced by any ajv (or
 * other JSON-Schema validator) call in src/ — confirmed by grep and by
 * test/m57.foundry-config.test.ts's own comment ("We do structural asserts
 * instead of AJV validation"). ajv appears only as a transitive dependency
 * (via @modelcontextprotocol/sdk / eslint) in package-lock.json, not in
 * package.json. This file therefore does structural JSON assertions rather
 * than pulling in ajv, matching the project's existing no-new-deps posture.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import {
  MAX_AUTOMERGE_POLICY_FILES,
  MAX_AUTOMERGE_POLICY_LINES,
} from '../src/core/foundry/automerge-scope-policy.js';

// ---------------------------------------------------------------------------
// Schema fixture (loaded once — pure JSON, no module system involved)
// ---------------------------------------------------------------------------

const SCHEMA_PATH = join(import.meta.dirname, '..', 'schema', 'config.schema.json');

function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

function foundrySchema(schema: Record<string, unknown>): Record<string, unknown> {
  const props = schema['properties'] as Record<string, unknown>;
  return props['foundry'] as Record<string, unknown>;
}

// Hand-walked from AshlrConfig['foundry'] in src/core/types.ts as of M340b —
// intentionally a static snapshot (not derived from the type at runtime,
// since TS types erase) so a future property removed from the type without a
// schema update fails this test.
const EXPECTED_TYPE_KEYS = [
  'executionIdentityV1', 'allowedBackends', 'autonomyControlLoop', 'repairHandoffV2Write',
  'repairHandoffV2Activation', 'models', 'claude5', 'modelGranularRouting',
  'bestOfN', 'bestOfNCandidates', 'bestOfNMinItemScore', 'outcomeWatcher',
  'verifyToGreen', 'sandboxExternal', 'timeoutMs', 'completenessGate',
  'mergeAuthority', 'limits', 'engines', 'nim', 'kimi', 'fleetMcp',
  'minItemValue', 'scanTodos', 'scanDeps', 'scanDependencyBumps', 'scanLint',
  'scanHygiene', 'goalPlanning', 'goalFocusMode', 'goalFocusActiveThreshold',
  'browserVerify', 'visualGrounding', 'usePhantom', 'diffSafety',
  'tasteCritic', 'routingPolicy', 'learnedRouting', 'modelRacing',
  'intelligence', 'pulseEmit', 'skillLibrary', 'judgePerPass',
  'autoArchiveAfterRejects', 'proposalTtlDays', 'simpleConductor',
  'resourceAwareDispatch', 'dispatchRetries', 'killSwitch',
  'engineFallbackOrder', 'autoMerge', 'generative', 'confinement', 'fabric',
  'productionVelocity', 'claudeResource', 'resourceOverrides', 'local',
  // M340b additions:
  'edvVerify', 'ashlrcodeExecutor', 'specContract', 'repoMap',
  'proposalRepair',
];

describe('schema/config.schema.json — foundry block (M340b)', () => {
  it('is valid JSON with a foundry object under properties', () => {
    const schema = loadSchema();
    const foundry = foundrySchema(schema);
    expect(foundry).toBeTruthy();
    expect(foundry['type']).toBe('object');
  });

  it('declares every key currently on AshlrConfig["foundry"]', () => {
    const foundry = foundrySchema(loadSchema());
    const declared = foundry['properties'] as Record<string, unknown>;
    for (const key of EXPECTED_TYPE_KEYS) {
      expect(declared, `schema/config.schema.json foundry.properties is missing "${key}"`).toHaveProperty(key);
    }
  });

  it('keeps foundry.additionalProperties permissive, with the reason documented', () => {
    const foundry = foundrySchema(loadSchema());
    // Deliberate: KNOWN_FOUNDRY_KEYS (effective-config.ts / config.ts) still
    // recognizes several runtime-read keys (e.g. acePlaybook, localization,
    // redTeam, feedbackEnabled) that are not yet promoted into the
    // AshlrConfig type. additionalProperties:false here would make those
    // legitimate keys schema-invalid while the type is the declared source
    // of truth for this block's *declared* properties.
    expect(foundry['additionalProperties']).toBe(true);
    expect(String(foundry['description'])).toMatch(/KNOWN_FOUNDRY_KEYS/);
  });

  it('declares the four previously-untyped-cast-only flags as booleans', () => {
    const declared = foundrySchema(loadSchema())['properties'] as Record<string, any>;
    for (const key of ['edvVerify', 'ashlrcodeExecutor', 'specContract', 'repoMap']) {
      expect(declared[key].type).toBe('boolean');
    }
  });

  it('declares kimi.tier (M270 frontier-promotion override)', () => {
    const declared = foundrySchema(loadSchema())['properties'] as Record<string, any>;
    expect(declared.kimi.properties.tier).toBeTruthy();
    expect(declared.kimi.properties.tier.enum).toEqual(['local', 'mid', 'frontier']);
  });

  it('pins autoMerge scope caps to the real enforced ceiling in automerge-scope-policy.ts', () => {
    const declared = foundrySchema(loadSchema())['properties'] as Record<string, any>;
    const autoMerge = declared.autoMerge.properties;
    expect(autoMerge.maxAutomergeFiles.maximum).toBe(MAX_AUTOMERGE_POLICY_FILES);
    expect(autoMerge.maxAutomergeLines.maximum).toBe(MAX_AUTOMERGE_POLICY_LINES);
  });
});

// ---------------------------------------------------------------------------
// loadConfig() / loadConfigReadOnly() — config-load-time typo warning
// ---------------------------------------------------------------------------
// Reuses the harness pattern from test/config.test.ts: CONFIG_DIR/CONFIG_PATH
// are module-level constants resolved from homedir() at import time, so we
// mock the module to redirect them into a temp HOME per test.

let _configDir = '';

vi.mock('../src/core/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/config.js')>();
  return {
    ...real,
    loadConfigReadOnly(): ReturnType<typeof real.loadConfigReadOnly> {
      const savedHome = process.env.HOME;
      if (_configDir) process.env.HOME = dirname(_configDir);
      try { return real.loadConfigReadOnly(); } finally { process.env.HOME = savedHome; }
    },
  };
});

import { loadConfigReadOnly } from '../src/core/config.js';

function makeTmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'ashlr-m340b-test-'));
}

function useTmpHome(tmpHome: string): string {
  const ashlrDir = join(tmpHome, '.ashlr');
  _configDir = ashlrDir;
  process.env.HOME = tmpHome;
  mkdirSync(ashlrDir, { recursive: true });
  return join(ashlrDir, 'config.json');
}

describe('loadConfigReadOnly — foundry key typo warning', () => {
  let tmpHome: string;
  const origHome = process.env.HOME;

  beforeEach(() => { tmpHome = makeTmpHome(); });
  afterEach(() => { process.env.HOME = origHome; _configDir = ''; rmSync(tmpHome, { recursive: true, force: true }); });

  it('warns exactly once, naming the misspelled key, without throwing', () => {
    const cfgPath = useTmpHome(tmpHome);
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      foundry: { modelGranularRoutng: { enabled: true } }, // typo: missing 'i'
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = loadConfigReadOnly();

    expect(warning).toHaveBeenCalledOnce();
    expect(String(warning.mock.calls[0][0])).toContain('modelGranularRoutng');
    expect(String(warning.mock.calls[0][0])).toContain('not recognized');
    // Non-fatal: the rest of the config still loads normally.
    expect(cfg.version).toBe(1);
    warning.mockRestore();
  });

  it('does not warn for a recognized, correctly-spelled foundry key', () => {
    const cfgPath = useTmpHome(tmpHome);
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      foundry: { edvVerify: true, ashlrcodeExecutor: true, specContract: false, repoMap: true, proposalRepair: false },
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadConfigReadOnly();

    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('does not warn for a runtime-known key that is not yet on the AshlrConfig type (e.g. acePlaybook)', () => {
    const cfgPath = useTmpHome(tmpHome);
    writeFileSync(cfgPath, JSON.stringify({
      version: 1,
      foundry: { acePlaybook: true, localization: true, redTeam: false },
    }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadConfigReadOnly();

    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('does not warn when foundry is absent', () => {
    const cfgPath = useTmpHome(tmpHome);
    writeFileSync(cfgPath, JSON.stringify({ version: 1, editor: 'vscode' }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadConfigReadOnly();

    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  // Verbatim copy of the `foundry` block from the operator's real
  // ~/.ashlr/config.json (M340b audit). Nothing sensitive lives under
  // `foundry` (no tokens/keys — those live under top-level `comms`), so this
  // is safe to inline. Frozen here as a regression fixture: if a future
  // rename lands in types.ts/effective-config.ts without updating the
  // KNOWN_FOUNDRY_KEYS lists, this test starts failing loudly.
  const LIVE_FOUNDRY_FIXTURE = {
    allowedBackends: ['builtin', 'local-coder', 'claude', 'codex', 'nim', 'kimi'],
    models: { 'local-coder': 'qwen3-coder:30b', codex: 'gpt-5.5', nim: 'moonshotai/kimi-k2.6' },
    autoMerge: {
      enabled: false, maxRisk: 'medium', maxAutomergeFiles: 40, maxAutomergeLines: 3000,
      managerGate: true, allowSelfMerge: false, pushToRemote: true, trustBasis: 'verification',
    },
    feedbackEnabled: true,
    scanTodos: false,
    acePlaybook: true,
    edvVerify: true,
    mergeAuthority: [
      { engine: 'codex', model: 'gpt-5.5' },
      { engine: 'claude', model: 'claude-sonnet-4-5' },
      { engine: 'claude', model: 'claude-opus-4-8' },
      { engine: 'claude', model: 'claude-sonnet-5' },
    ],
    repoMap: true,
    localization: true,
    strategistModel: 'claude-opus-4-8',
    routingPolicy: 'quality',
    bestOfN: 3,
    browserVerify: true,
    managerJudgeModel: 'gpt-5.5',
    judgePerPass: 5,
    redTeam: true,
    blastRadius: true,
    generative: true,
    inventPerCycle: 3,
    tasteCritic: true,
    nim: { tier: 'frontier', model: 'moonshotai/kimi-k2.6' },
    ashlrcodeExecutor: true,
    fabric: { gateway: true, resourceAware: true, concurrentDispatch: true, workhorseDispatch: true },
    kimi: { tier: 'frontier' },
    simpleConductor: true,
    stallIdleMs: 1800000,
    managerJudgeEngine: 'codex',
    resourceOverrides: {
      claude: { availability: 'exhausted', until: '2026-07-03T09:00:00-04:00', reason: 'weekly usage exhausted' },
    },
    verifyToGreen: { enabled: true },
    bestOfNMinItemScore: 7,
    bestOfNCandidates: [
      { engine: 'claude', model: 'claude-sonnet-5' },
      { engine: 'codex' },
      { engine: 'local-coder' },
    ],
    proposalRepair: false,
    repairHandoffV2Write: true,
    repairHandoffV2Activation: { id: 'a2997267-377d-4296-b7cf-84be17495ac4', activatedAt: '2026-07-12T20:13:06.471Z' },
  };

  it('the live-shaped foundry fixture triggers zero unknown-key warnings', () => {
    const cfgPath = useTmpHome(tmpHome);
    writeFileSync(cfgPath, JSON.stringify({ version: 1, foundry: LIVE_FOUNDRY_FIXTURE }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const cfg = loadConfigReadOnly();

    expect(warning).not.toHaveBeenCalled();
    expect(cfg.foundry?.edvVerify).toBe(true);
    expect(cfg.foundry?.kimi?.tier).toBe('frontier');
    warning.mockRestore();
  });

  it('the same fixture, with one key misspelled, warns only about that key', () => {
    const cfgPath = useTmpHome(tmpHome);
    const mutated: Record<string, unknown> = { ...LIVE_FOUNDRY_FIXTURE };
    mutated['proposalRepiar'] = mutated['proposalRepair']; // typo
    delete mutated['proposalRepair'];
    writeFileSync(cfgPath, JSON.stringify({ version: 1, foundry: mutated }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    loadConfigReadOnly();

    expect(warning).toHaveBeenCalledOnce();
    expect(String(warning.mock.calls[0][0])).toContain('proposalRepiar');
    warning.mockRestore();
  });

  it('LIVE_FOUNDRY_FIXTURE maxAutomergeFiles/Lines are WITHIN the real hard-enforced ceiling', () => {
    // M340b originally pinned the INVERSE of this: the operator's live config
    // requested 40 files / 3000 lines against a hard ceiling of 10 / 300, so
    // resolveAutoMergeScopePolicy() failed CLOSED (ok:false) and auto-merge
    // scope resolution was silently broken — configured but never respected.
    //
    // M504 raised MAX_AUTOMERGE_POLICY_FILES/LINES to 40 / 3000 so those
    // configured values actually resolve. This assertion is deliberately kept
    // (inverted rather than deleted) so that lowering the ceiling back below a
    // real operator config re-breaks the build loudly instead of silently
    // reverting auto-merge to fail-closed.
    expect(LIVE_FOUNDRY_FIXTURE.autoMerge.maxAutomergeFiles).toBeLessThanOrEqual(MAX_AUTOMERGE_POLICY_FILES);
    expect(LIVE_FOUNDRY_FIXTURE.autoMerge.maxAutomergeLines).toBeLessThanOrEqual(MAX_AUTOMERGE_POLICY_LINES);
  });
});

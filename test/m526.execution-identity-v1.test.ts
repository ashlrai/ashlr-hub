/**
 * M526 — Execution Identity V1 adversarial contract.
 *
 * V1 is default-off and shadow-only. These tests use private temporary stores;
 * no real account home, credential, provider, daemon, or dispatcher is touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig, EngineId, ExecutionIdentityPlanV1 } from '../src/core/types.js';
import {
  buildExecutionIdentityShadowStatusV1,
  digestExecutionIdentityRefV1,
  ExecutionIdentityResourceBookV1,
  resolveExecutionIdentityRuntimeV1,
} from '../src/core/fabric/execution-identity.js';

const ID_A = 'eid_11111111111111111111111111111111';
const ID_B = 'eid_22222222222222222222222222222222';
const LOCATOR_A = 'erl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LOCATOR_B = 'erl_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CLAUDE_ID = 'eid_33333333333333333333333333333333';
const CLAUDE_LOCATOR = 'erl_cccccccccccccccccccccccccccccccc';
const LOCAL_ID = 'eid_44444444444444444444444444444444';
const LOCAL_LOCATOR = 'erl_dddddddddddddddddddddddddddddddd';
const PHANTOM_ID = 'eid_55555555555555555555555555555555';
const PHANTOM_LOCATOR = 'erl_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const WRONG_PHANTOM_LOCATOR = 'erl_ffffffffffffffffffffffffffffffff';
const OBSERVED_AT = '2026-09-02T16:00:00.000Z';
const NOW = new Date('2026-09-02T16:01:00.000Z');

const cleanup = new Set<string>();
const describePosix = process.platform === 'win32' ? describe.skip : describe;
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

afterEach(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
  cleanup.clear();
  vi.restoreAllMocks();
});

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function privateFile(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}

function fixture(): {
  root: string;
  storePath: string;
  codexA: string;
  codexB: string;
  claude: string;
} {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-execution-identity-v1-')));
  cleanup.add(root);
  if (process.platform !== 'win32') chmodSync(root, 0o700);
  const privateRoot = join(root, 'private');
  const codexA = join(root, 'codex-a-private');
  const codexB = join(root, 'codex-b-private');
  const claude = join(root, 'claude-private');
  for (const path of [privateRoot, codexA, codexB, claude]) privateDirectory(path);
  const storePath = join(privateRoot, 'execution-identities-v1.json');
  privateFile(storePath, {
    schemaVersion: 1,
    bindings: [
      { ref: LOCATOR_A, kind: 'vendor-home', env: 'CODEX_HOME', locator: codexA },
      { ref: LOCATOR_B, kind: 'vendor-home', env: 'CODEX_HOME', locator: codexB },
      { ref: CLAUDE_LOCATOR, kind: 'vendor-home', env: 'CLAUDE_CONFIG_DIR', locator: claude },
      { ref: LOCAL_LOCATOR, kind: 'local-runtime' },
      { ref: PHANTOM_LOCATOR, kind: 'phantom-env', secretNames: ['XAI_API_KEY'] },
      { ref: WRONG_PHANTOM_LOCATOR, kind: 'phantom-env', secretNames: ['NVIDIA_NIM_API_KEY'] },
    ],
  });
  return { root, storePath, codexA, codexB, claude };
}

function config(
  rows: Array<{
    ref: string;
    engine: EngineId;
    privateRuntimeLocatorRef: string;
    plan: ExecutionIdentityPlanV1;
  }>,
  allowedBackends: EngineId[] = ['codex'],
): AshlrConfig {
  return {
    version: 1,
    foundry: {
      allowedBackends,
      executionIdentityV1: { enabled: true, shadowOnly: true, identities: rows },
    },
  } as unknown as AshlrConfig;
}

function codexConfig(): AshlrConfig {
  return config([
    {
      ref: ID_A,
      engine: 'codex',
      privateRuntimeLocatorRef: LOCATOR_A,
      plan: { kind: 'subscription', class: 'codex-max', maxConcurrent: 1 },
    },
    {
      ref: ID_B,
      engine: 'codex',
      privateRuntimeLocatorRef: LOCATOR_B,
      plan: { kind: 'subscription', class: 'codex-max', maxConcurrent: 1 },
    },
  ]);
}

describePosix('Execution Identity V1 — private account isolation', () => {
  it('resolves two Codex identities to distinct private homes but publishes digests only', () => {
    const f = fixture();
    const cfg = codexConfig();
    const a = resolveExecutionIdentityRuntimeV1(cfg, ID_A, { privateStorePath: f.storePath });
    const b = resolveExecutionIdentityRuntimeV1(cfg, ID_B, { privateStorePath: f.storePath });
    expect(a).toMatchObject({ ok: true, engine: 'codex', env: { CODEX_HOME: f.codexA } });
    expect(b).toMatchObject({ ok: true, engine: 'codex', env: { CODEX_HOME: f.codexB } });
    expect(a.ok && b.ok && a.env.CODEX_HOME).not.toBe(b.ok ? b.env.CODEX_HOME : undefined);

    const book = new ExecutionIdentityResourceBookV1(cfg, { privateStorePath: f.storePath });
    expect(book.recordObservation({
      identityRef: ID_A, state: 'open', availableSlots: 1, usedPercent: 20, observedAt: OBSERVED_AT,
    })).toBe(true);
    expect(book.recordObservation({
      identityRef: ID_B, state: 'open', availableSlots: 1, usedPercent: 30, observedAt: OBSERVED_AT,
    })).toBe(true);
    const status = buildExecutionIdentityShadowStatusV1(cfg, {
      privateStorePath: f.storePath,
      resourceBook: book,
      now: NOW,
      work: [
        { id: 'work-one', engine: 'codex' },
        { id: 'work-two', engine: 'codex' },
        { id: 'work-three', engine: 'codex' },
      ],
    });
    expect(status.sourceState).toBe('healthy');
    expect(status.assignments).toHaveLength(2);
    expect(new Set(status.assignments.map((row) => row.executionIdentityDigest)).size).toBe(2);
    expect(status.unassigned).toHaveLength(1);
    expect(status).toMatchObject({
      authority: 'shadow-only', executionAuthority: false,
      proposalAuthority: false, routingMutation: false,
    });
    const encoded = JSON.stringify(status);
    for (const forbidden of [ID_A, ID_B, LOCATOR_A, LOCATOR_B, f.codexA, f.codexB, 'CODEX_HOME']) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it('keys backoff by identity so one Codex account cannot poison the other', () => {
    const f = fixture();
    const cfg = codexConfig();
    const book = new ExecutionIdentityResourceBookV1(cfg, { privateStorePath: f.storePath });
    for (const identityRef of [ID_A, ID_B]) {
      expect(book.recordObservation({
        identityRef, state: 'open', availableSlots: 1, observedAt: OBSERVED_AT,
      })).toBe(true);
    }
    expect(book.recordBackoff(ID_A, 60_000, 'rate-limited', NOW.getTime())).toBe(true);
    const resources = book.publicResources(NOW.getTime());
    expect(resources.find((row) => row.executionIdentityDigest === digestExecutionIdentityRefV1(ID_A)))
      .toMatchObject({ trustedSlots: 0, reason: 'backoff-rate-limited' });
    expect(resources.find((row) => row.executionIdentityDigest === digestExecutionIdentityRefV1(ID_B)))
      .toMatchObject({ trustedSlots: 1, reason: 'observed-open' });

    const status = buildExecutionIdentityShadowStatusV1(cfg, {
      privateStorePath: f.storePath, resourceBook: book, now: NOW,
      work: [{ id: 'isolated-work', engine: 'codex' }],
    });
    expect(status.assignments[0]?.executionIdentityDigest).toBe(digestExecutionIdentityRefV1(ID_B));
  });

  it('assigns zero trusted capacity when observation is missing or stale', () => {
    const f = fixture();
    const cfg = codexConfig();
    const missingBook = new ExecutionIdentityResourceBookV1(cfg, { privateStorePath: f.storePath });
    expect(missingBook.recordObservation({
      identityRef: 'eid_44444444444444444444444444444444',
      state: 'open', availableSlots: 1, observedAt: OBSERVED_AT,
    })).toBe(false);
    expect(missingBook.publicResources(NOW.getTime()).every((row) => row.trustedSlots === 0)).toBe(true);
    const missing = buildExecutionIdentityShadowStatusV1(cfg, {
      privateStorePath: f.storePath, resourceBook: missingBook, now: NOW,
      work: [{ id: 'unknown-capacity', engine: 'codex' }],
    });
    expect(missing.assignments).toEqual([]);
    expect(missing.unassigned[0]?.reason).toBe('no-trusted-capacity');

    const staleBook = new ExecutionIdentityResourceBookV1(cfg, { privateStorePath: f.storePath });
    expect(staleBook.recordObservation({
      identityRef: ID_A, state: 'open', availableSlots: 1, observedAt: '2026-09-02T15:00:00.000Z',
    })).toBe(true);
    expect(staleBook.publicResources(NOW.getTime()).find(
      (row) => row.executionIdentityDigest === digestExecutionIdentityRefV1(ID_A),
    )).toMatchObject({ trustedSlots: 0, reason: 'observation-stale' });

    const skewBook = new ExecutionIdentityResourceBookV1(cfg, { privateStorePath: f.storePath });
    expect(skewBook.recordObservation({
      identityRef: ID_A,
      state: 'open',
      availableSlots: 1,
      observedAt: '2026-09-02T16:01:30.000Z',
    })).toBe(true);
    expect(skewBook.publicResources(NOW.getTime()).find(
      (row) => row.executionIdentityDigest === digestExecutionIdentityRefV1(ID_A),
    )).toMatchObject({ trustedSlots: 1, reason: 'observed-open' });

    expect(skewBook.recordObservation({
      identityRef: ID_A,
      state: 'open',
      availableSlots: 1,
      observedAt: '2026-09-02T16:02:00.001Z',
    })).toBe(true);
    expect(skewBook.publicResources(NOW.getTime()).find(
      (row) => row.executionIdentityDigest === digestExecutionIdentityRefV1(ID_A),
    )).toMatchObject({ trustedSlots: 0, reason: 'observation-stale' });
  });

  it('fails the complete roster closed when the private store is unsafe', () => {
    const f = fixture();
    if (process.platform !== 'win32') chmodSync(f.storePath, 0o644);
    const status = buildExecutionIdentityShadowStatusV1(codexConfig(), {
      privateStorePath: f.storePath, now: NOW,
    });
    expect(status).toMatchObject({ enabled: true, sourceState: 'degraded', identities: [], assignments: [] });
    expect(status.stopReasons).toContain('private-store-unsafe');
  });

  it('rejects symlinked, hard-linked, oversized, and non-private stores', () => {
    const cases: Array<(f: ReturnType<typeof fixture>) => string> = [
      (f) => {
        const path = join(f.root, 'private', 'symlink-store.json');
        symlinkSync(f.storePath, path);
        return path;
      },
      (f) => {
        const path = join(f.root, 'private', 'hard-link-store.json');
        linkSync(f.storePath, path);
        return path;
      },
      (f) => {
        const path = join(f.root, 'private', 'oversized-store.json');
        privateFile(path, 'x'.repeat(64 * 1024));
        return path;
      },
      (f) => {
        if (process.platform !== 'win32') chmodSync(f.storePath, 0o640);
        return f.storePath;
      },
      (f) => {
        if (process.platform !== 'win32') chmodSync(join(f.root, 'private'), 0o750);
        return f.storePath;
      },
    ];
    for (const buildPath of cases) {
      const f = fixture();
      const status = buildExecutionIdentityShadowStatusV1(codexConfig(), {
        privateStorePath: buildPath(f), now: NOW,
      });
      if (process.platform !== 'win32' || !status.stopReasons.includes('private-store-unsafe')) {
        expect(status).toMatchObject({ sourceState: 'degraded', identities: [], assignments: [] });
        expect(status.stopReasons).toContain('private-store-unsafe');
      }
    }
  });
});

describePosix('Execution Identity V1 — explicit Claude policy', () => {
  it('keeps Claude Max interactive-only and allows only explicit agent-credit capacity', () => {
    const f = fixture();
    const reserved = config([{
      ref: CLAUDE_ID,
      engine: 'claude',
      privateRuntimeLocatorRef: CLAUDE_LOCATOR,
      plan: { kind: 'interactive-reserved', class: 'claude-max', maxConcurrent: 0 },
    }], ['claude']);
    const reservedBook = new ExecutionIdentityResourceBookV1(reserved, { privateStorePath: f.storePath });
    expect(reservedBook.recordObservation({
      identityRef: CLAUDE_ID, state: 'open', availableSlots: 1, observedAt: OBSERVED_AT,
    })).toBe(true);
    expect(reservedBook.publicResources(NOW.getTime())[0]).toMatchObject({
      trustedSlots: 0, maxConcurrent: 0, reason: 'interactive-reserved',
    });

    const wrong = config([{
      ref: CLAUDE_ID,
      engine: 'claude',
      privateRuntimeLocatorRef: CLAUDE_LOCATOR,
      plan: { kind: 'subscription', class: 'codex-custom', maxConcurrent: 1 },
    }], ['claude']);
    expect(buildExecutionIdentityShadowStatusV1(wrong, {
      privateStorePath: f.storePath, now: NOW,
    })).toMatchObject({ sourceState: 'degraded', stopReasons: ['plan-engine-mismatch'] });

    const credit = config([{
      ref: CLAUDE_ID,
      engine: 'claude',
      privateRuntimeLocatorRef: CLAUDE_LOCATOR,
      plan: { kind: 'agent-credit', class: 'claude-agent-sdk-credit', maxConcurrent: 1 },
    }], ['claude']);
    const creditBook = new ExecutionIdentityResourceBookV1(credit, { privateStorePath: f.storePath });
    expect(creditBook.recordObservation({
      identityRef: CLAUDE_ID, state: 'open', availableSlots: 1, observedAt: OBSERVED_AT,
    })).toBe(true);
    expect(creditBook.publicResources(NOW.getTime())[0]).toMatchObject({ trustedSlots: 1 });
  });
});

describePosix('Execution Identity V1 — resolved engine binding matrix', () => {
  it('accepts only the exact credential source and plan for each resolved engine kind', () => {
    const f = fixture();
    const status = (
      engine: EngineId,
      privateRuntimeLocatorRef: string,
      plan: ExecutionIdentityPlanV1,
    ) => buildExecutionIdentityShadowStatusV1(config([{
      ref: engine === 'grok' ? PHANTOM_ID : LOCAL_ID,
      engine,
      privateRuntimeLocatorRef,
      plan,
    }], [engine]), { privateStorePath: f.storePath, now: NOW });

    expect(status('local-coder', LOCAL_LOCATOR,
      { kind: 'local', class: 'local-runtime', maxConcurrent: 1 }).sourceState).toBe('healthy');
    expect(status('grok', PHANTOM_LOCATOR,
      { kind: 'metered', class: 'api-metered', maxConcurrent: 1 }).sourceState).toBe('healthy');
    expect(status('aw', LOCAL_LOCATOR,
      { kind: 'local', class: 'local-runtime', maxConcurrent: 1 }).sourceState).toBe('healthy');
    expect(status('builtin', LOCAL_LOCATOR,
      { kind: 'local', class: 'local-runtime', maxConcurrent: 1 }).sourceState).toBe('healthy');

    expect(status('grok', LOCAL_LOCATOR,
      { kind: 'local', class: 'local-runtime', maxConcurrent: 1 }).stopReasons)
      .toContain('auth-engine-mismatch');
    expect(status('local-coder', PHANTOM_LOCATOR,
      { kind: 'metered', class: 'api-metered', maxConcurrent: 1 }).stopReasons)
      .toContain('auth-engine-mismatch');
    expect(status('grok', WRONG_PHANTOM_LOCATOR,
      { kind: 'metered', class: 'api-metered', maxConcurrent: 1 }).stopReasons)
      .toContain('auth-engine-mismatch');
  });
});

describeWindows('Execution Identity V1 — Windows private-store refusal', () => {
  it('keeps enabled V1 visible but degrades with no identity or assignment output', () => {
    const status = buildExecutionIdentityShadowStatusV1(codexConfig(), {
      privateStorePath: join(tmpdir(), 'must-not-be-opened-on-windows.json'),
      now: NOW,
      work: [{ id: 'must-remain-unassigned', engine: 'codex' }],
    });
    expect(status).toMatchObject({
      enabled: true,
      sourceState: 'degraded',
      stopReasons: ['platform-private-store-unsupported'],
      identities: [],
      assignments: [],
      executionAuthority: false,
      proposalAuthority: false,
      routingMutation: false,
    });
  });
});

describe('Execution Identity V1 — public boundary and flag-off compatibility', () => {
  it('does not inspect private stores or emit identities while disabled', () => {
    const cfg = {
      version: 1,
      foundry: {
        executionIdentityV1: {
          enabled: false,
          shadowOnly: true,
          identities: [{
            ref: 'not-opaque@example.com',
            engine: 'codex',
            privateRuntimeLocatorRef: '/private/leak',
            plan: { kind: 'subscription', class: 'codex-max', maxConcurrent: 1 },
          }],
        },
      },
    } as unknown as AshlrConfig;
    expect(buildExecutionIdentityShadowStatusV1(cfg, {
      privateStorePath: '/definitely/missing/private-store.json',
    })).toEqual({
      schemaVersion: 1, authority: 'shadow-only', enabled: false, shadowOnly: true,
      sourceState: 'disabled', stopReasons: [], configuredIdentityCount: 0,
      identities: [], assignments: [], unassigned: [], executionAuthority: false,
      proposalAuthority: false, routingMutation: false,
    });
  });

  it('strips locators, labels, emails, env names, and Phantom references from loadConfig()', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-execution-config-')));
    cleanup.add(root);
    const priorHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const configRoot = join(root, '.ashlr');
      privateDirectory(configRoot);
      privateFile(join(configRoot, 'config.json'), {
        version: 1,
        foundry: {
          allowedBackends: ['codex'],
          executionIdentityV1: {
            enabled: true,
            shadowOnly: true,
            accountLabel: 'personal-max-seat',
            accountEmail: 'seat@example.com',
            locator: '/private/should-never-load',
            secretNames: ['VERY_PRIVATE_PHANTOM_NAME'],
            identities: [{
              ref: ID_A,
              engine: 'codex',
              privateRuntimeLocatorRef: LOCATOR_A,
              CODEX_HOME: '/private/should-never-load',
              plan: {
                kind: 'subscription', class: 'codex-max', maxConcurrent: 1,
                phantomSecretName: 'VERY_PRIVATE_PHANTOM_NAME',
              },
            }],
          },
        },
      });
      vi.resetModules();
      const { loadConfig } = await import('../src/core/config.js');
      const loaded = loadConfig();
      const encoded = JSON.stringify(loaded);
      for (const forbidden of [
        'personal-max-seat', 'seat@example.com', '/private/should-never-load',
        'VERY_PRIVATE_PHANTOM_NAME', 'CODEX_HOME', 'phantomSecretName',
      ]) expect(encoded).not.toContain(forbidden);
      expect(loaded.foundry?.executionIdentityV1).toEqual({ enabled: true, shadowOnly: true });
      expect(encoded).not.toContain(ID_A);
      expect(encoded).not.toContain(LOCATOR_A);
      expect(buildExecutionIdentityShadowStatusV1(loaded, {
        privateStorePath: '/definitely/missing/private-store.json', now: NOW,
      })).toMatchObject({
        enabled: true,
        sourceState: 'degraded',
        stopReasons: ['identity-roster-missing'],
      });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      vi.resetModules();
    }
  });

});

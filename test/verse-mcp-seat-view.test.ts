/**
 * Tests for src/core/verse/mcp-seat-view.ts — which MCP servers each Verse
 * seat would load.
 *
 * What is proven here:
 *
 *   1. THE LOAD-BEARING CLAIM IS CHECKED AGAINST THE REAL ADAPTER, not
 *      restated. `VERSE_MCP_ISOLATED_ENGINES` says Claude and local seats load
 *      nothing; the first test builds a real launch through `claudeAdapter`
 *      and asserts the argv still carries `--strict-mcp-config` with an empty
 *      `--mcp-config`. If someone drops those flags, this file fails rather
 *      than the panel quietly turning into a lie.
 *   2. A seat NEVER inherits another account's servers: two Codex accounts
 *      with different private state roots resolve independently, and a
 *      machine-wide registry is never attributed to any seat.
 *   3. TOML is refused rather than half-parsed, and its refusal is
 *      distinguishable from "no config at all".
 *   4. NOTHING PRIVATE CROSSES THE BOUNDARY: no env value, no absolute path,
 *      no launcher argv appears anywhere in a serialized snapshot.
 *
 * Hermetic: every path is an explicit tmp root, nothing reads the real
 * ~/.ashlr, and nothing spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claudeAdapter } from '../src/core/verse/adapters/claude.js';
import type { VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import type { VerseSeat, VerseSession } from '../src/core/verse/types.js';
import {
  VERSE_MCP_ISOLATED_ENGINES,
  VERSE_MCP_ISOLATION_FLAGS,
  buildVerseMcpSnapshot,
  deriveVerseMcpSeatView,
  homeRelativeSourceRef,
  projectMcpServerView,
  resolveAccountStateRoots,
  type VerseMcpSeatInput,
} from '../src/core/verse/mcp-seat-view.js';
import type { VerseMcpScope } from '../src/core/verse/mcp-scope.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ashlr-mcp-seat-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const SCOPE: VerseMcpScope = {
  available: false,
  pinned: false,
  aliasRef: null,
  tenantRef: null,
  principalRef: null,
  bindingRef: null,
  sealOk: null,
  expired: null,
  frozen: null,
  expiresAt: null,
  status: null,
  statusOneline: null,
  reason: 'mcp-scope-locus-unavailable',
};

/**
 * Build a profile on disk exactly as `prepareResourceNativeProfile` lays one
 * out: `<dir>/launcher.mjs` next to `<dir>/profile.json`, with the provider's
 * private state under `<dir>/native-state`.
 */
function makeProfile(name: string): { launcher: string; stateRoot: string } {
  const dir = join(root, 'native-profiles', name);
  const stateRoot = join(dir, 'native-state');
  mkdirSync(stateRoot, { recursive: true });
  const launcher = join(dir, 'launcher.mjs');
  writeFileSync(launcher, '// launcher\n');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({
    schemaVersion: 1,
    provider: 'codex',
    nativeStatePath: stateRoot,
    // A real manifest also carries the argv. Nothing may lift it out.
    command: ['/usr/bin/node', launcher],
  }));
  return { launcher, stateRoot };
}

function writeConnections(accounts: Array<{ id: string; provider: string; launcher: string }>): string {
  const accountsRoot = join(root, 'account-connections');
  mkdirSync(accountsRoot, { recursive: true });
  writeFileSync(join(accountsRoot, 'connections.json'), JSON.stringify({
    schemaVersion: 1,
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.id,
      provider: a.provider,
      command: ['/usr/bin/node', a.launcher],
    })),
  }));
  return accountsRoot;
}

// ---------------------------------------------------------------------------
// 1. The claim, checked against the adapter that makes it true
// ---------------------------------------------------------------------------

describe('adapter isolation is a fact, not a comment', () => {
  const session: VerseSession = {
    id: 's1',
    title: 't',
    projectPath: '/tmp/project',
    engine: 'claude',
    accountId: 'claude',
    seatId: 'claude',
    model: 'claude-opus-4-1',
    nativeSessionId: '11111111-2222-3333-4444-555555555555',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'idle',
    turnCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 0,
      contextWindow: null,
    },
    lastError: null,
  };

  const seat: VerseSeat = {
    id: 'claude',
    engine: 'claude',
    label: 'Claude Code',
    accountId: 'claude',
    models: [{ id: 'claude-opus-4-1', label: 'Opus', contextWindow: null }],
    contextWindow: null,
    health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  };

  const launch: VerseSeatLaunch = {
    seat,
    launcher: ['/usr/bin/node', '/private/launcher.mjs'],
    ollamaBaseUrl: 'http://127.0.0.1:11434',
  };

  it('every Claude turn is launched with an empty --mcp-config under --strict-mcp-config', () => {
    const { argv } = claudeAdapter.buildLaunch(session, 'hello', launch);
    for (const flag of VERSE_MCP_ISOLATION_FLAGS) {
      expect(argv, `adapter argv lost ${flag}`).toContain(flag);
    }
    const index = argv.indexOf('--mcp-config');
    expect(argv[index + 1]).toBe('{"mcpServers":{}}');
  });

  it('the LOCAL engine rides the same builder, so it is isolated too', () => {
    const { argv } = claudeAdapter.buildLaunch(
      { ...session, engine: 'local', model: 'qwen3-coder-next' },
      'hello',
      { ...launch, launcher: null },
    );
    expect(argv).toContain('--strict-mcp-config');
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
  });

  it('VERSE_MCP_ISOLATED_ENGINES names exactly the engines that builder serves', () => {
    expect([...VERSE_MCP_ISOLATED_ENGINES].sort()).toEqual(['claude', 'local']);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-seat derivation
// ---------------------------------------------------------------------------

describe('deriveVerseMcpSeatView', () => {
  it('reports an isolated seat as loading nothing, whatever is configured', () => {
    const view = deriveVerseMcpSeatView(
      { id: 'claude', label: 'Claude Code', engine: 'claude', accountId: 'claude' },
      new Map([['claude', root]]),
      root,
    );
    expect(view.servers).toEqual([]);
    expect(view.reason).toBe('mcp-seat-isolated-by-adapter');
    // The reason is machine-readable; the NOTE is the sentence a human reads.
    expect(view.notes.join(' ')).toContain('--strict-mcp-config');
  });

  it('refuses TOML rather than half-parsing it', () => {
    const profile = makeProfile('codex-a');
    writeFileSync(join(profile.stateRoot, 'config.toml'), '[mcp_servers.demo]\ncommand = "x"\n');
    const view = deriveVerseMcpSeatView(
      { id: 'codex-a', label: 'Codex A', engine: 'codex', accountId: 'codex-a' },
      new Map([['codex-a', profile.stateRoot]]),
      root,
    );
    expect(view.reason).toBe('mcp-account-config-not-json');
    expect(view.configFormat).toBe('toml');
    expect(view.servers).toEqual([]);
  });

  it('distinguishes "no config" from "config we do not parse"', () => {
    const profile = makeProfile('codex-b');
    const view = deriveVerseMcpSeatView(
      { id: 'codex-b', label: 'Codex B', engine: 'codex', accountId: 'codex-b' },
      new Map([['codex-b', profile.stateRoot]]),
      root,
    );
    expect(view.reason).toBe('mcp-account-config-absent');
  });

  it('says so instead of guessing when the private profile is unresolvable', () => {
    const view = deriveVerseMcpSeatView(
      { id: 'codex-x', label: 'Codex X', engine: 'codex', accountId: 'codex-x' },
      new Map(),
      root,
    );
    expect(view.reason).toBe('mcp-account-profile-unresolved');
    expect(view.servers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Accounts do not bleed into each other
// ---------------------------------------------------------------------------

describe('one account never inherits another account\'s servers', () => {
  it('resolves each account to its own private state root', () => {
    const a = makeProfile('codex-a');
    const b = makeProfile('codex-b');
    const accountsRoot = writeConnections([
      { id: 'codex-personal', provider: 'codex', launcher: a.launcher },
      { id: 'codex-client', provider: 'codex', launcher: b.launcher },
    ]);

    const roots = resolveAccountStateRoots(accountsRoot);
    expect(roots.get('codex-personal')).toBe(a.stateRoot);
    expect(roots.get('codex-client')).toBe(b.stateRoot);
    expect(roots.get('codex-personal')).not.toBe(roots.get('codex-client'));
  });

  it('never attributes a machine-wide server to any seat', () => {
    const a = makeProfile('codex-a');
    const accountsRoot = writeConnections([
      { id: 'codex-personal', provider: 'codex', launcher: a.launcher },
    ]);

    // A machine-level registry with a real server in it.
    const machineConfig = join(root, '.mcp.json');
    writeFileSync(machineConfig, JSON.stringify({
      mcpServers: { 'house-keys': { command: '/usr/local/bin/keys', args: ['--serve'], env: { TOKEN: 'REDACTION-CANARY-D' } } },
    }));

    const seats: VerseMcpSeatInput[] = [
      { id: 'codex-personal', label: 'Personal', engine: 'codex', accountId: 'codex-personal' },
      { id: 'claude', label: 'Claude', engine: 'claude', accountId: 'claude' },
      { id: 'local', label: 'Local', engine: 'local', accountId: 'local' },
    ];

    const snapshot = buildVerseMcpSnapshot({
      accountsRoot,
      seats,
      machineConfigPaths: [machineConfig],
      scope: SCOPE,
      home: root,
    });

    expect(snapshot.machine.configured).toBe(true);
    expect(snapshot.machine.servers).toHaveLength(1);
    for (const seat of snapshot.seats) {
      expect(seat.servers, `${seat.seatId} was credited with a machine server`).toEqual([]);
    }
    // The whole point: a configured machine registry that no seat reads is
    // stated out loud rather than left for the operator to infer.
    expect(snapshot.notes.join(' ')).toContain('no Verse seat loads any of them');
  });
});

// ---------------------------------------------------------------------------
// 4. Nothing private crosses the boundary
// ---------------------------------------------------------------------------

describe('serialized output carries no secret, path or argv', () => {
  it('redacts every env value and publishes only a home-relative source', () => {
    const view = projectMcpServerView(
      {
        name: 'demo',
        command: '/usr/local/bin/demo',
        args: ['--serve'],
        env: { API_TOKEN: 'REDACTION-CANARY-D', OTHER: 'REDACTION-CANARY-E' },
        source: join(root, '.mcp.json'),
      },
      root,
    );
    expect(view.env).toEqual({ API_TOKEN: '<set>', OTHER: '<set>' });
    expect(view.sourceRef).toBe('.mcp.json');
    expect(JSON.stringify(view)).not.toContain('REDACTION-CANARY-D');
  });

  it('never emits an absolute path or a launcher argv in a whole snapshot', () => {
    const a = makeProfile('codex-a');
    const accountsRoot = writeConnections([
      { id: 'codex-personal', provider: 'codex', launcher: a.launcher },
    ]);
    const machineConfig = join(root, '.claude.json');
    writeFileSync(machineConfig, JSON.stringify({
      mcpServers: { demo: { command: '/usr/local/bin/demo', env: { SECRET: 'REDACTION-CANARY-G' } } },
    }));

    const serialized = JSON.stringify(buildVerseMcpSnapshot({
      accountsRoot,
      seats: [{ id: 'codex-personal', label: 'Personal', engine: 'codex', accountId: 'codex-personal' }],
      machineConfigPaths: [machineConfig],
      scope: SCOPE,
      home: root,
    }));

    expect(serialized).not.toContain('REDACTION-CANARY-G');
    expect(serialized).not.toContain('launcher.mjs');
    expect(serialized).not.toContain(a.stateRoot);
    expect(serialized).not.toContain(root);
  });

  it('refuses to name a file that sits outside home', () => {
    expect(homeRelativeSourceRef('/etc/somewhere/mcp.json', root)).toBe('(outside home)');
    expect(homeRelativeSourceRef(join(root, '.ashlr', 'settings.json'), root)).toBe('.ashlr/settings.json');
  });
});

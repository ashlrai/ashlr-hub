/**
 * Tests for src/core/verse/mcp-mutation.ts — adding an MCP server, which is
 * installing arbitrary code that will run with the agent's privileges.
 *
 * What is proven here:
 *
 *   1. NO ONE-CLICK INSTALL. `apply` refuses without the digest the proposal
 *      returned, and refuses again when the target file changed after the
 *      proposal was shown. Both are refusals, not merges.
 *   2. The disclosure is COMPLETE and REDACTED: the full command and args are
 *      shown verbatim, env keys are shown, and no env value appears anywhere
 *      in the proposal, the apply result, or a rejection message.
 *   3. TOML is refused rather than rewritten, and the forbidden hub files are
 *      unreachable as targets.
 *   4. Locus owns admission: a refused gate blocks the write and leaves the
 *      file untouched.
 *   5. Validation is strict — unknown keys, control characters and oversized
 *      inputs are rejected rather than coerced.
 *
 * Hermetic: every path is an explicit tmp root; nothing spawns; the Locus
 * scope gate is a plain value.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VerseMcpScopeGate } from '../src/core/verse/mcp-scope.js';
import {
  VERSE_MCP_FORBIDDEN_FILES,
  applyVerseMcpProposal,
  buildVerseMcpProposal,
  parseVerseMcpSpec,
  resolveVerseMcpTarget,
} from '../src/core/verse/mcp-mutation.js';

let root: string;
let accountsRoot: string;

const SECRET = 'REDACTION-CANARY-A';

const ALLOWED: VerseMcpScopeGate = {
  scope: {
    available: true, pinned: true, aliasRef: 'acme', tenantRef: 'tenant_01HX',
    principalRef: 'principal_44a', bindingRef: 'bind_9f2', sealOk: true, expired: false,
    frozen: false, expiresAt: null, status: 'ready', statusOneline: 'acme:tenant_01HX',
    reason: 'mcp-scope-pinned',
  },
  mode: 'warn',
  allow: true,
  blockers: [],
};

const BLOCKED: VerseMcpScopeGate = {
  ...ALLOWED,
  mode: 'enforce',
  allow: false,
  blockers: ['locus: pin expired'],
};

const SERVER = {
  name: 'weather',
  command: '/usr/local/bin/weather-mcp',
  args: ['--serve', '--port', '7333'],
  env: { WEATHER_API_KEY: SECRET },
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ashlr-mcp-mut-'));
  accountsRoot = join(root, 'account-connections');
  mkdirSync(accountsRoot, { recursive: true });
  mkdirSync(join(root, '.ashlr'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function propose(server: unknown = SERVER, scope: VerseMcpScopeGate = ALLOWED) {
  return buildVerseMcpProposal({ targetId: 'hub', server, accountsRoot, scope, home: root });
}

function hubPath(): string {
  return join(root, '.ashlr', 'settings.json');
}

/** Build an account profile whose private config is TOML (Codex / Grok). */
function makeTomlAccount(id: string): void {
  const dir = join(root, 'native-profiles', id);
  const stateRoot = join(dir, 'native-state');
  mkdirSync(stateRoot, { recursive: true });
  const launcher = join(dir, 'launcher.mjs');
  writeFileSync(launcher, '// launcher\n');
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ nativeStatePath: stateRoot }));
  writeFileSync(join(stateRoot, 'config.toml'), '[mcp_servers.x]\n');
  writeFileSync(join(accountsRoot, 'connections.json'), JSON.stringify({
    accounts: [{ id, label: id, provider: 'codex', command: ['/usr/bin/node', launcher] }],
  }));
}

// ---------------------------------------------------------------------------
// 1. Never a one-click install
// ---------------------------------------------------------------------------

describe('the write takes two steps and the second cannot be forged', () => {
  it('a proposal writes nothing', () => {
    const proposal = propose();
    expect(proposal.ok).toBe(true);
    expect(() => readFileSync(hubPath(), 'utf8')).toThrow();
  });

  it('apply refuses a digest that was never issued', () => {
    const result = applyVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: ALLOWED, home: root,
      digest: 'f'.repeat(64),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('mcp-digest-mismatch');
    expect(() => readFileSync(hubPath(), 'utf8')).toThrow();
  });

  it('apply accepts the digest the proposal returned', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');

    const result = applyVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: ALLOWED, home: root,
      digest: proposal.digest,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.action).toBe('add');

    const written = JSON.parse(readFileSync(hubPath(), 'utf8')) as Record<string, any>;
    expect(written['mcpServers']['weather']).toEqual({
      command: '/usr/local/bin/weather-mcp',
      args: ['--serve', '--port', '7333'],
      env: { WEATHER_API_KEY: SECRET },
    });
  });

  it('refuses a digest that went stale because the target changed underneath it', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');

    // Someone else edits the registry between the disclosure and the confirm.
    writeFileSync(hubPath(), JSON.stringify({ mcpServers: { other: { command: '/bin/other' } } }));

    const result = applyVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: ALLOWED, home: root,
      digest: proposal.digest,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('mcp-digest-mismatch');

    // The other edit is intact: a stale confirm does not clobber.
    const after = JSON.parse(readFileSync(hubPath(), 'utf8')) as Record<string, any>;
    expect(Object.keys(after['mcpServers'])).toEqual(['other']);
  });

  it('shows what a replacement would overwrite before it overwrites it', () => {
    writeFileSync(hubPath(), JSON.stringify({
      mcpServers: { weather: { command: '/old/path/weather', args: ['--old'], env: { WEATHER_API_KEY: 'REDACTION-CANARY-F' } } },
    }));
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');

    expect(proposal.action).toBe('replace');
    expect(proposal.replaces).not.toBeNull();
    expect(proposal.replaces!.command).toBe('/old/path/weather');
    expect(proposal.replaces!.env).toEqual({ WEATHER_API_KEY: '<set>' });
    expect(JSON.stringify(proposal)).not.toContain('REDACTION-CANARY-F');
    expect(proposal.warnings.join(' ')).toContain('would be replaced');
  });
});

// ---------------------------------------------------------------------------
// 2. Full disclosure, fully redacted
// ---------------------------------------------------------------------------

describe('the operator sees the command and never sees the secret', () => {
  it('shows command and args verbatim and env keys with redacted values', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');

    expect(proposal.server.command).toBe('/usr/local/bin/weather-mcp');
    expect(proposal.server.args).toEqual(['--serve', '--port', '7333']);
    expect(proposal.server.env).toEqual({ WEATHER_API_KEY: '<set>' });
    expect(JSON.stringify(proposal)).not.toContain(SECRET);
    // The env KEY is named, so the operator knows what is being handed over.
    expect(proposal.warnings.join(' ')).toContain('WEATHER_API_KEY');
  });

  it('keeps the secret out of the apply result too', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    const result = applyVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: ALLOWED, home: root, digest: proposal.digest,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    if (!result.ok) throw new Error('unreachable');
    expect(result.server.env).toEqual({ WEATHER_API_KEY: '<set>' });
  });

  it('keeps the secret out of a REJECTION message', () => {
    const parsed = parseVerseMcpSpec({
      name: 'x', command: '/bin/x', env: { TOKEN: `line-one\nline-two-${SECRET}` },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('TOKEN');
    expect(parsed.error).not.toContain(SECRET);
  });

  it('warns that a non-absolute command is resolved through PATH', () => {
    const proposal = propose({ name: 'npx-thing', command: 'npx', args: ['-y', 'some-server'] });
    if (!proposal.ok) throw new Error('expected a proposal');
    expect(proposal.warnings.join(' ')).toContain('resolved through PATH');
  });

  it('never publishes an absolute target path', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    expect(proposal.target.ref).toBe('.ashlr/settings.json');
    expect(JSON.stringify(proposal)).not.toContain(root);
  });

  it('names the Locus tenant the write lands under', () => {
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    expect(proposal.warnings.join(' ')).toContain('tenant_01HX');
  });
});

// ---------------------------------------------------------------------------
// 3. Targets that are refused
// ---------------------------------------------------------------------------

describe('targets', () => {
  it('refuses to rewrite an account that keeps TOML', () => {
    makeTomlAccount('codex-personal');
    const resolved = resolveVerseMcpTarget('account:codex-personal', { accountsRoot, home: root });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.refusal).toBe('mcp-target-not-json');
    expect(resolved.error).toContain('does not rewrite TOML');
  });

  it('refuses an unknown target rather than writing somewhere plausible', () => {
    const proposal = buildVerseMcpProposal({
      targetId: '/etc/passwd', server: SERVER, accountsRoot, scope: ALLOWED, home: root,
    });
    expect(proposal.ok).toBe(false);
    if (proposal.ok) throw new Error('unreachable');
    expect(proposal.refusal).toBe('mcp-target-unknown');
  });

  it('refuses an account with no resolvable private profile', () => {
    const resolved = resolveVerseMcpTarget('account:ghost', { accountsRoot, home: root });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('unreachable');
    expect(resolved.refusal).toBe('mcp-target-unresolved');
  });

  it('never resolves a target onto a hub file that is not an MCP registry', () => {
    // The enumerated target set is the control; this asserts the names that
    // must never be reachable are the ones the constant lists.
    expect([...VERSE_MCP_FORBIDDEN_FILES].sort()).toEqual(['KILL', 'config.json', 'enrollment.json']);
    for (const id of ['config.json', 'enrollment.json', 'KILL', 'account:../..']) {
      const resolved = resolveVerseMcpTarget(id, { accountsRoot, home: root });
      expect(resolved.ok, `${id} must not resolve`).toBe(false);
    }
  });

  it('leaves the hub config untouched when it writes the hub registry', () => {
    const configPath = join(root, '.ashlr', 'config.json');
    writeFileSync(configPath, JSON.stringify({ untouched: true }));
    const proposal = propose();
    if (!proposal.ok) throw new Error('expected a proposal');
    applyVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: ALLOWED, home: root, digest: proposal.digest,
    });
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ untouched: true });
  });
});

// ---------------------------------------------------------------------------
// 4. Locus owns admission
// ---------------------------------------------------------------------------

describe('a blocked Locus scope blocks the write', () => {
  it('refuses and writes nothing', () => {
    const proposal = buildVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: BLOCKED, home: root,
    });
    if (!proposal.ok) throw new Error('expected a proposal');
    // The proposal still renders — the operator should SEE what is blocked.
    expect(proposal.warnings.join(' ')).toContain('Locus is blocking writes');

    const result = applyVerseMcpProposal({
      targetId: 'hub', server: SERVER, accountsRoot, scope: BLOCKED, home: root, digest: proposal.digest,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.refusal).toBe('mcp-scope-refused');
    expect(result.error).toContain('pin expired');
    expect(() => readFileSync(hubPath(), 'utf8')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Strict validation
// ---------------------------------------------------------------------------

describe('parseVerseMcpSpec', () => {
  it('rejects an unknown key rather than ignoring it', () => {
    const parsed = parseVerseMcpSpec({ name: 'x', command: '/bin/x', cwd: '/tmp' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.error).toContain('unknown key');
  });

  it('rejects control characters in a command', () => {
    expect(parseVerseMcpSpec({ name: 'x', command: '/bin/x --evil' }).ok).toBe(false);
    expect(parseVerseMcpSpec({ name: 'x', command: '/bin/x\nrm -rf /' }).ok).toBe(false);
  });

  it('rejects a name that is not a plain identifier', () => {
    for (const name of ['', '../escape', 'has space', 'a'.repeat(65)]) {
      expect(parseVerseMcpSpec({ name, command: '/bin/x' }).ok, `${name} must be rejected`).toBe(false);
    }
  });

  it('rejects an invalid env key', () => {
    expect(parseVerseMcpSpec({ name: 'x', command: '/bin/x', env: { '9BAD': 'v' } }).ok).toBe(false);
  });

  it('rejects an oversized args list', () => {
    const args = Array.from({ length: 65 }, (_, i) => `--flag-${i}`);
    expect(parseVerseMcpSpec({ name: 'x', command: '/bin/x', args }).ok).toBe(false);
  });

  it('never coerces: a non-string arg is a rejection, not a cast', () => {
    expect(parseVerseMcpSpec({ name: 'x', command: '/bin/x', args: [7] }).ok).toBe(false);
  });

  it('accepts a minimal valid spec with no env and no args', () => {
    const parsed = parseVerseMcpSpec({ name: 'minimal', command: '/bin/minimal' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.spec.args).toEqual([]);
    expect(parsed.spec.env).toBeUndefined();
  });
});

/**
 * apps-model.test.ts — the decisions behind Apps & Accounts, without a DOM:
 * which launch command a choice runs, where a Launch may start, which seat
 * gets which action, what MCP target can take a write, and how the Add form
 * turns text into argv and env without guessing.
 */
import { describe, expect, it } from 'vitest';
import { buildCapacityRows } from '../usage/capacity-strip-model.js';
import { GROK_SEAT, LOCAL_SEAT_V2 } from '../seat-fixtures.test-support.js';
import { projectMcpSnapshot } from '../mcp/mcp-contract.js';
import {
  accountActions,
  appHealthTone,
  launchCommand,
  launchProjects,
  localModelTags,
  mcpSeatRows,
  mcpTargets,
  parseEnvLines,
  splitArgs,
} from './apps-model.js';
import { APPS, BOOTSTRAP, CLAUDE_SEAT, HEALTH, MCP } from './apps.test-support.js';

const agents = APPS.groups.find((g) => g.id === 'terminal-agents')!.apps;
const codex = agents.find((a) => a.id === 'codex')!;
const grok = agents.find((a) => a.id === 'grok')!;

describe('launch', () => {
  it('runs the agent’s own command, or `ollama launch <id> [--model <tag>]` only where listed', () => {
    expect(launchCommand(codex, { via: 'native', model: null })).toEqual(['codex']);
    expect(launchCommand(codex, { via: 'ollama', model: null })).toEqual(['ollama', 'launch', 'codex']);
    expect(launchCommand(codex, { via: 'ollama', model: 'qwen3.8:27b' })).toEqual(['ollama', 'launch', 'codex', '--model', 'qwen3.8:27b']);
    expect(launchCommand(grok, { via: 'ollama', model: null })).toBeNull();
  });

  it('starts in the newest chat’s folder, then every project, without duplicates', () => {
    expect(launchProjects(BOOTSTRAP)).toEqual([
      { path: '/Users/op/code/ashlr-hub', name: 'ashlr-hub' },
      { path: '/Users/op/code/site', name: 'site' },
    ]);
    expect(launchProjects(undefined)).toEqual([]);
  });

  it('offers the local seats’ Ollama tags as models', () => {
    expect(localModelTags([CLAUDE_SEAT, LOCAL_SEAT_V2, { ...LOCAL_SEAT_V2, id: 'local:x', models: [] }])).toEqual(['qwen3-coder', 'x']);
  });
});

describe('accountActions', () => {
  const rows = buildCapacityRows([CLAUDE_SEAT, GROK_SEAT, LOCAL_SEAT_V2], { health: HEALTH.seats });
  const byId = new Map(rows.map((r) => [r.seatId, r]));

  it('signed out → Reconnect first; a re-pin → Fix with its command; every paid seat → Edit budget', () => {
    expect(accountActions(byId.get('grok')!).map((a) => [a.kind, a.primary])).toEqual([['reconnect', true], ['edit-budget', false]]);
    expect(accountActions(byId.get('claude-a')!)).toEqual([
      { kind: 'fix', label: 'Fix', command: ['ashlr', 'resources', 'profile', 'repin'], primary: true },
      { kind: 'edit-budget', label: 'Edit budget', command: null, primary: false },
    ]);
  });

  it('a spent, unread or unavailable seat offers Check again as its one action; a usable one does not', () => {
    const spent = { kind: 'spent', label: 'Spent', detail: 'resets Fri 11:46 PM', tone: 'danger', usableAgain: null, checked: null, checkedTitle: null, coversConnection: true } as const;
    const claude = byId.get('claude-a')!;
    // claude-a is pinned to an older CLI: with a recheckable status, Check again leads and Fix follows.
    expect(accountActions(claude, spent).map((a) => [a.kind, a.primary])).toEqual([['check-again', true], ['fix', false], ['edit-budget', false]]);
    expect(accountActions(claude, { ...spent, kind: 'usable', label: 'Connected' }).map((a) => a.kind)).toEqual(['fix', 'edit-budget']);
    // Signed out needs the sign-in, not a re-check.
    expect(accountActions(byId.get('grok')!, { ...spent, kind: 'not-checked' }).map((a) => a.kind)).toEqual(['reconnect', 'edit-budget']);
  });

  it('a local seat needs none', () => {
    expect(accountActions(byId.get('local:qwen3-coder')!)).toEqual([]);
  });
});

describe('MCP', () => {
  const snapshot = projectMcpSnapshot(MCP)!;

  it('says what each seat loads, isolated seats in their own words', () => {
    const rows = mcpSeatRows(snapshot);
    expect(rows.map((r) => [r.seatId, r.loads, r.monogram])).toEqual([
      ['claude-a', 'loads none — isolated by Verse', 'C'],
      ['codex-a', 'loads 1 server', 'X'],
      ['local', 'loads none — isolated by Verse', 'L'],
    ]);
    expect(rows[1]!.sentence).toBe("Read from this account's own private configuration.");
  });

  it('offers the hub and JSON accounts as targets; TOML accounts say why not', () => {
    expect(mcpTargets(snapshot)).toEqual([
      { id: 'hub', label: 'Hub gateway registry', disabledReason: null },
      { id: 'account:claude-a', label: 'Claude Max (claude)', disabledReason: null },
      { id: 'account:codex-a', label: 'Personal Codex (codex)', disabledReason: 'Keeps its MCP servers in TOML, which Hub does not rewrite.' },
    ]);
    expect(mcpTargets(null)).toHaveLength(1);
  });

  it('splits arguments like a shell, keeping quoted spaces', () => {
    expect(splitArgs('-y @scope/server "~/My Code" \'a b\' ""')).toEqual(['-y', '@scope/server', '~/My Code', 'a b', '']);
    expect(splitArgs('   ')).toEqual([]);
  });

  it('reads KEY=value lines and reports the first bad one instead of guessing', () => {
    expect(parseEnvLines('A=1\n# note\n\nB_2=x=y')).toEqual({ ok: true, env: { A: '1', B_2: 'x=y' } });
    expect(parseEnvLines('A=1\nnot a pair')).toEqual({ ok: false, error: '“not a pair” is not KEY=value.' });
    expect(parseEnvLines('1BAD=x').ok).toBe(false);
  });
});

describe('appHealthTone', () => {
  it('keeps "off" quiet and "unknown" distinct from a fault', () => {
    expect(appHealthTone('ok')).toBe('success');
    expect(appHealthTone('off')).toBe('off');
    expect(appHealthTone('unknown')).toBe('neutral');
    expect(appHealthTone('error')).toBe('danger');
  });
});

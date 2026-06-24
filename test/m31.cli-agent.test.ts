/**
 * M31 — agent-grade CLI surface: docs --agent registry, CLAUDE.md snippet,
 * completions scripts, and the "did you mean" suggester.
 *
 * Pure unit tests over the exported data/functions — no CLI process spawns,
 * no HOME mutation needed (everything here is read-only).
 */

import { describe, it, expect } from 'vitest';

import { AGENT_COMMANDS, agentDocsText, claudeMdSnippet } from '../src/cli/help.js';
import { TOP_LEVEL_COMMANDS, didYouMean, cmdCompletions } from '../src/cli/completions.js';
import { nativeToolDefs } from '../src/core/mcp-native.js';

// ---------------------------------------------------------------------------
// AGENT_COMMANDS registry
// ---------------------------------------------------------------------------

describe('AGENT_COMMANDS — the CLI-first agent contract', () => {
  it('every entry has usage, description, safety, and a json shape', () => {
    expect(AGENT_COMMANDS.length).toBeGreaterThanOrEqual(10);
    for (const c of AGENT_COMMANDS) {
      expect(c.usage).toMatch(/^ashlr /);
      expect(c.description.length).toBeGreaterThan(20);
      expect(['read', 'append', 'proposal', 'human-gate']).toContain(c.safety);
      expect(c.jsonShape.length).toBeGreaterThan(0);
    }
  });

  it('covers the core agent loop: orient, ask, recall, learn, backlog, health', () => {
    const usages = AGENT_COMMANDS.map((c) => c.usage).join('\n');
    for (const cmd of ['orient', 'ask', 'recall', 'learn', 'backlog', 'health']) {
      expect(usages).toContain(`ashlr ${cmd}`);
    }
  });

  it('marks inbox approval as human-gate', () => {
    const approve = AGENT_COMMANDS.find((c) => c.usage.includes('approve'));
    expect(approve).toBeTruthy();
    expect(approve!.safety).toBe('human-gate');
  });
});

// ---------------------------------------------------------------------------
// agentDocsText / claudeMdSnippet
// ---------------------------------------------------------------------------

describe('agent docs surfaces', () => {
  it('agentDocsText is ANSI-free plain text containing every usage line', () => {
    const text = agentDocsText();
    expect(text).not.toContain('\u001b');
    for (const c of AGENT_COMMANDS) expect(text).toContain(c.usage);
  });
  it('agentDocsText lists every native MCP tool by name (no drift)', () => {
    const text = agentDocsText();
    // ashlr_desktop_open is MCP-only (safety: proposal, no CLI equivalent);
    // it is intentionally absent from the agentDocsText hardcoded tool list.
    const cliSurfaced = nativeToolDefs().filter((t) => t.name !== 'ashlr_desktop_open');
    for (const t of cliSurfaced) expect(text).toContain(t.name);
  });

  it('claudeMdSnippet teaches orient-at-session-start and forbids the human gates', () => {
    const snippet = claudeMdSnippet();
    expect(snippet).toContain('ashlr orient');
    expect(snippet).toContain('NEVER run');
    expect(snippet).toContain('ashlr inbox approve|reject');
  });
});

// ---------------------------------------------------------------------------
// Completions
// ---------------------------------------------------------------------------

describe('completions', () => {
  it('TOP_LEVEL_COMMANDS includes the M31 additions', () => {
    for (const cmd of ['orient', 'docs', 'completions']) {
      expect(TOP_LEVEL_COMMANDS).toContain(cmd);
    }
  });

  it('zsh script emits a #compdef header and every command', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { chunks.push(String(s)); return true; }) as typeof process.stdout.write;
    try {
      const code = await cmdCompletions(['zsh']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const script = chunks.join('');
    expect(script).toContain('#compdef ashlr');
    for (const cmd of TOP_LEVEL_COMMANDS) expect(script).toContain(`'${cmd}'`);
  });

  it('bash script emits a complete -F registration', async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => { chunks.push(String(s)); return true; }) as typeof process.stdout.write;
    try {
      const code = await cmdCompletions(['bash']);
      expect(code).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    expect(chunks.join('')).toContain('complete -F _ashlr_completions ashlr');
  });

  it('unknown shell returns exit 2', async () => {
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(await cmdCompletions(['fish'])).toBe(2);
    } finally {
      process.stdout.write = orig;
      console.log = origLog;
    }
  });
});

// ---------------------------------------------------------------------------
// did you mean
// ---------------------------------------------------------------------------

describe('didYouMean', () => {
  it('suggests close commands for one-edit typos', () => {
    expect(didYouMean('staus')).toBe('status');
    expect(didYouMean('orint')).toBe('orient');
    expect(didYouMean('inbx')).toBe('inbox');
  });

  it('returns null for nothing-like-a-command input', () => {
    expect(didYouMean('xyzzyplugh')).toBeNull();
  });
});

/**
 * M31 — agent-grade CLI surface: docs --agent registry, CLAUDE.md snippet,
 * completions scripts, and the "did you mean" suggester.
 *
 * Pure unit tests over the exported data/functions — no CLI process spawns,
 * no HOME mutation needed (everything here is read-only).
 */

import { describe, it, expect, vi } from 'vitest';

import { AGENT_COMMANDS, agentDocsText, claudeMdSnippet, cmdDocs } from '../src/cli/help.js';
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

  it.each([
    ['campaign init ', 'append', 'UniverseCampaignSummary'],
    ['campaign status ', 'read', 'UniverseCampaignSummary | {campaigns: UniverseCampaignSummary[], sourceState, reasons}'],
    ['campaign check ', 'read', 'UniverseCampaignReadiness'],
    ['resources check ', 'read', 'ResourceGenerationRuntimeCheck'],
    ['campaign run|resume ', 'append', 'UniverseCampaignSummary without delivery flags; UniverseCampaignDeliveryResult {campaign, delivery} with paired flags'],
    ['campaign supervise ', 'append', 'UniverseCampaignSupervisorResult'],
    ['deliver ', 'append', 'UniverseDeliveryReceipt'],
    ['deliveries ', 'read', 'UniverseDeliveryReport'],
  ])('discovers universe %s with its existing result contract', (command, safety, jsonShape) => {
    const entries = AGENT_COMMANDS.filter((entry) => entry.usage.startsWith(`ashlr universe ${command}`));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ safety, jsonShape });
    expect(entries[0]!.usage).toContain('--json');
  });

  it('distinguishes recorded readiness and valid configuration from execution readiness', () => {
    const campaign = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe campaign check '))!;
    const resources = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe resources check '))!;
    expect(campaign.usage).toContain('--root <absolute>');
    expect(campaign.usage).not.toContain('--resource-runtime');
    expect(campaign.description).toContain('automaticAction is advisory');
    expect(campaign.description).toContain('Exit 0 includes held and terminal healthy snapshots');
    expect(campaign.description).toContain('No provider contact, quota refresh or resume');
    expect(resources.description).toContain('local-configuration-only');
    expect(resources.description).toContain('providerContacted is false');
    expect(resources.description).toContain('even when all workers are excluded');
    expect(resources.description).toContain('Does not prove authentication, current quota or campaign admission');
  });

  it('documents bounded execution, paired delivery and independent replay outcomes', () => {
    const run = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe campaign run|resume '))!;
    const supervise = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe campaign supervise '))!;
    expect(run.usage).toContain('[--deliver-branch codex/<name> --deliver-base <full-seed-commit>]');
    expect(run.description).toContain('resume does not reset limits');
    expect(run.description).toContain('can consume provider/model usage');
    expect(run.description).toContain('best strict measured improvement');
    expect(run.description).toContain('Exit 0 can include withheld/no-strict-improvement');
    expect(supervise.usage).toContain('--max-duration-ms <N>');
    expect(supervise.usage).toContain('[--delivery-plan <private-absolute.json>]');
    expect(supervise.description).toContain('fixed explicit queue of 1-32');
    expect(supervise.description).toContain('private mode-0600 delivery plan');
    expect(supervise.description).toContain('without rerunning workers');
    expect(supervise.description).toContain('attempted tracks campaign execution, not delivery replay');
    expect(supervise.description).toContain('130 caller cancellation');
    for (const entry of [run, supervise]) {
      expect(entry.description).toContain('No merge, push, checkout or service activation');
    }
  });

  it('distinguishes explicit elite delivery from strict-improvement campaign selection', () => {
    const deliver = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe deliver '))!;
    const receipts = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe deliveries '))!;
    expect(deliver.description).toContain('not a campaign strict-improvement winner');
    expect(deliver.description).toContain('Unchanged artifacts create no branch');
    expect(deliver.description).toContain('Does not change checkout, index or HEAD, merge, push or deploy');
    expect(receipts.description).toContain('without changing the repository or dispatching work');
    expect(receipts.description).toContain('Exit 1 for pending/degraded evidence, 0 otherwise (including no receipts)');
  });
});

// ---------------------------------------------------------------------------
// agentDocsText / claudeMdSnippet
// ---------------------------------------------------------------------------

describe('agent docs surfaces', () => {
  it('preserves the four-field JSON registry and top-level commands wrapper', async () => {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      expect(await cmdDocs(['--agent', '--json'])).toBe(0);
    } finally {
      stdout.mockRestore();
    }
    const result = JSON.parse(chunks.join(''));
    expect(Object.keys(result)).toEqual(['commands']);
    expect(result.commands).toEqual(AGENT_COMMANDS);
    for (const entry of result.commands) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'jsonShape', 'safety', 'usage']);
    }
  });

  it('does not present legacy safety labels or zero exits as execution permission', () => {
    const text = agentDocsText();
    expect(text).toContain('not an exhaustive command list');
    expect(text).toContain('not authorization');
    expect(text).toContain('not append-only');
    expect(text).toContain('exit 0 need not mean ready, delivered or accepted');
    expect(text).toContain('130 for caller cancellation');
    expect(text).not.toContain('read = always safe');
    expect(text).not.toContain('append = append-only under ~/.ashlr/');
    expect(text).not.toContain('exit codes are 0 success / 1 error / 2 bad usage');
  });

  it('agentDocsText is ANSI-free plain text containing every usage line', () => {
    const text = agentDocsText();
    expect(text).not.toContain('\u001b');
    for (const c of AGENT_COMMANDS) expect(text).toContain(c.usage);
  });
  it('agentDocsText lists every native MCP tool by name (no drift)', () => {
    const text = agentDocsText();
    // ashlr_desktop_open and ashlr_browser_task are MCP-only (safety: proposal,
    // no CLI equivalent); they are intentionally absent from the agentDocsText
    // hardcoded tool list.
    const cliSurfaced = nativeToolDefs().filter(
      (t) => t.name !== 'ashlr_desktop_open' && t.name !== 'ashlr_browser_task',
    );
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
    for (const cmd of ['orient', 'docs', 'completions', 'fleet']) {
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
    expect(script).toContain("fleet) _values 'subcommand'");
    expect(script).toContain("'evidence'");
    expect(script).toContain("runtime) _values 'subcommand' 'install' 'status' 'rollback' 'run' ;;");
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
    expect(chunks.join('')).toContain('runtime) COMPREPLY=( $(compgen -W "install status rollback run" -- "$cur") ) ;;');
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
    expect(didYouMean('runtim')).toBe('runtime');
  });

  it('returns null for nothing-like-a-command input', () => {
    expect(didYouMean('xyzzyplugh')).toBeNull();
  });
});

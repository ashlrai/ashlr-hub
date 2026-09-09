/**
 * M32 — topic-grouped help (src/cli/help.ts cmdHelp + HELP_ENTRIES).
 *
 * Pure unit tests over the exported data + captured stdout. No HOME mutation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { AGENT_COMMANDS, cmdHelp, HELP_ENTRIES } from '../src/cli/help.js';
import { TOP_LEVEL_COMMANDS } from '../src/cli/completions.js';

let captured: string[] = [];
let origLog: typeof console.log;

beforeEach(() => {
  expect.hasAssertions();
  captured = [];
  origLog = console.log;
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
});

afterEach(() => {
  console.log = origLog;
});

function output(): string {
  return captured.join('\n');
}

describe('HELP_ENTRIES — the command table', () => {
  it.each([
    'universe campaign <init|status|run|resume|pause|stop>',
    'universe campaign check ',
    'universe resources check ',
    'universe campaign supervise ',
    'universe deliver ',
    'universe deliveries ',
  ])('routes %s to autonomy help', (prefix) => {
    const entries = HELP_ENTRIES.filter((entry) => entry.cmd.startsWith(prefix));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.topic).toBe('autonomy');
  });

  it('shows campaign checks, bounded supervision and local delivery through help autonomy', async () => {
    expect(await cmdHelp(['autonomy'])).toBe(0);
    const text = output();
    expect(text).toContain('universe campaign check');
    expect(text).toContain('universe resources check');
    expect(text).toContain('--max-duration-ms');
    expect(text).toContain('--delivery-plan');
    expect(text).toContain('--deliver-branch');
    expect(text).toContain('--deliver-base');
    expect(text).toContain('universe deliveries');
    expect(text).toContain('without rerunning workers');
  });

  it('advertises execution-only portfolio resource bindings without changing the plan contract', () => {
    const run = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe portfolio run '))!;
    const plan = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe portfolio plan '))!;
    expect(run.usage).toContain('--resource-runtime <private-absolute.json>');
    expect(run.description).toContain('shared pool limits and campaign budgets');
    expect(run.usage).toContain('--delivery-plan <private-absolute.json>');
    expect(run.description).toContain('explicit local Git delivery prerequisites');
    expect(plan.usage).not.toContain('--delivery-plan');
    expect(run.safety).toBe('append');
    expect(run.jsonShape).toBe('UniversePortfolioResult');
    expect(plan.usage).not.toContain('--resource-runtime');
    expect(plan.safety).toBe('read');
    expect(plan.jsonShape).toBe('UniversePortfolioPlan');
  });

  it('advertises resource diagnostics without promoting them to execution authority', () => {
    const check = AGENT_COMMANDS.find((entry) => entry.usage.startsWith('ashlr universe resources check '))!;
    expect(check.safety).toBe('read');
    expect(check.jsonShape).toBe('ResourceGenerationRuntimeCheck');
    expect(check.description).toContain('policy holds, planner recheck hints and diagnostic nextChecks');
    expect(check.description).toContain('without changing reserves');
    expect(check.description).toContain('providerContacted is false');
  });

  it('every entry has a command, description, and known topic', () => {
    expect(HELP_ENTRIES.length).toBeGreaterThanOrEqual(80);
    for (const e of HELP_ENTRIES) {
      expect(e.cmd.length).toBeGreaterThan(1);
      expect(e.desc.length).toBeGreaterThan(10);
    }
  });

  it('covers every top-level command (no drift vs completions)', () => {
    const tableCmds = new Set(HELP_ENTRIES.map((e) => e.cmd.split(' ')[0]));
    for (const cmd of TOP_LEVEL_COMMANDS) {
      if (cmd === 'dash') continue; // alias of tui
      expect(tableCmds.has(cmd), `help table missing "${cmd}"`).toBe(true);
    }
  });

  it('truthfully documents the temporary resident-service restriction', () => {
    const byCommand = new Map(HELP_ENTRIES.map((entry) => [entry.cmd, entry.desc]));

    expect(byCommand.get('daemon install')).toContain('Temporarily unavailable');
    expect(byCommand.get('daemon service-status')).toContain('remains available');
    expect(byCommand.get('daemon uninstall')).toContain('remains available');
    expect(byCommand.get('worker setup')).toContain('fail-closed');
    expect(byCommand.get('setup')).toContain('refuses before config or wizard effects');
    expect(byCommand.get('setup')).toContain('compiled runtime roots are empty');
    expect(byCommand.get('daemon start --once')).toContain('compiled daemon trust roots are empty');
    expect(byCommand.get('daemon start --once --drain diagnostic-reslices --limit 3')).toContain('Dormant');
    expect(byCommand.get('goal "<objective>"')).toContain('Live owner-invoked');
    expect(byCommand.get('goal "<objective>"')).toContain('proposal-only advance');
    expect(byCommand.get('goal "<objective>"')).not.toContain('Dormant');
    expect(byCommand.get('loop')).toContain('compiled conductor trust roots are empty');
    expect(byCommand.get('update [--check] [--json]')).toContain('registration proven absent');
  });
});

describe('cmdHelp routing', () => {
  it('no args → grouped topic summary (not the full wall)', async () => {
    expect(await cmdHelp([])).toBe(0);
    const text = output();
    expect(text).toContain('autonomy');
    expect(text).toContain('ashlr help <topic>');
    // The summary must NOT include every command (that is --all's job).
    expect(text).not.toContain('onboard --rollback');
  });

  it('help <topic> → full table for that topic with examples', async () => {
    expect(await cmdHelp(['run'])).toBe(0);
    const text = output();
    expect(text).toContain('run "<goal>"');
    expect(text).toContain('--estimate');
    expect(text).not.toContain('enroll add');
  });

  it('help autonomy advertises resource-aware direction', async () => {
    expect(await cmdHelp(['autonomy'])).toBe(0);
    const text = output();
    expect(text).toContain('fleet direction [--json]');
    expect(text).toContain('resource-aware mode recommendation');
    expect(text).toContain('fleet evidence doctor <source>');
    expect(text).toContain('Bounded read-only diagnosis');
    expect(text).toContain('daemon install');
    expect(text).toContain('install/reinstall/repair/restart authority is withheld');
  });

  it('help --all → every command', async () => {
    expect(await cmdHelp(['--all'])).toBe(0);
    const text = output();
    for (const e of HELP_ENTRIES.slice(0, 30)) {
      expect(text).toContain(e.cmd);
    }
  });

  it('help --search finds commands by keyword', async () => {
    expect(await cmdHelp(['--search', 'kill'])).toBe(0);
    expect(output()).toContain('enroll kill on|off');
  });

  it('help --search with no hits says so', async () => {
    expect(await cmdHelp(['--search', 'zzzznotathing'])).toBe(0);
    expect(output()).toContain('no commands match');
  });

  it('unknown topic lists the valid topics (exit 0 — help never fails)', async () => {
    expect(await cmdHelp(['nonsense'])).toBe(0);
    expect(output()).toContain('unknown topic');
    expect(output()).toContain('autonomy');
  });
});

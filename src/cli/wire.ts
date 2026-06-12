/**
 * `ashlr wire` — wire the ashlr MCP gateway into editor config(s).
 *
 * Usage:
 *   ashlr wire [claude|codex|cursor|all]  [--config <path>]  [--json]
 *
 * Defaults to detected editors when no target is specified.
 * Backup-first, deep-merge mcpServers, idempotent, LOCAL only.
 * `--config <path>` overrides the default config path for the first/only target
 * (temp-config-safe for tests; with `all` it applies to each detected editor).
 *
 * Exit codes:
 *   0  all targets wired (or already up-to-date)
 *   1  one or more targets failed
 *   2  bad usage
 */

import { pad, makeColors, isTty } from './ui.js';

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy import — integrations built by another agent; degrade gracefully
// ---------------------------------------------------------------------------

async function importEditors() {
  return import('../core/integrations/editors.js') as Promise<
    typeof import('../core/integrations/editors.js')
  >;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const VALID_TARGETS = ['claude', 'codex', 'cursor', 'all'] as const;
type WireTarget = typeof VALID_TARGETS[number];

interface ParsedWireArgs {
  targets: Array<'claude' | 'codex' | 'cursor'>;
  configPath?: string;
  json: boolean;
  usageError?: string;
}

function parseWireArgs(args: string[]): ParsedWireArgs {
  let explicitTarget: WireTarget | null = null;
  let configPath: string | undefined;
  let json = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;

    if (arg === '--json') {
      json = true;
    } else if (arg === '--config') {
      const val = args[++i];
      if (!val || val.startsWith('--')) {
        return { targets: [], json, usageError: `--config requires a path; got: ${val ?? '(missing)'}` };
      }
      configPath = val;
    } else if (VALID_TARGETS.includes(arg as WireTarget)) {
      if (explicitTarget !== null) {
        return { targets: [], json, usageError: `multiple targets specified; pass one of: claude codex cursor all` };
      }
      explicitTarget = arg as WireTarget;
    } else if (arg.startsWith('--')) {
      return { targets: [], json, usageError: `unknown flag: ${arg}` };
    } else {
      return { targets: [], json, usageError: `unexpected argument: ${arg}` };
    }
    i++;
  }

  // Resolve targets; 'all' and default (no target) → detect
  if (explicitTarget === 'all' || explicitTarget === null) {
    // Will be filled in at runtime via detectEditors()
    return { targets: [] as Array<'claude' | 'codex' | 'cursor'>, configPath, json, usageError: undefined };
  }

  return { targets: [explicitTarget], configPath, json };
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printWireHelp(): void {
  console.log('');
  console.log(bold('  ashlr wire') + dim(' — wire the ashlr MCP gateway into editor config(s)'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr wire ${cyan('[claude|codex|cursor|all]')} [options]`);
  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');

  const opts: [string, string][] = [
    ['[target]',          'Editor to wire: claude, codex, cursor, or all. Defaults to detected editors.'],
    ['--config <path>',   'Override the config path (temp-config-safe for tests).'],
    ['--json',            'Emit results as JSON on stdout.'],
    ['--claude-md',       'Print a CLAUDE.md snippet teaching agents the CLI-first ashlr usage (read-only).'],
  ];
  const w = Math.max(...opts.map(([o]) => o.length));
  for (const [opt, desc] of opts) {
    console.log(`    ${cyan(pad(opt, w))}  ${desc}`);
  }
  console.log('');
  console.log('  ' + bold('What it does:'));
  console.log('');
  console.log(`    ${dim('• Backs up the editor config before any write.')}`);
  console.log(`    ${dim('• Deep-merges the "ashlr" MCP gateway into mcpServers — never clobbers existing entries.')}`);
  console.log(`    ${dim('• Idempotent: re-running with the same config is a no-op.')}`);
  console.log(`    ${dim('• LOCAL only: only writes the editor\'s own config file.')}`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${cyan('ashlr wire')}                     ${dim('# wire all detected editors')}`);
  console.log(`    ${cyan('ashlr wire claude')}              ${dim('# wire only Claude Code')}`);
  console.log(`    ${cyan('ashlr wire all --json')}          ${dim('# wire all, machine-readable output')}`);
  console.log(`    ${cyan('ashlr wire claude --config /tmp/test.json')}  ${dim('# test against a temp file')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// cmdWire — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr wire <claude|codex|cursor|all>` — wire MCP gateway into editor config(s).
 * Defaults to detected editors; backup-first, idempotent, local.
 * Returns a process exit code.
 */
export async function cmdWire(args: string[]): Promise<number> {
  const sub = args[0];

  if (sub === '--help' || sub === '-h' || sub === 'help') {
    printWireHelp();
    return 0;
  }

  // M31: `ashlr wire --claude-md` — print a ready-to-paste CLAUDE.md snippet
  // teaching agents the CLI-first ashlr usage. Read-only; writes nothing.
  if (args.includes('--claude-md')) {
    const { claudeMdSnippet } = await import('./help.js');
    process.stdout.write(claudeMdSnippet());
    return 0;
  }

  const parsed = parseWireArgs(args);

  if (parsed.usageError) {
    process.stderr.write(red('error: ') + parsed.usageError + '\n');
    return 2;
  }

  // Load the editors integration module
  let mod: Awaited<ReturnType<typeof importEditors>>;
  try {
    mod = await importEditors();
  } catch {
    process.stderr.write(red('error: ') + 'Editor integration module not yet available.\n');
    return 1;
  }

  // Resolve targets: empty means use detectEditors()
  const resolvedTargets: Array<'claude' | 'codex' | 'cursor'> =
    parsed.targets.length > 0
      ? parsed.targets
      : (mod.detectEditors() as Array<'claude' | 'codex' | 'cursor'>);

  if (resolvedTargets.length === 0) {
    if (parsed.json) {
      process.stdout.write(JSON.stringify({ wired: [], skipped: [], errors: [], detected: [] }, null, 2) + '\n');
    } else {
      console.log('');
      console.log(yellow('  No editors detected.'));
      console.log(dim('  Install Claude Code, Cursor, or Codex and try again.'));
      console.log(dim('  Or pass an explicit target: ashlr wire claude'));
      console.log('');
    }
    return 0;
  }

  if (!parsed.json) {
    console.log('');
    console.log(bold('  ashlr wire') + gray(`  — wiring ${resolvedTargets.join(', ')}`));
    console.log('');
  }

  const results: Array<{ target: string; ok: boolean; detail: string }> = [];

  for (const target of resolvedTargets) {
    const opts = parsed.configPath ? { configPath: parsed.configPath } : {};

    let result: { ok: boolean; detail: string };
    try {
      result = await mod.wireEditor(target, opts);
    } catch (err) {
      result = {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    results.push({ target, ...result });

    if (!parsed.json) {
      const icon = result.ok ? green('✓') : red('✗');
      const targetLabel = bold(target);
      const detailStr = result.ok ? dim(result.detail) : red(result.detail);
      console.log(`  ${icon}  ${targetLabel}  ${detailStr}`);
    }
  }

  if (parsed.json) {
    const wired   = results.filter(r => r.ok).map(r => r.target);
    const errors  = results.filter(r => !r.ok).map(r => ({ target: r.target, detail: r.detail }));
    process.stdout.write(JSON.stringify({ wired, errors, detected: resolvedTargets }, null, 2) + '\n');
  } else {
    console.log('');
    const allOk = results.every(r => r.ok);
    const anyFailed = results.some(r => !r.ok);
    if (allOk) {
      console.log(dim('  All editors wired. Restart your editor to pick up the new MCP entry.'));
    } else if (anyFailed) {
      const failCount = results.filter(r => !r.ok).length;
      console.log(yellow(`  ${failCount} target(s) failed — check the details above.`));
    }
    console.log('');
  }

  const exitCode = results.some(r => !r.ok) ? 1 : 0;
  return exitCode;
}

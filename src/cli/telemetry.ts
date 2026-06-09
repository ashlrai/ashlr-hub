/**
 * `ashlr telemetry` — M19 telemetry status + test command.
 *
 * Sub-commands:
 *   status   Print endpoint configured (bool), PAT available (bool, NEVER the
 *            value), active sink mode, local telemetry dir + JSONL file count.
 *   test     Emit a single synthetic metadata-only span via getSink and report
 *            the TelemetryEmitResult.
 *
 * Flags:
 *   --json   Emit machine-readable JSON on stdout.
 *
 * Privacy + security guardrails (always enforced):
 *   - PAT is NEVER printed, logged, returned, or placed in any output field.
 *   - Endpoint is shown as a boolean; value only printed in status (non-secret
 *     URL, shown as configured endpoint for user awareness, never the PAT).
 *   - Synthetic test span contains METADATA ONLY (zeroed tokens, no content).
 *
 * Lazy imports — degrades gracefully if M19 modules not yet built.
 */

import type { AshlrConfig, TelemetryEmitResult, GovernanceStatus, GenAiSpan } from '../core/types.js';
import { C, makeColors, isTty, pad } from './ui.js';

const { bold, dim, green, yellow, red, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy imports — M19 modules
// ---------------------------------------------------------------------------

type TelemetrySink  = { emit(spans: GenAiSpan[]): Promise<TelemetryEmitResult> };
type GetSinkFn      = (cfg: AshlrConfig) => TelemetrySink;
type PatAvailableFn = (cfg: AshlrConfig) => boolean;
type LocalDirFn     = () => string;
type EvalGovFn      = (cfg: AshlrConfig) => GovernanceStatus;

let _getSink:      GetSinkFn      | null | undefined = undefined;
let _patAvailable: PatAvailableFn | null | undefined = undefined;
let _localDir:     LocalDirFn     | null | undefined = undefined;
let _evalGov:      EvalGovFn      | null | undefined = undefined;

async function loadSink(): Promise<{ getSink: GetSinkFn; patAvailable: PatAvailableFn; localTelemetryDir: LocalDirFn } | null> {
  if (_getSink === undefined) {
    try {
      const mod = await import('../core/observability/telemetry-sink.js') as {
        getSink: GetSinkFn;
        patAvailable: PatAvailableFn;
        localTelemetryDir: LocalDirFn;
      };
      _getSink      = mod.getSink;
      _patAvailable = mod.patAvailable;
      _localDir     = mod.localTelemetryDir;
    } catch {
      _getSink      = null;
      _patAvailable = null;
      _localDir     = null;
    }
  }
  if (_getSink && _patAvailable && _localDir) {
    return { getSink: _getSink, patAvailable: _patAvailable, localTelemetryDir: _localDir };
  }
  return null;
}

async function loadEvalGovernance(): Promise<EvalGovFn | null> {
  if (_evalGov === undefined) {
    try {
      const mod = await import('../core/observability/governance.js') as { evalGovernance: EvalGovFn };
      _evalGov = mod.evalGovernance;
    } catch {
      _evalGov = null;
    }
  }
  return _evalGov ?? null;
}

async function loadConfig(): Promise<AshlrConfig> {
  const mod = await import('../core/config.js') as { loadConfig: () => AshlrConfig };
  return mod.loadConfig();
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedTelemetryArgs {
  sub: 'status' | 'test' | 'help';
  json: boolean;
  usageError?: string;
}

function parseTelemetryArgs(args: string[]): ParsedTelemetryArgs {
  const result: ParsedTelemetryArgs = { sub: 'status', json: false };

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === 'status') {
      result.sub = 'status';
      i++;
    } else if (arg === 'test') {
      result.sub = 'test';
      i++;
    } else if (arg === 'help' || arg === '--help' || arg === '-h') {
      result.sub = 'help';
      i++;
    } else if (arg === '--json') {
      result.json = true;
      i++;
    } else {
      result.usageError = `unknown argument: ${arg}`;
      return result;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Count local telemetry JSONL files
// ---------------------------------------------------------------------------

async function countLocalFiles(dir: string): Promise<number> {
  try {
    const fs = await import('node:fs');
    if (!fs.existsSync(dir)) return 0;
    const entries = fs.readdirSync(dir);
    return entries.filter(e => e.endsWith('.jsonl')).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Synthetic test span — METADATA ONLY, no content
// ---------------------------------------------------------------------------

function syntheticSpan(): GenAiSpan {
  const now = new Date().toISOString();
  return {
    name:        'ashlr.telemetry.test',
    runId:       'test-synthetic-0000',
    model:       'test-model',
    provider:    'test',
    tier:        'local',
    tokensIn:    0,
    tokensOut:   0,
    estCostUsd:  0,
    status:      'done',
    startTs:     now,
    endTs:       now,
  };
}

// ---------------------------------------------------------------------------
// Level color helper
// ---------------------------------------------------------------------------

function govLevelColor(level: 'ok' | 'warn' | 'over'): (s: string) => string {
  if (level === 'over') return red;
  if (level === 'warn') return yellow;
  return green;
}

// ---------------------------------------------------------------------------
// cmdTelemetry — main entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr telemetry [status|test] [--json]`
 *
 * Returns a process exit code: 0 = ok, 1 = error.
 */
export async function cmdTelemetry(args: string[]): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printTelemetryHelp();
    return 0;
  }

  const parsed = parseTelemetryArgs(args);

  if (parsed.usageError) {
    process.stderr.write(`${C.red}error:${C.reset} ${parsed.usageError}\n`);
    return 2;
  }

  if (parsed.sub === 'help') {
    printTelemetryHelp();
    return 0;
  }

  // Load config
  let cfg: AshlrConfig;
  try {
    cfg = await loadConfig();
  } catch (err) {
    process.stderr.write(
      `${C.red}error:${C.reset} failed to load config: ` +
      (err instanceof Error ? err.message : String(err)) + '\n',
    );
    return 1;
  }

  // Load M19 sink module (lazy — degrades if not yet built)
  const sinkMod = await loadSink();
  const evalGov = await loadEvalGovernance();

  // Derive status fields
  const endpointConfigured = Boolean(cfg.telemetry?.pulse);
  const patAvailable: boolean = sinkMod ? sinkMod.patAvailable(cfg) : false;
  const sinkMode: 'otlp' | 'local' = (endpointConfigured && patAvailable) ? 'otlp' : 'local';

  // Local telemetry dir + file count
  const localDir = sinkMod ? sinkMod.localTelemetryDir() : `${process.env['HOME'] ?? '~'}/.ashlr/telemetry`;
  const localFileCount = await countLocalFiles(localDir);

  // Governance
  let governance: GovernanceStatus | null = null;
  if (evalGov) {
    try {
      governance = evalGov(cfg);
    } catch {
      governance = null;
    }
  }

  // ── status sub-command ────────────────────────────────────────────────────
  if (parsed.sub === 'status') {
    if (parsed.json) {
      const out = {
        endpointConfigured,
        // Show endpoint URL (non-secret) but NEVER the PAT
        endpoint: endpointConfigured ? (cfg.telemetry.pulse ?? null) : null,
        patAvailable,
        sinkMode,
        localTelemetryDir: localDir,
        localFileCount,
        governance: governance ?? null,
        m19ModulesAvailable: sinkMod !== null,
      };
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      return 0;
    }

    console.log('');
    console.log(bold('  ashlr telemetry') + dim(' — M19 telemetry status'));
    console.log('');

    const W = 26;
    const row = (label: string, value: string) =>
      console.log(`  ${pad(label, W)}${value}`);

    row('Endpoint configured:', endpointConfigured ? green('yes') : dim('no'));
    if (endpointConfigured && cfg.telemetry.pulse) {
      // Endpoint URL is not a secret — show it for usability
      row('Endpoint URL:', cyan(cfg.telemetry.pulse));
    }
    row('PAT available:', patAvailable ? green('yes') : dim('no'));
    // PAT value is NEVER printed
    row('Active sink:', sinkMode === 'otlp' ? cyan('otlp') : dim('local'));
    row('Local telemetry dir:', gray(localDir));
    row('Local JSONL files:', String(localFileCount));

    if (!sinkMod) {
      console.log('');
      console.log(`  ${yellow('Note:')} ${dim('M19 telemetry-sink module not yet built (telemetry-sink.ts).')}`);
      console.log(`  ${dim('Default: LocalFileSink (all spans written to local JSONL).')}`);
    }

    // Governance summary
    if (governance) {
      console.log('');
      const colorFn = govLevelColor(governance.level);
      const ICON = governance.level === 'over' ? '●' : governance.level === 'warn' ? '◐' : '○';
      console.log(`  ${bold('Spend governance')}  ${colorFn(`${ICON} ${governance.level.toUpperCase()}`)}`);
      console.log(`  ${pad('', W)}${dim(governance.message)}`);
      if (governance.capUsd !== null) {
        const pct = governance.capUsd > 0
          ? Math.round((governance.spentUsd / governance.capUsd) * 100)
          : 0;
        row('Spent / cap:', `$${governance.spentUsd.toFixed(2)} / $${governance.capUsd.toFixed(2)}  (${pct}%)`);
        row('Window:', governance.window);
      }
    } else if (evalGov === null) {
      console.log('');
      console.log(`  ${dim('Spend governance: M19 governance module not yet built (governance.ts).')}`);
    } else {
      console.log('');
      console.log(`  ${bold('Spend governance')}  ${dim('○ ok — no cap configured')}`);
    }

    console.log('');
    return 0;
  }

  // ── test sub-command ──────────────────────────────────────────────────────
  if (parsed.sub === 'test') {
    if (!sinkMod) {
      const msg = 'M19 telemetry-sink module not yet built; cannot emit test span.';
      if (parsed.json) {
        process.stdout.write(JSON.stringify({ ok: false, detail: msg }) + '\n');
      } else {
        console.log('');
        console.log(`  ${yellow('warn:')} ${msg}`);
        console.log(`  ${dim('Fallback: test span would be written to local JSONL when built.')}`);
        console.log('');
      }
      return 1;
    }

    let result: TelemetryEmitResult;
    try {
      const sink = sinkMod.getSink(cfg);
      result = await sink.emit([syntheticSpan()]);
    } catch (err) {
      result = {
        sink: 'local',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (parsed.json) {
      // detail must never contain PAT — the contract guarantees this, but
      // we sanitize defensively (strip anything that looks like a Bearer token)
      const safeDetail = result.detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
      process.stdout.write(JSON.stringify({ ...result, detail: safeDetail }, null, 2) + '\n');
      return result.ok ? 0 : 1;
    }

    console.log('');
    console.log(bold('  ashlr telemetry test'));
    console.log('');
    const statusIcon = result.ok ? green('✓') : red('✗');
    const sinkLabel  = result.sink === 'otlp' ? cyan('otlp') : dim('local');
    console.log(`  ${statusIcon} sink=${sinkLabel}  ok=${result.ok ? green('true') : red('false')}`);
    if (result.detail) {
      // Defensively strip any accidental Bearer value before printing
      const safeDetail = result.detail.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
      console.log(`  ${dim(safeDetail)}`);
    }
    console.log('');
    return result.ok ? 0 : 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printTelemetryHelp(): void {
  const { bold, dim, cyan } = makeColors(isTty());

  console.log('');
  console.log(bold('  ashlr telemetry') + dim(' — M19 telemetry status and test'));
  console.log('');
  console.log('  ' + bold('Usage:'));
  console.log('');
  console.log(`    ashlr telemetry [sub-command] [--json]`);
  console.log('');
  console.log('  ' + bold('Sub-commands:'));
  console.log('');

  const subs: [string, string][] = [
    ['status (default)', 'Show endpoint + PAT configured (booleans only — values never printed),'],
    ['',                 'active sink mode (local/otlp), local telemetry dir + file count,'],
    ['',                 'and spend governance summary.'],
    ['test',             'Emit a synthetic metadata-only test span via the configured sink'],
    ['',                 'and report the TelemetryEmitResult (ok/detail).'],
  ];

  for (const [sub, desc] of subs) {
    if (sub) {
      console.log(`    ${cyan(pad(sub, 20))}  ${desc}`);
    } else {
      console.log(`    ${pad('', 20)}    ${dim(desc)}`);
    }
  }

  console.log('');
  console.log('  ' + bold('Options:'));
  console.log('');
  console.log(`    ${cyan('--json')}  Emit machine-readable JSON on stdout.`);
  console.log('');
  console.log('  ' + bold('Security:'));
  console.log('');
  console.log(`    ${dim('• The PAT (ASHLR_PULSE_TOKEN or phantom) is NEVER printed or returned.')}`);
  console.log(`    ${dim('• Only boolean availability is shown.')}`);
  console.log(`    ${dim('• Span attributes are metadata only (model, tokens, cost, ids).')}`);
  console.log(`    ${dim('• No prompts, completions, tool args, or file contents ever appear.')}`);
  console.log('');
  console.log('  ' + bold('Sink selection:'));
  console.log('');
  console.log(`    ${dim('• Default: LocalFileSink — spans appended to ~/.ashlr/telemetry/*.jsonl')}`);
  console.log(`    ${dim('• OtlpHttpSink: active when cfg.telemetry.pulse AND PAT are both configured.')}`);
  console.log(`    ${dim('• Configure: ashlr config set telemetry.pulse https://your-endpoint/v1/traces')}`);
  console.log(`    ${dim('• PAT via:   phantom add ASHLR_PULSE_TOKEN  OR  export ASHLR_PULSE_TOKEN=...')}`);
  console.log('');
  console.log('  ' + bold('Spend governance:'));
  console.log('');
  console.log(`    ${dim('• Configure: ashlr config set telemetry.budgetUsd 10.00')}`);
  console.log(`    ${dim('             ashlr config set telemetry.budgetWindow 7d')}`);
  console.log(`    ${dim('             ashlr config set telemetry.govAction warn   # or block')}`);
  console.log(`    ${dim('• warn (default): advisory warning when over cap; never blocks.')}`);
  console.log(`    ${dim('• block: additionally require --over-budget to proceed.')}`);
  console.log('');
  console.log('  ' + bold('Examples:'));
  console.log('');
  console.log(`    ${cyan('ashlr telemetry')}              ${dim('# status (default)')}`);
  console.log(`    ${cyan('ashlr telemetry status')}       ${dim('# explicit status')}`);
  console.log(`    ${cyan('ashlr telemetry status --json')} ${dim('# machine-readable')}`);
  console.log(`    ${cyan('ashlr telemetry test')}         ${dim('# emit one synthetic test span')}`);
  console.log(`    ${cyan('ashlr telemetry test --json')}  ${dim('# test + JSON result')}`);
  console.log('');
}

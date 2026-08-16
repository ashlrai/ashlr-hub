/**
 * `ashlr activation` — operator authority for the autonomous fleet (M470).
 *
 * The daemon, goal/simple conductors, and resident-service install are all
 * held shut by hard-coded denials until an operator EXPLICITLY grants
 * authority here. Doing nothing keeps today's exact behavior: everything
 * denied. This command group is how an operator opts in, on their own
 * terms, with a real signed/expiring/revocable authorization trail.
 *
 * Subcommands:
 *   activation init [--label <text>] [--force] [--yes] [--json]
 *       Generate an Ed25519 keypair on this machine (private key never
 *       leaves it) and register the public half as a trust root. Grants
 *       NOTHING by itself — run `activation grant` next.
 *   activation status [--json]
 *       Trust roots, pending one-shot permit, standing grants, and what is
 *       currently authorized, right now, and why.
 *   activation grant <scope...> [--ttl <duration>] [--yes] [--json]
 *       Mint a scoped, signed, expiring authorization. `once`/`resident`
 *       mint a single-use permit for `ashlr daemon start`; any of
 *       `conductor`/`automerge`/`repair`/`deploy`/`install`/`proposalOnly`
 *       mint a standing grant checked on every use until it expires or is
 *       revoked.
 *   activation revoke --root <keyId> | --grant <grantId> [--yes] [--json]
 *       Immediately invalidate a trust root or a standing grant.
 *
 * Every subcommand supports --help. Mutating subcommands (init/grant/revoke)
 * refuse to run unattended in a non-TTY session without --yes — the same
 * confirm-gate convention as `ashlr inbox approve`.
 */

import { makeColors } from './ui.js';
import type { AshlrConfig } from '../core/types.js';
import {
  DAEMON_ACTIVATION_SCOPE_KEYS,
  DEFAULT_STANDING_GRANT_VALIDITY_MS,
  EMPTY_DAEMON_ACTIVATION_SCOPE,
  MAX_STANDING_GRANT_VALIDITY_MS,
  daemonActivationDiagnosePendingPermitBindings,
  daemonActivationDirPath,
  daemonActivationGrantStatus,
  daemonActivationInit,
  daemonActivationMintOneShotPermit,
  daemonActivationMintStandingGrant,
  daemonActivationPermitPath,
  daemonActivationRevokeGrant,
  daemonActivationRevokeTrustRoot,
  daemonActivationScopeGranted,
  daemonActivationTrustRootStatus,
  inspectDaemonActivationPermit,
  type DaemonActivationGrantScope,
  type DaemonActivationScopeKey,
} from '../core/daemon/activation-permit.js';

type ActivationSubcommand = 'init' | 'status' | 'grant' | 'revoke';

const ACTIVATION_SUBCOMMANDS = new Set<ActivationSubcommand>(['init', 'status', 'grant', 'revoke']);

const ONE_SHOT_SCOPE_KEYS = new Set<DaemonActivationScopeKey>(['once', 'resident']);

const ACTIVATION_USAGE: Record<ActivationSubcommand, string> = {
  init:
    'Usage: ashlr activation init [--label <text>] [--force] [--yes] [--json]',
  status: 'Usage: ashlr activation status [--json]',
  grant:
    `Usage: ashlr activation grant <scope...> [--ttl <duration>] [--yes] [--json]\n` +
    `   scopes: ${DAEMON_ACTIVATION_SCOPE_KEYS.join(', ')}\n` +
    `   duration: <n>s | <n>m | <n>h | <n>d (default: 24h; hard cap: 30d; standing grants only)`,
  revoke: 'Usage: ashlr activation revoke (--root <keyId> | --grant <grantId>) [--yes] [--json]',
};

const ACTIVATION_TOP_LEVEL_USAGE = `Usage: ashlr activation [subcommand] [flags]

Everything here is denied by default. Run \`activation init\` then
\`activation grant <scope...>\` to explicitly opt this machine's fleet into
real authority — nothing else changes anything on its own.

Subcommands:
  init      Generate an operator keypair and register the trust root
  status    Show what is granted, by whom, when, and current eligibility
  grant     Mint a scoped, signed, expiring permit or standing grant
  revoke    Immediately invalidate a trust root or a standing grant

Run \`ashlr activation <subcommand> --help\` for subcommand usage.`;

function isHelpFlag(arg: string): boolean {
  return arg === '--help' || arg === '-h';
}

function isActivationSubcommand(value: string): value is ActivationSubcommand {
  return ACTIVATION_SUBCOMMANDS.has(value as ActivationSubcommand);
}

function printActivationUsage(subcommand?: ActivationSubcommand): void {
  console.log(subcommand ? ACTIVATION_USAGE[subcommand] : ACTIVATION_TOP_LEVEL_USAGE);
}

function printActivationUsageError(message: string, subcommand?: ActivationSubcommand): number {
  const col = makeColors(process.stdout.isTTY === true);
  console.error(col.red('error: ') + message);
  console.error(col.dim(subcommand ? ACTIVATION_USAGE[subcommand] : ACTIVATION_TOP_LEVEL_USAGE));
  return 2;
}

function parseDurationMs(text: string): number | null {
  const match = /^(\d+)(s|m|h|d)?$/u.exec(text.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2] ?? 'h';
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

async function importConfig(): Promise<(() => AshlrConfig) | null> {
  try {
    const mod = (await import('../core/config.js')) as { loadConfigReadOnlyStrict: () => AshlrConfig };
    return mod.loadConfigReadOnlyStrict;
  } catch {
    return null;
  }
}

/** Non-TTY without --yes refuses — no silently-automated grants, matching `inbox approve`. */
function refuseUnattended(yes: boolean, jsonMode: boolean, action: string): boolean {
  const tty = process.stdout.isTTY === true;
  if (tty || yes) return false;
  const col = makeColors(false);
  const msg = `non-TTY: activation ${action} requires --yes to prevent silent, unattended authorization`;
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: msg }));
  } else {
    console.error(col.red('error: ') + msg);
    console.error(col.dim(`  Use \`ashlr activation ${action} ... --yes\` in non-interactive environments.`));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Subcommand: init
// ---------------------------------------------------------------------------

async function cmdActivationInit(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const force = args.includes('--force');
  const yes = args.includes('--yes');
  const labelIndex = args.indexOf('--label');
  const label = labelIndex !== -1 ? args[labelIndex + 1] : undefined;
  const known = new Set(['--json', '--force', '--yes', '--label', label].filter((v): v is string => v !== undefined));
  const unknown = args.find((a, i) => !known.has(a) && !(args[i - 1] === '--label'));
  if (unknown) return printActivationUsageError(`Unknown flag: ${unknown}`, 'init');
  if (labelIndex !== -1 && label === undefined) {
    return printActivationUsageError('--label requires a value', 'init');
  }

  const col = makeColors(process.stdout.isTTY === true);
  if (!jsonMode) {
    console.log('');
    console.log(col.bold('  ashlr activation init'));
    console.log(col.dim(
      '  Generates an Ed25519 keypair on THIS machine and registers the public\n'
      + '  half as a trust root. The private key never leaves this machine, is\n'
      + '  written 0600 under an 0700 directory, and is the ONLY thing that can\n'
      + '  sign a future `activation grant`. This step grants no capability by\n'
      + '  itself — the fleet stays exactly as denied as it is today until you\n'
      + '  run `ashlr activation grant <scope...>`.',
    ));
    console.log('');
  }
  if (refuseUnattended(yes, jsonMode, 'init')) return 2;

  const result = daemonActivationInit({ label, force });
  if (!result.ok) {
    const msg = `activation init refused: ${result.reason}`;
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: result.reason }));
    else console.error(col.red('error: ') + msg);
    return 1;
  }
  if (jsonMode) {
    console.log(JSON.stringify({
      ok: true,
      keyId: result.keyId,
      publicKeyPem: result.publicKeyPem,
      rotated: result.rotated,
      trustRootsPath: daemonActivationDirPath(),
    }));
  } else {
    console.log(col.green('ok: ') + `trust root registered (keyId=${result.keyId}${result.rotated ? ', rotated' : ''}).`);
    console.log(col.dim(`  store: ${daemonActivationDirPath()}`));
    console.log(col.dim('  Next: `ashlr activation grant <scope...>` to actually authorize something.'));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: status
// ---------------------------------------------------------------------------

async function cmdActivationStatus(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const unknown = args.find((a) => a !== '--json');
  if (unknown) return printActivationUsageError(`Unknown flag: ${unknown}`, 'status');
  const col = makeColors(process.stdout.isTTY === true);

  const trustRoots = daemonActivationTrustRootStatus();
  const grants = daemonActivationGrantStatus();

  const loadConfig = await importConfig();
  let cfg: AshlrConfig | null = null;
  try {
    cfg = loadConfig ? loadConfig() : null;
  } catch {
    cfg = null;
  }
  const onceReadiness = cfg ? inspectDaemonActivationPermit(cfg, { once: true, dryRun: false }) : null;
  const residentReadiness = cfg ? inspectDaemonActivationPermit(cfg, { once: false, dryRun: false }) : null;
  const bindingMismatch = onceReadiness?.reason === 'permit-runtime-binding-mismatch'
    || residentReadiness?.reason === 'permit-runtime-binding-mismatch';
  const bindingDiagnosis = cfg && bindingMismatch
    ? daemonActivationDiagnosePendingPermitBindings(cfg)
    : null;

  const nowMs = Date.now();
  const grantSummaries = grants.ok
    ? grants.records.map((record) => ({
        grantId: record.grantId,
        keyId: record.keyId,
        scope: DAEMON_ACTIVATION_SCOPE_KEYS.filter((key) => record.scope[key]),
        issuedAt: record.issuedAt,
        expiresAt: record.expiresAt,
        revoked: record.revokedAt !== null,
        expired: Date.parse(record.expiresAt) <= nowMs,
      }))
    : [];

  if (jsonMode) {
    console.log(JSON.stringify({
      ok: true,
      store: daemonActivationDirPath(),
      trustRoots: trustRoots.ok
        ? trustRoots.records.map((r) => ({
            keyId: r.keyId, label: r.label, createdAt: r.createdAt, revoked: r.revokedAt !== null,
          }))
        : null,
      trustRootStoreError: trustRoots.ok ? null : trustRoots.reason,
      grants: grants.ok ? grantSummaries : null,
      grantStoreError: grants.ok ? null : grants.reason,
      pendingOneShotPermitPath: daemonActivationPermitPath(),
      onceEligibility: onceReadiness,
      residentEligibility: residentReadiness,
      bindingMismatchDiagnosis: bindingDiagnosis,
    }, null, 2));
    return 0;
  }

  console.log('');
  console.log(col.bold('  ashlr activation status'));
  console.log(col.dim(`  store: ${daemonActivationDirPath()}`));
  console.log('');
  console.log(col.bold('  Trust roots'));
  if (!trustRoots.ok) {
    console.log(col.yellow(`    unreadable/unsafe (${trustRoots.reason}) — treated as NO authority.`));
  } else if (trustRoots.records.length === 0) {
    console.log(col.dim('    none — run `ashlr activation init`.'));
  } else {
    for (const root of trustRoots.records) {
      const state = root.revokedAt !== null ? col.red(`revoked ${root.revokedAt}`) : col.green('active');
      console.log(`    ${root.keyId}  ${state}  ${root.label ? `"${root.label}"` : ''}  (created ${root.createdAt})`);
    }
  }
  console.log('');
  console.log(col.bold('  Standing grants'));
  if (!grants.ok) {
    console.log(col.yellow(`    unreadable/unsafe (${grants.reason}) — treated as NO authority.`));
  } else if (grantSummaries.length === 0) {
    console.log(col.dim('    none.'));
  } else {
    for (const g of grantSummaries) {
      const state = g.revoked ? col.red('revoked') : g.expired ? col.yellow('expired') : col.green('active');
      console.log(`    ${g.grantId}  ${state}  scope=[${g.scope.join(', ')}]  keyId=${g.keyId}  expires ${g.expiresAt}`);
    }
  }
  console.log('');
  console.log(col.bold('  Currently granted, right now'));
  for (const scopeKey of DAEMON_ACTIVATION_SCOPE_KEYS) {
    if (ONE_SHOT_SCOPE_KEYS.has(scopeKey)) continue;
    const check = daemonActivationScopeGranted(scopeKey);
    console.log(`    ${scopeKey.padEnd(12)} ${check.granted ? col.green('granted') : col.dim('denied')}  (${check.reason})`);
  }
  console.log('');
  console.log(col.bold('  One-shot permit (ashlr daemon start)'));
  console.log(`    pending file: ${daemonActivationPermitPath()}`);
  if (onceReadiness) {
    console.log(`    --once:       ${onceReadiness.state === 'ready' ? col.green('ready') : col.dim(onceReadiness.state)}  (${onceReadiness.reason})`);
  }
  if (residentReadiness) {
    console.log(`    resident:     ${residentReadiness.state === 'ready' ? col.green('ready') : col.dim(residentReadiness.state)}  (${residentReadiness.reason})`);
  }
  if (bindingDiagnosis) {
    console.log('');
    if (bindingDiagnosis.ok || !bindingDiagnosis.mismatches) {
      console.log(col.dim(`    binding diagnosis: ${bindingDiagnosis.reason}`));
    } else {
      console.log(col.yellow('    binding mismatch — field(s) that differ between the signed permit and right now:'));
      for (const [field, { signed, current }] of Object.entries(bindingDiagnosis.mismatches)) {
        console.log(`      ${col.bold(field)}:`);
        console.log(`        signed:  ${formatBindingValue(signed)}`);
        console.log(`        current: ${formatBindingValue(current)}`);
      }
    }
  }
  console.log('');
  return 0;
}

function formatBindingValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if ('sha256' in (value as Record<string, unknown>)) {
    const binding = value as { path: string; sha256: string };
    return `${binding.path}  sha256:${binding.sha256}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Subcommand: grant
// ---------------------------------------------------------------------------

async function cmdActivationGrant(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const yes = args.includes('--yes');
  const ttlIndex = args.indexOf('--ttl');
  const ttlText = ttlIndex !== -1 ? args[ttlIndex + 1] : undefined;
  const flagsConsumed = new Set(['--json', '--yes', '--ttl', ttlText].filter((v): v is string => v !== undefined));
  const scopeArgs = args.filter((a, i) => !flagsConsumed.has(a) && args[i - 1] !== '--ttl');
  const unknownFlag = args.find((a) => a.startsWith('--') && !['--json', '--yes', '--ttl'].includes(a));
  if (unknownFlag) return printActivationUsageError(`Unknown flag: ${unknownFlag}`, 'grant');
  if (ttlIndex !== -1 && ttlText === undefined) return printActivationUsageError('--ttl requires a value', 'grant');

  if (scopeArgs.length === 0) {
    return printActivationUsageError('At least one scope is required.', 'grant');
  }
  const invalidScope = scopeArgs.find((s) => !(DAEMON_ACTIVATION_SCOPE_KEYS as readonly string[]).includes(s));
  if (invalidScope) {
    return printActivationUsageError(
      `Unknown scope: ${invalidScope} (expected one of: ${DAEMON_ACTIVATION_SCOPE_KEYS.join(', ')})`,
      'grant',
    );
  }
  const scopeKeys = [...new Set(scopeArgs)] as DaemonActivationScopeKey[];
  const scope: DaemonActivationGrantScope = { ...EMPTY_DAEMON_ACTIVATION_SCOPE };
  for (const key of scopeKeys) scope[key] = true;
  const isOneShot = scopeKeys.some((key) => ONE_SHOT_SCOPE_KEYS.has(key));

  let ttlMs = DEFAULT_STANDING_GRANT_VALIDITY_MS;
  if (ttlText !== undefined) {
    if (isOneShot) {
      return printActivationUsageError(
        '--ttl only applies to standing grants (not once/resident, which use a fixed 2-minute window).',
        'grant',
      );
    }
    const parsed = parseDurationMs(ttlText);
    if (parsed === null || parsed > MAX_STANDING_GRANT_VALIDITY_MS) {
      return printActivationUsageError(
        `Invalid --ttl (expected <n>s|m|h|d, max ${MAX_STANDING_GRANT_VALIDITY_MS / 86_400_000}d): ${ttlText}`,
        'grant',
      );
    }
    ttlMs = parsed;
  }

  const col = makeColors(process.stdout.isTTY === true);
  if (!jsonMode) {
    console.log('');
    console.log(col.bold('  ashlr activation grant') + col.dim(` — scope=[${scopeKeys.join(', ')}]`));
    console.log(col.dim(
      isOneShot
        ? '  Mints a SINGLE-USE, signed permit for `ashlr daemon start`. Consumed and\n'
          + '  deleted the moment the daemon starts; expires in 2 minutes if unused.'
        : `  Mints a standing, signed grant valid for ${Math.round(ttlMs / 3_600_000)}h, checked on every\n`
          + '  use until it expires or you run `ashlr activation revoke`.',
    ));
    console.log('');
  }
  if (refuseUnattended(yes, jsonMode, 'grant')) return 2;

  if (isOneShot) {
    const loadConfig = await importConfig();
    if (!loadConfig) {
      console.error(col.red('error: ') + 'activation grant requires src/core/config.ts.');
      return 1;
    }
    let cfg: AshlrConfig;
    try {
      cfg = loadConfig();
    } catch (e) {
      console.error(col.red('error: ') + 'Failed to load config: ' + (e instanceof Error ? e.message : String(e)));
      return 1;
    }
    const result = daemonActivationMintOneShotPermit({ cfg, scope });
    if (!result.ok) {
      if (jsonMode) console.log(JSON.stringify({ ok: false, error: result.reason }));
      else console.error(col.red('error: ') + `activation grant refused: ${result.reason}`);
      return 1;
    }
    if (jsonMode) {
      console.log(JSON.stringify({ kind: 'one-shot-permit', ...result }));
    } else {
      console.log(col.green('ok: ') + `one-shot permit minted (permitId=${result.permitId}, expires ${result.expiresAt}).`);
      console.log(col.dim(`  ${result.permitPath}`));
      console.log(col.dim('  Run `ashlr daemon start' + (scope.once ? ' --once' : '') + '` now — the permit is single-use.'));
    }
    return 0;
  }

  const result = daemonActivationMintStandingGrant({ scope, ttlMs });
  if (!result.ok) {
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: result.reason }));
    else console.error(col.red('error: ') + `activation grant refused: ${result.reason}`);
    return 1;
  }
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, kind: 'standing-grant', record: result.record }));
  } else {
    console.log(col.green('ok: ') + `standing grant minted (grantId=${result.record.grantId}, expires ${result.record.expiresAt}).`);
    console.log(col.dim(`  scope=[${scopeKeys.join(', ')}]`));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: revoke
// ---------------------------------------------------------------------------

async function cmdActivationRevoke(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const yes = args.includes('--yes');
  const rootIndex = args.indexOf('--root');
  const grantIndex = args.indexOf('--grant');
  const rootId = rootIndex !== -1 ? args[rootIndex + 1] : undefined;
  const grantId = grantIndex !== -1 ? args[grantIndex + 1] : undefined;
  const known = new Set(['--json', '--yes', '--root', '--grant', rootId, grantId].filter((v): v is string => v !== undefined));
  const unknown = args.find((a, i) => !known.has(a) && args[i - 1] !== '--root' && args[i - 1] !== '--grant');
  if (unknown) return printActivationUsageError(`Unknown flag: ${unknown}`, 'revoke');
  if ((rootIndex === -1) === (grantIndex === -1)) {
    return printActivationUsageError('Specify exactly one of --root <keyId> or --grant <grantId>.', 'revoke');
  }
  if (rootIndex !== -1 && rootId === undefined) return printActivationUsageError('--root requires a value', 'revoke');
  if (grantIndex !== -1 && grantId === undefined) return printActivationUsageError('--grant requires a value', 'revoke');

  const col = makeColors(process.stdout.isTTY === true);
  if (!jsonMode) {
    console.log('');
    console.log(col.bold('  ashlr activation revoke'));
    console.log(col.dim(
      rootId
        ? `  Immediately invalidates trust root ${rootId}. Every permit and standing\n`
          + '  grant signed by it stops verifying from this instant on.'
        : `  Immediately invalidates standing grant ${grantId}. Every guard that\n`
          + '  consults it denies from this instant on.',
    ));
    console.log('');
  }
  if (refuseUnattended(yes, jsonMode, 'revoke')) return 2;

  const result = rootId !== undefined
    ? daemonActivationRevokeTrustRoot(rootId)
    : daemonActivationRevokeGrant(grantId!);

  if (!result.ok) {
    if (jsonMode) console.log(JSON.stringify({ ok: false, error: result.reason }));
    else console.error(col.red('error: ') + `activation revoke refused: ${result.reason}`);
    return 1;
  }
  if (jsonMode) console.log(JSON.stringify({ ok: true }));
  else console.log(col.green('ok: ') + 'revoked.');
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr activation [init|status|grant|revoke] [flags]`
 *
 * Returns a process exit code (0 = success, non-zero = error/usage).
 */
export async function cmdActivation(args: string[]): Promise<number> {
  const requestedSub = args[0];
  if (requestedSub !== undefined && isHelpFlag(requestedSub)) {
    printActivationUsage();
    return 0;
  }
  if (requestedSub !== undefined && !isActivationSubcommand(requestedSub)) {
    const message = requestedSub.startsWith('-')
      ? `Unknown flag: ${requestedSub}`
      : `Unknown activation subcommand: ${requestedSub}`;
    return printActivationUsageError(message);
  }

  const sub: ActivationSubcommand = requestedSub ?? 'status';
  const rest = args.slice(1);
  if (rest.some(isHelpFlag)) {
    printActivationUsage(sub);
    return 0;
  }

  switch (sub) {
    case 'init':
      return cmdActivationInit(rest);
    case 'status':
      return cmdActivationStatus(rest);
    case 'grant':
      return cmdActivationGrant(rest);
    case 'revoke':
      return cmdActivationRevoke(rest);
  }
}

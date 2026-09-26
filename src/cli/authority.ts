/**
 * `ashlr authority …` — V3.10 Track B (unit B-U1).
 *
 *   status [--json]                       the standing authority, as the daemon would see it
 *   switch <off|propose|autonomous>       lower instantly; raise within the grant (past it: Touch ID)
 *   stop [--no-wait] | clear-stop         ~/.ashlr/KILL on (drains agents, revokes armed merges) / off
 *   revoke [--reason <text>] [--no-wait]  Stop + switch off + minGrantSeq bump; resuming needs a new grant
 *   draft [--new|--reapprove] [--json]    the grant you would be asked to sign
 *   grant [--yes] [--payload <file>] [--switch <mode>]   sign (Touch ID) + install a new grant
 *   re-approve [--yes] [--switch <mode>]  sign a continuation (after a deploy, expiry, …)
 *   ledger verify [--json]                full chain verification
 *   ledger tail [--limit N] [--kind K] [--json]
 *   surface [--installed] [--json]        the authority-surface digest and verification
 *   protect --print|--apply [--repo owner/name …]        GitHub rulesets (addendum §4)
 *   github-app [--org <login>] [--yes]    GitHub App manifest flow; the key goes straight to custody
 *   rotate-provenance [--yes]             replace the provenance HMAC key agents could read
 *   setup [--dry-run [--json]] [--yes] [--source <ashlr-hub checkout>]   the guided Phase-0 command
 *   resident start|stop|status [--json]   the resident daemon service under the grant (docs/RESIDENT-RUNTIME.md)
 *
 * LOWERING never asks anything. Everything that raises authority or touches
 * GitHub asks first (or needs --yes) and prints exactly what it did. Nothing
 * here ever runs `sudo` or prints a secret. Only `resident start` / `resident
 * stop` change launchd, only for ai.ashlr.daemon, and `start` only after the
 * operator confirms at a terminal under an active standing grant (no --yes).
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { CUSTODY_HELPER_PATH } from '../core/authority/custody-client.js';
import type { ResidentAdmission, ResidentPlistState } from '../core/authority/resident.js';
import type {
  AuthoritySetupNeed,
  AuthoritySetupReportV1,
  AuthoritySetupStepStatus,
  AutonomySwitch,
  LedgerEventKind,
  SignedStandingGrantV1,
  StandingGrantTrustRoot,
  StandingGrantV1,
} from '../core/authority/types.js';

export type { AuthoritySetupReportV1 } from '../core/authority/types.js';

// ---------------------------------------------------------------------------
// Dependencies (all injectable — tests never touch custody, GitHub or a browser)
// ---------------------------------------------------------------------------

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface AuthorityCliDeps {
  out(line: string): void;
  err(line: string): void;
  /** Ask a yes/no question; false when not interactive. */
  confirm(question: string): Promise<boolean>;
  /** Read a secret without echoing it. */
  readSecret(prompt: string): Promise<string>;
  /**
   * Run `gh` or `git` with argv — never through a shell. May answer
   * asynchronously (the Verse server's read-only probe runner must not block
   * its event loop), so every caller awaits it.
   */
  run(bin: 'gh' | 'git', args: readonly string[], opts?: { cwd?: string; input?: string }): GhResult | Promise<GhResult>;
  openBrowser(url: string): void;
  fetch: typeof fetch;
  custody: typeof import('../core/authority/custody-client.js');
  /** Read-only: the resident daemon service's state (setup's last step). Never changes launchd. */
  daemonService(): Promise<DaemonServiceState>;
  /** `resident start|stop|status` and setup's resident step (docs/RESIDENT-RUNTIME.md). */
  resident: ResidentCliDeps;
}

/** What `resident status` and setup read about the installed service. Read-only. */
export interface ResidentServiceObservation {
  state: DaemonServiceState;
  /** The installed plist vs the one `resident start` would write from config now. */
  plist: ResidentPlistState;
  plistPath: string | null;
  installedBudgetUsd: number | null;
  expectedBudgetUsd: number | null;
  /** Why the expected plist could not be computed (config unreadable…); null when it could. */
  problem: string | null;
}

export type ResidentEffectResult = { ok: true; detail: string } | { ok: false; reason: string };

export interface ResidentCliDeps {
  /** Fresh, read-only admission verdict for the code this process runs. */
  admission(): Promise<ResidentAdmission>;
  /** Read-only service + plist observation. Never changes launchd. */
  observe(): Promise<ResidentServiceObservation>;
  /** Why this process is not the operator at a terminal; null when it is. */
  operatorRefusal(): Promise<string | null>;
  /** Mint the capability (re-verifying everything), record it, install / restart the service. */
  start(): Promise<ResidentEffectResult>;
  /** Lowering: boot the service out and remove its plist. Never touches Stop or the grant. */
  stop(): Promise<ResidentEffectResult>;
}

/** The resident daemon service as setup reports it. */
export type DaemonServiceState = 'running' | 'loaded' | 'not-loaded' | 'absent' | 'unknown';

// Loaded lazily: `authority stop` and friends must never depend on the daemon
// service module being importable.
// `cached` (the Verse probe) reuses a launchd read up to 15 s old.
async function realDaemonService(cached = false): Promise<DaemonServiceState> {
  const { serviceStatus, serviceStatusCached } = await import('../core/daemon/service.js');
  const status = cached ? serviceStatusCached() : serviceStatus();
  if (status.running) return 'running';
  if (status.registrationState === 'absent') return 'absent';
  if (status.runtimeState === 'ready') return 'loaded';
  if (status.runtimeState === 'stopped' || status.runtimeState === 'disabled') return 'not-loaded';
  return 'unknown';
}

function realRun(bin: 'gh' | 'git', args: readonly string[], opts: { cwd?: string; input?: string } = {}): GhResult {
  const result = spawnSync(bin, [...args], {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? (result.error ? String(result.error.message) : '') };
}

async function realConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((done) => rl.question(`${question} [y/N] `, done));
    return /^y(es)?$/iu.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function realReadSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('a secret can only be entered in an interactive terminal');
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((done, fail) => {
      let value = '';
      const onData = (chunk: string): void => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') {
            stdin.off('data', onData);
            process.stdout.write('\n');
            done(value);
            return;
          }
          if (ch === '\u0003') {
            stdin.off('data', onData);
            fail(new Error('cancelled'));
            return;
          }
          if (ch === '\u007f') value = value.slice(0, -1);
          else value += ch;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function defaultDeps(): Promise<AuthorityCliDeps> {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    confirm: realConfirm,
    readSecret: realReadSecret,
    run: realRun,
    openBrowser: (url) => {
      // `open` is macOS's own launcher; the URL is one this command built.
      spawnSync('/usr/bin/open', [url], { stdio: 'ignore', timeout: 10_000 });
    },
    fetch: globalThis.fetch,
    custody: await import('../core/authority/custody-client.js'),
    daemonService: realDaemonService,
    resident: realResidentDeps,
  };
}


// ---------------------------------------------------------------------------
// Resident service — real effects (lazy: `authority stop` never loads them)
// ---------------------------------------------------------------------------

type ServiceInstallOptions = import('../core/daemon/service.js').ServiceInstallOptions;

async function residentServiceOptions(): Promise<{ ok: true; opts: ServiceInstallOptions; budgetUsd: number | null } | { ok: false; problem: string }> {
  const { loadConfigReadOnlyStrict } = await import('../core/config.js');
  const { daemonServiceInstallOptions } = await import('../core/daemon/service-config.js');
  let cfg: ReturnType<typeof loadConfigReadOnlyStrict>;
  try {
    cfg = loadConfigReadOnlyStrict();
  } catch (error) {
    return { ok: false, problem: `config.json could not be read (${(error as Error).message.slice(0, 160)})` };
  }
  // ALWAYS regenerated from config (daemon.dailyBudgetUsd / intervalMs /
  // parallel) — never carried over from an earlier install, so a budget
  // changed in config reaches the service on the next `resident start`.
  const opts = daemonServiceInstallOptions(cfg, { autostart: true });
  return { ok: true, opts, budgetUsd: opts.budget ?? null };
}

/** The installed service file: its text, null when absent, undefined when unreadable. */
function readServiceFile(path: string): string | null | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

const realResidentDeps: ResidentCliDeps = {
  admission: async () => (await import('../core/authority/resident.js')).observeResidentAdmission().admission,
  observe: async () => {
    const { residentPlistState, plistBudgetUsd } = await import('../core/authority/resident.js');
    const { generateServiceDefinition } = await import('../core/daemon/service.js');
    let state: DaemonServiceState;
    try {
      state = await realDaemonService();
    } catch {
      state = 'unknown';
    }
    const prepared = await residentServiceOptions();
    const def = generateServiceDefinition(prepared.ok ? prepared.opts : {});
    const installed = readServiceFile(def.filePath);
    return {
      state,
      plist: residentPlistState(installed, prepared.ok ? def.content : null),
      plistPath: def.filePath,
      installedBudgetUsd: plistBudgetUsd(installed ?? null),
      expectedBudgetUsd: prepared.ok ? prepared.budgetUsd : null,
      problem: prepared.ok ? null : prepared.problem,
    };
  },
  operatorRefusal: async () => {
    const { operatorContextRefusal, currentOperatorContext } = await import('../core/authority/resident.js');
    return operatorContextRefusal(currentOperatorContext());
  },
  start: async () => {
    const resident = await import('../core/authority/resident.js');
    const service = await import('../core/daemon/service.js');
    const { appendLedger } = await import('../core/authority/ledger.js');
    const prepared = await residentServiceOptions();
    if (!prepared.ok) return { ok: false, reason: prepared.problem };
    // The mint re-observes the operator context and re-verifies the grant,
    // the build identity and the authority surface itself: nothing this
    // command computed or printed earlier counts toward the decision.
    const minted = resident.mintResidentServiceCapability();
    if (!minted.ok) return { ok: false, reason: minted.reason };
    const def = service.generateServiceDefinition(prepared.opts);
    const digest = createHash('sha256').update(def.content, 'utf8').digest('hex');
    const grantId = minted.capability.grantId;
    const detail = `release ${minted.admission.revision?.slice(0, 12) ?? '?'} · plist sha256 ${digest.slice(0, 16)} · `
      + `budget $${prepared.budgetUsd ?? '?'}/day · interval ${prepared.opts.intervalMs ?? '?'} ms · parallel ${prepared.opts.parallel ?? '?'}`;
    // Fail closed: a start the authority ledger cannot record does not happen.
    const recorded = appendLedger({ kind: 'note', actor: 'mason', grantId, repo: null, data: { topic: 'resident-service:start', detail } });
    if (!recorded.ok) return { ok: false, reason: `the ledger refused the start record: ${recorded.reason}` };
    try {
      await service.installResidentService(prepared.opts, minted.capability);
    } catch (error) {
      appendLedger({ kind: 'note', actor: 'mason', grantId, repo: null, data: { topic: 'resident-service:start-failed', detail: (error as Error).message.slice(0, 300) } });
      return { ok: false, reason: (error as Error).message };
    }
    const status = service.serviceStatus(prepared.opts);
    const grant = `grant #${minted.admission.grantSeq ?? '?'}`;
    return {
      ok: true,
      detail: status.running
        ? `ai.ashlr.daemon is running under ${grant} (${detail})`
        : `ai.ashlr.daemon is installed and loaded under ${grant}, but launchd has not reported it running yet — check \`${resident.RESIDENT_STATUS_COMMAND}\` (${detail})`,
    };
  },
  stop: async () => {
    const service = await import('../core/daemon/service.js');
    try {
      await service.uninstall({});
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    try {
      const { appendLedger } = await import('../core/authority/ledger.js');
      appendLedger({ kind: 'note', actor: 'mason', grantId: null, repo: null, data: { topic: 'resident-service:stop', detail: 'ai.ashlr.daemon booted out and its plist removed' } });
    } catch {
      // Lowering never depends on the ledger.
    }
    return { ok: true, detail: 'ai.ashlr.daemon is stopped and its plist removed' };
  },
};


// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Parsed {
  positional: string[];
  flags: Set<string>;
  values: Map<string, string[]>;
}

const VALUE_FLAGS = new Set(['--reason', '--payload', '--switch', '--limit', '--kind', '--repo', '--org', '--source']);

function parseArgs(args: readonly string[]): Parsed | string {
  const out: Parsed = { positional: [], flags: new Set(), values: new Map() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) {
      out.positional.push(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      out.values.set(arg, [...(out.values.get(arg) ?? []), value]);
      i += 1;
    } else {
      out.flags.add(arg);
    }
  }
  return out;
}

function one(parsed: Parsed, flag: string): string | null {
  const values = parsed.values.get(flag);
  return values && values.length > 0 ? values[values.length - 1]! : null;
}

const USAGE = `Usage: ashlr authority <command>

  status [--json]                        Standing authority: grant, switch, Stop, rollout, ledger, custody
  switch <off|propose|autonomous>        Lower instantly; raise up to what the grant allows
  stop [--no-wait] | clear-stop          Engage Stop (~/.ashlr/KILL): halt agents, cancel armed merges / clear it
  revoke [--reason <text>] [--no-wait]   Stop, switch off, and require a new grant (Touch ID) to resume
  draft [--new|--reapprove] [--json]     Show the grant you would sign
  grant [--yes] [--payload <file>] [--switch <mode>]
                                         Sign a new grant with Touch ID and install it
  re-approve [--yes] [--switch <mode>]   Sign a continuation (after an authority deploy, expiry, …)
  ledger verify [--json]                 Verify the whole authority ledger chain
  ledger tail [--limit N] [--kind K] [--json]
  surface [--installed] [--json]         Authority-surface digest of this / the installed release
  protect --print|--apply [--repo o/n]   GitHub rulesets for the grant's server-enforced repos
  github-app [--org <login>] [--yes]     Create the ashlr-fleet GitHub App (key stored in custody)
  rotate-provenance [--yes]              Replace the provenance HMAC key
  setup [--dry-run [--json]] [--yes] [--source <checkout>]
                                         Guided Phase 0: custody, trust root, App, token, canary, rulesets, first grant, daemon
  resident start                         Install / restart the resident daemon under the active grant (you confirm here)
  resident stop                          Boot the resident daemon out and remove its plist (Stop is separate)
  resident status [--json]               Resident admission, service state and plist drift

Lowering authority never asks. Anything that raises it asks first (or takes --yes).`;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** `ashlr authority …` (the CLI's `(args) => exit code` shape). */
export async function runAuthorityCli(args: string[], injected?: Partial<AuthorityCliDeps>): Promise<number> {
  const deps: AuthorityCliDeps = { ...(await defaultDeps()), ...(injected ?? {}) };
  const parsed = parseArgs(args);
  if (typeof parsed === 'string') {
    deps.err(parsed);
    return 2;
  }
  const [command, ...rest] = parsed.positional;
  try {
    switch (command) {
      case undefined:
      case 'help':
        deps.out(USAGE);
        return command === undefined ? 2 : 0;
      case 'status':
        return await cmdStatus(parsed, deps);
      case 'switch':
        return await cmdSwitch(rest[0], deps);
      case 'stop':
        return await cmdStop(parsed, deps);
      case 'clear-stop':
        return await cmdClearStop(deps);
      case 'revoke':
        return await cmdRevoke(parsed, deps);
      case 'draft':
        return await cmdDraft(parsed, deps);
      case 'grant':
        return await cmdGrant(parsed, deps, 'new');
      case 're-approve':
        return await cmdGrant(parsed, deps, 'reapprove');
      case 'ledger':
        return await cmdLedger(rest[0], parsed, deps);
      case 'surface':
        return await cmdSurface(parsed, deps);
      case 'protect':
        return await cmdProtect(parsed, deps);
      case 'github-app':
        return await cmdGithubApp(parsed, deps);
      case 'rotate-provenance':
        return await cmdRotateProvenance(parsed, deps);
      case 'setup':
        return await cmdSetup(parsed, deps);
      case 'resident':
        return await cmdResident(rest[0], parsed, deps);
      default:
        deps.err(`Unknown authority command: ${command}`);
        deps.out(USAGE);
        return 2;
    }
  } catch (error) {
    deps.err(`authority ${command}: ${(error as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// status / switch / stop / revoke
// ---------------------------------------------------------------------------

async function cmdStatus(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const { buildAuthorityStatus } = await import('../core/verse/authority-api.js');
  const { status } = await buildAuthorityStatus();
  if (parsed.flags.has('--json')) {
    deps.out(JSON.stringify(status, null, 2));
    return 0;
  }
  const g = status.grant;
  deps.out(`Autonomy: ${status.effectiveSwitch}${status.effectiveSwitch !== status.switch ? ` (switch set to ${status.switch})` : ''}${status.kill ? ' — STOPPED' : ''}`);
  if (status.effectiveReason) deps.out(`  why: ${status.effectiveReason}`);
  deps.out(`Grant: ${g.state}${g.grantSeq !== null ? ` #${g.grantSeq}` : ''}${g.expiresAt ? `, expires ${g.expiresAt}` : ''}`);
  if (g.reason) deps.out(`  ${g.reason}`);
  if (status.rollout) {
    const r = status.rollout;
    deps.out(`Rollout: stage ${r.stageId} (${r.stageIndex + 1}/${r.stageCount}) since ${r.enteredAt}${r.met ? ' — criteria met' : ''}`);
    if (r.unmet.length > 0) deps.out(`  to advance: ${r.unmet.join('; ')}`);
  }
  if (status.policy) {
    const merging = status.policy.repos.filter((repo) => repo.stage === 'merge').map((repo) => repo.nameWithOwner);
    deps.out(`Policy: ${status.policy.repos.length} repos (${merging.length} merging), engines ${status.policy.engines.join(', ')}, caps ${status.policy.merge.maxFiles}/${status.policy.merge.maxLines}`);
  }
  deps.out(`Ledger: ${status.ledger.state}${status.ledger.head ? `, ${status.ledger.head.seq + 1} entries, head ${status.ledger.head.hash.slice(0, 12)}` : ''}${status.ledger.reason ? ` — ${status.ledger.reason}` : ''}`);
  const c = status.custody;
  const yn = (v: boolean | null): string => (v === null ? 'unknown' : v ? 'yes' : 'no');
  deps.out(`Custody: installed ${yn(c.installed)}, key ${yn(c.keyInitialized)}, GitHub App ${yn(c.githubApp)}, Claude token ${yn(c.claudeToken)}`);
  return 0;
}

const SWITCHES: readonly AutonomySwitch[] = ['off', 'propose', 'autonomous'];

async function cmdSwitch(to: string | undefined, deps: AuthorityCliDeps): Promise<number> {
  if (!to || !(SWITCHES as readonly string[]).includes(to)) {
    deps.err('Usage: ashlr authority switch <off|propose|autonomous>');
    return 2;
  }
  const { requestAutonomySwitch } = await import('../core/authority/effective-config.js');
  const result = requestAutonomySwitch(to as AutonomySwitch, 'mason', 'set with ashlr authority switch');
  if (!result.ok) {
    deps.err(result.reason);
    if (result.code === 'grant-required') deps.err('Run `ashlr authority grant` (Touch ID) to approve more.');
    return 1;
  }
  deps.out(result.changed ? `Switch: ${result.from} → ${result.to}.${result.ledgered ? '' : ' (the ledger could not record it)'}` : `Switch already ${result.to}.`);
  return 0;
}

/** One line on what Stop left behind: running agents and armed merges (U6 / U3). */
function drainSummary(r: { quiesced: boolean; liveExecutionLeases: number; drainWaitedMs: number; mergesRevoked: number | null; mergeRevokeFailures: string[] }): string[] {
  const lines: string[] = [];
  lines.push(r.quiesced || r.liveExecutionLeases === 0
    ? `No agent is running${r.drainWaitedMs > 0 ? ` (drained in ${(r.drainWaitedMs / 1000).toFixed(1)} s)` : ''}.`
    : `${r.liveExecutionLeases} agent${r.liveExecutionLeases === 1 ? ' is' : 's are'} still running after ${(r.drainWaitedMs / 1000).toFixed(1)} s; they were told to stop and cannot file anything while Stop is on.`);
  if (r.mergesRevoked !== null && r.mergesRevoked > 0) lines.push(`Cancelled ${r.mergesRevoked} armed merge${r.mergesRevoked === 1 ? '' : 's'} before GitHub was called.`);
  for (const failure of r.mergeRevokeFailures) lines.push(`  could not cancel an armed merge (Stop still blocks it at send time): ${failure}`);
  return lines;
}

/**
 * Stop from the CLI waits for agents to exit (U6's setKillAndDrain, up to
 * 30 s) and cancels armed merges (U3) — the terminal can afford to wait and
 * Mason wants to know the fleet is actually quiet. `--no-wait` arms and
 * returns at once, like the Verse button.
 */
async function cmdStop(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const { stopAutonomy, stopAutonomyAndDrain } = await import('../core/authority/clamp.js');
  const result = parsed.flags.has('--no-wait')
    ? stopAutonomy({ actor: 'mason', reason: 'ashlr authority stop', waitMs: 2_000 })
    : await stopAutonomyAndDrain({ actor: 'mason', reason: 'ashlr authority stop' });
  if (!result.armed) {
    deps.err(`Stop could not be armed: ${result.reason}`);
    return 1;
  }
  deps.out(`Stopped.${result.ledgered ? '' : ' (the ledger could not record it)'}`);
  for (const line of drainSummary(result)) deps.out(line);
  if (parsed.flags.has('--json')) deps.out(JSON.stringify(result, null, 2));
  return 0;
}

async function cmdClearStop(deps: AuthorityCliDeps): Promise<number> {
  const { clearStop } = await import('../core/authority/clamp.js');
  const result = clearStop({ actor: 'mason', reason: 'ashlr authority clear-stop', waitMs: 5_000 });
  if (!result.ok) {
    deps.err(result.reason);
    return 1;
  }
  deps.out(result.reason);
  return 0;
}

async function cmdRevoke(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const { revokeStanding, revokeStandingAndDrain } = await import('../core/authority/clamp.js');
  const reason = one(parsed, '--reason') ?? 'revoked with ashlr authority revoke';
  const result = parsed.flags.has('--no-wait')
    ? revokeStanding({ actor: 'mason', reason })
    : await revokeStandingAndDrain({ actor: 'mason', reason });
  (result.ok ? deps.out : deps.err)(`${result.reason}${result.grantId ? ` (grant ${result.grantId.slice(0, 8)}; grants below #${result.minGrantSeq} are dead)` : ''}`);
  if (result.stopped) for (const line of drainSummary({ ...result, quiesced: result.liveExecutionLeases === 0 })) deps.out(line);
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// draft / grant / re-approve
// ---------------------------------------------------------------------------

async function cmdDraft(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const { buildStandingGrantDraft } = await import('../core/verse/authority-api.js');
  const kind = parsed.flags.has('--new') ? 'new' : parsed.flags.has('--reapprove') ? 'reapprove' : 'auto';
  const draft = await buildStandingGrantDraft(kind);
  if (parsed.flags.has('--json')) {
    deps.out(JSON.stringify({ kind: draft.kind, digest: draft.digest, payload: draft.payload }, null, 2));
    return 0;
  }
  deps.out(`Draft (${draft.kind === 'new' ? 'new grant' : 're-approval'}), digest ${draft.digest}`);
  for (const line of draft.summary) deps.out(`  ${line}`);
  return 0;
}

async function signAndInstall(
  payload: StandingGrantV1,
  deps: AuthorityCliDeps,
): Promise<{ ok: true; grant: StandingGrantV1 } | { ok: false; reason: string }> {
  const { standingGrantPayloadDigest, installStandingGrant } = await import('../core/authority/standing-grant.js');
  const { displaySurfaceTarget, invalidateStandingPolicyCache } = await import('../core/authority/effective-config.js');
  const digest = standingGrantPayloadDigest(payload);
  let signed: SignedStandingGrantV1;
  try {
    signed = await deps.custody.signGrant(payload);
  } catch (error) {
    return { ok: false, reason: `not signed: ${(error as Error).message}` };
  }
  if (!signed || standingGrantPayloadDigest(signed.payload) !== digest) {
    return { ok: false, reason: 'the custody helper signed something other than this draft; nothing was installed' };
  }
  const installed = installStandingGrant(signed, { surface: displaySurfaceTarget() });
  invalidateStandingPolicyCache();
  if (!installed.ok) return { ok: false, reason: installed.reason };
  return { ok: true, grant: installed.grant };
}

async function cmdGrant(parsed: Parsed, deps: AuthorityCliDeps, kind: 'new' | 'reapprove'): Promise<number> {
  const { describeGrantScope, parseStandingGrantPayload } = await import('../core/authority/standing-grant.js');
  let payload: StandingGrantV1;
  const file = one(parsed, '--payload');
  if (file) {
    if (kind !== 'new') {
      deps.err('--payload only applies to `grant`.');
      return 2;
    }
    const checked = parseStandingGrantPayload(JSON.parse(readFileSync(resolve(file), 'utf8')) as unknown);
    if (!checked.ok) {
      deps.err(`That payload would be refused: ${checked.reason}`);
      return 1;
    }
    payload = checked.value;
  } else {
    const { buildStandingGrantDraft } = await import('../core/verse/authority-api.js');
    payload = (await buildStandingGrantDraft(kind)).payload;
  }
  deps.out(kind === 'new' ? 'You are about to sign this standing grant:' : 'You are about to re-approve (continue) this standing grant:');
  for (const line of describeGrantScope(payload)) deps.out(`  ${line}`);
  if (!parsed.flags.has('--yes') && !(await deps.confirm('Sign it with Touch ID?'))) {
    deps.out('Not signed.');
    return 1;
  }
  const result = await signAndInstall(payload, deps);
  if (!result.ok) {
    deps.err(result.reason);
    return 1;
  }
  deps.out(`Installed grant #${result.grant.grantSeq} (${result.grant.grantId.slice(0, 8)}), starting at stage ${result.grant.rollout.stages[0]!.id}.`);
  const to = one(parsed, '--switch');
  if (to) return cmdSwitch(to, deps);
  return 0;
}

// ---------------------------------------------------------------------------
// ledger / surface
// ---------------------------------------------------------------------------

async function cmdLedger(sub: string | undefined, parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const { readLedger } = await import('../core/authority/ledger.js');
  const { LEDGER_EVENT_KINDS } = await import('../core/authority/types.js');
  if (sub === 'verify') {
    const read = await readLedger({ limit: 0 });
    if (parsed.flags.has('--json')) deps.out(JSON.stringify({ chain: read.chain, head: read.head, brokenAtSeq: read.brokenAtSeq, reason: read.reason }, null, 2));
    else if (read.chain === 'broken') deps.err(`Ledger BROKEN at entry ${read.brokenAtSeq ?? '?'}: ${read.reason}`);
    else deps.out(read.chain === 'empty' ? 'Ledger is empty.' : `Ledger OK: ${read.head!.seq + 1} entries, head ${read.head!.hash}.`);
    return read.chain === 'broken' ? 1 : 0;
  }
  if (sub === 'tail') {
    const limitRaw = one(parsed, '--limit');
    const limit = limitRaw === null ? 20 : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      deps.err('--limit must be a whole number from 1 to 1000');
      return 2;
    }
    const kind = one(parsed, '--kind');
    if (kind !== null && !(LEDGER_EVENT_KINDS as readonly string[]).includes(kind)) {
      deps.err(`--kind must be one of: ${LEDGER_EVENT_KINDS.join(', ')}`);
      return 2;
    }
    const read = await readLedger({ limit, ...(kind ? { kinds: [kind as LedgerEventKind] } : {}) });
    if (parsed.flags.has('--json')) {
      deps.out(JSON.stringify(read, null, 2));
    } else {
      for (const entry of read.entries) deps.out(`${String(entry.seq).padStart(6)} ${entry.at} ${entry.actor.padEnd(16)} ${entry.kind}${entry.repo ? ` ${entry.repo}` : ''}`);
      if (read.chain === 'broken') deps.err(`Ledger BROKEN at entry ${read.brokenAtSeq ?? '?'}: ${read.reason}`);
    }
    return read.chain === 'broken' ? 1 : 0;
  }
  deps.err('Usage: ashlr authority ledger <verify|tail>');
  return 2;
}

async function cmdSurface(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const { verifyAuthoritySurface } = await import('../core/authority/surface.js');
  const result = verifyAuthoritySurface(parsed.flags.has('--installed') ? 'installed' : 'running', { fresh: true });
  if (parsed.flags.has('--json')) deps.out(JSON.stringify(result, null, 2));
  else if (result.ok) deps.out(`Authority surface OK (${result.target}): ${result.fileCount} files, digest ${result.digest}`);
  else deps.err(`Authority surface ${result.code} (${result.target}): ${result.reason}`);
  return result.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// protect — rulesets (addendum §4)
// ---------------------------------------------------------------------------

export const FLEET_RULESET_NAME = 'ashlr-fleet: default branch';

/**
 * GitHub's built-in "Repository admin" role id for ruleset bypass actors
 * (actor_type RepositoryRole). Printed with --print for review before --apply.
 */
export const REPOSITORY_ADMIN_ROLE_ID = 5;

/**
 * PURE: the default-branch ruleset for one repo. Required checks, no
 * force-push, no deletion, changes through PRs with code-owner review on
 * CODEOWNERS paths — bypassable by the repository ADMIN role (Mason is solo;
 * forcing approvals on his own PRs would make him the bottleneck again) but
 * NOT by the ashlr-fleet App, which is not an admin.
 */
export interface RequiredCheck {
  context: string;
  /** The GitHub App that reports this check on the default branch today; null = unknown or ambiguous. */
  integrationId: number | null;
}

/**
 * Normalize to one entry per context. A context reported by two different
 * Apps is left unpinned (null) rather than guessing which one is real.
 */
function normalizeRequiredChecks(requiredChecks: readonly (string | RequiredCheck)[]): RequiredCheck[] {
  const byContext = new Map<string, number | null>();
  for (const check of requiredChecks) {
    const entry = typeof check === 'string' ? { context: check, integrationId: null } : check;
    if (!byContext.has(entry.context)) byContext.set(entry.context, entry.integrationId);
    else if (byContext.get(entry.context) !== entry.integrationId) byContext.set(entry.context, null);
  }
  return [...byContext.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([context, integrationId]) => ({ context, integrationId }));
}

export function buildFleetRuleset(requiredChecks: readonly (string | RequiredCheck)[]): Record<string, unknown> {
  const checks = normalizeRequiredChecks(requiredChecks);
  return {
    name: FLEET_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: REPOSITORY_ADMIN_ROLE_ID, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      ...(checks.length > 0
        ? [{
            type: 'required_status_checks',
            parameters: {
              // "Require branches to be up to date" (U3's request): GitHub then
              // refuses to merge a head that is behind its base, which closes
              // the base-move race the SHA pin alone cannot — the standing
              // merge pass rebuilds the PR on the new base and re-verifies.
              strict_required_status_checks_policy: true,
              // Each check is pinned to the App that reports it today (for
              // example GitHub Actions), so nothing else can satisfy it by
              // posting a status with the same name.
              required_status_checks: checks.map(({ context, integrationId }) => (
                integrationId === null ? { context } : { context, integration_id: integrationId }
              )),
            },
          }]
        : []),
    ],
  };
}

interface RepoProtectPlan {
  repo: string;
  skipped: string | null;
  checks: string[];
  ruleset: Record<string, unknown> | null;
  existingId: number | null;
  /** GitHub already holds exactly this ruleset: applying it again would change nothing. */
  upToDate: boolean;
  /** 3.13: why `ashlr/verify` is not required for a grant repo (null when it is, or the repo is not in the grant). */
  verifyNote?: string | null;
}

async function ghJson(deps: AuthorityCliDeps, args: readonly string[]): Promise<unknown> {
  const result = await deps.run('gh', args);
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim().slice(0, 200)}`);
  return JSON.parse(result.stdout || 'null') as unknown;
}

/** Check-run names on the default branch head: what CI actually reports today. */
/**
 * 3.13: with `verifyAppId` (the repo is in the grant, the fleet can verify it
 * and the ashlr-fleet App's id is known) the host-verified `ashlr/verify` is
 * always required, pinned to the App — even when the default branch has no
 * runs at all (Actions off), which is exactly the repo it exists for. A
 * same-named run from another App never replaces the pin.
 */
async function discoverChecks(deps: AuthorityCliDeps, repo: string, branch: string, verifyAppId: number | null = null): Promise<RequiredCheck[]> {
  const runs = await ghJson(deps, ['api', `repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`]) as { check_runs?: { name?: string; app?: { id?: unknown } }[] };
  const found: RequiredCheck[] = [];
  for (const run of runs.check_runs ?? []) {
    if (typeof run.name !== 'string' || run.name.length === 0) continue;
    if (verifyAppId !== null && run.name === ASHLR_VERIFY_CHECK) continue;
    const appId = run.app?.id;
    found.push({ context: run.name, integrationId: typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0 ? appId : null });
  }
  if (verifyAppId !== null) found.push({ context: ASHLR_VERIFY_CHECK, integrationId: verifyAppId });
  return normalizeRequiredChecks(found);
}

/** The check the ashlr-fleet App posts on fleet PR heads (core/fleet/verify-check-run.ts ASHLR_VERIFY_CHECK_NAME). */
export const ASHLR_VERIFY_CHECK = 'ashlr/verify';

export interface FleetAppInfo {
  id: number;
  slug: string;
  ownerLogin: string;
  ownerIsOrg: boolean;
  /** The App's configured permission for check runs ('write' | 'read' | null = none). */
  checks: string | null;
}

/** The ashlr-fleet App as GitHub describes it to your own gh auth (a `gh api` read); null = unreadable. */
export async function readFleetApp(deps: AuthorityCliDeps): Promise<FleetAppInfo | null> {
  try {
    const app = await ghJson(deps, ['api', `apps/${FLEET_APP_NAME}`]) as {
      id?: unknown;
      slug?: unknown;
      owner?: { login?: unknown; type?: unknown };
      permissions?: Record<string, unknown>;
    } | null;
    if (!app || typeof app.id !== 'number' || !Number.isSafeInteger(app.id) || app.id <= 0) return null;
    const slug = typeof app.slug === 'string' && /^[a-z0-9-]{1,100}$/.test(app.slug) ? app.slug : FLEET_APP_NAME;
    const ownerLogin = typeof app.owner?.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(app.owner.login) ? app.owner.login : '';
    const checks = typeof app.permissions?.['checks'] === 'string' ? app.permissions['checks'] as string : null;
    return { id: app.id, slug, ownerLogin, ownerIsOrg: app.owner?.type === 'Organization', checks };
  } catch {
    return null;
  }
}

/** PURE: where the App's permissions (and then each installation's acceptance) are changed. */
export function fleetAppPermissionUrls(app: Pick<FleetAppInfo, 'slug' | 'ownerLogin' | 'ownerIsOrg'>): { permissions: string; installations: string } {
  const base = app.ownerIsOrg && app.ownerLogin
    ? `https://github.com/organizations/${app.ownerLogin}/settings`
    : 'https://github.com/settings';
  return { permissions: `${base}/apps/${app.slug}/permissions`, installations: `${base}/installations` };
}

/** True when the fleet mirror of `repo` exists and the fleet detects at least one required verify command there. */
async function fleetCanVerify(repo: string): Promise<boolean> {
  try {
    const { mirrorPathFor } = await import('../core/fleet/mirrors.js');
    const { detectVerifyCommands } = await import('../core/run/verify-commands.js');
    const mirror = mirrorPathFor(repo);
    if (!existsSync(mirror)) return false;
    return detectVerifyCommands(mirror, 'merge').some((command) => command.required !== false);
  } catch {
    return false;
  }
}

/**
 * PURE: `actual` (a ruleset as GitHub returns it) already says everything
 * `desired` says. GitHub adds ids, links, timestamps and server-side rule
 * defaults to what it returns, so extra object keys are ignored — but every
 * field we set must match, and arrays must match one-to-one in any order, so
 * an extra rule, an extra bypass actor or an extra required check is drift
 * (re-applying would remove it). Anything unreadable is "not up to date".
 */
export function rulesetMatches(desired: unknown, actual: unknown): boolean {
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual) || actual.length !== desired.length) return false;
    const unused = [...actual];
    for (const wanted of desired) {
      const at = unused.findIndex((candidate) => rulesetMatches(wanted, candidate));
      if (at < 0) return false;
      unused.splice(at, 1);
    }
    return true;
  }
  if (desired !== null && typeof desired === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const have = actual as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) => rulesetMatches(value, have[key]));
  }
  return Object.is(desired, actual);
}

/** A repo setup looks after, and whether GitHub or the daemon enforces its gates (null = not known yet). */
interface SetupRepo {
  nameWithOwner: string;
  enforcement: 'server' | 'local' | null;
}

/**
 * The repos the fleet works in: the installed grant's, or — before the first
 * grant — the ones it would name (every enrolled checkout's GitHub repo plus
 * the canary; authority-api draftRepos), which are server-enforced until a
 * grant says otherwise. Read-only: no draft is built and the ledger is not
 * touched, so a dry run (and Verse's checklist) can ask it freely.
 */
async function setupTargetRepos(): Promise<SetupRepo[]> {
  const { readInstalledGrant, FLEET_CANARY_REPO } = await import('../core/authority/standing-grant.js');
  const installed = readInstalledGrant();
  if (installed.state === 'ok') {
    return installed.envelope.payload.repos.map((repo) => ({ nameWithOwner: repo.nameWithOwner, enforcement: repo.enforcement }));
  }
  const byKey = new Map<string, SetupRepo>();
  try {
    const { readEnrollmentRegistry } = await import('../core/sandbox/policy.js');
    const { repoIdentityOfPath } = await import('../core/fleet/repo-identity.js');
    const registry = readEnrollmentRegistry();
    if (registry.state === 'ready') {
      for (const path of registry.repos) {
        const nameWithOwner = repoIdentityOfPath(path);
        if (nameWithOwner && !byKey.has(nameWithOwner.toLowerCase())) byKey.set(nameWithOwner.toLowerCase(), { nameWithOwner, enforcement: 'server' });
      }
    }
  } catch {
    // An unreadable registry leaves the canary alone on the list.
  }
  if (!byKey.has(FLEET_CANARY_REPO)) byKey.set(FLEET_CANARY_REPO, { nameWithOwner: FLEET_CANARY_REPO, enforcement: 'server' });
  return [...byKey.values()];
}

/** Read-only: what `protect --apply` would do for each repo (every gh call here is a GET). */
async function protectPlans(parsed: Parsed, deps: AuthorityCliDeps, given?: readonly SetupRepo[]): Promise<RepoProtectPlan[]> {
  const explicit = parsed.values.get('--repo') ?? [];
  const byGrant = given !== undefined || explicit.length === 0;
  const targets: readonly SetupRepo[] = given
    ?? (explicit.length > 0 ? explicit.map((nameWithOwner) => ({ nameWithOwner, enforcement: null })) : await setupTargetRepos());
  // Repos the grant covers (installed grant, or the would-be grant's own list):
  // only those get the fleet's ashlr/verify requirement.
  const grantMembers = new Set<string>();
  const { readInstalledGrant } = await import('../core/authority/standing-grant.js');
  const installed = readInstalledGrant();
  if (installed.state === 'ok') for (const r of installed.envelope.payload.repos) grantMembers.add(r.nameWithOwner.toLowerCase());
  if (byGrant) for (const r of targets) grantMembers.add(r.nameWithOwner.toLowerCase());
  let fleetApp: FleetAppInfo | null | undefined;
  const plans: RepoProtectPlan[] = [];
  for (const { nameWithOwner: repo, enforcement } of targets) {
    if (enforcement === 'local') {
      plans.push({ repo, skipped: 'local enforcement (private free-plan repo: GitHub rulesets unavailable) — the daemon enforces its gates', checks: [], ruleset: null, existingId: null, upToDate: false });
      continue;
    }
    try {
      const info = await ghJson(deps, ['api', `repos/${repo}`]) as { private?: boolean; default_branch?: string } | null;
      let verifyAppId: number | null = null;
      let verifyNote: string | null = null;
      if (grantMembers.has(repo.toLowerCase())) {
        if (!(await fleetCanVerify(repo))) {
          verifyNote = `${ASHLR_VERIFY_CHECK} not required: the fleet mirror has no verify command yet (rerun protect once it has synced)`;
        } else {
          if (fleetApp === undefined) fleetApp = await readFleetApp(deps);
          if (fleetApp) verifyAppId = fleetApp.id;
          else verifyNote = `${ASHLR_VERIFY_CHECK} not required: the ${FLEET_APP_NAME} App could not be read (\`gh api apps/${FLEET_APP_NAME}\`)`;
        }
      }
      const required = await discoverChecks(deps, repo, info?.default_branch ?? 'main', verifyAppId);
      const checks = required.map((check) => check.context);
      const existing = await ghJson(deps, ['api', `repos/${repo}/rulesets`]) as { id?: number; name?: string }[] | null;
      const match = Array.isArray(existing) ? existing.find((r) => r.name === FLEET_RULESET_NAME) : undefined;
      const existingId = typeof match?.id === 'number' && Number.isSafeInteger(match.id) ? match.id : null;
      const ruleset = buildFleetRuleset(required);
      // Rerun-safe: a ruleset already on GitHub with this exact content is
      // reported as in place instead of being PUT again.
      const upToDate = existingId !== null && rulesetMatches(ruleset, await ghJson(deps, ['api', `repos/${repo}/rulesets/${existingId}`]));
      plans.push({
        repo,
        skipped: info?.private === true && checks.length === 0 ? 'private repo with no CI checks — protect it by hand or keep it propose-only' : null,
        checks,
        ruleset,
        existingId,
        upToDate,
        verifyNote,
      });
    } catch (error) {
      plans.push({ repo, skipped: `could not read it from GitHub: ${(error as Error).message}`, checks: [], ruleset: null, existingId: null, upToDate: false });
    }
  }
  return plans;
}

/** Create or update each plan's ruleset; the number that failed. */
async function applyProtectPlans(plans: readonly RepoProtectPlan[], deps: AuthorityCliDeps): Promise<number> {
  let failures = 0;
  for (const plan of plans) {
    const result = await deps.run('gh', [
      'api', '--method', plan.existingId === null ? 'POST' : 'PUT',
      `repos/${plan.repo}/rulesets${plan.existingId === null ? '' : `/${plan.existingId}`}`,
      '--input', '-',
    ], { input: JSON.stringify(plan.ruleset) });
    if (result.status === 0) deps.out(`${plan.repo}: ruleset ${plan.existingId === null ? 'created' : 'updated'}.`);
    else {
      failures += 1;
      deps.err(`${plan.repo}: failed — ${result.stderr.trim().slice(0, 300)}`);
    }
  }
  return failures;
}

async function cmdProtect(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const apply = parsed.flags.has('--apply');
  if (!apply && !parsed.flags.has('--print')) {
    deps.err('Usage: ashlr authority protect --print|--apply [--repo owner/name …]');
    return 2;
  }
  const plans = await protectPlans(parsed, deps);
  for (const plan of plans) {
    if (plan.skipped) {
      deps.out(`${plan.repo}: skipped — ${plan.skipped}`);
      continue;
    }
    const checks = plan.checks.length > 0 ? plan.checks.join(', ') : 'none found (the repo goes to the owner lane until it has CI)';
    if (plan.upToDate) {
      deps.out(`${plan.repo}: ruleset ${plan.existingId} already up to date; required checks: ${checks}`);
      continue;
    }
    deps.out(`${plan.repo}: ${plan.existingId === null ? 'create' : `update ruleset ${plan.existingId}`}; required checks: ${checks}`);
    if (plan.verifyNote) deps.out(`  note: ${plan.verifyNote}`);
    else if (plan.checks.includes(ASHLR_VERIFY_CHECK)) {
      deps.out(`  note: ${ASHLR_VERIFY_CHECK} is posted only on fleet PRs; your own PRs need the admin bypass unless another required check covers them`);
    }
    if (!apply) {
      deps.out(`  gh api --method ${plan.existingId === null ? 'POST' : 'PUT'} repos/${plan.repo}/rulesets${plan.existingId === null ? '' : `/${plan.existingId}`} --input - <<'JSON'`);
      deps.out(JSON.stringify(plan.ruleset, null, 2));
      deps.out('JSON');
    }
  }
  if (!apply) return 0;
  const actionable = plans.filter((plan) => !plan.skipped && !plan.upToDate);
  if (actionable.length === 0) return 0;
  if (!parsed.flags.has('--yes') && !(await deps.confirm(`Apply the ruleset to ${actionable.length} repo(s)?`))) {
    deps.out('Nothing applied.');
    return 1;
  }
  return (await applyProtectPlans(actionable, deps)) === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// github-app — App Manifest flow (addendum §3)
// ---------------------------------------------------------------------------

export const FLEET_APP_NAME = 'ashlr-fleet';

/**
 * PURE: the App manifest. Contents + pull requests read/write, checks
 * read/write (3.13: the App posts the host-verified `ashlr/verify` check run
 * on fleet PR heads — core/fleet/verify-check-run.ts), statuses / metadata
 * read. No workflows, no administration — GitHub itself then refuses
 * CI-config and protection changes from the fleet. An App created before 3.13
 * has `checks: read`; `ashlr authority setup` detects that and prints where
 * to raise it (fleetAppPermissionUrls).
 */
export function buildGithubAppManifest(redirectUrl: string): Record<string, unknown> {
  return {
    name: FLEET_APP_NAME,
    url: 'https://github.com/ashlrai/ashlr-hub',
    hook_attributes: { url: 'https://github.com/ashlrai/ashlr-hub', active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', checks: 'write', statuses: 'read', metadata: 'read' },
    default_events: [],
  };
}

function htmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** PURE: the local page that POSTs the manifest to GitHub. */
export function manifestFormPage(manifest: Record<string, unknown>, org: string | null, state: string): string {
  const action = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;
  return `<!doctype html><meta charset="utf-8"><title>Create ${FLEET_APP_NAME}</title>
<form id="f" method="post" action="${htmlAttr(action)}"><input type="hidden" name="manifest" value="${htmlAttr(JSON.stringify(manifest))}">
<p>Creating the <b>${FLEET_APP_NAME}</b> GitHub App… <button type="submit">Continue on GitHub</button></p></form>
<script>document.getElementById('f').submit()</script>`;
}

export interface GithubAppFlowResult {
  appId: string;
  slug: string;
  installUrl: string;
}

/**
 * Run the manifest flow: a one-shot loopback server, the browser, the code
 * exchange, and the private key straight into custody. The PEM never touches
 * disk and is never printed.
 */
export async function runGithubAppFlow(deps: AuthorityCliDeps, opts: { org: string | null; timeoutMs?: number }): Promise<GithubAppFlowResult> {
  const state = randomBytes(16).toString('hex');
  let settle!: (code: string) => void;
  let fail!: (error: Error) => void;
  const codePromise = new Promise<string>((done, reject) => {
    settle = done;
    fail = reject;
  });
  let manifestPage = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(manifestPage);
      return;
    }
    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state || !code || !/^[A-Za-z0-9_-]{1,200}$/u.test(code)) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('This callback does not belong to the running setup.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${FLEET_APP_NAME} created — you can close this tab and return to the terminal.`);
      settle(code);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const timer = setTimeout(() => fail(new Error('timed out waiting for GitHub')), opts.timeoutMs ?? 10 * 60 * 1000);
  try {
    manifestPage = manifestFormPage(buildGithubAppManifest(`http://127.0.0.1:${port}/callback`), opts.org, state);
    deps.out(`Opening your browser to create the ${FLEET_APP_NAME} App (http://127.0.0.1:${port}/)…`);
    deps.openBrowser(`http://127.0.0.1:${port}/`);
    const code = await codePromise;
    const response = await deps.fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!response.ok) throw new Error(`GitHub refused the manifest code (HTTP ${response.status})`);
    const app = (await response.json()) as { id?: unknown; slug?: unknown; pem?: unknown };
    if (typeof app.id !== 'number' || typeof app.slug !== 'string' || typeof app.pem !== 'string' || !app.pem.includes('PRIVATE KEY')) {
      throw new Error('GitHub returned an unexpected App description');
    }
    await deps.custody.storeGithubApp({ appId: String(app.id), privateKeyPem: app.pem });
    return { appId: String(app.id), slug: app.slug, installUrl: `https://github.com/apps/${app.slug}/installations/new` };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

async function cmdGithubApp(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const org = one(parsed, '--org') ?? 'ashlrai';
  if (!parsed.flags.has('--yes') && !(await deps.confirm(`Create the ${FLEET_APP_NAME} GitHub App under ${org} (one browser page; the key goes straight into custody)?`))) {
    deps.out('Not created.');
    return 1;
  }
  const result = await runGithubAppFlow(deps, { org });
  deps.out(`Created ${result.slug} (App id ${result.appId}); its private key is in custody and was never written to disk.`);
  deps.out(`Install it on the enrolled repos: ${result.installUrl}`);
  deps.out(`It can post the host-verified ${ASHLR_VERIFY_CHECK} check (checks: write). An ${FLEET_APP_NAME} App created before 3.13 cannot: \`ashlr authority setup\` prints the exact settings link to raise it.`);
  return 0;
}

/** Where Mason installs the App (and picks its repos). */
export const FLEET_APP_INSTALL_URL = `https://github.com/apps/${FLEET_APP_NAME}/installations/new`;

/** Bounded wait: a probe that does not answer in time is "unknown", never a hang. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface AppInstallProbe {
  installed: string[];
  missing: string[];
  unknown: { repo: string; reason: string }[];
}

const APP_PROBE_TIMEOUT_MS = 20_000;

/**
 * Where the ashlr-fleet App is installed — read-only, in two passes:
 *
 *  1. per owner, `gh api orgs/<owner>/installations` with Mason's own gh auth
 *     (a GET; needs admin:org). An installation on "All repositories" settles
 *     every repo of that owner; no installation at all settles them as missing.
 *  2. what that cannot settle (a user account, "Only select repositories", a
 *     gh token without admin:org) is asked of the App itself: custody's
 *     gh-token looks the repo up AS the App (GET /repos/<r>/installation under
 *     the App's JWT), and a 404 there means "not installed". The one-hour token
 *     the helper mints on success stays in this process's memory, is never
 *     printed, and changes nothing on GitHub.
 */
export async function probeAppInstallation(deps: AuthorityCliDeps, repos: readonly string[]): Promise<AppInstallProbe> {
  const result: AppInstallProbe = { installed: [], missing: [], unknown: [] };
  const byOwner = new Map<string, string[]>();
  for (const repo of repos) {
    const owner = repo.split('/')[0]!;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), repo]);
  }
  const unsettled: string[] = [];
  for (const [owner, ownerRepos] of byOwner) {
    type Installation = { app_slug?: unknown; repository_selection?: unknown };
    let listed: Installation[] | null = null;
    try {
      const read = await ghJson(deps, ['api', `orgs/${owner}/installations?per_page=100`]) as { installations?: unknown } | null;
      if (read && Array.isArray(read.installations)) listed = read.installations as Installation[];
    } catch {
      listed = null;
    }
    const app = listed?.find((entry) => entry.app_slug === FLEET_APP_NAME);
    if (listed && !app) result.missing.push(...ownerRepos);
    else if (app?.repository_selection === 'all') result.installed.push(...ownerRepos);
    else unsettled.push(...ownerRepos);
  }
  // A few at a time: each lookup is two HTTPS calls inside the helper.
  const queue = [...unsettled];
  const worker = async (): Promise<void> => {
    for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
      try {
        await withTimeout(deps.custody.githubToken(repo), APP_PROBE_TIMEOUT_MS, 'ashlr-custody gh-token');
        result.installed.push(repo);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const message = (error as Error).message ?? String(error);
        if (code === 'github' && /not installed/u.test(message)) result.missing.push(repo);
        else result.unknown.push({ repo, reason: message.slice(0, 160) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  // Stable order for the checklist line, whatever order the lookups finished in.
  const order = new Map(repos.map((repo, i) => [repo, i]));
  const byInput = (a: string, b: string): number => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  result.installed.sort(byInput);
  result.missing.sort(byInput);
  result.unknown.sort((a, b) => byInput(a.repo, b.repo));
  return result;
}

/** "a, b and 3 more" — a list short enough for one checklist line. */
function shortList(items: readonly string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

// ---------------------------------------------------------------------------
// rotate-provenance
// ---------------------------------------------------------------------------

/** What a rotation leaves next to the key: which key it made, and when (no secret — a sha256 of 32 random bytes). */
interface ProvenanceRotationRecord {
  v: 1;
  rotatedAt: string;
  keySha256: string;
}

function provenanceRotationRecordPath(keyPath: string): string {
  return `${keyPath}.rotation.json`;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readRotationRecord(keyPath: string): ProvenanceRotationRecord | null {
  try {
    const raw = JSON.parse(readFileSync(provenanceRotationRecordPath(keyPath), 'utf8')) as Partial<ProvenanceRotationRecord>;
    if (raw.v !== 1 || typeof raw.rotatedAt !== 'string' || typeof raw.keySha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.keySha256)) return null;
    return { v: 1, rotatedAt: raw.rotatedAt, keySha256: raw.keySha256 };
  } catch {
    return null;
  }
}

/**
 * - `rotated`   — the key in place is the one a rotation created (setup must not rotate it again:
 *                 that would invalidate every pending proposal for nothing);
 * - `unrotated` — a key no rotation recorded: the one agents could read while confinement was off;
 * - `missing`   — no key yet (nothing burned; the first one is created fresh);
 * - `unhealthy` — the key's storage is refused (symlink, mode, length…).
 */
export type ProvenanceKeyState =
  | { state: 'rotated'; rotatedAt: string }
  | { state: 'unrotated' }
  | { state: 'missing' }
  | { state: 'unhealthy'; reason: string };

/** Read-only: never creates, repairs or moves the key. */
export async function provenanceKeyState(): Promise<ProvenanceKeyState> {
  const { provenanceKeyPath, loadExistingProvenanceKeyReadOnly } = await import('../core/foundry/provenance.js');
  let path: string;
  let key: Buffer | null;
  try {
    path = provenanceKeyPath();
    key = loadExistingProvenanceKeyReadOnly();
  } catch (error) {
    return { state: 'unhealthy', reason: (error as Error).message.replace(homedir(), '~') };
  }
  if (!key) return { state: 'missing' };
  const record = readRotationRecord(path);
  // The record names the exact key it made: a key swapped in afterwards is not "already rotated".
  if (record && record.keySha256 === sha256Hex(key)) return { state: 'rotated', rotatedAt: record.rotatedAt };
  return { state: 'unrotated' };
}

/**
 * Move the provenance HMAC key aside and create a new one. Every pending
 * provenance signature stops verifying (by design: agents could read the old
 * key while confinement was off), so pending proposals are re-verified.
 * Records which key it made (provenanceKeyState reads it) so setup can tell
 * a key it already rotated from the burned one.
 */
export async function rotateProvenanceKey(): Promise<{ retiredAs: string | null; rotatedAt: string }> {
  const { provenanceKeyPath, loadOrCreateKey, loadExistingProvenanceKeyReadOnly } = await import('../core/foundry/provenance.js');
  const path = provenanceKeyPath();
  let retiredAs: string | null = null;
  if (existsSync(path)) {
    retiredAs = `${path}.retired-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(path, retiredAs);
  }
  const created = loadOrCreateKey();
  // loadOrCreateKey falls back to a process-lifetime key when it cannot write
  // one; that is not a rotation — say so instead of recording it.
  const stored = loadExistingProvenanceKeyReadOnly();
  if (!stored || !stored.equals(created)) throw new Error('the new provenance key could not be stored in ~/.ashlr/foundry');
  const rotatedAt = new Date().toISOString();
  const record: ProvenanceRotationRecord = { v: 1, rotatedAt, keySha256: sha256Hex(stored) };
  const target = provenanceRotationRecordPath(path);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  return { retiredAs, rotatedAt };
}

async function cmdRotateProvenance(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  if (!parsed.flags.has('--yes') && !(await deps.confirm('Replace the provenance HMAC key? Pending proposals will need re-verification.'))) {
    deps.out('Not rotated.');
    return 1;
  }
  const result = await rotateProvenanceKey();
  deps.out(`Provenance key rotated.${result.retiredAs ? ` The old key was moved to ${result.retiredAs.replace(homedir(), '~')} — delete it once you are satisfied.` : ''}`);
  return 0;
}

// ---------------------------------------------------------------------------
// setup — the guided Phase-0 command (addendum §8)
// ---------------------------------------------------------------------------

/** PURE: trust-roots.ts with `root` added, or null when the file is not in its day-0 shape. */
export function renderTrustRootsWithKey(source: string, root: StandingGrantTrustRoot): string | null {
  const empty = /export const STANDING_GRANT_TRUST_ROOTS: readonly Readonly<StandingGrantTrustRoot>\[\] = Object\.freeze\(\[\]\);/u;
  if (!empty.test(source)) return null;
  const pem = root.publicKeyPem.trim().split('\n').map((line) => line.trim()).join('\\n');
  const literal = [
    'export const STANDING_GRANT_TRUST_ROOTS: readonly Readonly<StandingGrantTrustRoot>[] = Object.freeze([',
    '  Object.freeze({',
    `    keyId: '${root.keyId}',`,
    "    alg: 'ES256' as const,",
    `    publicKeyPem: '${pem}\\n',`,
    '  }),',
    ']);',
  ].join('\n');
  return source.replace(empty, literal);
}

/**
 * Validate a custody public key before it is proposed as a trust root. The id
 * must be the one DERIVED from the key (custody-client keyIdForPublicKeyPem)
 * — the verifier refuses any other root, so a mismatched PR would only darken
 * autonomy after Mason merged it.
 */
export function validateCustodyRoot(root: StandingGrantTrustRoot, keyIdFor: (pem: string) => string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(root.keyId)) return 'the key id is malformed';
  if (root.keyId === 'mason-workstation') return 'that key id is burned';
  try {
    const key = createPublicKey(root.publicKeyPem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return 'the key is not P-256';
  } catch {
    return 'the public key is not a PEM public key';
  }
  let derived: string;
  try {
    derived = keyIdFor(root.publicKeyPem);
  } catch {
    return 'the public key is not a PEM public key';
  }
  if (derived !== root.keyId) return `the key id does not match the key (expected ${derived})`;
  return null;
}

/** PURE: the canary repo's CI (addendum §7) — a test that can be turned red on purpose. */
export const CANARY_WORKFLOW = `name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: canary
        run: |
          if [ -f RED ]; then echo "canary is red on purpose"; exit 1; fi
          echo "canary green"
`;

type StepStatus = AuthoritySetupStepStatus;

/** What a setup step needs from Mason himself (a UI renders these as badges). */
export type SetupNeed = AuthoritySetupNeed;

const SETUP_STEP_NEEDS: Readonly<Record<string, readonly SetupNeed[]>> = Object.freeze({
  'custody-helper': ['sudo', 'terminal'],
  'host-binding': [],
  'signing-key': ['touch-id'],
  'trust-root': ['github'],
  deploy: ['terminal'],
  'github-app': ['browser', 'github'],
  'claude-token': ['terminal'],
  'canary-repo': ['github'],
  rulesets: ['github'],
  'old-activation-state': [],
  'provenance-key': [],
  'standing-grant': ['touch-id'],
  'autonomy-switch': [],
  'daemon-service': ['terminal'],
  'resident-runtime': ['terminal'],
});

/** The one command that walks every step and resumes where the last run stopped. */
export const AUTHORITY_SETUP_COMMAND = 'ashlr authority setup';

/** The only command that installs or restarts the resident service (you, at a terminal, under the grant). */
const RESIDENT_START_COMMAND = 'ashlr authority resident start';

/**
 * The command that moves each step on while it is not in place. Setup is
 * rerun-safe, so for everything it performs itself the answer is setup; the
 * rest is what only Mason runs (sudo, the build, the grant, resident start).
 * A row may name its own (the resident step names what its admission asks
 * for, or none when a prerequisite outside this Mac's commands is missing).
 */
const SETUP_STEP_COMMAND: Readonly<Record<string, string | null>> = Object.freeze({
  'custody-helper': 'sudo scripts/install-custody.sh',
  'host-binding': 'sudo scripts/install-custody.sh',
  'signing-key': AUTHORITY_SETUP_COMMAND,
  'trust-root': AUTHORITY_SETUP_COMMAND,
  deploy: 'npm run build',
  'github-app': AUTHORITY_SETUP_COMMAND,
  'claude-token': AUTHORITY_SETUP_COMMAND,
  'canary-repo': AUTHORITY_SETUP_COMMAND,
  rulesets: AUTHORITY_SETUP_COMMAND,
  'old-activation-state': AUTHORITY_SETUP_COMMAND,
  'provenance-key': AUTHORITY_SETUP_COMMAND,
  'standing-grant': 'ashlr authority grant',
  'autonomy-switch': 'ashlr authority switch autonomous',
  'daemon-service': RESIDENT_START_COMMAND,
  'resident-runtime': RESIDENT_START_COMMAND,
});

// Every exit before the grant is known to be active (the first unmet live
// prerequisite, or a dry run past one) reports the resident step with this:
// a resident service is admitted only under an active standing grant
// (docs/RESIDENT-RUNTIME.md), so without one it is genuinely blocked.
const RESIDENT_NEEDS_GRANT =
  'blocked until a grant is active (`ashlr authority grant`, Touch ID); then `ashlr authority resident start` in your own terminal installs the resident daemon under it';

type SetupRow = { step: string; status: StepStatus; detail: string; command?: string | null; link?: string | null };

function setupStepId(step: string): string {
  return step.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** PURE: the machine-readable form of a setup run. */
export function authoritySetupReport(report: readonly SetupRow[], dryRun: boolean): AuthoritySetupReportV1 {
  const count = (status: StepStatus): number => report.filter((r) => r.status === status).length;
  const steps = report.map((r) => {
    const id = setupStepId(r.step);
    // A step in place needs nothing; one that is not names what moves it on.
    const open = r.status !== 'done' && r.status !== 'already';
    return {
      id,
      step: r.step,
      status: r.status,
      detail: r.detail,
      needs: SETUP_STEP_NEEDS[id] ?? [],
      command: open ? (r.command !== undefined ? r.command : SETUP_STEP_COMMAND[id] ?? null) : null,
      link: open ? r.link ?? null : null,
    };
  });
  const open = steps.find((s) => s.status !== 'done' && s.status !== 'already');
  return {
    schema: 'ashlr.authority-setup.v1',
    dryRun,
    complete: open === undefined,
    summary: { done: count('done'), already: count('already'), waitingOnYou: count('waiting-on-you'), blocked: count('blocked'), failed: count('failed'), planned: count('skipped') },
    steps,
    next: open?.id ?? null,
  };
}

async function cmdSetup(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const dryRun = parsed.flags.has('--dry-run');
  const json = parsed.flags.has('--json');
  if (json && !dryRun) {
    // A real run asks questions and prints what gh / signing did; only the
    // read-only plan can promise a clean JSON document on stdout.
    deps.err('setup --json needs --dry-run');
    return 2;
  }
  const report = await runSetup(parsed, deps, { dryRun, yes: parsed.flags.has('--yes'), print: !json });
  return finish(report, deps, dryRun, json);
}

// ---------------------------------------------------------------------------
// The read-only checklist (Verse: GET /api/verse/authority/setup)
// ---------------------------------------------------------------------------

/** Per `gh api` GET in the read-only probe. */
const READ_ONLY_GH_TIMEOUT_MS = 10_000;
/** All `gh api` reads of one read-only probe together. */
const READ_ONLY_PROBE_BUDGET_MS = 30_000;
const GH_API_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._~/?=&%-]{0,400}$/u;

/**
 * The read-only probe's runner: `gh api <path>` — a GET, since no field,
 * method or input flag is ever passed — run asynchronously (the Verse server
 * must not block its event loop) and killed after READ_ONLY_GH_TIMEOUT_MS.
 * Anything else (git, `gh pr`, `gh repo create`, `--method`) is refused
 * without running, so a dry-run path that ever grew a write could not reach it.
 */
/** PURE: `gh api <path>` with nothing else — the only call the read-only probe runs. */
export function isReadOnlyGhApiCall(bin: 'gh' | 'git', args: readonly string[]): boolean {
  return bin === 'gh' && args.length === 2 && args[0] === 'api' && GH_API_PATH_RE.test(args[1] ?? '');
}

export function readOnlyGhRun(bin: 'gh' | 'git', args: readonly string[]): Promise<GhResult> {
  if (!isReadOnlyGhApiCall(bin, args)) {
    return Promise.resolve({ status: 1, stdout: '', stderr: 'refused: the read-only setup probe only runs `gh api <path>` reads' });
  }
  return new Promise((done) => {
    execFile('gh', ['api', args[1]!], {
      encoding: 'utf8',
      timeout: READ_ONLY_GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      done({
        status: error ? (typeof code === 'number' ? code : 1) : 0,
        stdout: stdout ?? '',
        stderr: stderr || (error ? error.message : ''),
      });
    });
  });
}

function refusedInProbe(what: string): never {
  throw new Error(`${what} is not available to the read-only setup probe`);
}

/**
 * `ashlr authority setup --dry-run --json` as a function: the same planning
 * path (cmdSetup's steps with --dry-run), with dependencies that cannot ask,
 * prompt, open a browser, reach the network directly or run anything but a
 * bounded `gh api` GET. Custody is only asked read-only questions (status,
 * host binding, public key, and whether the App can see a repo).
 */
export async function planAuthoritySetup(injected?: Partial<AuthorityCliDeps>): Promise<AuthoritySetupReportV1> {
  // The whole probe gets READ_ONLY_PROBE_BUDGET_MS of gh time: past it, a read
  // is answered "not read" at once (the step then says what it could not
  // check) instead of queueing more ten-second waits behind a slow network.
  const deadline = Date.now() + READ_ONLY_PROBE_BUDGET_MS;
  const budgeted = (bin: 'gh' | 'git', args: readonly string[]): Promise<GhResult> => (Date.now() > deadline
    ? Promise.resolve({ status: 1, stdout: '', stderr: 'not read: the setup probe ran out of time' })
    : readOnlyGhRun(bin, args));
  const deps: AuthorityCliDeps = {
    out: () => undefined,
    err: () => undefined,
    confirm: async () => false,
    readSecret: async () => refusedInProbe('a secret prompt'),
    run: budgeted,
    openBrowser: () => refusedInProbe('a browser'),
    fetch: (async () => refusedInProbe('the network')) as unknown as typeof fetch,
    custody: injected?.custody ?? await import('../core/authority/custody-client.js'),
    daemonService: () => realDaemonService(true),
    // The resident step only reads (admission verdict, service + plist
    // observation); the effects are refused here, never reached by setup.
    resident: {
      admission: realResidentDeps.admission,
      observe: realResidentDeps.observe,
      operatorRefusal: async () => 'the read-only setup probe is not the operator at a terminal',
      start: async () => refusedInProbe('resident start'),
      stop: async () => refusedInProbe('resident stop'),
    },
    ...(injected ?? {}),
  };
  const parsed: Parsed = { positional: ['setup'], flags: new Set(['--dry-run', '--json']), values: new Map() };
  return authoritySetupReport(await runSetup(parsed, deps, { dryRun: true, yes: false, print: false }), true);
}

interface SetupRunOptions {
  dryRun: boolean;
  yes: boolean;
  /** Print each step as it is noted (the human form); false for JSON and the Verse probe. */
  print: boolean;
}

/**
 * Every step of setup, in order. RERUN-SAFE: Mason runs it several times, so
 * each step first checks whether it is already in place and says so
 * ('already') instead of doing it again — the provenance key is rotated once,
 * a ruleset GitHub already holds is not PUT again, the App counts only when it
 * is installed, an open trust-root PR is found rather than reopened. A step
 * that throws is recorded as failed and the run still ends with its summary.
 */
async function runSetup(parsed: Parsed, deps: AuthorityCliDeps, opts: SetupRunOptions): Promise<SetupRow[]> {
  const { dryRun, yes } = opts;
  const report: SetupRow[] = [];
  const note = (step: string, status: StepStatus, detail: string, extra: { command?: string | null; link?: string | null } = {}): void => {
    report.push({ step, status, detail, ...extra });
    if (!opts.print) return;
    // 'skipped' gets its own glyph: a ✓ on a step a dry run did not perform read as done.
    const glyph = status === 'failed' ? '✗' : status === 'blocked' ? '×' : status === 'waiting-on-you' ? '…' : status === 'skipped' ? '·' : '✓';
    deps.out(`${glyph} ${step}: ${detail}`);
  };
  const done = (): SetupRow[] => {
    // Every exit, including the first unmet live prerequisite, reports the
    // resident step exactly once — it is never silently complete.
    if (!report.some((row) => row.step === 'resident runtime')) {
      note('resident runtime', 'blocked', RESIDENT_NEEDS_GRANT, { command: 'ashlr authority grant' });
    }
    return report;
  };
  const ask = async (question: string): Promise<boolean> => !dryRun && (yes || deps.confirm(question));
  const failure = (error: unknown): string => ((error as Error)?.message ?? String(error)).replace(homedir(), '~').slice(0, 300);
  // --dry-run PLANS: the CHANGELOG and docs/AUTHORITY.md promise it "prints
  // every step first" (3.10 review c20). A real run must stop at an unmet
  // prerequisite; a dry run notes it and keeps describing the remaining
  // steps. Once past an unmet prerequisite (`planning`), later steps are only
  // described — no custody calls, no gh calls, no config reads — because
  // nothing they would check can be true yet.
  let planning = false;
  const stopHere = (): boolean => {
    if (!dryRun) return true;
    planning = true;
    return false;
  };
  // Which step is running: an exception nobody anticipated becomes its
  // failure (with the summary still printed), never a bare abort.
  let current = 'custody helper';

  try {
    // 1. Custody helper (installing it needs sudo — Mason runs that himself).
    let custody: Awaited<ReturnType<typeof deps.custody.custodyStatus>> | null = null;
    try {
      custody = await deps.custody.custodyStatus();
    } catch (error) {
      note('custody helper', 'failed', `status unavailable (${failure(error)})`);
    }
    if (!custody || !custody.installed) {
      note('custody helper', 'waiting-on-you', 'run `sudo scripts/install-custody.sh` from the ashlr-hub checkout, then run setup again');
      if (stopHere()) return done();
    } else {
      note('custody helper', 'already', `installed${custody.version ? ` (${custody.version})` : ''}`);
    }

    // 1b. The helper and this CLI must agree on which Mac this is: the helper
    // derives StandingGrantV1.hostBinding as sha256(uppercase IOPlatformUUID)
    // and so does surface.ts. A disagreement would make every grant fail
    // "signed for a different Mac" only AFTER Mason's Touch ID — catch it first.
    current = 'host binding';
    if (planning) {
      note('host binding', 'skipped', 'would check that ashlr-custody and this release agree on which Mac this is');
    } else {
      try {
        const { currentHostBinding } = await import('../core/authority/surface.js');
        const ours = currentHostBinding();
        const helpers = await deps.custody.custodyHostBinding();
        if (ours === null) note('host binding', 'failed', "this Mac's IOPlatformUUID could not be read, so no grant can be bound to it");
        else if (ours !== helpers) note('host binding', 'failed', 'ashlr-custody and this release disagree on the host binding — reinstall the helper from this checkout');
        else note('host binding', 'already', `this Mac is ${ours.slice(0, 12)}…`);
      } catch (error) {
        note('host binding', 'failed', `could not compare with ashlr-custody (${failure(error)})`);
      }
    }
    if (report.some((r) => r.step === 'host binding' && r.status === 'failed') && stopHere()) return done();

    // 2. Secure Enclave key (Touch ID). The helper is not on PATH, so every
    // message names it by its installed path.
    current = 'signing key';
    let keyId = custody?.keyId ?? null;
    let publicKeyPem: string | null = null;
    if (planning || !custody) {
      note('signing key', 'skipped', 'would create the Secure Enclave signing key (Touch ID) unless it already exists');
    } else if (!custody.keyInitialized) {
      if (!(await ask('Create the Secure Enclave signing key now (Touch ID)?'))) {
        note('signing key', dryRun ? 'skipped' : 'waiting-on-you', dryRun
          ? `would create it (Touch ID) — or run \`${CUSTODY_HELPER_PATH} init\``
          : `create it with \`${CUSTODY_HELPER_PATH} init\` or rerun setup`);
        if (stopHere()) return done();
      } else {
        try {
          const info = await deps.custody.custodyInit();
          keyId = info.keyId;
          publicKeyPem = info.publicKeyPem;
          note('signing key', 'done', `created ${info.keyId}`);
        } catch (error) {
          note('signing key', 'failed', `not created (${failure(error)}) — rerun setup, or run \`${CUSTODY_HELPER_PATH} init\``);
          if (stopHere()) return done();
        }
      }
    } else {
      note('signing key', 'already', `key ${keyId ?? '(id unknown)'}`);
    }

    // 3. Trust root compiled in (Mason's own PR).
    current = 'trust root';
    const { STANDING_GRANT_TRUST_ROOTS } = await import('../core/authority/trust-roots.js');
    // A key made on an earlier run whose id status did not report: read its
    // public half back (`ashlr-custody pubkey`, no Touch ID) instead of asking
    // Mason to copy it by hand.
    const isTrusted = (id: string | null): boolean => id !== null && STANDING_GRANT_TRUST_ROOTS.some((root) => root.keyId === id);
    // No kickstart here: a daemon that is disabled or not loaded (the usual
    // state before the first grant) has nothing to kickstart, and the last step
    // (daemon service) says how to start it once the grant is in force.
    const DEPLOY_DETAIL = 'after you merge that PR: `npm run build`, install the release as you normally do (docs/RELEASING-LOCALLY.md), then rerun setup (restart a running daemon with `launchctl kickstart -k gui/$(id -u)/ai.ashlr.daemon`)';
    if (planning) {
      note('trust root', 'skipped', 'would check that your signing key is compiled into this release, and if not open a PR adding it to trust-roots.ts for you to review and merge');
      note('deploy', 'skipped', `would wait for you: ${DEPLOY_DETAIL}`);
    } else {
      let trustRootFailed = false;
      if (!isTrusted(keyId) && !publicKeyPem) {
        try {
          const info = await deps.custody.custodyPublicKey();
          keyId = info.keyId;
          publicKeyPem = info.publicKeyPem;
        } catch (error) {
          note('trust root', 'failed', `could not read the custody public key (${failure(error)})`);
          trustRootFailed = true;
        }
      }
      if (trustRootFailed) {
        if (stopHere()) return done();
      } else if (isTrusted(keyId)) {
        note('trust root', 'already', `${keyId} is compiled into this release`);
        note('deploy', 'already', 'this release carries your trust root');
      } else {
        const root: StandingGrantTrustRoot = { keyId: keyId!, alg: 'ES256', publicKeyPem: publicKeyPem! };
        const invalid = validateCustodyRoot(root, deps.custody.keyIdForPublicKeyPem);
        if (invalid) {
          note('trust root', 'failed', invalid);
        } else {
          let pr: TrustRootPrResult;
          try {
            // A dry run looks too, through `gh api` reads only (the
            // Verse checklist is this path): an open PR, a merged key or a
            // pushed branch is reported instead of "add this root yourself".
            pr = (dryRun ? await probeTrustRootReadOnly(deps, root) : null) ?? await openTrustRootPr(parsed, deps, root, ask, !dryRun);
          } catch (error) {
            pr = { status: 'failed', detail: failure(error) };
          }
          note('trust root', pr.status, pr.detail, {
            ...(pr.link ? { link: pr.link } : {}),
            ...(pr.command !== undefined ? { command: pr.command } : {}),
          });
          note('deploy', 'waiting-on-you', DEPLOY_DETAIL);
        }
        if (stopHere()) return done();
      }
    }

    // The canary's existence decides whether the App and ruleset checks
    // include it yet (setup creates it at step 6). One read-only GET.
    const canaryRepo = 'ashlrai/fleet-canary';
    let canaryExists = planning ? false : (await deps.run('gh', ['api', `repos/${canaryRepo}`])).status === 0;

    // 4. GitHub App: its key in custody is half of it — it also has to be
    // INSTALLED on the repos the fleet works in, or every mint fails.
    current = 'GitHub App';
    if (!custody?.githubApp) {
      if (await ask(`Create the ${FLEET_APP_NAME} GitHub App now (one browser page)?`)) {
        try {
          const app = await runGithubAppFlow(deps, { org: one(parsed, '--org') ?? 'ashlrai' });
          // A new App is installed nowhere yet.
          note('GitHub App', 'waiting-on-you', `created ${app.slug} (its key is in custody); now install it on the enrolled repos: ${app.installUrl} — then rerun setup`, { link: app.installUrl });
        } catch (error) {
          note('GitHub App', 'failed', `not created (${failure(error)}) — rerun setup, or run \`ashlr authority github-app\``);
        }
      } else note('GitHub App', dryRun ? 'skipped' : 'waiting-on-you', 'run `ashlr authority github-app`');
    } else if (planning) {
      note('GitHub App', 'skipped', `the ${FLEET_APP_NAME} key is in custody; would check the App is installed on the enrolled repos`);
    } else {
      const targets = (await setupTargetRepos()).map((repo) => repo.nameWithOwner)
        .filter((repo) => canaryExists || repo.toLowerCase() !== canaryRepo);
      const probe = await probeAppInstallation(deps, targets);
      const later = canaryExists ? '' : ` (${canaryRepo} needs it too once it exists)`;
      if (probe.missing.length > 0) {
        note('GitHub App', 'waiting-on-you', `the ${FLEET_APP_NAME} key is in custody, but the App is not installed on ${shortList(probe.missing)} — install it: ${FLEET_APP_INSTALL_URL}, then rerun setup${later}`, { link: FLEET_APP_INSTALL_URL });
      } else if (probe.unknown.length > 0) {
        note('GitHub App', 'waiting-on-you', `the ${FLEET_APP_NAME} key is in custody, but its installation on ${shortList(probe.unknown.map((u) => u.repo))} could not be confirmed (${probe.unknown[0]!.reason}) — check ${FLEET_APP_INSTALL_URL}, then rerun setup`, { link: FLEET_APP_INSTALL_URL });
      } else {
        const where = probe.installed.length === 0 ? 'no enrolled repo needs it yet' : probe.installed.length === 1 ? `installed on ${probe.installed[0]}` : `installed on all ${probe.installed.length} enrolled repos`;
        // 3.13: it must also be able to post ashlr/verify (checks: write); an
        // App created before 3.13 has checks: read and must be raised by hand.
        const app = await readFleetApp(deps);
        if (app && app.checks !== 'write') {
          const urls = fleetAppPermissionUrls(app);
          note('GitHub App', 'waiting-on-you', `the ${FLEET_APP_NAME} key is in custody and the App is ${where}, but it cannot post the ${ASHLR_VERIFY_CHECK} check (Checks: ${app.checks ?? 'no access'}): `
            + `set "Checks: Read and write" at ${urls.permissions}, accept the new permission on each installation at ${urls.installations}, then rerun setup`, { link: urls.permissions });
        } else {
          note('GitHub App', 'already', app
            ? `the ${FLEET_APP_NAME} key is in custody; ${where}${later}; the App can post ${ASHLR_VERIFY_CHECK} (checks: write)`
            : `the ${FLEET_APP_NAME} key is in custody; ${where}${later} (its checks permission was not read; it needs "Checks: Read and write" for ${ASHLR_VERIFY_CHECK})`);
        }
      }
    }

    // 5. Claude token for restricted judge / Leader calls.
    current = 'Claude token';
    if (custody?.claudeToken) note('Claude token', 'already', 'stored in custody');
    else if (await ask('Store a Claude token now (run `claude setup-token` in another terminal and paste it)?')) {
      try {
        const token = (await deps.readSecret('Paste the token (hidden): ')).trim();
        if (!token) note('Claude token', 'failed', 'nothing was pasted');
        else {
          await deps.custody.storeClaudeToken(token);
          note('Claude token', 'done', 'stored in custody (never written to disk here)');
        }
      } catch (error) {
        note('Claude token', 'failed', `not stored (${failure(error)}) — run \`claude setup-token\`, then rerun setup`);
      }
    } else note('Claude token', dryRun ? 'skipped' : 'waiting-on-you', 'run `claude setup-token`, then rerun setup');

    // 6. Canary repo (the App cannot write workflows, so this uses your own gh
    // auth). Before the rulesets: the grant's server-enforced repos include the
    // canary, and a ruleset cannot be applied to a repo that does not exist yet.
    current = 'canary repo';
    if (canaryExists) note('canary repo', 'already', `${canaryRepo} exists`);
    else if (await ask(`Create the public repo ${canaryRepo} with its CI workflow (your gh auth)?`)) {
      const created = await deps.run('gh', ['repo', 'create', canaryRepo, '--public', '--add-readme', '--description', 'ashlr fleet canary (revert drills)']);
      const workflow = created.status === 0
        ? await deps.run('gh', ['api', '--method', 'PUT', `repos/${canaryRepo}/contents/.github/workflows/ci.yml`, '--input', '-'], {
            input: JSON.stringify({ message: 'ci: canary workflow', content: Buffer.from(CANARY_WORKFLOW, 'utf8').toString('base64') }),
          })
        : null;
      canaryExists = created.status === 0;
      note('canary repo', created.status === 0 && workflow?.status === 0 ? 'done' : 'failed', created.status === 0 ? (workflow?.status === 0 ? 'created with its CI workflow' : 'created, but the workflow push failed') : created.stderr.trim().slice(0, 200));
    } else note('canary repo', dryRun ? 'skipped' : 'waiting-on-you', `create ${canaryRepo} with a CI workflow`);

    // 7. Rulesets — only where GitHub does not already hold exactly this one.
    current = 'rulesets';
    if (planning) {
      note('rulesets', 'skipped', 'would check the fleet ruleset on the server-enforced repos and apply it where it is missing or different');
    } else {
      const targets = (await setupTargetRepos()).filter((repo) => canaryExists || repo.nameWithOwner.toLowerCase() !== canaryRepo);
      const plans = await protectPlans(parsed, deps, targets);
      const stale = plans.filter((plan) => !plan.skipped && !plan.upToDate);
      const inPlace = plans.filter((plan) => !plan.skipped && plan.upToDate).length;
      const unreadable = plans.filter((plan) => plan.skipped?.startsWith('could not read')).map((plan) => plan.repo);
      const byHand = plans.filter((plan) => plan.skipped && !plan.skipped.startsWith('could not read')).length;
      const unread = unreadable.length > 0 ? `; could not read ${shortList(unreadable)} from GitHub` : '';
      const left = byHand > 0 ? `; ${byHand} left to you (local enforcement or no CI)` : '';
      if (plans.length === 0) {
        // Nothing to look at yet — never "in place on 0 repos".
        if (canaryExists) note('rulesets', 'already', 'no server-enforced repo needs one');
        else note('rulesets', dryRun ? 'skipped' : 'waiting-on-you', `${canaryRepo} gets the fleet ruleset once it exists`);
      } else if (stale.length > 0) {
        const where = shortList(stale.map((plan) => plan.repo));
        if (await ask(`Apply the fleet ruleset to ${stale.length} repo(s) where it is missing or different (${where})?`)) {
          const failures = await applyProtectPlans(stale, deps);
          note('rulesets', failures > 0 ? 'failed' : unreadable.length > 0 ? 'waiting-on-you' : 'done', failures === 0
            ? `applied to ${where}${inPlace > 0 ? `; ${inPlace} already in place` : ''}${unread}${left}`
            : `${failures} of ${stale.length} failed (see above)${unread}`);
        } else {
          note('rulesets', dryRun ? 'skipped' : 'waiting-on-you', `${stale.length} repo(s) need the fleet ruleset (${where})${unread} — run \`ashlr authority protect --print\`, then \`--apply\``);
        }
      } else if (unreadable.length > 0) {
        note('rulesets', 'waiting-on-you', `could not read ${shortList(unreadable)} from GitHub — check \`gh auth status\`, then rerun setup${inPlace > 0 ? ` (${inPlace} already in place)` : ''}`);
      } else {
        note('rulesets', 'already', `the fleet ruleset is in place on ${inPlace === 1 ? '1 repo' : `${inPlace} repos`}${left}`);
      }
    }

    // 8. Retire the burned activation directory.
    current = 'old activation state';
    const activation = join(homedir(), '.ashlr', 'activation');
    if (!existsSync(activation)) note('old activation state', 'already', 'nothing to retire');
    else if (await ask('Move ~/.ashlr/activation (the burned key) out of ~/.ashlr so no code path can reach it?')) {
      try {
        const target = join(homedir(), `ashlr-activation-retired-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        renameSync(activation, target);
        note('old activation state', 'done', `moved to ${target.replace(homedir(), '~')} — move it offline, then delete it`);
      } catch (error) {
        note('old activation state', 'failed', `not moved (${failure(error)})`);
      }
    } else note('old activation state', dryRun ? 'skipped' : 'waiting-on-you', 'archive ~/.ashlr/activation offline, then delete it');

    // 9. Provenance key — rotated ONCE. The burned key is whichever one no
    // rotation recorded; a key a rotation made (and recorded) is left alone,
    // because rotating again would invalidate every pending proposal for nothing.
    current = 'provenance key';
    const provenance = await provenanceKeyState();
    if (provenance.state === 'rotated') {
      note('provenance key', 'already', `rotated ${provenance.rotatedAt.slice(0, 10)}; not rotated again, so pending proposals keep verifying`);
    } else if (await ask(provenance.state === 'missing'
      ? 'Create the provenance HMAC key now?'
      : 'Rotate the provenance HMAC key (agents could read the old one)?')) {
      try {
        const rotated = await rotateProvenanceKey();
        note('provenance key', 'done', rotated.retiredAs ? 'rotated; the old key was moved aside' : 'created');
      } catch (error) {
        note('provenance key', 'failed', `not rotated (${failure(error)})`);
      }
    } else {
      const why = provenance.state === 'unhealthy' ? `the current key is unusable (${provenance.reason}); ` : '';
      note('provenance key', dryRun ? 'skipped' : 'waiting-on-you', `${why}run \`ashlr authority rotate-provenance\``);
    }

    // 10. First grant (Touch ID), 11. the switch, 12. the daemon service,
    // 13. resident admission (docs/RESIDENT-RUNTIME.md). Setup itself never
    // touches launchd: it names the one command that does.
    const DAEMON_DETAIL = 'would check that the ai.ashlr.daemon service is loaded and running (each tick re-verifies the grant)';
    if (planning) {
      note('standing grant', 'skipped', 'would sign the first standing grant (Touch ID)');
      note('autonomy switch', 'skipped', 'would offer to set the autonomy switch to Autonomous (the ladder starts in shadow)');
      note('daemon service', 'skipped', DAEMON_DETAIL);
      return done();
    }
    current = 'standing grant';
    const { evaluateStandingAuthority, displaySurfaceTarget } = await import('../core/authority/effective-config.js');
    const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
    let grantActive = evaluation.grantState === 'active';
    if (grantActive) {
      note('standing grant', 'already', `grant #${evaluation.grant?.grantSeq ?? '?'} is active`);
    } else if (await ask('Sign the first standing grant now (Touch ID)?')) {
      try {
        const { buildStandingGrantDraft } = await import('../core/verse/authority-api.js');
        const draft = await buildStandingGrantDraft('auto');
        for (const line of draft.summary) deps.out(`    ${line}`);
        const signed = await signAndInstall(draft.payload, deps);
        grantActive = signed.ok;
        note('standing grant', signed.ok ? 'done' : 'failed', signed.ok ? `grant #${signed.grant.grantSeq} installed, starting at ${signed.grant.rollout.stages[0]!.id}` : signed.reason);
      } catch (error) {
        note('standing grant', 'failed', `no grant was drafted (${failure(error)}) — rerun setup, or run \`ashlr authority grant\``);
      }
    } else note('standing grant', dryRun ? 'skipped' : 'waiting-on-you', 'run `ashlr authority grant`');

    // Resumable: a grant signed on an earlier run (or with `authority grant`)
    // still gets the switch offered — it used to be offered only in the run
    // that signed. Raising stays capped by the grant (requestAutonomySwitch).
    current = 'autonomy switch';
    if (!grantActive) {
      note('autonomy switch', dryRun ? 'skipped' : 'waiting-on-you', 'needs an active standing grant first');
    } else if (evaluation.switch === 'autonomous') {
      note('autonomy switch', 'already', 'Autonomous');
    } else if (await ask('Set the autonomy switch to Autonomous (the ladder starts in shadow)?')) {
      const { requestAutonomySwitch } = await import('../core/authority/effective-config.js');
      const switched = requestAutonomySwitch('autonomous', 'mason', 'ashlr authority setup');
      note('autonomy switch', switched.ok ? 'done' : 'failed', switched.ok ? 'Autonomous' : switched.reason);
    } else note('autonomy switch', dryRun ? 'skipped' : 'waiting-on-you', `it is ${evaluation.switch} — run \`ashlr authority switch autonomous\``);

    // 12. Read-only service observation. Only `resident start` (Mason, in his
    // own terminal, under the active grant) installs or restarts the service.
    current = 'daemon service';
    let service: DaemonServiceState;
    try {
      service = await deps.daemonService();
    } catch {
      service = 'unknown';
    }
    const START = `\`${RESIDENT_START_COMMAND}\``;
    const after = grantActive ? `run ${START}` : `after the standing grant, run ${START}`;
    // Before the grant, the command that moves this step on is the grant.
    const serviceCommand = grantActive ? {} : { command: 'ashlr authority grant' };
    if (service === 'running') note('daemon service', 'already', 'ai.ashlr.daemon is running (each tick re-verifies the grant)');
    else if (service === 'absent') note('daemon service', 'waiting-on-you', `no ai.ashlr.daemon service is installed — ${after} to install it`, serviceCommand);
    else if (service === 'loaded') note('daemon service', 'waiting-on-you', `ai.ashlr.daemon is loaded but stopped — ${after} to restart it`, serviceCommand);
    else if (service === 'not-loaded') note('daemon service', 'waiting-on-you', `ai.ashlr.daemon is not loaded — ${after} to load it`, serviceCommand);
    else note('daemon service', 'waiting-on-you', `ai.ashlr.daemon state is unknown — \`ashlr authority resident status\` shows why; ${after} to repair it`, serviceCommand);

    // 13. Resident admission: the grant, this release and the service together.
    current = 'resident runtime';
    if (!grantActive) {
      note('resident runtime', 'blocked', RESIDENT_NEEDS_GRANT, { command: 'ashlr authority grant' });
    } else {
      const resident = await residentSetupRow(deps, service);
      note('resident runtime', resident.status, resident.detail, { command: resident.command });
    }
  } catch (error) {
    // Nothing above is expected to throw; if something does, it is this
    // step's failure and the run still ends with the summary.
    note(report.some((row) => row.step === current) ? 'setup' : current, 'failed', `stopped: ${failure(error)}`);
  }
  return done();
}

/**
 * Setup's resident step (docs/RESIDENT-RUNTIME.md §d):
 *   already        admitted AND ai.ashlr.daemon running AND its plist is what
 *                  `resident start` would write from config now;
 *   waiting-on-you the exact command that gets there (start / clear-stop / switch);
 *   blocked        a prerequisite is missing (no active grant, not a compiled
 *                  release, dirty build, no confinement, not macOS).
 * Read-only: never mints, never touches launchd.
 */
async function residentSetupRow(deps: AuthorityCliDeps, service: DaemonServiceState): Promise<{ status: StepStatus; detail: string; command?: string | null }> {
  let admission: ResidentAdmission;
  try {
    admission = await deps.resident.admission();
  } catch (error) {
    return { status: 'failed', detail: `resident admission could not be evaluated (${(error as Error).message})` };
  }
  if (!admission.ok) {
    const fix = admission.command ? ` — run \`${admission.command}\`` : '';
    // The checklist's command is exactly what the admission asks for (none when it names none).
    return { status: admission.status === 'waiting-on-you' ? 'waiting-on-you' : 'blocked', detail: `${admission.reason}${fix}`, command: admission.command ?? null };
  }
  let observed: ResidentServiceObservation;
  try {
    observed = await deps.resident.observe();
  } catch (error) {
    return { status: 'failed', detail: `the resident service could not be observed (${(error as Error).message})` };
  }
  if (observed.problem) return { status: 'blocked', detail: observed.problem, command: null };
  const start = '`ashlr authority resident start`';
  if (service !== 'running') {
    return { status: 'waiting-on-you', detail: `admitted under grant #${admission.grantSeq ?? '?'} but the resident daemon is not running — run ${start} in your own terminal` };
  }
  if (observed.plist === 'drifted') {
    const budget = observed.installedBudgetUsd !== observed.expectedBudgetUsd
      ? ` (installed budget $${observed.installedBudgetUsd ?? '?'}/day, config says $${observed.expectedBudgetUsd ?? '?'}/day)`
      : '';
    return { status: 'waiting-on-you', detail: `the running service's plist differs from config${budget} — run ${start} to regenerate and restart it` };
  }
  if (observed.plist !== 'current') {
    return { status: 'waiting-on-you', detail: `the running service's plist could not be matched (${observed.plist}) — run ${start} to regenerate it` };
  }
  return { status: 'already', detail: `the resident daemon is running under grant #${admission.grantSeq ?? '?'} (until ${admission.expiresAt ?? '?'}), from clean release ${admission.revision?.slice(0, 12) ?? '?'}` };
}

// ---------------------------------------------------------------------------
// resident start | stop | status
// ---------------------------------------------------------------------------

function describeAdmission(admission: ResidentAdmission): string {
  if (admission.ok) return `admitted — ${admission.reason}`;
  return `${admission.status} — ${admission.reason}${admission.command ? ` (run \`${admission.command}\`)` : ''}`;
}

async function cmdResident(sub: string | undefined, parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  switch (sub) {
    case 'status':
      return cmdResidentStatus(parsed, deps);
    case 'start':
      return cmdResidentStart(parsed, deps);
    case 'stop':
      return cmdResidentStop(deps);
    default:
      deps.err('Usage: ashlr authority resident <start|stop|status [--json]>');
      return 2;
  }
}

async function cmdResidentStatus(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  const admission = await deps.resident.admission();
  const observed = await deps.resident.observe();
  if (parsed.flags.has('--json')) {
    deps.out(JSON.stringify({ schema: 'ashlr.resident-status.v1', admission, service: observed }, null, 2));
    return 0;
  }
  deps.out(`Resident admission: ${describeAdmission(admission)}`);
  deps.out(`Service: ai.ashlr.daemon ${observed.state}${observed.plistPath ? ` (${observed.plistPath.replace(homedir(), '~')})` : ''}`);
  const budget = `installed $${observed.installedBudgetUsd ?? '—'}/day, config $${observed.expectedBudgetUsd ?? '?'}/day`;
  deps.out(`Plist: ${observed.plist}${observed.plist === 'drifted' ? ' — `ashlr authority resident start` regenerates it' : ''} (budget: ${budget})`);
  if (observed.problem) deps.out(`  ${observed.problem}`);
  return 0;
}

/**
 * `resident start` — the only command that installs or restarts the resident
 * service. Order: refuse a non-operator context; show the verdict; stop if
 * not admitted; no-op when already running from the current plist; show
 * exactly what will happen and ask (no --yes: the operator confirms here);
 * then the real start, which re-verifies everything itself (mint).
 */
async function cmdResidentStart(parsed: Parsed, deps: AuthorityCliDeps): Promise<number> {
  if (parsed.flags.has('--yes')) {
    deps.err('resident start takes no --yes: confirm it yourself at the prompt.');
    return 2;
  }
  const refusal = await deps.resident.operatorRefusal();
  if (refusal) {
    deps.err(`resident start refused: ${refusal}`);
    return 1;
  }
  const admission = await deps.resident.admission();
  if (!admission.ok) {
    deps.err(`resident start refused: ${describeAdmission(admission)}`);
    return 1;
  }
  const observed = await deps.resident.observe();
  if (observed.problem) {
    deps.err(`resident start refused: ${observed.problem}`);
    return 1;
  }
  if (observed.state === 'running' && observed.plist === 'current') {
    deps.out(`ai.ashlr.daemon is already running under grant #${admission.grantSeq ?? '?'} from the current plist; nothing to do.`);
    return 0;
  }
  const action = observed.state === 'running' ? 'regenerate the plist from config and restart' : observed.plist === 'absent' ? 'install and start' : 'regenerate, load and start';
  deps.out(`Resident daemon under grant #${admission.grantSeq ?? '?'} (expires ${admission.expiresAt ?? '?'}):`);
  deps.out(`  release   ${admission.revision ?? '?'} (${admission.packageRoot?.replace(homedir(), '~') ?? '?'})`);
  deps.out(`  service   ai.ashlr.daemon → ${observed.plistPath?.replace(homedir(), '~') ?? '?'} (${observed.state}, plist ${observed.plist})`);
  deps.out(`  budget    $${observed.expectedBudgetUsd ?? '?'}/day from config daemon.dailyBudgetUsd${observed.installedBudgetUsd !== null && observed.installedBudgetUsd !== observed.expectedBudgetUsd ? ` (installed: $${observed.installedBudgetUsd})` : ''}`);
  deps.out('  launchd   enable + bootstrap (RunAtLoad); every tick re-verifies the grant, Stop and the switch');
  if (!(await deps.confirm(`${action[0]!.toUpperCase()}${action.slice(1)} ai.ashlr.daemon now?`))) {
    deps.out('Nothing was changed.');
    return 1;
  }
  const result = await deps.resident.start();
  if (!result.ok) {
    deps.err(`resident start failed: ${result.reason}`);
    return 1;
  }
  deps.out(`✓ ${result.detail}`);
  deps.out('Stop anytime: `ashlr authority stop` halts agents (the service stays up, idle); `ashlr authority resident stop` removes the service.');
  return 0;
}

/** Lowering: never asks, never needs the grant. */
async function cmdResidentStop(deps: AuthorityCliDeps): Promise<number> {
  const result = await deps.resident.stop();
  if (!result.ok) {
    deps.err(`resident stop failed: ${result.reason}`);
    return 1;
  }
  deps.out(`${result.detail}. Stop (~/.ashlr/KILL) and the grant are unchanged.`);
  return 0;
}


function finish(report: readonly SetupRow[], deps: AuthorityCliDeps, dryRun = false, json = false): number {
  const result = authoritySetupReport(report, dryRun);
  const { summary } = result;
  if (json) {
    deps.out(JSON.stringify(result, null, 2));
  } else {
    const planned = dryRun ? `, ${summary.planned} planned (dry run: nothing was asked or changed)` : '';
    deps.out(`\nSetup: ${summary.done} done, ${summary.already} already in place, ${summary.waitingOnYou} waiting on you, ${summary.blocked} blocked on a prerequisite, ${summary.failed} failed${planned}.`);
  }
  return summary.failed > 0 ? 1 : 0;
}

type TrustRootPrResult = { status: StepStatus; detail: string; link?: string; command?: string | null };

const HUB_REPO = 'ashlrai/ashlr-hub';

/**
 * The dry run's look at the trust-root PR, through `gh api <path>` GETs only
 * (each passes isReadOnlyGhApiCall, so the Verse probe can run it): the PR an
 * earlier run opened, the key already merged on the default branch, or a
 * branch an earlier run pushed without a PR. Same order as the live run's
 * probes. null = none of these (or GitHub could not be read): the step then
 * reads as it always has.
 */
async function probeTrustRootReadOnly(deps: AuthorityCliDeps, root: StandingGrantTrustRoot): Promise<TrustRootPrResult | null> {
  const branch = `authority/trust-root-${root.keyId}`;
  const read = async (path: string): Promise<unknown> => {
    const result = await deps.run('gh', ['api', path]);
    if (result.status !== 0) return null;
    try {
      return JSON.parse(result.stdout || 'null') as unknown;
    } catch {
      return null;
    }
  };
  const open = await read(`repos/${HUB_REPO}/pulls?head=${HUB_REPO.split('/')[0]}%3A${encodeURIComponent(branch)}&state=open&per_page=1`);
  const url = Array.isArray(open) ? (open[0] as { html_url?: unknown } | undefined)?.html_url : undefined;
  if (typeof url === 'string' && /^https:\/\/github\.com\/[^\s]+\/pull\/\d+$/u.test(url)) {
    return { status: 'waiting-on-you', detail: `${url} is already open — review and merge it yourself`, link: url, command: null };
  }
  const repo = await read(`repos/${HUB_REPO}`) as { default_branch?: unknown } | null;
  const base = typeof repo?.default_branch === 'string' && /^[A-Za-z0-9._/-]{1,100}$/u.test(repo.default_branch) ? repo.default_branch : 'master';
  const file = await read(`repos/${HUB_REPO}/contents/src/core/authority/trust-roots.ts?ref=${encodeURIComponent(base)}`) as { content?: unknown; encoding?: unknown } | null;
  if (file && file.encoding === 'base64' && typeof file.content === 'string'
    && Buffer.from(file.content, 'base64').toString('utf8').includes(`keyId: '${root.keyId}'`)) {
    return {
      status: 'waiting-on-you',
      detail: `${root.keyId} is merged on ${base}, but this release was built before it — install a release built after it`,
      command: 'npm run build',
    };
  }
  const pushed = await read(`repos/${HUB_REPO}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`) as { ref?: unknown } | null;
  if (pushed && pushed.ref === `refs/heads/${branch}`) {
    return { status: 'waiting-on-you', detail: `${branch} was pushed by an earlier run but has no PR yet — rerun setup to open it` };
  }
  return null;
}

/**
 * Open Mason's trust-root PR from a throwaway worktree (his checkout is never
 * touched). Resumable: a rerun finds the PR it already opened, or the key
 * already merged on the base branch, instead of failing on the leftover branch.
 */
async function openTrustRootPr(
  parsed: Parsed,
  deps: AuthorityCliDeps,
  root: StandingGrantTrustRoot,
  ask: (q: string) => Promise<boolean>,
  probe: boolean,
): Promise<{ status: StepStatus; detail: string; link?: string }> {
  const source = one(parsed, '--source') ?? (await findSelfCheckout());
  if (!source) return { status: 'waiting-on-you', detail: 'pass --source <your ashlr-hub checkout> so setup can open the trust-root PR' };
  const branch = `authority/trust-root-${root.keyId}`;
  const base = async (): Promise<string> => {
    const result = await deps.run('gh', ['repo', 'view', 'ashlrai/ashlr-hub', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'master';
  };
  const prLink = (text: string): string | undefined => /https:\/\/github\.com\/\S+\/pull\/\d+/u.exec(text)?.[0];
  let baseBranch: string | null = null;
  let pushedAlready = false;
  if (probe) {
    // Read-only probes (a dry run never makes them).
    const open = await deps.run('gh', ['pr', 'list', '--repo', 'ashlrai/ashlr-hub', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""']);
    if (open.status === 0 && open.stdout.trim()) {
      const url = open.stdout.trim();
      return { status: 'waiting-on-you', detail: `${url} is already open — review and merge it yourself`, ...(prLink(url) ? { link: prLink(url)! } : {}) };
    }
    baseBranch = await base();
    const fetched = await deps.run('git', ['-C', source, 'fetch', 'origin', baseBranch]);
    const onBase = fetched.status === 0
      ? await deps.run('git', ['-C', source, 'show', `origin/${baseBranch}:src/core/authority/trust-roots.ts`])
      : null;
    if (onBase?.status === 0 && onBase.stdout.includes(`keyId: '${root.keyId}'`)) {
      return { status: 'waiting-on-you', detail: `${root.keyId} is already on ${baseBranch}, but this release was built before it` };
    }
    // An earlier run pushed the branch but `gh pr create` failed: open the PR from it.
    const remote = await deps.run('git', ['-C', source, 'ls-remote', '--exit-code', '--heads', 'origin', branch]);
    pushedAlready = remote.status === 0 && remote.stdout.trim() !== '';
  }
  if (!(await ask(`Open a PR in ${source.replace(homedir(), '~')} adding key ${root.keyId} to trust-roots.ts?`))) {
    return { status: 'waiting-on-you', detail: `add this root yourself: ${JSON.stringify({ keyId: root.keyId, alg: 'ES256' })}` };
  }
  baseBranch ??= await base();
  const createPr = async (cwd?: string): Promise<{ status: StepStatus; detail: string; link?: string }> => {
    const pr = await deps.run('gh', ['pr', 'create', '--repo', 'ashlrai/ashlr-hub', '--base', baseBranch!, '--head', branch,
      '--title', `authority: trust custody key ${root.keyId}`,
      '--body', `Adds the Secure Enclave custody key \`${root.keyId}\` to STANDING_GRANT_TRUST_ROOTS (opened by \`ashlr authority setup\`). Tier-1 path: review it yourself.`], cwd ? { cwd } : {});
    if (pr.status !== 0) return { status: 'failed', detail: `pushed ${branch}, but the PR could not be opened: ${pr.stderr.trim().slice(0, 200)}` };
    const url = pr.stdout.trim();
    return { status: 'waiting-on-you', detail: `opened ${url} — review and merge it yourself`, ...(prLink(url) ? { link: prLink(url)! } : {}) };
  };
  if (pushedAlready) return createPr();
  const worktree = mkdtempSync(join(tmpdir(), 'ashlr-trust-root-'));
  rmSync(worktree, { recursive: true, force: true });
  const step = async (bin: 'git' | 'gh', args: readonly string[], cwd?: string): Promise<void> => {
    const result = await deps.run(bin, args, cwd ? { cwd } : {});
    if (result.status !== 0) throw new Error(`${bin} ${args[0] === '-C' ? args[2] : args[0]} failed: ${result.stderr.trim().slice(0, 200)}`);
  };
  let worktreeAdded = false;
  try {
    await step('git', ['-C', source, 'fetch', 'origin', baseBranch]);
    // -B: a local branch left by an earlier run that stopped before the PR
    // (push or `gh pr create` failed) is reset instead of blocking every rerun.
    await step('git', ['-C', source, 'worktree', 'add', '-B', branch, worktree, `origin/${baseBranch}`]);
    worktreeAdded = true;
    const file = join(worktree, 'src', 'core', 'authority', 'trust-roots.ts');
    const updated = renderTrustRootsWithKey(readFileSync(file, 'utf8'), root);
    if (!updated) return { status: 'failed', detail: `trust-roots.ts on ${baseBranch} already lists a different root — add the key by hand` };
    writeFileSync(file, updated);
    await step('git', ['add', 'src/core/authority/trust-roots.ts'], worktree);
    await step('git', ['commit', '-m', `authority: trust custody key ${root.keyId}`], worktree);
    await step('git', ['push', '-u', 'origin', branch], worktree);
    return await createPr(worktree);
  } finally {
    await deps.run('git', ['-C', source, 'worktree', 'remove', '--force', worktree]);
    // The pushed branch lives on origin; the local copy only blocks a rerun.
    if (worktreeAdded) await deps.run('git', ['-C', source, 'branch', '-D', branch]);
  }
}

/** The enrolled checkout of ashlr-hub itself, if any. */
async function findSelfCheckout(): Promise<string | null> {
  try {
    const { readEnrollmentRegistry } = await import('../core/sandbox/policy.js');
    const { repoIdentityOfPath } = await import('../core/fleet/repo-identity.js');
    const registry = readEnrollmentRegistry();
    if (registry.state !== 'ready') return null;
    return registry.repos.find((path) => repoIdentityOfPath(path)?.toLowerCase() === 'ashlrai/ashlr-hub') ?? null;
  } catch {
    return null;
  }
}

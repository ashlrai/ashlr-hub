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
 *
 * LOWERING never asks anything. Everything that raises authority or touches
 * GitHub asks first (or needs --yes) and prints exactly what it did. Nothing
 * here ever runs `sudo`, changes launchd, or prints a secret.
 */
import { spawnSync } from 'node:child_process';
import { createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { CUSTODY_HELPER_PATH } from '../core/authority/custody-client.js';
import type { AutonomySwitch, LedgerEventKind, SignedStandingGrantV1, StandingGrantTrustRoot, StandingGrantV1 } from '../core/authority/types.js';

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
  /** Run `gh` or `git` with argv — never through a shell. */
  run(bin: 'gh' | 'git', args: readonly string[], opts?: { cwd?: string; input?: string }): GhResult;
  openBrowser(url: string): void;
  fetch: typeof fetch;
  custody: typeof import('../core/authority/custody-client.js');
  /** Read-only: the resident daemon service's state (setup's last step). Never changes launchd. */
  daemonService(): Promise<DaemonServiceState>;
}

/** The resident daemon service as setup reports it. */
export type DaemonServiceState = 'running' | 'loaded' | 'not-loaded' | 'absent' | 'unknown';

// Loaded lazily: `authority stop` and friends must never depend on the daemon
// service module being importable.
async function realDaemonService(): Promise<DaemonServiceState> {
  const { serviceStatus } = await import('../core/daemon/service.js');
  const status = serviceStatus();
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
  };
}

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
}

function ghJson(deps: AuthorityCliDeps, args: readonly string[]): unknown {
  const result = deps.run('gh', args);
  if (result.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${result.stderr.trim().slice(0, 200)}`);
  return JSON.parse(result.stdout || 'null') as unknown;
}

/** Check-run names on the default branch head: what CI actually reports today. */
function discoverChecks(deps: AuthorityCliDeps, repo: string): RequiredCheck[] {
  const info = ghJson(deps, ['api', `repos/${repo}`]) as { default_branch?: string; private?: boolean };
  const branch = info.default_branch ?? 'main';
  const runs = ghJson(deps, ['api', `repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`]) as { check_runs?: { name?: string; app?: { id?: unknown } }[] };
  const found: RequiredCheck[] = [];
  for (const run of runs.check_runs ?? []) {
    if (typeof run.name !== 'string' || run.name.length === 0) continue;
    const appId = run.app?.id;
    found.push({ context: run.name, integrationId: typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0 ? appId : null });
  }
  return normalizeRequiredChecks(found);
}

async function protectPlans(parsed: Parsed, deps: AuthorityCliDeps): Promise<RepoProtectPlan[]> {
  let repos = parsed.values.get('--repo') ?? [];
  let enforcement = new Map<string, string>();
  if (repos.length === 0) {
    const { readInstalledGrant } = await import('../core/authority/standing-grant.js');
    const installed = readInstalledGrant();
    let grantRepos: { nameWithOwner: string; enforcement: string }[] = [];
    if (installed.state === 'ok') grantRepos = installed.envelope.payload.repos;
    else {
      const { buildStandingGrantDraft } = await import('../core/verse/authority-api.js');
      grantRepos = (await buildStandingGrantDraft('new')).payload.repos;
    }
    repos = grantRepos.map((r) => r.nameWithOwner);
    enforcement = new Map(grantRepos.map((r) => [r.nameWithOwner, r.enforcement]));
  }
  const plans: RepoProtectPlan[] = [];
  for (const repo of repos) {
    if (enforcement.get(repo) === 'local') {
      plans.push({ repo, skipped: 'local enforcement (private free-plan repo: GitHub rulesets unavailable) — the daemon enforces its gates', checks: [], ruleset: null, existingId: null });
      continue;
    }
    try {
      const info = ghJson(deps, ['api', `repos/${repo}`]) as { private?: boolean; visibility?: string };
      const required = discoverChecks(deps, repo);
      const checks = required.map((check) => check.context);
      const existing = ghJson(deps, ['api', `repos/${repo}/rulesets`]) as { id?: number; name?: string }[] | null;
      const match = Array.isArray(existing) ? existing.find((r) => r.name === FLEET_RULESET_NAME) : undefined;
      plans.push({
        repo,
        skipped: info.private === true && checks.length === 0 ? 'private repo with no CI checks — protect it by hand or keep it propose-only' : null,
        checks,
        ruleset: buildFleetRuleset(required),
        existingId: typeof match?.id === 'number' ? match.id : null,
      });
    } catch (error) {
      plans.push({ repo, skipped: `could not read it from GitHub: ${(error as Error).message}`, checks: [], ruleset: null, existingId: null });
    }
  }
  return plans;
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
    deps.out(`${plan.repo}: ${plan.existingId === null ? 'create' : `update ruleset ${plan.existingId}`}; required checks: ${plan.checks.length > 0 ? plan.checks.join(', ') : 'none found (the repo goes to the owner lane until it has CI)'}`);
    if (!apply) {
      deps.out(`  gh api --method ${plan.existingId === null ? 'POST' : 'PUT'} repos/${plan.repo}/rulesets${plan.existingId === null ? '' : `/${plan.existingId}`} --input - <<'JSON'`);
      deps.out(JSON.stringify(plan.ruleset, null, 2));
      deps.out('JSON');
    }
  }
  if (!apply) return 0;
  const actionable = plans.filter((plan) => !plan.skipped);
  if (actionable.length === 0) return 0;
  if (!parsed.flags.has('--yes') && !(await deps.confirm(`Apply the ruleset to ${actionable.length} repo(s)?`))) {
    deps.out('Nothing applied.');
    return 1;
  }
  let failures = 0;
  for (const plan of actionable) {
    const result = deps.run('gh', [
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
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// github-app — App Manifest flow (addendum §3)
// ---------------------------------------------------------------------------

export const FLEET_APP_NAME = 'ashlr-fleet';

/**
 * PURE: the App manifest. Contents + pull requests read/write, checks /
 * statuses / metadata read. No workflows, no administration — GitHub itself
 * then refuses CI-config and protection changes from the fleet.
 */
export function buildGithubAppManifest(redirectUrl: string): Record<string, unknown> {
  return {
    name: FLEET_APP_NAME,
    url: 'https://github.com/ashlrai/ashlr-hub',
    hook_attributes: { url: 'https://github.com/ashlrai/ashlr-hub', active: false },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: { contents: 'write', pull_requests: 'write', checks: 'read', statuses: 'read', metadata: 'read' },
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
  return 0;
}

// ---------------------------------------------------------------------------
// rotate-provenance
// ---------------------------------------------------------------------------

/**
 * Move the provenance HMAC key aside and create a new one. Every pending
 * provenance signature stops verifying (by design: agents could read the old
 * key while confinement was off), so pending proposals are re-verified.
 */
export async function rotateProvenanceKey(): Promise<{ retiredAs: string | null }> {
  const { provenanceKeyPath, loadOrCreateKey } = await import('../core/foundry/provenance.js');
  const path = provenanceKeyPath();
  let retiredAs: string | null = null;
  if (existsSync(path)) {
    retiredAs = `${path}.retired-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(path, retiredAs);
  }
  loadOrCreateKey();
  return { retiredAs };
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

type StepStatus = 'done' | 'already' | 'waiting-on-you' | 'skipped' | 'blocked' | 'failed';

/** What a setup step needs from Mason himself (a UI renders these as badges). */
export type SetupNeed = 'sudo' | 'touch-id' | 'browser' | 'github' | 'terminal';

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
  'resident-runtime': [],
});

// The packaged runtime still has no resident-start broker or production
// authority roots. This is a source/release gate, not a missing setup action.
// Keep the checklist blocked until a reviewed resident consumer can prove it.
const RESIDENT_RUNTIME_BLOCK =
  'Resident activation is unavailable in this build: service install/restart authority, compiled daemon and conductor roots, and the native resident-start broker are absent. Preparing the other steps does not start autonomous work.';

/** `ashlr authority setup --dry-run --json` — the checklist a UI can render. */
export interface AuthoritySetupReportV1 {
  schema: 'ashlr.authority-setup.v1';
  dryRun: boolean;
  /** Every step is done or already in place, including resident runtime admission. */
  complete: boolean;
  summary: { done: number; already: number; waitingOnYou: number; blocked: number; failed: number; planned: number };
  steps: { id: string; step: string; status: StepStatus; detail: string; needs: readonly SetupNeed[] }[];
  /** The first step that is not done or already in place (null when complete). */
  next: string | null;
}

type SetupRow = { step: string; status: StepStatus; detail: string };

function setupStepId(step: string): string {
  return step.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** PURE: the machine-readable form of a setup run. */
export function authoritySetupReport(report: readonly SetupRow[], dryRun: boolean): AuthoritySetupReportV1 {
  const count = (status: StepStatus): number => report.filter((r) => r.status === status).length;
  const steps = report.map((r) => {
    const id = setupStepId(r.step);
    return { id, step: r.step, status: r.status, detail: r.detail, needs: SETUP_STEP_NEEDS[id] ?? [] };
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
  const yes = parsed.flags.has('--yes');
  const json = parsed.flags.has('--json');
  if (json && !dryRun) {
    // A real run asks questions and prints what gh / signing did; only the
    // read-only plan can promise a clean JSON document on stdout.
    deps.err('setup --json needs --dry-run');
    return 2;
  }
  const report: SetupRow[] = [];
  const note = (step: string, status: StepStatus, detail: string): void => {
    report.push({ step, status, detail });
    if (json) return;
    // 'skipped' gets its own glyph: a ✓ on a step a dry run did not perform read as done.
    const glyph = status === 'failed' ? '✗' : status === 'blocked' ? '×' : status === 'waiting-on-you' ? '…' : status === 'skipped' ? '·' : '✓';
    deps.out(`${glyph} ${step}: ${detail}`);
  };
  const done = (): number => {
    // Every exit, including the first unmet live prerequisite, must report
    // this independent source/release block exactly once.
    if (!report.some((row) => row.step === 'resident runtime')) {
      note('resident runtime', 'blocked', RESIDENT_RUNTIME_BLOCK);
    }
    return finish(report, deps, dryRun, json);
  };
  const ask = async (question: string): Promise<boolean> => !dryRun && (yes || deps.confirm(question));
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

  // 1. Custody helper (installing it needs sudo — Mason runs that himself).
  let custody: Awaited<ReturnType<typeof deps.custody.custodyStatus>> | null = null;
  try {
    custody = await deps.custody.custodyStatus();
  } catch (error) {
    note('custody helper', 'failed', `status unavailable (${(error as Error).message})`);
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
      note('host binding', 'failed', `could not compare with ashlr-custody (${(error as Error).message})`);
    }
  }
  if (report.some((r) => r.step === 'host binding' && r.status === 'failed') && stopHere()) return done();

  // 2. Secure Enclave key (Touch ID). The helper is not on PATH, so every
  // message names it by its installed path.
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
      const info = await deps.custody.custodyInit();
      keyId = info.keyId;
      publicKeyPem = info.publicKeyPem;
      note('signing key', 'done', `created ${info.keyId}`);
    }
  } else {
    note('signing key', 'already', `key ${keyId ?? '(id unknown)'}`);
  }

  // 3. Trust root compiled in (Mason's own PR).
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
        note('trust root', 'failed', `could not read the custody public key (${(error as Error).message})`);
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
        let pr: { status: StepStatus; detail: string };
        try {
          pr = await openTrustRootPr(parsed, deps, root, ask, !dryRun);
        } catch (error) {
          pr = { status: 'failed', detail: (error as Error).message };
        }
        note('trust root', pr.status, pr.detail);
        note('deploy', 'waiting-on-you', DEPLOY_DETAIL);
      }
      if (stopHere()) return done();
    }
  }

  // 4. GitHub App.
  if (custody?.githubApp) note('GitHub App', 'already', 'the ashlr-fleet key is in custody');
  else if (await ask(`Create the ${FLEET_APP_NAME} GitHub App now (one browser page)?`)) {
    const app = await runGithubAppFlow(deps, { org: one(parsed, '--org') ?? 'ashlrai' });
    note('GitHub App', 'done', `created ${app.slug}; install it on the repos: ${app.installUrl}`);
  } else note('GitHub App', dryRun ? 'skipped' : 'waiting-on-you', 'run `ashlr authority github-app`');

  // 5. Claude token for restricted judge / Leader calls.
  if (custody?.claudeToken) note('Claude token', 'already', 'stored in custody');
  else if (await ask('Store a Claude token now (run `claude setup-token` in another terminal and paste it)?')) {
    const token = (await deps.readSecret('Paste the token (hidden): ')).trim();
    if (!token) note('Claude token', 'failed', 'nothing was pasted');
    else {
      await deps.custody.storeClaudeToken(token);
      note('Claude token', 'done', 'stored in custody (never written to disk here)');
    }
  } else note('Claude token', dryRun ? 'skipped' : 'waiting-on-you', 'run `claude setup-token`, then rerun setup');

  // 6. Canary repo (the App cannot write workflows, so this uses your own gh
  // auth). Before the rulesets: the grant's server-enforced repos include the
  // canary, and a ruleset cannot be applied to a repo that does not exist yet.
  const canary = planning ? null : deps.run('gh', ['api', 'repos/ashlrai/fleet-canary']);
  if (canary?.status === 0) note('canary repo', 'already', 'ashlrai/fleet-canary exists');
  else if (await ask('Create the public repo ashlrai/fleet-canary with its CI workflow (your gh auth)?')) {
    const created = deps.run('gh', ['repo', 'create', 'ashlrai/fleet-canary', '--public', '--add-readme', '--description', 'ashlr fleet canary (revert drills)']);
    const workflow = created.status === 0
      ? deps.run('gh', ['api', '--method', 'PUT', 'repos/ashlrai/fleet-canary/contents/.github/workflows/ci.yml', '--input', '-'], {
          input: JSON.stringify({ message: 'ci: canary workflow', content: Buffer.from(CANARY_WORKFLOW, 'utf8').toString('base64') }),
        })
      : null;
    note('canary repo', created.status === 0 && workflow?.status === 0 ? 'done' : 'failed', created.status === 0 ? (workflow?.status === 0 ? 'created with its CI workflow' : 'created, but the workflow push failed') : created.stderr.trim().slice(0, 200));
  } else note('canary repo', dryRun ? 'skipped' : 'waiting-on-you', 'create ashlrai/fleet-canary with a CI workflow');

  // 7. Rulesets.
  if (await ask('Apply the fleet rulesets to the server-enforced repos now?')) {
    const code = await cmdProtect({ ...parsed, flags: new Set([...parsed.flags, '--apply', '--yes']) }, deps);
    note('rulesets', code === 0 ? 'done' : 'failed', code === 0 ? 'applied (see above)' : 'some repos failed (see above)');
  } else note('rulesets', dryRun ? 'skipped' : 'waiting-on-you', 'run `ashlr authority protect --print`, then `--apply`');

  // 8. Retire the burned activation directory.
  const activation = join(homedir(), '.ashlr', 'activation');
  if (!existsSync(activation)) note('old activation state', 'already', 'nothing to retire');
  else if (await ask('Move ~/.ashlr/activation (the burned key) out of ~/.ashlr so no code path can reach it?')) {
    const target = join(homedir(), `ashlr-activation-retired-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    renameSync(activation, target);
    note('old activation state', 'done', `moved to ${target.replace(homedir(), '~')} — move it offline, then delete it`);
  } else note('old activation state', dryRun ? 'skipped' : 'waiting-on-you', 'archive ~/.ashlr/activation offline, then delete it');

  // 9. Provenance key.
  if (await ask('Rotate the provenance HMAC key (agents could read the old one)?')) {
    const rotated = await rotateProvenanceKey();
    note('provenance key', 'done', rotated.retiredAs ? 'rotated; the old key was moved aside' : 'created');
  } else note('provenance key', dryRun ? 'skipped' : 'waiting-on-you', 'run `ashlr authority rotate-provenance`');

  // 10. First grant (Touch ID), 11. the switch, 12. the daemon service,
  // 13. production resident admission. A running legacy service is not proof
  // that its execution gate or native release boundary is available.
  const DAEMON_DETAIL = 'would check that the ai.ashlr.daemon service is loaded and running (each tick re-verifies the grant)';
  if (planning) {
    note('standing grant', 'skipped', 'would sign the first standing grant (Touch ID)');
    note('autonomy switch', 'skipped', 'would offer to set the autonomy switch to Autonomous (the ladder starts in shadow)');
    note('daemon service', 'skipped', DAEMON_DETAIL);
    return done();
  }
  const { evaluateStandingAuthority, displaySurfaceTarget } = await import('../core/authority/effective-config.js');
  const evaluation = evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() });
  let grantActive = evaluation.grantState === 'active';
  if (grantActive) {
    note('standing grant', 'already', `grant #${evaluation.grant?.grantSeq ?? '?'} is active`);
  } else if (await ask('Sign the first standing grant now (Touch ID)?')) {
    const { buildStandingGrantDraft } = await import('../core/verse/authority-api.js');
    const draft = await buildStandingGrantDraft('auto');
    for (const line of draft.summary) deps.out(`    ${line}`);
    const signed = await signAndInstall(draft.payload, deps);
    grantActive = signed.ok;
    note('standing grant', signed.ok ? 'done' : 'failed', signed.ok ? `grant #${signed.grant.grantSeq} installed, starting at ${signed.grant.rollout.stages[0]!.id}` : signed.reason);
  } else note('standing grant', dryRun ? 'skipped' : 'waiting-on-you', 'run `ashlr authority grant`');

  // Resumable: a grant signed on an earlier run (or with `authority grant`)
  // still gets the switch offered — it used to be offered only in the run
  // that signed. Raising stays capped by the grant (requestAutonomySwitch).
  if (!grantActive) {
    note('autonomy switch', dryRun ? 'skipped' : 'waiting-on-you', 'needs an active standing grant first');
  } else if (evaluation.switch === 'autonomous') {
    note('autonomy switch', 'already', 'Autonomous');
  } else if (await ask('Set the autonomy switch to Autonomous (the ladder starts in shadow)?')) {
    const { requestAutonomySwitch } = await import('../core/authority/effective-config.js');
    const switched = requestAutonomySwitch('autonomous', 'mason', 'ashlr authority setup');
    note('autonomy switch', switched.ok ? 'done' : 'failed', switched.ok ? 'Autonomous' : switched.reason);
  } else note('autonomy switch', dryRun ? 'skipped' : 'waiting-on-you', `it is ${evaluation.switch} — run \`ashlr authority switch autonomous\``);

  // 12. Read-only service observation. Manual launchctl advice would imply
  // that this build can admit a resident start, which its production gate denies.
  let service: DaemonServiceState;
  try {
    service = await deps.daemonService();
  } catch {
    service = 'unknown';
  }
  if (service === 'running') note('daemon service', 'already', 'ai.ashlr.daemon is running; resident execution still requires the separate runtime admission below');
  else if (service === 'absent') note('daemon service', 'waiting-on-you', 'no ai.ashlr.daemon service is installed; this build cannot install or start one');
  else if (service === 'loaded') note('daemon service', 'waiting-on-you', 'ai.ashlr.daemon is loaded but stopped; this build cannot restart it');
  else if (service === 'not-loaded') note('daemon service', 'waiting-on-you', 'ai.ashlr.daemon is not loaded; this build cannot start it');
  else note('daemon service', 'waiting-on-you', 'ai.ashlr.daemon state is unknown; this build cannot start or repair it');
  return done();
}

function finish(report: readonly SetupRow[], deps: AuthorityCliDeps, dryRun = false, json = false): number {
  const result = authoritySetupReport(report, dryRun);
  const { summary } = result;
  if (json) {
    deps.out(JSON.stringify(result, null, 2));
  } else {
    const planned = dryRun ? `, ${summary.planned} planned (dry run: nothing was asked or changed)` : '';
    deps.out(`\nSetup: ${summary.done} done, ${summary.already} already in place, ${summary.waitingOnYou} waiting on you, ${summary.blocked} blocked by this build, ${summary.failed} failed${planned}.`);
  }
  return summary.failed > 0 ? 1 : 0;
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
): Promise<{ status: StepStatus; detail: string }> {
  const source = one(parsed, '--source') ?? (await findSelfCheckout());
  if (!source) return { status: 'waiting-on-you', detail: 'pass --source <your ashlr-hub checkout> so setup can open the trust-root PR' };
  const branch = `authority/trust-root-${root.keyId}`;
  const base = (): string => {
    const result = deps.run('gh', ['repo', 'view', 'ashlrai/ashlr-hub', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
    return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : 'master';
  };
  let baseBranch: string | null = null;
  let pushedAlready = false;
  if (probe) {
    // Read-only probes (a dry run never makes them).
    const open = deps.run('gh', ['pr', 'list', '--repo', 'ashlrai/ashlr-hub', '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""']);
    if (open.status === 0 && open.stdout.trim()) {
      return { status: 'waiting-on-you', detail: `${open.stdout.trim()} is already open — review and merge it yourself` };
    }
    baseBranch = base();
    const fetched = deps.run('git', ['-C', source, 'fetch', 'origin', baseBranch]);
    const onBase = fetched.status === 0
      ? deps.run('git', ['-C', source, 'show', `origin/${baseBranch}:src/core/authority/trust-roots.ts`])
      : null;
    if (onBase?.status === 0 && onBase.stdout.includes(`keyId: '${root.keyId}'`)) {
      return { status: 'waiting-on-you', detail: `${root.keyId} is already on ${baseBranch}, but this release was built before it` };
    }
    // An earlier run pushed the branch but `gh pr create` failed: open the PR from it.
    const remote = deps.run('git', ['-C', source, 'ls-remote', '--exit-code', '--heads', 'origin', branch]);
    pushedAlready = remote.status === 0 && remote.stdout.trim() !== '';
  }
  if (!(await ask(`Open a PR in ${source.replace(homedir(), '~')} adding key ${root.keyId} to trust-roots.ts?`))) {
    return { status: 'waiting-on-you', detail: `add this root yourself: ${JSON.stringify({ keyId: root.keyId, alg: 'ES256' })}` };
  }
  baseBranch ??= base();
  const createPr = (cwd?: string): { status: StepStatus; detail: string } => {
    const pr = deps.run('gh', ['pr', 'create', '--repo', 'ashlrai/ashlr-hub', '--base', baseBranch!, '--head', branch,
      '--title', `authority: trust custody key ${root.keyId}`,
      '--body', `Adds the Secure Enclave custody key \`${root.keyId}\` to STANDING_GRANT_TRUST_ROOTS (opened by \`ashlr authority setup\`). Tier-1 path: review it yourself.`], cwd ? { cwd } : {});
    if (pr.status !== 0) return { status: 'failed', detail: `pushed ${branch}, but the PR could not be opened: ${pr.stderr.trim().slice(0, 200)}` };
    return { status: 'waiting-on-you', detail: `opened ${pr.stdout.trim()} — review and merge it yourself` };
  };
  if (pushedAlready) return createPr();
  const worktree = mkdtempSync(join(tmpdir(), 'ashlr-trust-root-'));
  rmSync(worktree, { recursive: true, force: true });
  const step = (bin: 'git' | 'gh', args: readonly string[], cwd?: string): void => {
    const result = deps.run(bin, args, cwd ? { cwd } : {});
    if (result.status !== 0) throw new Error(`${bin} ${args[0] === '-C' ? args[2] : args[0]} failed: ${result.stderr.trim().slice(0, 200)}`);
  };
  let worktreeAdded = false;
  try {
    step('git', ['-C', source, 'fetch', 'origin', baseBranch]);
    // -B: a local branch left by an earlier run that stopped before the PR
    // (push or `gh pr create` failed) is reset instead of blocking every rerun.
    step('git', ['-C', source, 'worktree', 'add', '-B', branch, worktree, `origin/${baseBranch}`]);
    worktreeAdded = true;
    const file = join(worktree, 'src', 'core', 'authority', 'trust-roots.ts');
    const updated = renderTrustRootsWithKey(readFileSync(file, 'utf8'), root);
    if (!updated) return { status: 'failed', detail: `trust-roots.ts on ${baseBranch} already lists a different root — add the key by hand` };
    writeFileSync(file, updated);
    step('git', ['add', 'src/core/authority/trust-roots.ts'], worktree);
    step('git', ['commit', '-m', `authority: trust custody key ${root.keyId}`], worktree);
    step('git', ['push', '-u', 'origin', branch], worktree);
    return createPr(worktree);
  } finally {
    deps.run('git', ['-C', source, 'worktree', 'remove', '--force', worktree]);
    // The pushed branch lives on origin; the local copy only blocks a rerun.
    if (worktreeAdded) deps.run('git', ['-C', source, 'branch', '-D', branch]);
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

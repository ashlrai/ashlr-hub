/**
 * `ashlr sandbox` / `ashlr audit` / `ashlr enroll` — M21 Safety Foundation CLI.
 *
 * Commands:
 *   sandbox list                List all active sandboxes.
 *   sandbox diff <id>           Show the diff of a sandbox vs its base HEAD.
 *   sandbox cleanup <id>        Remove a sandbox worktree and scratch branch.
 *   sandbox gc                  Reclaim STALE orphan sandboxes (crash leftovers).
 *
 *   audit [--limit N] [--json]  Tail the audit trail (newest-first).
 *
 *   enroll list                 List enrolled repos + kill switch state.
 *   enroll add <repo>           Enroll a repo for autonomous work.
 *   enroll remove <repo>        Remove a repo from the enrollment registry.
 *   enroll kill on|off          Toggle the global kill switch.
 *
 * Non-TTY safe; --json where sensible. Returns 0 on success, non-zero on
 * bad args / not-found / error.
 */

import { pad, makeColors, isTty } from './ui.js';
import type { Sandbox, SandboxDiff, AuditEntry } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy imports — core/sandbox/worktree.ts (M21)
// ---------------------------------------------------------------------------

type ListSandboxesFn = () => Sandbox[];
type SandboxDiffFn   = (sb: Sandbox) => SandboxDiff;
type RemoveSandboxFn = (sb: Sandbox) => void;
// H5 CHANGE 1 — explicit human repair surface for the orphan sweep.
type SweepOrphanSandboxesFn = (opts?: { staleMs?: number }) => string[];

let _listSandboxes: ListSandboxesFn | null | undefined = undefined;
let _sandboxDiff:   SandboxDiffFn   | null | undefined = undefined;
let _removeSandbox: RemoveSandboxFn | null | undefined = undefined;
let _sweepOrphans:  SweepOrphanSandboxesFn | null | undefined = undefined;
// H5 CHANGE 1 — reuse worktree's single-source-of-truth staleness threshold so
// `sandbox gc` and the daemon-start sweep can NEVER drift apart.
let _orphanStaleMs: number | null | undefined = undefined;

async function loadWorktree(): Promise<{
  listSandboxes: ListSandboxesFn;
  sandboxDiff:   SandboxDiffFn;
  removeSandbox: RemoveSandboxFn;
  sweepOrphanSandboxes: SweepOrphanSandboxesFn;
  orphanStaleMs: number;
} | null> {
  if (_listSandboxes === undefined) {
    try {
      const mod = await import('../core/sandbox/worktree.js' as unknown as string) as {
        listSandboxes: ListSandboxesFn;
        sandboxDiff:   SandboxDiffFn;
        removeSandbox: RemoveSandboxFn;
        sweepOrphanSandboxes: SweepOrphanSandboxesFn;
        ORPHAN_STALE_MS: number;
      };
      _listSandboxes = mod.listSandboxes;
      _sandboxDiff   = mod.sandboxDiff;
      _removeSandbox = mod.removeSandbox;
      _sweepOrphans  = mod.sweepOrphanSandboxes;
      _orphanStaleMs = mod.ORPHAN_STALE_MS;
    } catch {
      _listSandboxes = null;
      _sandboxDiff   = null;
      _removeSandbox = null;
      _sweepOrphans  = null;
      _orphanStaleMs = null;
    }
  }
  if (_listSandboxes === null) return null;
  return {
    listSandboxes: _listSandboxes!,
    sandboxDiff:   _sandboxDiff!,
    removeSandbox: _removeSandbox!,
    sweepOrphanSandboxes: _sweepOrphans!,
    orphanStaleMs: _orphanStaleMs!,
  };
}

// ---------------------------------------------------------------------------
// Lazy imports — core/sandbox/audit.ts (M21)
// ---------------------------------------------------------------------------

type ReadAuditFn = (limit?: number) => AuditEntry[];

let _readAudit: ReadAuditFn | null | undefined = undefined;

async function loadAuditModule(): Promise<ReadAuditFn | null> {
  if (_readAudit === undefined) {
    try {
      const mod = await import('../core/sandbox/audit.js' as unknown as string) as { readAudit: ReadAuditFn };
      _readAudit = mod.readAudit;
    } catch {
      _readAudit = null;
    }
  }
  return _readAudit ?? null;
}

// ---------------------------------------------------------------------------
// Lazy imports — core/sandbox/policy.ts (M21)
// ---------------------------------------------------------------------------

type ListEnrolledFn = () => string[];
type EnrollFn       = (repo: string) => void;
type UnenrollFn     = (repo: string) => void;
type KillSwitchOnFn = () => boolean;
type SetKillFn      = (on: boolean) => void;

let _listEnrolled: ListEnrolledFn | null | undefined = undefined;
let _enroll:       EnrollFn       | null | undefined = undefined;
let _unenroll:     UnenrollFn     | null | undefined = undefined;
let _killSwitchOn: KillSwitchOnFn | null | undefined = undefined;
let _setKill:      SetKillFn      | null | undefined = undefined;

async function loadPolicy(): Promise<{
  listEnrolled: ListEnrolledFn;
  enroll:       EnrollFn;
  unenroll:     UnenrollFn;
  killSwitchOn: KillSwitchOnFn;
  setKill:      SetKillFn;
} | null> {
  if (_listEnrolled === undefined) {
    try {
      const mod = await import('../core/sandbox/policy.js' as unknown as string) as {
        listEnrolled: ListEnrolledFn;
        enroll:       EnrollFn;
        unenroll:     UnenrollFn;
        killSwitchOn: KillSwitchOnFn;
        setKill:      SetKillFn;
      };
      _listEnrolled = mod.listEnrolled;
      _enroll       = mod.enroll;
      _unenroll     = mod.unenroll;
      _killSwitchOn = mod.killSwitchOn;
      _setKill      = mod.setKill;
    } catch {
      _listEnrolled = null;
      _enroll       = null;
      _unenroll     = null;
      _killSwitchOn = null;
      _setKill      = null;
    }
  }
  if (_listEnrolled === null) return null;
  return {
    listEnrolled: _listEnrolled!,
    enroll:       _enroll!,
    unenroll:     _unenroll!,
    killSwitchOn: _killSwitchOn!,
    setKill:      _setKill!,
  };
}

// ---------------------------------------------------------------------------
// Helper — module-not-built stub
// ---------------------------------------------------------------------------

function moduleNotBuilt(module: string): void {
  console.error(red('error: ') + `${module} requires src/core/sandbox/ (M21 module not yet built).`);
}

// ---------------------------------------------------------------------------
// cmdSandbox — list | diff <id> | cleanup <id>
// ---------------------------------------------------------------------------

function printSandboxList(sandboxes: Sandbox[]): void {
  if (sandboxes.length === 0) {
    console.log(dim('No active sandboxes.'));
    return;
  }

  const idW    = Math.max(10, ...sandboxes.map(s => s.id.length));
  const repoW  = Math.max(10, ...sandboxes.map(s => s.sourceRepo.length));
  const branchW = Math.max(8,  ...sandboxes.map(s => s.branch.length));

  // Header
  console.log(
    bold(pad('ID',         idW)) + '  ' +
    bold(pad('BRANCH',     branchW)) + '  ' +
    bold(pad('SOURCE REPO', repoW)) + '  ' +
    bold('CREATED'),
  );
  console.log(dim('─'.repeat(idW + branchW + repoW + 22)));

  for (const sb of sandboxes) {
    console.log(
      cyan(pad(sb.id,          idW)) + '  ' +
      gray(pad(sb.branch,      branchW)) + '  ' +
      pad(sb.sourceRepo,       repoW) + '  ' +
      dim(sb.createdAt),
    );
  }
}

export async function cmdSandbox(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const wt = await loadWorktree();
    if (!wt) { moduleNotBuilt('sandbox list'); return 1; }
    const sandboxes = wt.listSandboxes();
    printSandboxList(sandboxes);
    return 0;
  }

  if (sub === 'diff') {
    const id = args[1];
    if (!id) {
      console.error(red('error: ') + 'Usage: ashlr sandbox diff <id>');
      return 2;
    }
    const wt = await loadWorktree();
    if (!wt) { moduleNotBuilt('sandbox diff'); return 1; }
    const sandboxes = wt.listSandboxes();
    const sb = sandboxes.find(s => s.id === id);
    if (!sb) {
      console.error(red('error: ') + `Sandbox not found: ${id}`);
      return 1;
    }
    try {
      const diff = wt.sandboxDiff(sb);
      console.log(bold(`Sandbox: ${cyan(diff.sandboxId)}`));
      console.log(
        `  ${green(String(diff.insertions))} insertions, ` +
        `${red(String(diff.deletions))} deletions, ` +
        `${String(diff.files)} file(s) changed`,
      );
      if (diff.patch) {
        console.log('');
        console.log(diff.patch);
      } else {
        console.log(dim('  (no changes)'));
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red('error: ') + msg);
      return 1;
    }
  }

  if (sub === 'cleanup') {
    const id = args[1];
    if (!id) {
      console.error(red('error: ') + 'Usage: ashlr sandbox cleanup <id>');
      return 2;
    }
    const wt = await loadWorktree();
    if (!wt) { moduleNotBuilt('sandbox cleanup'); return 1; }
    const sandboxes = wt.listSandboxes();
    const sb = sandboxes.find(s => s.id === id);
    if (!sb) {
      console.error(red('error: ') + `Sandbox not found: ${id}`);
      return 1;
    }
    try {
      wt.removeSandbox(sb);
      console.log(green('✓') + ` Sandbox ${cyan(id)} removed.`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red('error: ') + msg);
      return 1;
    }
  }

  if (sub === 'gc') {
    // H5 CHANGE 1 — explicit human repair surface for the orphan sweep.
    // Sweeps STALE orphan sandboxes (crash leftovers) via the reclaim primitive,
    // which inherits removeSandbox's containment guards verbatim (a tampered/out-
    // of-namespace entry is refused git ops and falls through to local-dir cleanup
    // only). Conservative staleMs (worktree's exported ORPHAN_STALE_MS, > max swarm
    // wall-clock) so a LIVE in-flight worktree is NEVER reclaimed. Inward cleanup
    // only; pushes nothing, opens no PR, applies no proposal.
    const wt = await loadWorktree();
    if (!wt) { moduleNotBuilt('sandbox gc'); return 1; }
    try {
      const swept = wt.sweepOrphanSandboxes({ staleMs: wt.orphanStaleMs });
      if (swept.length === 0) {
        console.log(dim('No stale orphan sandboxes to reclaim.'));
      } else {
        console.log(green('✓') + ` Reclaimed ${cyan(String(swept.length))} stale orphan sandbox(es).`);
        for (const id of swept) console.log(`    ${cyan('•')} ${id}`);
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red('error: ') + msg);
      return 1;
    }
  }

  // Unknown subcommand
  console.error(red('error: ') + `Unknown sandbox subcommand: ${sub}`);
  console.error(dim('Usage: ashlr sandbox [list | diff <id> | cleanup <id> | gc]'));
  return 2;
}

// ---------------------------------------------------------------------------
// cmdAudit — tail audit trail
// ---------------------------------------------------------------------------

function formatAuditEntry(entry: AuditEntry): string {
  const resultColor =
    entry.result === 'ok'      ? green(entry.result)   :
    entry.result === 'refused' ? yellow(entry.result)  :
                                 red(entry.result);

  const ts    = dim(entry.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z'));
  const action = bold(entry.action);
  const repo   = entry.repo    ? dim(` repo=${entry.repo}`)          : '';
  const sbId   = entry.sandboxId ? dim(` sandbox=${entry.sandboxId}`) : '';

  return `${ts}  [${resultColor}]  ${action}  ${entry.summary}${repo}${sbId}`;
}

export async function cmdAudit(args: string[]): Promise<number> {
  let limit: number | undefined = undefined;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      const n = parseInt(args[i + 1], 10);
      if (!isNaN(n) && n > 0) { limit = n; i++; }
    } else if (args[i] === '--json') {
      jsonMode = true;
    } else if (/^\d+$/.test(args[i])) {
      // Positional numeric arg as limit shorthand: `ashlr audit 20`
      limit = parseInt(args[i], 10);
    }
  }

  const readAudit = await loadAuditModule();
  if (!readAudit) { moduleNotBuilt('audit'); return 1; }

  const entries = readAudit(limit);

  if (jsonMode) {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  if (entries.length === 0) {
    console.log(dim('No audit entries found.'));
    return 0;
  }

  for (const entry of entries) {
    console.log(formatAuditEntry(entry));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cmdEnroll — list | add <repo> | remove <repo> | kill on|off
// ---------------------------------------------------------------------------

function printEnrollList(repos: string[], killOn: boolean): void {
  const killState = killOn
    ? red('ON  ') + dim('(all autonomous/sandbox ops REFUSED)')
    : green('OFF') + dim('(normal operation)');

  console.log('');
  console.log(bold('  Kill switch: ') + killState);
  console.log('');

  if (repos.length === 0) {
    console.log(bold('  Enrolled repos: ') + dim('(none — no repos enrolled for autonomous work)'));
  } else {
    console.log(bold('  Enrolled repos:'));
    for (const r of repos) {
      console.log(`    ${cyan('•')} ${r}`);
    }
  }
  console.log('');
}

export async function cmdEnroll(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === 'list') {
    const policy = await loadPolicy();
    if (!policy) { moduleNotBuilt('enroll list'); return 1; }
    const repos  = policy.listEnrolled();
    const killOn = policy.killSwitchOn();
    printEnrollList(repos, killOn);
    return 0;
  }

  if (sub === 'add') {
    const repo = args[1];
    if (!repo) {
      console.error(red('error: ') + 'Usage: ashlr enroll add <repo>');
      return 2;
    }
    const policy = await loadPolicy();
    if (!policy) { moduleNotBuilt('enroll add'); return 1; }
    try {
      policy.enroll(repo);
      console.log(green('✓') + ` Enrolled: ${cyan(repo)}`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red('error: ') + msg);
      return 1;
    }
  }

  if (sub === 'remove') {
    const repo = args[1];
    if (!repo) {
      console.error(red('error: ') + 'Usage: ashlr enroll remove <repo>');
      return 2;
    }
    const policy = await loadPolicy();
    if (!policy) { moduleNotBuilt('enroll remove'); return 1; }
    try {
      policy.unenroll(repo);
      console.log(green('✓') + ` Removed: ${cyan(repo)}`);
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red('error: ') + msg);
      return 1;
    }
  }

  if (sub === 'kill') {
    const val = args[1];
    if (val !== 'on' && val !== 'off') {
      console.error(red('error: ') + 'Usage: ashlr enroll kill on|off');
      return 2;
    }
    const policy = await loadPolicy();
    if (!policy) { moduleNotBuilt('enroll kill'); return 1; }
    try {
      policy.setKill(val === 'on');
      if (val === 'on') {
        console.log(yellow('Kill switch ON') + dim(' — all autonomous/sandbox ops refused.'));
      } else {
        console.log(green('Kill switch OFF') + dim(' — normal operation.'));
      }
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red('error: ') + msg);
      return 1;
    }
  }

  console.error(red('error: ') + `Unknown enroll subcommand: ${sub}`);
  console.error(dim('Usage: ashlr enroll [list | add <repo> | remove <repo> | kill on|off]'));
  return 2;
}

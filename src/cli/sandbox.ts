/**
 * `ashlr sandbox` / `ashlr enroll` — M21 Safety Foundation CLI.
 * (`ashlr audit` moved to src/cli/audit.ts in H6 — see docs/contracts/CONTRACT-H6.md §A.3.)
 *
 * Commands:
 *   sandbox list                List all active sandboxes.
 *   sandbox diff <id>           Show the diff of a sandbox vs its base HEAD.
 *   sandbox cleanup <id>        Remove a sandbox worktree and scratch branch.
 *   sandbox gc                  Reclaim STALE orphan sandboxes (crash leftovers).
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
import type {
  Sandbox,
  SandboxCleanupResult,
  SandboxDiff,
  SandboxInventory,
  SandboxSweepResult,
} from '../core/types.js';
import type { PolicyMutationResult } from '../core/sandbox/policy.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe)
// ---------------------------------------------------------------------------

const { bold, dim, red, green, yellow, cyan, gray } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy imports — core/sandbox/worktree.ts (M21)
// ---------------------------------------------------------------------------

type ListSandboxesFn = () => Sandbox[];
type SandboxDiffFn   = (sb: Sandbox) => SandboxDiff;
type RemoveSandboxFn = (sb: Sandbox) => SandboxCleanupResult;
type SandboxInventoryFn = () => SandboxInventory;
// H5 CHANGE 1 — explicit human repair surface for the orphan sweep.
type SweepOrphanSandboxesFn = (opts?: { staleMs?: number }) => string[];
type SweepOrphanSandboxesDetailedFn = (opts?: { staleMs?: number }) => SandboxSweepResult;

let _listSandboxes: ListSandboxesFn | null | undefined = undefined;
let _sandboxDiff:   SandboxDiffFn   | null | undefined = undefined;
let _removeSandbox: RemoveSandboxFn | null | undefined = undefined;
let _sandboxInventory: SandboxInventoryFn | null | undefined = undefined;
let _sweepOrphans:  SweepOrphanSandboxesFn | null | undefined = undefined;
let _sweepOrphansDetailed: SweepOrphanSandboxesDetailedFn | null | undefined = undefined;
// H5 CHANGE 1 — reuse worktree's single-source-of-truth staleness threshold so
// `sandbox gc` and the daemon-start sweep can NEVER drift apart.
let _orphanStaleMs: number | null | undefined = undefined;

async function loadWorktree(): Promise<{
  listSandboxes: ListSandboxesFn;
  sandboxDiff:   SandboxDiffFn;
  removeSandbox: RemoveSandboxFn;
  sandboxInventory: SandboxInventoryFn;
  sweepOrphanSandboxes: SweepOrphanSandboxesFn;
  sweepOrphanSandboxesDetailed: SweepOrphanSandboxesDetailedFn;
  orphanStaleMs: number;
} | null> {
  if (_listSandboxes === undefined) {
    try {
      const mod = await import('../core/sandbox/worktree.js' as unknown as string) as {
        listSandboxes: ListSandboxesFn;
        sandboxDiff:   SandboxDiffFn;
        removeSandbox: RemoveSandboxFn;
        sandboxInventory: SandboxInventoryFn;
        sweepOrphanSandboxes: SweepOrphanSandboxesFn;
        sweepOrphanSandboxesDetailed: SweepOrphanSandboxesDetailedFn;
        ORPHAN_STALE_MS: number;
      };
      _listSandboxes = mod.listSandboxes;
      _sandboxDiff   = mod.sandboxDiff;
      _removeSandbox = mod.removeSandbox;
      _sandboxInventory = mod.sandboxInventory;
      _sweepOrphans  = mod.sweepOrphanSandboxes;
      _sweepOrphansDetailed = mod.sweepOrphanSandboxesDetailed;
      _orphanStaleMs = mod.ORPHAN_STALE_MS;
    } catch {
      _listSandboxes = null;
      _sandboxDiff   = null;
      _removeSandbox = null;
      _sandboxInventory = null;
      _sweepOrphans  = null;
      _sweepOrphansDetailed = null;
      _orphanStaleMs = null;
    }
  }
  if (_listSandboxes === null) return null;
  return {
    listSandboxes: _listSandboxes!,
    sandboxDiff:   _sandboxDiff!,
    removeSandbox: _removeSandbox!,
    sandboxInventory: _sandboxInventory!,
    sweepOrphanSandboxes: _sweepOrphans!,
    sweepOrphanSandboxesDetailed: _sweepOrphansDetailed!,
    orphanStaleMs: _orphanStaleMs!,
  };
}

// H6 (PART A): the `ashlr audit` viewer + its readAudit() lazy-loader moved to
// the dedicated src/cli/audit.ts module (read-only; --action/--result/--since
// filters). The old loadAuditModule/cmdAudit/formatAuditEntry block that lived
// here was removed — see docs/contracts/CONTRACT-H6.md §A.3.

// ---------------------------------------------------------------------------
// Lazy imports — core/sandbox/policy.ts (M21)
// ---------------------------------------------------------------------------

type ListEnrolledFn = () => string[];
type EnrollFn       = (repo: string) => PolicyMutationResult | void;
type UnenrollFn     = (repo: string) => PolicyMutationResult | void;
type KillSwitchOnFn = () => boolean;
type SetKillFn      = (on: boolean) => PolicyMutationResult | void;

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

function policyMutationFailure(
  result: PolicyMutationResult,
  action: string,
): string | null {
  if (result.ok && result.quiesced) return null;
  if (/unsafe/i.test(result.reason)) {
    return `${action} refused: unsafe policy storage (${result.reason}); operator repair is required.`;
  }
  if (!result.quiesced && (result.ok ||
    /fence unavailable|has not quiesced|outward mutation.*active|\bbusy\b/i.test(result.reason))) {
    return `${action} is busy and has not quiesced (${result.reason}); retry the command.`;
  }
  return `${action} refused: policy storage is degraded (${result.reason}); operator repair is required.`;
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
    const inventory = wt.sandboxInventory();
    if (inventory.malformedHomes > 0 || inventory.unsafeEntries > 0) {
      console.error(yellow('warning: ') +
        `${inventory.malformedHomes} malformed sandbox home(s), ` +
        `${inventory.unsafeEntries} unsafe entry/entries require operator inspection.`);
    }
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
      const cleanup = wt.removeSandbox(sb);
      if (cleanup.status === 'complete') {
        console.log(green('✓') + ` Sandbox ${cyan(id)} removed.`);
        return 0;
      }
      console.error(red('error: ') + (cleanup.retryable
        ? `Sandbox cleanup ${cleanup.status}; retry with \`ashlr sandbox cleanup ${id}\`.`
        : `Sandbox cleanup ${cleanup.status}; metadata requires operator inspection.`));
      return 1;
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
    // of-namespace entry is refused and retained for operator recovery).
    // Conservative staleMs (worktree's exported ORPHAN_STALE_MS, > max swarm
    // wall-clock) so a LIVE in-flight worktree is NEVER reclaimed. Inward cleanup
    // only; pushes nothing, opens no PR, applies no proposal.
    const wt = await loadWorktree();
    if (!wt) { moduleNotBuilt('sandbox gc'); return 1; }
    try {
      const sweep = wt.sweepOrphanSandboxesDetailed({ staleMs: wt.orphanStaleMs });
      const unclassified = sweep.inventory.malformedHomes + sweep.inventory.unsafeEntries;
      const failed = sweep.residual.length + sweep.refused.length + sweep.unavailable.length +
        sweep.unexpectedErrors.length + unclassified;
      if (sweep.completed.length === 0 && failed === 0) {
        console.log(dim('No stale orphan sandboxes to reclaim.'));
      } else {
        if (sweep.completed.length > 0) {
          console.log(green('✓') + ` Reclaimed ${cyan(String(sweep.completed.length))} stale orphan sandbox(es).`);
          for (const id of sweep.completed) console.log(`    ${cyan('•')} ${id}`);
        }
        if (failed > 0) {
          console.error(yellow('warning: ') + `${failed} stale sandbox cleanup(s) remain incomplete.`);
          if (unclassified > 0) {
            console.error(yellow('warning: ') + `${unclassified} sandbox filesystem entry(s) require operator inspection.`);
          }
        }
      }
      return failed > 0 ? 1 : 0;
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
      const result = policy.enroll(repo);
      // Older test doubles returned void; real policy mutators return a result.
      const failure = result === undefined ? null : policyMutationFailure(result, 'Enrollment');
      if (failure) {
        console.error(red('error: ') + failure);
        return 1;
      }
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
      const result = policy.unenroll(repo);
      const failure = result === undefined ? null : policyMutationFailure(result, 'Unenrollment');
      if (failure) {
        console.error(red('error: ') + failure);
        return 1;
      }
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
      const result = policy.setKill(val === 'on');
      const failure = result === undefined
        ? null
        : policyMutationFailure(result, val === 'on' ? 'Kill switch pause' : 'Kill switch resume');
      if (failure) {
        console.error(red('error: ') + failure);
        return 1;
      }
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

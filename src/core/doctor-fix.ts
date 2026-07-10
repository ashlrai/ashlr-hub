/**
 * core/doctor-fix.ts — self-healing `ashlr doctor --fix`.
 *
 * fixDoctor(cfg): run runDoctor, then for each failing/warn check whose id
 * is in the SAFE-FIXABLE set, apply ONE safe, local, non-destructive
 * remediation and record a FixAction. Every other failing/warn check gets a
 * FixAction with applied:false, manual:true and a one-line guidance detail.
 *
 * GUARDRAILS (non-negotiable):
 *  - ONLY safe, local, non-destructive fixes.
 *  - NEVER delete or overwrite existing user data.
 *  - NEVER auto-download models (pull stays explicit).
 *  - NEVER modify secrets or shell profiles.
 *  - NEVER do anything outward/network.
 *  - Editor-config writes are backup-first + idempotent (M18 wireEditor).
 *  - Each fix is reversible-ish and logged in FixAction.detail.
 *  - Ambiguous → leave as manual.
 *  - Never throws.
 */

import { existsSync, mkdirSync, symlinkSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AshlrConfig, FixAction } from './types.js';
import { runDoctor } from './doctor.js';
import { defaultConfig, saveConfig } from './config.js';
import { buildIndex, writeIndex } from './index-engine.js';
import { detectEditors, wireEditor } from './integrations/editors.js';

// ---------------------------------------------------------------------------
// SAFE-FIXABLE check ids
// ---------------------------------------------------------------------------

const SAFE_FIXABLE = new Set([
  'config',
  'index',
  'local-bin',
  'genome-memory',
  'mcp-plugin',
]);

// ---------------------------------------------------------------------------
// Individual fix helpers — each returns a FixAction, never throws
// ---------------------------------------------------------------------------

/**
 * Fix: config — create missing ~/.ashlr/config.json from defaultConfig().
 * ONLY when ABSENT; never overwrites an existing config (even a broken one —
 * that's a manual fix to preserve user data).
 */
async function fixConfig(_cfg: AshlrConfig, checkDetail: string): Promise<FixAction> {
  const base: Omit<FixAction, 'applied' | 'detail' | 'manual'> = {
    checkId: 'config',
    label: 'Create missing config file',
  };

  // Resolve the config path from homedir() at call time so a moving HOME (e.g.
  // in tests, or a relocated home dir) is honored — must match the path that
  // saveConfig() actually writes to. The exported CONFIG_PATH constant is
  // resolved once at module load and would point at a stale home here.
  const configPath = join(homedir(), '.ashlr', 'config.json');

  // If the file exists (even if unreadable/malformed), do NOT overwrite.
  if (existsSync(configPath)) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Config file exists but may be invalid (${checkDetail}). Fix JSON syntax errors manually in ${configPath}.`,
    };
  }

  try {
    const defaults = defaultConfig();
    saveConfig(defaults);
    return {
      ...base,
      applied: true,
      manual: false,
      detail: `Created ${configPath} from defaults.`,
    };
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not create ${configPath}: ${String(err)}. Create it manually by running: ashlr init`,
    };
  }
}

/**
 * Fix: index — rebuild a stale/missing ~/.ashlr/index.json.
 * buildIndex + writeIndex is non-destructive (regenerates derived data only).
 */
async function fixIndex(cfg: AshlrConfig): Promise<FixAction> {
  const base: Omit<FixAction, 'applied' | 'detail' | 'manual'> = {
    checkId: 'index',
    label: 'Rebuild stale/missing index',
  };

  try {
    const index = buildIndex(cfg);
    writeIndex(index);
    return {
      ...base,
      applied: true,
      manual: false,
      detail: `Rebuilt index (${index.items.length} item${index.items.length !== 1 ? 's' : ''}) and wrote to ~/.ashlr/index.json.`,
    };
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not rebuild index: ${String(err)}. Run: ashlr index`,
    };
  }
}

/**
 * Fix: local-bin — create the ashlr → ~/.local/bin/ashlr symlink when missing
 * and the source binary resolves. Never modifies shell profiles.
 *
 * If ~/.local/bin/ashlr already exists (broken symlink or stale file), we
 * do NOT overwrite it — that's a manual decision.
 *
 * PATH presence is a separate concern — always manual (shell profile edit).
 */
async function fixLocalBin(): Promise<FixAction> {
  const base: Omit<FixAction, 'applied' | 'detail' | 'manual'> = {
    checkId: 'local-bin',
    label: 'Create ~/.local/bin/ashlr symlink',
  };

  const localBinDir = join(homedir(), '.local', 'bin');
  const symlinkPath = join(localBinDir, 'ashlr');

  // If something already exists at the symlink path (any kind), leave it.
  if (existsSync(symlinkPath)) {
    // Symlink exists and resolves — check PATH separately (manual).
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `${symlinkPath} already exists. If ashlr is not on PATH, add to your shell profile: export PATH="$HOME/.local/bin:$PATH"`,
    };
  }

  // Also check lstat: catches broken symlinks that existsSync misses.
  try {
    lstatSync(symlinkPath);
    // lstat succeeded but existsSync returned false → broken symlink exists.
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `${symlinkPath} is a broken symlink. Remove it manually then re-run: ashlr doctor --fix`,
    };
  } catch {
    // lstatSync threw → path truly does not exist, safe to create.
  }

  // Resolve the source binary path from this module's location.
  // __filename → <repo>/dist/core/doctor-fix.js → source is <repo>/bin/ashlr
  let sourceBin: string;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // dist/core/doctor-fix.js → repo root is two levels up
    const repoRoot = resolve(dirname(thisFile), '..', '..');
    sourceBin = join(repoRoot, 'bin', 'ashlr');

    if (!existsSync(sourceBin)) {
      return {
        ...base,
        applied: false,
        manual: true,
        detail: `Could not locate bin/ashlr (expected at ${sourceBin}). Run install.sh to create the symlink manually.`,
      };
    }
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not resolve bin/ashlr path: ${String(err)}. Run install.sh to create the symlink manually.`,
    };
  }

  // Ensure ~/.local/bin exists.
  try {
    mkdirSync(localBinDir, { recursive: true });
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not create ${localBinDir}: ${String(err)}.`,
    };
  }

  // Create the symlink.
  try {
    symlinkSync(sourceBin, symlinkPath);
    // Success detail intentionally does NOT mention shell-profile PATH edits —
    // creating the symlink is the safe local fix; ensuring ~/.local/bin is on
    // PATH stays a manual shell-profile concern surfaced by the doctor report.
    return {
      ...base,
      applied: true,
      manual: false,
      detail: `Created symlink: ${symlinkPath} -> ${sourceBin}.`,
    };
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not create symlink at ${symlinkPath}: ${String(err)}. Run install.sh manually.`,
    };
  }
}

/**
 * Fix: genome-memory — create ~/.ashlr/genome/ directory when missing.
 * mkdir-only; never seeds or edits entries.
 */
async function fixGenomeMemory(): Promise<FixAction> {
  const base: Omit<FixAction, 'applied' | 'detail' | 'manual'> = {
    checkId: 'genome-memory',
    label: 'Create genome memory directory',
  };

  const genomeDir = join(homedir(), '.ashlr', 'genome');

  if (existsSync(genomeDir)) {
    // Dir exists but genome is empty — that's a content issue, not a structural one.
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Genome directory exists at ${genomeDir} but is empty. Run: ashlr learn  to seed memory.`,
    };
  }

  try {
    mkdirSync(genomeDir, { recursive: true });
    return {
      ...base,
      applied: true,
      manual: false,
      detail: `Created genome directory at ${genomeDir}.`,
    };
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not create genome directory at ${genomeDir}: ${String(err)}.`,
    };
  }
}

/**
 * Fix: mcp-plugin — register the ashlr MCP gateway into a detected editor
 * config via wireEditor (backup-first, idempotent — M18 pattern).
 *
 * Tries each detected editor in order; stops at the first successful wire.
 * If no editor is detected, leaves as manual.
 */
async function fixMcpPlugin(): Promise<FixAction> {
  const base: Omit<FixAction, 'applied' | 'detail' | 'manual'> = {
    checkId: 'mcp-plugin',
    label: 'Register ashlr MCP gateway in editor config',
  };

  let detectedEditors: string[];
  try {
    detectedEditors = detectEditors();
  } catch (err) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: `Could not detect editors: ${String(err)}. Run: ashlr init --wire`,
    };
  }

  if (detectedEditors.length === 0) {
    return {
      ...base,
      applied: false,
      manual: true,
      detail: 'No supported editors detected (claude/codex/cursor). Install one and run: ashlr init --wire',
    };
  }

  const errors: string[] = [];

  for (const editor of detectedEditors) {
    // wireEditor only accepts the three known targets; skip unknown values.
    if (editor !== 'claude' && editor !== 'codex' && editor !== 'cursor') continue;

    try {
      const result = await wireEditor(editor, {});
      if (result.ok) {
        return {
          ...base,
          applied: true,
          manual: false,
          detail: `Wired ashlr MCP gateway into ${editor} config: ${result.detail}`,
        };
      }
      errors.push(`${editor}: ${result.detail}`);
    } catch (err) {
      errors.push(`${editor}: ${String(err)}`);
    }
  }

  // All attempts failed.
  return {
    ...base,
    applied: false,
    manual: true,
    detail: `Could not auto-wire MCP plugin (${errors.join('; ')}). Run: ashlr init --wire`,
  };
}

/**
 * Produce a manual-only FixAction for a check that has no safe auto-fix.
 * Uses the check's existing `fix` hint as guidance.
 */
function manualAction(checkId: string, label: string, fix?: string): FixAction {
  return {
    checkId,
    label,
    applied: false,
    manual: true,
    detail: fix ?? `Manual action required — see: ashlr doctor for details.`,
  };
}

// ---------------------------------------------------------------------------
// fixDoctor
// ---------------------------------------------------------------------------

/**
 * Run runDoctor(cfg), then for each failing or warn check:
 *  - If the check id is in SAFE_FIXABLE: apply the safe automated remediation.
 *  - Otherwise: return a manual FixAction with the check's fix hint.
 *
 * Pass-status checks produce no FixAction.
 * Returns FixAction[] in check display order.
 * Never throws.
 */
/**
 * H5 CHANGE 1 — `doctor --fix` orphan-sweep hook. Reclaims STALE crash-leftover
 * sandbox worktrees (the same primitive the daemon runs at start + `sandbox gc`
 * exposes). LOCAL + non-destructive: sweepOrphanSandboxes routes every removal
 * through removeSandbox's containment guards (re-derived safe path + branch; a
 * tampered/out-of-namespace entry is refused and retained for operator recovery)
 * and the conservative ORPHAN_STALE_MS guard means a LIVE in-flight worktree is
 * NEVER reclaimed — only genuine crash leftovers. Pushes nothing, opens no PR,
 * applies no proposal. Lazy-imports the build-optional worktree module and never
 * throws (degrades to a manual note). Returns a synthetic FixAction.
 */
async function fixSandboxOrphans(): Promise<FixAction> {
  const checkId = 'sandbox-orphans';
  const label = 'Reclaim stale orphan sandboxes';
  try {
    const wt = await import('./sandbox/worktree.js');
    const sweep = wt.sweepOrphanSandboxesDetailed({ staleMs: wt.ORPHAN_STALE_MS });
    const swept = sweep.completed;
    const incomplete = sweep.residual.length + sweep.refused.length + sweep.unavailable.length +
      sweep.unexpectedErrors.length + sweep.inventory.malformedHomes + sweep.inventory.unsafeEntries;
    return {
      checkId,
      label,
      applied: swept.length > 0,
      manual: incomplete > 0,
      detail:
        incomplete > 0
          ? `Reclaimed ${swept.length} sandbox(es); ${incomplete} entry/entries require operator inspection. Try: ashlr sandbox gc`
          : swept.length === 0
          ? 'No stale orphan sandboxes to reclaim.'
          : `Reclaimed ${swept.length} stale orphan sandbox(es): ${swept.join(', ')}`,
    };
  } catch (err) {
    return {
      checkId,
      label,
      applied: false,
      manual: true,
      detail: `Could not sweep orphan sandboxes: ${String(err)}. Try: ashlr sandbox gc`,
    };
  }
}

export async function fixDoctor(cfg: AshlrConfig): Promise<FixAction[]> {
  let report;
  try {
    report = await runDoctor(cfg);
  } catch (err) {
    // runDoctor itself is documented to never throw, but belt-and-suspenders.
    return [
      {
        checkId: '_internal',
        label: 'Run doctor',
        applied: false,
        manual: true,
        detail: `Could not run doctor: ${String(err)}. Try: ashlr doctor`,
      },
    ];
  }

  const actions: FixAction[] = [];

  for (const check of report.checks) {
    // Pass checks need no action.
    if (check.status === 'pass') continue;

    if (!SAFE_FIXABLE.has(check.id)) {
      // Not in the safe-fixable set → always manual.
      actions.push(manualAction(check.id, check.label, check.fix));
      continue;
    }

    // Apply the appropriate safe fix.
    let action: FixAction;
    try {
      switch (check.id) {
        case 'config':
          action = await fixConfig(cfg, check.detail);
          break;
        case 'index':
          action = await fixIndex(cfg);
          break;
        case 'local-bin':
          action = await fixLocalBin();
          break;
        case 'genome-memory':
          action = await fixGenomeMemory();
          break;
        case 'mcp-plugin':
          action = await fixMcpPlugin();
          break;
        default:
          // Should not be reachable given the SAFE_FIXABLE guard above.
          action = manualAction(check.id, check.label, check.fix);
      }
    } catch (err) {
      // Belt-and-suspenders: individual fix helpers should never throw,
      // but if one does, degrade to manual rather than crashing.
      action = {
        checkId: check.id,
        label: check.label,
        applied: false,
        manual: true,
        detail: `Fix failed unexpectedly: ${String(err)}. Manual action: ${check.fix ?? 'see ashlr doctor'}`,
      };
    }

    actions.push(action);
  }

  // H5 CHANGE 1 — always-run orphan sweep (independent of doctor checks): reclaim
  // stale crash-leftover sandboxes. Safe + local + non-destructive (see helper).
  actions.push(await fixSandboxOrphans());

  return actions;
}

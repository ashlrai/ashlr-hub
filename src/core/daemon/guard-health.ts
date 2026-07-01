/**
 * Read-only guard health diagnosis for daemon/autonomy repair UX.
 *
 * This module reports safety guards that explain why autonomous work is blocked
 * or likely to fail closed. It never repairs or probes by writing files.
 */

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { evidenceDir } from '../autonomy/evidence-pack.js';
import { killSwitchOn, killSwitchPath } from '../sandbox/policy.js';
import { loadDaemonStateStrict, readDaemonSpendGuard } from './state.js';

export type GuardHealthBlockId =
  | 'daemon-state-malformed'
  | 'daemon-spend-guard-armed'
  | 'daemon-spend-guard-malformed'
  | 'kill-switch'
  | 'autonomy-evidence-unwritable';

export interface GuardHealthBlock {
  id: GuardHealthBlockId;
  detail: string;
  path: string;
  repairCommands: string[];
}

export interface GuardHealthDiagnosis {
  generatedAt: string;
  blocked: boolean;
  blocks: GuardHealthBlock[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function backupCommand(path: string): string {
  return `mv ${shellQuote(path)} ${shellQuote(`${path}.bak`)}`;
}

function nearestExistingPath(path: string): string | null {
  let current = path;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isWritableDirectory(path: string): { ok: true } | { ok: false; detail: string; repairCommands: string[] } {
  try {
    if (existsSync(path)) {
      const st = statSync(path);
      if (!st.isDirectory()) {
        return {
          ok: false,
          detail: 'autonomy evidence path exists but is not a directory',
          repairCommands: [backupCommand(path), `mkdir -p ${shellQuote(path)}`],
        };
      }
      accessSync(path, constants.W_OK | constants.X_OK);
      return { ok: true };
    }

    const parent = nearestExistingPath(dirname(path));
    if (!parent) {
      return {
        ok: false,
        detail: 'no existing parent directory for autonomy evidence path',
        repairCommands: [`mkdir -p ${shellQuote(path)}`],
      };
    }
    const st = statSync(parent);
    if (!st.isDirectory()) {
      return {
        ok: false,
        detail: `autonomy evidence parent is not a directory: ${parent}`,
        repairCommands: [backupCommand(parent), `mkdir -p ${shellQuote(path)}`],
      };
    }
    accessSync(parent, constants.W_OK | constants.X_OK);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail: `autonomy evidence path is not writable: ${msg}`,
      repairCommands: [`mkdir -p ${shellQuote(path)}`, `chmod u+rwx ${shellQuote(path)}`],
    };
  }
}

function fallbackDiagnosis(generatedAt: string, err: unknown): GuardHealthDiagnosis {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    generatedAt,
    blocked: true,
    blocks: [
      {
        id: 'daemon-state-malformed',
        detail: `guard health diagnosis failed closed: ${msg}`,
        path: '',
        repairCommands: ['ashlr doctor'],
      },
    ],
  };
}

/**
 * Diagnose daemon/autonomy guard state. Never mutates and never throws.
 */
export function diagnoseGuardHealth(): GuardHealthDiagnosis {
  const generatedAt = new Date().toISOString();
  try {
    const blocks: GuardHealthBlock[] = [];

    const daemonState = loadDaemonStateStrict();
    if (!daemonState.ok) {
      blocks.push({
        id: 'daemon-state-malformed',
        detail: `daemon state is ${daemonState.reason}: ${daemonState.error}`,
        path: daemonState.path,
        repairCommands: [backupCommand(daemonState.path), 'ashlr daemon status'],
      });
    }

    const spendGuard = readDaemonSpendGuard();
    if (spendGuard.exists) {
      if (spendGuard.malformed || !spendGuard.guard) {
        blocks.push({
          id: 'daemon-spend-guard-malformed',
          detail: spendGuard.error
            ? `daemon spend guard is malformed or unreadable: ${spendGuard.error}`
            : 'daemon spend guard is malformed',
          path: spendGuard.path,
          repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
        });
      } else {
        blocks.push({
          id: 'daemon-spend-guard-armed',
          detail: `daemon spend guard armed at ${spendGuard.guard.armedAt} for ${spendGuard.guard.itemIds.length} item(s)`,
          path: spendGuard.path,
          repairCommands: ['ashlr daemon stop', backupCommand(spendGuard.path), 'ashlr daemon status'],
        });
      }
    }

    if (killSwitchOn()) {
      blocks.push({
        id: 'kill-switch',
        detail: 'global kill switch is engaged; autonomous dispatch is paused',
        path: killSwitchPath(),
        repairCommands: ['ashlr fleet resume'],
      });
    }

    const evidencePath = evidenceDir();
    const evidence = isWritableDirectory(evidencePath);
    if (!evidence.ok) {
      blocks.push({
        id: 'autonomy-evidence-unwritable',
        detail: evidence.detail,
        path: evidencePath,
        repairCommands: evidence.repairCommands,
      });
    }

    return {
      generatedAt,
      blocked: blocks.length > 0,
      blocks,
    };
  } catch (err) {
    return fallbackDiagnosis(generatedAt, err);
  }
}

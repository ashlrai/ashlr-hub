/**
 * Soft-offer Locus firm profile during production onboard / first-repo enroll.
 *
 * M4 always-on firm (opt-in only — NEVER monorepo/CI default):
 *   - If `locus` CLI is available and `config.locus.firm` is not already true,
 *     recommend enabling firm so pre-mutate / CI session gates resolve to enforce.
 *   - TTY interactive: confirm y/N (default N).
 *   - Non-interactive (`--yes` / non-TTY): set only when explicitly requested via
 *     `--locus-firm` or env `ASHLR_LOCUS_FIRM=1` (also accepts true/yes).
 *   - Absent those signals: skip. CI and tests stay firm=off by default.
 *
 * Writes via loadConfig + saveConfig (existing config APIs). Never throws.
 */

import { loadConfig, saveConfig } from '../core/config.js';
import {
  extractLocusConfigFirm,
  locusAvailable as locusAvailableProbe,
} from '../core/integrations/locus.js';
import type { AshlrConfig } from '../core/types.js';
import { makeColors, isTty } from './ui.js';

const { bold, dim, green, cyan, yellow } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Test seams — injectable so unit tests never hang on readline or PATH
// ---------------------------------------------------------------------------

export type FirmOfferDecision =
  | 'set'
  | 'skip'
  | 'already'
  | 'locus-absent'
  | 'declined';

export interface FirmOfferResult {
  decision: FirmOfferDecision;
  detail: string;
}

export interface FirmOfferOptions {
  /**
   * Non-interactive mode (`--yes` or non-TTY guidance). When true, firm is
   * enabled only if `locusFirmFlag` or `ASHLR_LOCUS_FIRM` is set — never by
   * default (CI-safe).
   */
  yes?: boolean;
  /** Explicit `--locus-firm` CLI flag. */
  locusFirmFlag?: boolean;
  /**
   * True when this is the first-repo enrollment path or the guided `ashlr
   * onboard` activation. Callers gate when to invoke; this is for messaging.
   */
  context?: 'onboard' | 'enroll-first';
  /** Env override (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Whether stdin is a TTY (defaults to process.stdin.isTTY). */
  isInteractive?: boolean;
}

/**
 * Injectable seams for tests. Production always uses real implementations.
 * `confirm` must not hang — callers that already own a prompt seam should
 * point this at the same seam (e.g. onboard `_internals.confirm`).
 */
export const _firmOfferInternals: {
  locusAvailable: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  loadConfig: () => AshlrConfig;
  saveConfig: (cfg: AshlrConfig) => void;
  log: (...args: unknown[]) => void;
} = {
  locusAvailable: locusAvailableProbe,
  confirm: defaultConfirm,
  loadConfig,
  saveConfig,
  log: (...args: unknown[]) => {
    console.log(...args);
  },
};

/** Interactive y/N confirm; false on non-TTY (fail closed for firm enable). */
async function defaultConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline');
  return new Promise<boolean>((resolveP) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question + ' [y/N] ', (answer) => {
      rl.close();
      resolveP(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Parse `ASHLR_LOCUS_FIRM` / similar: truthy only for 1 / true / yes (case-insensitive).
 * Absent, empty, 0, false → false.
 */
export function envRequestsLocusFirm(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ASHLR_LOCUS_FIRM;
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Detect `--locus-firm` in a CLI argv tail (not `--locus-firm=false`). */
export function argsRequestLocusFirm(args: string[]): boolean {
  return args.includes('--locus-firm');
}

/**
 * Soft-offer enabling `config.locus.firm = true`.
 *
 * Decision table:
 * | locus missing     | skip (locus-absent) |
 * | already firm      | already             |
 * | --locus-firm / ASHLR_LOCUS_FIRM | set (no prompt) |
 * | TTY + !yes        | confirm → set|declined |
 * | yes / non-TTY     | skip (never force)  |
 */
export async function maybeOfferLocusFirm(
  opts: FirmOfferOptions = {},
): Promise<FirmOfferResult> {
  try {
    if (!_firmOfferInternals.locusAvailable()) {
      return {
        decision: 'locus-absent',
        detail: 'locus CLI not on PATH — firm profile not offered',
      };
    }

    const cfg = _firmOfferInternals.loadConfig();
    if (extractLocusConfigFirm(cfg)) {
      return {
        decision: 'already',
        detail: 'locus.firm already true',
      };
    }

    const env = opts.env ?? process.env;
    const yes = opts.yes === true;
    const flag = opts.locusFirmFlag === true;
    const envOn = envRequestsLocusFirm(env);
    const interactive =
      opts.isInteractive ?? Boolean(process.stdin.isTTY);

    // Explicit opt-in: flag or env — works with --yes and non-TTY.
    if (flag || envOn) {
      return writeFirm(cfg, opts.context, flag ? '--locus-firm' : 'ASHLR_LOCUS_FIRM');
    }

    // Non-interactive / --yes without explicit opt-in: NEVER force firm.
    if (yes || !interactive) {
      return {
        decision: 'skip',
        detail:
          'non-interactive: firm left off (pass --locus-firm or ASHLR_LOCUS_FIRM=1 to enable)',
      };
    }

    // TTY soft recommend.
    _firmOfferInternals.log('');
    _firmOfferInternals.log(
      bold('  Locus firm profile') +
        dim('  (optional — production fleets)'),
    );
    _firmOfferInternals.log('');
    _firmOfferInternals.log(
      `  ${dim('When enabled, hub pre-mutate / CI session gates resolve to')}` +
        ` ${cyan('enforce')}`,
    );
    _firmOfferInternals.log(
      `  ${dim('when LOCUS_ENFORCE is unset. Monorepo CI stays off unless you opt in.')}`,
    );
    _firmOfferInternals.log(
      `  ${dim('You can change this later:')} ${cyan('ashlr config set locus.firm true|false')}`,
    );
    _firmOfferInternals.log('');

    const ok = await _firmOfferInternals.confirm(
      `  Enable Locus firm profile (locus.firm=true)?`,
    );
    if (!ok) {
      _firmOfferInternals.log(
        `  ${dim('Firm left off. Enable anytime with')} ${cyan('ashlr config set locus.firm true')}`,
      );
      _firmOfferInternals.log('');
      return { decision: 'declined', detail: 'operator declined firm profile' };
    }
    return writeFirm(cfg, opts.context, 'confirm');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Never block onboard/enroll on firm offer failure.
    return { decision: 'skip', detail: `firm offer failed: ${msg}` };
  }
}

function writeFirm(
  cfg: AshlrConfig,
  context: FirmOfferOptions['context'],
  via: string,
): FirmOfferResult {
  const next: AshlrConfig = {
    ...cfg,
    locus: {
      ...(cfg.locus ?? {}),
      firm: true,
    },
  };
  _firmOfferInternals.saveConfig(next);
  _firmOfferInternals.log('');
  _firmOfferInternals.log(
    `  ${green('✓')} ${bold('locus.firm=true')}` +
      dim(`  (${via}${context ? `, ${context}` : ''})`),
  );
  _firmOfferInternals.log(
    `  ${yellow('→')} ${dim('Identity gates: env LOCUS_ENFORCE wins; else firm → enforce')}`,
  );
  _firmOfferInternals.log('');
  return {
    decision: 'set',
    detail: `locus.firm set true via ${via}`,
  };
}

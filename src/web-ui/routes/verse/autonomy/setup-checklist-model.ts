/**
 * routes/verse/autonomy/setup-checklist-model.ts — the live setup checklist,
 * read from GET /api/verse/authority/setup (the server's own
 * `ashlr authority setup --dry-run --json`, AuthoritySetupReportV1).
 *
 * It answers three things for the "Autonomy is off" state and onboarding:
 *   - how far setup is (every step, done ✓ or not, what each needs from you);
 *   - the ONE next step and the exact command that moves it on;
 *   - whether the next step is approving the grant — the only time Verse asks
 *     the server to draft one (the Touch ID sheet, on click). Before that the
 *     draft route answers 409 `no-trust-roots`, so it is never read on load.
 *
 * Framework-free; tested directly.
 */
import type { AuthoritySetupNeed, AuthoritySetupReportV1, AuthoritySetupStepV1 } from '../../../../core/authority/types.js';

export const AUTHORITY_SETUP_PATH = '/api/verse/authority/setup';

/** The one command that walks every step, resuming where the last run stopped. */
export const SETUP_COMMAND = 'ashlr authority setup';

/** Reruns of setup happen in a terminal; a minute-old checklist is fine, and the server caches 30 s. */
export const SETUP_FRESH_MS = 30_000;
export const SETUP_POLL_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Structural guard: the schema tag, and steps shaped enough to render. */
export function narrowSetupReport(raw: unknown): AuthoritySetupReportV1 | null {
  if (!isRecord(raw) || raw['schema'] !== 'ashlr.authority-setup.v1' || !Array.isArray(raw['steps'])) return null;
  const ok = (raw['steps'] as unknown[]).every((s) => isRecord(s) && typeof s['id'] === 'string' && typeof s['step'] === 'string' && typeof s['status'] === 'string' && Array.isArray(s['needs']));
  return ok ? (raw as unknown as AuthoritySetupReportV1) : null;
}

/**
 * Where setup stands, as the "Autonomy is off" state needs it:
 * `ready` — everything before the standing grant is in place, so approving
 *           it (Touch ID, on Command) is the next step;
 * `setup` — an earlier step is open: the checklist's next action;
 * `unknown` — the checklist did not answer.
 * Undefined while the read is in flight.
 */
export type SetupReadiness = 'ready' | 'setup' | 'unknown';

export function setupReadiness(read: { value: AuthoritySetupReportV1 | null } | undefined): SetupReadiness | undefined {
  if (!read) return undefined;
  if (!read.value) return 'unknown';
  return read.value.next === 'standing-grant' ? 'ready' : 'setup';
}

export const NEED_LABEL: Readonly<Record<AuthoritySetupNeed, string>> = Object.freeze({
  sudo: 'sudo',
  'touch-id': 'Touch ID',
  browser: 'Browser',
  github: 'GitHub',
  terminal: 'Terminal',
});

export type SetupRowMark = 'done' | 'next' | 'todo' | 'blocked' | 'failed';

export interface SetupRow {
  id: string;
  /** "GitHub App", "Custody helper" — the CLI's step name, sentence-cased. */
  label: string;
  mark: SetupRowMark;
  needs: { id: AuthoritySetupNeed; label: string }[];
  detail: string;
  command: string | null;
  link: string | null;
}

function label(step: string): string {
  return step.length > 0 ? step[0]!.toUpperCase() + step.slice(1) : step;
}

function markOf(step: AuthoritySetupStepV1, next: string | null): SetupRowMark {
  if (step.status === 'done' || step.status === 'already') return 'done';
  if (step.id === next) return step.status === 'failed' ? 'failed' : step.status === 'blocked' ? 'blocked' : 'next';
  if (step.status === 'failed') return 'failed';
  if (step.status === 'blocked') return 'blocked';
  return 'todo';
}

export function setupRows(report: AuthoritySetupReportV1): SetupRow[] {
  return report.steps.map((step) => ({
    id: step.id,
    label: label(step.step),
    mark: markOf(step, report.next),
    needs: step.needs.filter((n): n is AuthoritySetupNeed => n in NEED_LABEL).map((n) => ({ id: n, label: NEED_LABEL[n] })),
    detail: step.detail,
    command: step.command ?? null,
    link: step.link ?? null,
  }));
}

/**
 * A step's detail as the CLI wrote it ("run `sudo scripts/install-custody.sh`
 * from …"), split so commands in backticks render as code, first letter
 * capitalised — the CLI prints it after "step: ", Verse on its own line.
 */
export function detailParts(detail: string): { text: string; code: boolean }[] {
  const pieces = detail.split(/`([^`\n]+)`/u);
  const parts = pieces.map((text, i) => ({ text, code: i % 2 === 1 })).filter((p) => p.text.length > 0);
  const first = parts[0];
  if (first && !first.code) parts[0] = { text: first.text[0]!.toUpperCase() + first.text.slice(1), code: false };
  return parts;
}

/** A step's page, only when it is a plain https://github.com/ address (the App's install page, the trust-root PR). */
export function safeSetupLink(link: string | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** "6 of 15 ready" — steps done or already in place. */
export function setupProgress(report: AuthoritySetupReportV1): { ready: number; total: number } {
  return { ready: report.steps.filter((s) => s.status === 'done' || s.status === 'already').length, total: report.steps.length };
}

/** The next step's row, or null when every step is in place. */
export function nextRow(report: AuthoritySetupReportV1): SetupRow | null {
  return setupRows(report).find((row) => row.id === report.next) ?? null;
}

/**
 * The command to copy for the next step: the step's own (sudo for the
 * helper, the build after the trust-root PR, …), else the setup command
 * (rerun-safe, it resumes where it stopped). A blocked step offers only the
 * command it names itself (e.g. the grant that unblocks the resident step);
 * null when nothing on this Mac moves it (not a compiled release, …).
 */
export function nextCommand(report: AuthoritySetupReportV1 | null): string | null {
  if (!report) return SETUP_COMMAND;
  const row = nextRow(report);
  if (!row) return null;
  if (row.mark === 'blocked') return row.command;
  return row.command ?? SETUP_COMMAND;
}

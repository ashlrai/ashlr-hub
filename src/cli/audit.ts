/**
 * `ashlr audit` — READ-ONLY audit-trail viewer (Ashlr v2.1 MILESTONE H6, PART A).
 *
 * Tails the append-only JSONL audit trail (newest-first) written by
 * `core/sandbox/audit.ts`. MUTATES NOTHING. No outward call. No model. The only
 * thing this command does is READ `~/.ashlr/audit/<date>.jsonl` via `readAudit()`
 * and print / filter it — see docs/contracts/CONTRACT-H6.md §A.3.
 *
 * H6 MOVES the viewer here from `cli/sandbox.ts` (where a minimal `cmdAudit`
 * lived) and EXTENDS it with `--action` / `--result` / `--since` filters. The
 * dispatcher's `loadAuditCmd` (src/cli/index.ts) is re-pointed at this module;
 * the old `cmdAudit`/`formatAuditEntry`/`loadAuditModule` block in
 * `cli/sandbox.ts` is removed in the implementation step.
 *
 * Flags (ALL read-only):
 *   --limit N | -n N | N   Cap to the newest N records (applied AFTER filters).
 *   --json                 Emit the records as a JSON array.
 *   --action <verb>        Filter by action; `--action enroll` matches `enroll:*`,
 *                          `--action kill:on` matches exactly.            [H6 NEW]
 *   --result <ok|refused|error>  Filter by outcome.                        [H6 NEW]
 *   --since <ISO|YYYY-MM-DD>     Drop records with ts strictly before this. [H6 NEW]
 *
 * Returns 0 on success, 2 on bad args (unknown flag / unparseable --since),
 * 1 when the audit core module is not built.
 */

import { makeColors, isTty } from './ui.js';
import type { AuditEntry } from '../core/types.js';

// ---------------------------------------------------------------------------
// ANSI helpers (non-TTY safe) — same palette as cli/sandbox.ts
// ---------------------------------------------------------------------------

const { bold, dim, red, green, yellow } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy import — core/sandbox/audit.ts (M21). Mirrors cli/sandbox.ts's pattern so
// a not-yet-built core surfaces the standard moduleNotBuilt message (return 1).
// ---------------------------------------------------------------------------

type ReadAuditFn = (limit?: number) => AuditEntry[];

let _readAudit: ReadAuditFn | null | undefined = undefined;

async function loadReadAudit(): Promise<ReadAuditFn | null> {
  if (_readAudit === undefined) {
    try {
      const mod = (await import('../core/sandbox/audit.js' as unknown as string)) as {
        readAudit: ReadAuditFn;
      };
      _readAudit = mod.readAudit;
    } catch {
      _readAudit = null;
    }
  }
  return _readAudit ?? null;
}

function moduleNotBuilt(): void {
  console.error(
    red('error: ') + 'audit requires src/core/sandbox/ (M21 module not yet built).',
  );
}

// ---------------------------------------------------------------------------
// Parsed options
// ---------------------------------------------------------------------------

interface AuditViewOptions {
  limit?: number;
  json: boolean;
  /** Action filter — bare verb (matches `verb:*`) or exact `verb:sub`. */
  action?: string;
  /** Outcome filter. */
  result?: AuditEntry['result'];
  /** Epoch-ms lower bound (records with ts < this are dropped). */
  sinceMs?: number;
}

/**
 * Parse argv into AuditViewOptions. Returns `{ error }` for bad args so the
 * caller can print usage + return 2 (read NOTHING — never touch disk on bad args).
 *
 * The action/result/since values parsed here drive the read-only post-filter in
 * applyFilters(). See docs/contracts/CONTRACT-H6.md §A.3.
 */
function parseArgs(args: string[]): AuditViewOptions | { error: string } {
  const opts: AuditViewOptions = { json: false };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--limit' || a === '-n') && args[i + 1] !== undefined) {
      const n = parseInt(args[i + 1]!, 10);
      if (!isNaN(n) && n > 0) {
        opts.limit = n;
        i++;
      } else {
        return { error: `invalid --limit value: ${args[i + 1]}` };
      }
    } else if (a === '--json') {
      opts.json = true;
    } else if (a === '--action' && args[i + 1] !== undefined) {
      opts.action = args[i + 1];
      i++;
    } else if (a === '--result' && args[i + 1] !== undefined) {
      const v = args[i + 1]!;
      if (v !== 'ok' && v !== 'refused' && v !== 'error') {
        return { error: `invalid --result value: ${v} (expected ok|refused|error)` };
      }
      opts.result = v;
      i++;
    } else if (a === '--since' && args[i + 1] !== undefined) {
      const v = args[i + 1]!;
      const ms = Date.parse(v);
      if (isNaN(ms)) {
        return { error: `invalid --since value: ${v} (expected ISO timestamp or YYYY-MM-DD)` };
      }
      opts.sinceMs = ms;
      i++;
    } else if (/^\d+$/.test(a ?? '')) {
      // Positional numeric shorthand: `ashlr audit 20`
      opts.limit = parseInt(a!, 10);
    } else {
      return { error: `unknown argument: ${a}` };
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Filtering (READ-ONLY post-filter over readAudit() output)
// ---------------------------------------------------------------------------

/**
 * Apply the H6 action/result/since filters to an already-loaded record list,
 * THEN cap to `limit` (so the result is "newest N MATCHING"). Read-only — never
 * touches disk.
 *
 * Filter order: action → result → since, then slice(0, limit) LAST so the
 * result is "newest N MATCHING". See docs/contracts/CONTRACT-H6.md §A.3.
 */
function applyFilters(entries: AuditEntry[], opts: AuditViewOptions): AuditEntry[] {
  // READ-ONLY post-filter over readAudit()'s output — touches NO disk. Filters
  // are applied FIRST (action → result → since), THEN `--limit` last, so the
  // result is "the newest N records MATCHING the filters". See CONTRACT-H6 §A.3.
  let out = entries;

  if (opts.action !== undefined) {
    const want = opts.action;
    // A bare verb (no ':') matches every `verb:*` sub-action (e.g. `enroll`
    // matches `enroll:add` + `enroll:remove`); a `verb:sub` value matches exactly.
    const prefixMatch = !want.includes(':');
    out = out.filter((e) =>
      prefixMatch ? e.action === want || e.action.startsWith(`${want}:`) : e.action === want,
    );
  }

  if (opts.result !== undefined) {
    out = out.filter((e) => e.result === opts.result);
  }

  if (opts.sinceMs !== undefined) {
    const floor = opts.sinceMs;
    // Drop records whose ts is STRICTLY before the bound. An unparseable ts in a
    // record is treated as not-after-the-floor and dropped (it cannot prove it is
    // newer); readAudit() only yields string `ts`, so this is defensive.
    out = out.filter((e) => {
      const t = Date.parse(e.ts);
      return !isNaN(t) && t >= floor;
    });
  }

  // `--limit` LAST: newest-N of the already-filtered set (readAudit() is newest-first).
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

// ---------------------------------------------------------------------------
// Pretty printer (non-TTY safe) — carried over from cli/sandbox.ts
// ---------------------------------------------------------------------------

// READ-TIME TRUST CONTRACT (H6 review finding, §A.3): this viewer prints
// entry.summary / entry.repo / entry.sandboxId verbatim (and re-emits all fields
// in --json) WITHOUT re-running stripSecrets on read. That is correct by design:
// the SOLE secret-scrub enforcement point is audit() WRITE-TIME
// (core/sandbox/audit.ts) which runs stripSecrets() over `summary` before append.
// `repo`/`sandboxId` are METADATA-ONLY by the audit() contract (an abs repo path
// or a sandbox id — never a token), so re-scrubbing on read would be redundant on
// `summary` and would not cover `repo`/`sandboxId` anyway. The invariant the
// viewer relies on: every audit() CALL SITE (current and future) MUST keep tokens
// out of `repo`/`sandboxId`; the H6 sites pass repo=abs-path, sandboxId=null.
function formatAuditEntry(entry: AuditEntry): string {
  const resultColor =
    entry.result === 'ok'
      ? green(entry.result)
      : entry.result === 'refused'
        ? yellow(entry.result)
        : red(entry.result);

  const ts = dim(entry.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z'));
  const action = bold(entry.action);
  const repo = entry.repo ? dim(` repo=${entry.repo}`) : '';
  const sbId = entry.sandboxId ? dim(` sandbox=${entry.sandboxId}`) : '';

  return `${ts}  [${resultColor}]  ${action}  ${entry.summary}${repo}${sbId}`;
}

// ---------------------------------------------------------------------------
// cmdAudit — the command entry point
// ---------------------------------------------------------------------------

export async function cmdAudit(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if ('error' in parsed) {
    console.error(red('error: ') + parsed.error);
    console.error(
      dim(
        'Usage: ashlr audit [N | --limit N] [--json] [--action <verb>] ' +
          '[--result ok|refused|error] [--since <ISO|YYYY-MM-DD>]',
      ),
    );
    return 2;
  }

  const readAudit = await loadReadAudit();
  if (!readAudit) {
    moduleNotBuilt();
    return 1;
  }

  // Read ALL records (limit is applied AFTER filtering in applyFilters), then
  // filter read-only. readAudit() itself is unchanged + never throws.
  const all = readAudit();
  const entries = applyFilters(all, parsed);

  if (parsed.json) {
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

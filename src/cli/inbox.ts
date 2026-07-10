/**
 * `ashlr inbox` — Approval Inbox CLI (M23).
 *
 * The single human control plane for every proposed outward action. PENDING
 * proposals NEVER auto-apply. The ONLY path to applyProposal is the explicit
 * `inbox approve <id> [--yes]` subcommand, with a confirm gate.
 *
 * Subcommands:
 *   inbox                    List PENDING proposals + counts by status.
 *   inbox show <id>          Full detail of one proposal incl. diff (read-only).
 *   inbox approve <id>       Confirm gate, setStatus approved, then applyProposal.
 *   inbox approve <id> --yes Skip interactive prompt (requires TTY check; non-TTY
 *                            with no --yes refuses — no silent auto-approve).
 *   inbox reject <id>        Mark rejected; applies nothing.
 *
 * Flags:
 *   --yes    Skip interactive confirm prompt (approve only; non-TTY w/o --yes refuses).
 *   --json   Emit raw JSON for list / show / approve result.
 *
 * Non-TTY: approve without --yes refuses (no auto-approve, ever).
 * READ-ONLY except for approve (which routes through the single applyProposal gate).
 */

import { makeColors, pad } from './ui.js';
import type { Proposal, ProposalStatus } from '../core/types.js';

// ---------------------------------------------------------------------------
// M70: ashlr-md render seam (lazy — degrades when ashlr-md not installed)
// ---------------------------------------------------------------------------

type PresentMarkdownFn = (
  title: string,
  body: string,
) => { rendered: boolean; path?: string; detail: string };

let _presentMarkdown: PresentMarkdownFn | null | undefined;

async function loadMarkdownModule(): Promise<PresentMarkdownFn | null> {
  if (_presentMarkdown === undefined) {
    try {
      const mod = await import('../core/integrations/markdown.js') as {
        presentMarkdown: PresentMarkdownFn;
      };
      _presentMarkdown = mod.presentMarkdown;
    } catch {
      _presentMarkdown = null;
    }
  }
  return _presentMarkdown ?? null;
}

/**
 * Build a clean Markdown document for a proposal.
 * Pure function — no side effects, safe to unit-test directly.
 */
export function buildProposalMarkdown(p: Proposal): string {
  const lines: string[] = [];

  lines.push(`## Metadata\n`);
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **Title** | ${p.title} |`);
  lines.push(`| **ID** | \`${p.id}\` |`);
  lines.push(`| **Kind** | ${p.kind} |`);
  lines.push(`| **Status** | ${p.status} |`);
  lines.push(`| **Origin** | ${p.origin} |`);
  if (p.repo) lines.push(`| **Repo** | ${p.repo} |`);
  const pRec = p as unknown as Record<string, unknown>;
  if (pRec['engineModel']) {
    lines.push(`| **Engine** | ${pRec['engineModel'] as string} |`);
  }
  if (pRec['engineTier']) {
    lines.push(`| **Tier** | ${pRec['engineTier'] as string} |`);
  }
  lines.push(`| **Created** | ${p.createdAt} |`);
  if (p.decidedAt) lines.push(`| **Decided** | ${p.decidedAt} |`);
  if (p.sandboxId) lines.push(`| **Sandbox** | \`${p.sandboxId}\` |`);

  lines.push(``);
  lines.push(`## Summary\n`);
  lines.push(p.summary);

  if (p.diff) {
    lines.push(``);
    lines.push(`## Diff\n`);
    lines.push('```diff');
    lines.push(p.diff);
    lines.push('```');
  }

  if (p.status === 'pending') {
    lines.push(``);
    lines.push(`## Actions\n`);
    lines.push(`- Approve: \`ashlr inbox approve ${p.id.slice(0, 12)}\``);
    lines.push(`- Reject:  \`ashlr inbox reject ${p.id.slice(0, 12)}\``);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Lazy loaders — degrade gracefully if inbox modules not yet built
// ---------------------------------------------------------------------------

type ListProposalsFn  = (filter?: { status?: ProposalStatus }) => Proposal[];
type LoadProposalFn   = (id: string) => Proposal | null;
type SetStatusFn      = (id: string, status: ProposalStatus, result?: string) => void;
type PendingCountFn   = () => number;
type ApplyProposalFn  = (id: string, opts: { confirmed: boolean }) => Promise<import('../core/types.js').ApplyResult>;
type AutoMergeResult  = { ok: boolean; merged: boolean; handoff?: boolean; reason: string; prUrl?: string };
type AutoMergeFn      = (id: string, cfg: import('../core/types.js').AshlrConfig) => Promise<AutoMergeResult>;

let _listProposals:  ListProposalsFn  | null | undefined;
let _loadProposal:   LoadProposalFn   | null | undefined;
let _setStatus:      SetStatusFn      | null | undefined;
let _pendingCount:   PendingCountFn   | null | undefined;
let _applyProposal:  ApplyProposalFn  | null | undefined;
let _autoMerge:      AutoMergeFn      | null | undefined;

async function loadStoreModule(): Promise<boolean> {
  if (_listProposals === undefined) {
    try {
      const mod = await import('../core/inbox/store.js') as {
        listProposals:  ListProposalsFn;
        loadProposal:   LoadProposalFn;
        setStatus:      SetStatusFn;
        pendingCount:   PendingCountFn;
      };
      _listProposals = mod.listProposals;
      _loadProposal  = mod.loadProposal;
      _setStatus     = mod.setStatus;
      _pendingCount  = mod.pendingCount;
    } catch {
      _listProposals = null;
      _loadProposal  = null;
      _setStatus     = null;
      _pendingCount  = null;
    }
  }
  return _listProposals !== null;
}

async function loadApplyModule(): Promise<boolean> {
  if (_applyProposal === undefined) {
    try {
      const mod = await import('../core/inbox/apply.js') as {
        applyProposal: ApplyProposalFn;
      };
      _applyProposal = mod.applyProposal;
    } catch {
      _applyProposal = null;
    }
  }
  return _applyProposal !== null;
}

async function loadMergeModule(): Promise<boolean> {
  if (_autoMerge === undefined) {
    try {
      const mod = await import('../core/inbox/merge.js') as {
        autoMergeProposal: AutoMergeFn;
      };
      _autoMerge = mod.autoMergeProposal;
    } catch {
      _autoMerge = null;
    }
  }
  return _autoMerge !== null;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<ProposalStatus, string> = {
  pending:  'pending',
  approved: 'approved',
  rejected: 'rejected',
  'awaiting-host-merge': 'host-pr',
  applied:  'applied',
  failed:   'failed',
};

type ColKey = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'magenta' | 'gray';

const STATUS_COLORS: Record<ProposalStatus, ColKey> = {
  pending:  'yellow',
  approved: 'cyan',
  rejected: 'dim',
  'awaiting-host-merge': 'magenta',
  applied:  'green',
  failed:   'red',
};

const KIND_COLORS: Record<string, ColKey> = {
  patch:  'blue',
  pr:     'cyan',
  deploy: 'magenta',
  note:   'gray',
};

/** Relative age string from an ISO timestamp. */
function relAge(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000)        return 'just now';
    if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)}h ago`;
    return `${Math.floor(ms / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}

/** Shorten an absolute repo path for display. */
function shortRepo(repo: string | null): string {
  if (!repo) return '(none)';
  const home = process.env['HOME'] ?? '';
  const s = home ? repo.replace(home, '~') : repo;
  const parts = s.split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : s;
}

/** Describe what approve will do, for the confirm gate. */
function describeApplyAction(p: Proposal): string {
  switch (p.kind) {
    case 'patch':
      return `apply a patch on a NEW local branch in ${shortRepo(p.repo)} (no push, local only)`;
    case 'pr':
      return `create a branch + commit, then open a PR in ${shortRepo(p.repo)} via gh CLI`;
    case 'deploy':
      return `run the gated ship/deploy path for ${shortRepo(p.repo)}`;
    case 'note':
      return 'record a note (no-op, no repo mutation)';
    case 'desktop-action': {
      const da = p.action?.type !== 'browser-task' ? p.action : undefined;
      return `open ${da?.target ?? shortRepo(p.repo)} in your ${da?.type?.replace('open-', '') ?? 'desktop'} (local, no repo mutation)`;
    }
    case 'browser-action': {
      const ba = p.action?.type === 'browser-task' ? p.action : undefined;
      const urlPart = ba?.url ? ` at ${ba.url}` : '';
      return `run a gated browser task${urlPart} via Claude-in-Chrome MCP (requires approval)`;
    }
  }
}

/** Print a table of proposals. */
function printTable(proposals: Proposal[], tty: boolean): void {
  const col = makeColors(tty);

  if (proposals.length === 0) {
    console.log(col.dim('  (no proposals)'));
    return;
  }

  const idW     = 12;  // first 12 chars of id
  const kindW   = 7;   // 'deploy' = 6
  const statusW = 8;   // 'approved' = 8
  const repoW   = Math.min(28, Math.max(8, ...proposals.map(p => shortRepo(p.repo).length)));
  const ageW    = 10;
  const titleW  = Math.min(55, Math.max(10, ...proposals.map(p => p.title.length)));

  const hdr = [
    col.bold(pad('ID',     idW)),
    col.bold(pad('KIND',   kindW)),
    col.bold(pad('STATUS', statusW)),
    col.bold(pad('REPO',   repoW)),
    col.bold(pad('AGE',    ageW)),
    col.bold('TITLE'),
  ].join('  ');

  console.log('');
  console.log('  ' + hdr);
  console.log('  ' + col.dim('─'.repeat(idW + kindW + statusW + repoW + ageW + titleW + 10)));

  for (const p of proposals) {
    const kindColor  = KIND_COLORS[p.kind]   ?? 'cyan';
    const statColor  = STATUS_COLORS[p.status] ?? 'dim';
    const kindFn     = col[kindColor]  as (s: string) => string;
    const statFn     = col[statColor]  as (s: string) => string;

    const idShort = p.id.slice(0, idW);
    const age     = relAge(p.createdAt);
    const title   = p.title.length > titleW
      ? p.title.slice(0, titleW - 1) + '…'
      : p.title;

    const row = [
      col.dim(pad(idShort, idW)),
      kindFn(pad(p.kind, kindW)),
      statFn(pad(STATUS_LABELS[p.status] ?? p.status, statusW)),
      col.dim(pad(shortRepo(p.repo), repoW)),
      col.dim(pad(age, ageW)),
      title,
    ].join('  ');

    console.log('  ' + row);
  }
  console.log('');
}

/** Print a status summary line: counts by status. */
function printStatusCounts(proposals: Proposal[], tty: boolean): void {
  const col = makeColors(tty);
  const counts: Partial<Record<ProposalStatus, number>> = {};
  for (const p of proposals) {
    counts[p.status] = (counts[p.status] ?? 0) + 1;
  }

  const all: ProposalStatus[] = ['pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed'];
  const parts = all
    .filter(s => (counts[s] ?? 0) > 0)
    .map(s => {
      const n = counts[s] ?? 0;
      const colorFn = col[STATUS_COLORS[s]] as (s: string) => string;
      return colorFn(`${n} ${s}`);
    });

  if (parts.length === 0) {
    console.log(col.dim('  Inbox is empty.'));
  } else {
    console.log('  ' + col.bold('Counts:') + '  ' + parts.join(col.dim('  ·  ')));
  }
  console.log('');
}

/** Interactive readline confirm (y/N). Resolves false if stdin is not a TTY. */
async function promptConfirmAsync(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const readline = await import('node:readline');
  return new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });
    rl.question(question + ' [y/N] ', (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// Subcommand: list (default)
// ---------------------------------------------------------------------------

async function cmdInboxList(jsonMode: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const storeOk = await loadStoreModule();
  if (!storeOk || !_listProposals || !_pendingCount) {
    console.error(col.red('error: ') + 'inbox requires src/core/inbox/store.ts (M23 module not yet built).');
    return 1;
  }

  const all      = _listProposals();
  const pending  = _listProposals({ status: 'pending' });

  if (jsonMode) {
    console.log(JSON.stringify({ proposals: pending, counts: buildCounts(all) }, null, 2));
    return 0;
  }

  const pendingN = pending.length;
  console.log('');
  console.log(
    col.bold('  ashlr inbox') +
    col.dim(` — ${pendingN} pending proposal${pendingN !== 1 ? 's' : ''}` +
      `  ·  ${all.length} total`),
  );

  if (pendingN === 0) {
    printStatusCounts(all, tty);
    console.log(col.dim('  No pending proposals.'));
    console.log(col.dim('  Proposals are created here by the autonomous org (M24+) or `ashlr backlog`.'));
    console.log('');
    return 0;
  }

  printTable(pending, tty);
  printStatusCounts(all, tty);
  console.log(col.dim('  Use `ashlr inbox show <id>` for full detail.  Add --open to view in ashlr-md.'));
  console.log(col.dim('  Use `ashlr inbox approve <id>` to approve and apply.'));
  console.log(col.dim('  Use `ashlr inbox reject <id>` to discard.'));
  console.log('');

  return 0;
}

function buildCounts(proposals: Proposal[]): Record<ProposalStatus, number> {
  const counts: Record<ProposalStatus, number> = {
    pending: 0, approved: 0, rejected: 0, 'awaiting-host-merge': 0, applied: 0, failed: 0,
  };
  for (const p of proposals) {
    counts[p.status] = (counts[p.status] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Subcommand: show <id>
// ---------------------------------------------------------------------------

async function cmdInboxShow(id: string, jsonMode: boolean, openMd: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  const storeOk = await loadStoreModule();
  if (!storeOk || !_loadProposal) {
    console.error(col.red('error: ') + 'inbox requires src/core/inbox/store.ts (M23 module not yet built).');
    return 1;
  }

  if (!id) {
    console.error(col.red('error: ') + 'Usage: ashlr inbox show <id> [--open]');
    return 2;
  }

  // Resolve by prefix (mirrors approve/reject)
  const p = resolveProposal(id);
  if (!p) {
    console.error(col.red('error: ') + `Proposal not found: ${id}`);
    return 1;
  }

  if (jsonMode) {
    console.log(JSON.stringify(p, null, 2));
    return 0;
  }

  // ── M70: open in ashlr-md viewer when --open / --md is set ──────────────
  if (openMd) {
    const presentFn = await loadMarkdownModule();
    if (presentFn) {
      const mdBody = buildProposalMarkdown(p);
      const result = presentFn(p.title, mdBody);
      if (result.rendered && result.path) {
        console.log(col.cyan('  opened in ashlr-md: ') + result.path);
        return 0;
      }
      // rendered:false → fall through to terminal rendering below
    }
    // markdown module unavailable or viewer not installed → terminal fallback
  }

  const kindColor = KIND_COLORS[p.kind]    ?? 'cyan';
  const statColor = STATUS_COLORS[p.status] ?? 'dim';
  const kindFn    = col[kindColor]  as (s: string) => string;
  const statFn    = col[statColor]  as (s: string) => string;

  console.log('');
  console.log(col.bold('  Proposal: ') + col.dim(p.id));
  console.log('  ' + col.bold('Title:   ') + p.title);
  console.log('  ' + col.bold('Kind:    ') + kindFn(p.kind));
  console.log('  ' + col.bold('Status:  ') + statFn(p.status));
  console.log('  ' + col.bold('Origin:  ') + p.origin);
  console.log('  ' + col.bold('Repo:    ') + col.dim(shortRepo(p.repo)));
  console.log('  ' + col.bold('Created: ') + col.dim(p.createdAt + '  (' + relAge(p.createdAt) + ')'));
  if (p.decidedAt) {
    console.log('  ' + col.bold('Decided: ') + col.dim(p.decidedAt + '  (' + relAge(p.decidedAt) + ')'));
  }
  if (p.sandboxId) {
    console.log('  ' + col.bold('Sandbox: ') + col.dim(p.sandboxId));
  }
  if (p.result) {
    console.log('  ' + col.bold('Result:  ') + p.result);
  }
  console.log('');
  console.log('  ' + col.bold('Summary:'));
  for (const line of p.summary.split('\n')) {
    console.log('    ' + line);
  }
  console.log('');

  if (p.diff) {
    console.log('  ' + col.bold('Diff:'));
    // Print diff with simple coloring: + lines green, - lines red, @@ cyan.
    for (const line of p.diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        process.stdout.write('    ' + col.green(line) + '\n');
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        process.stdout.write('    ' + col.red(line) + '\n');
      } else if (line.startsWith('@@')) {
        process.stdout.write('    ' + col.cyan(line) + '\n');
      } else {
        process.stdout.write('    ' + col.dim(line) + '\n');
      }
    }
    console.log('');
  } else {
    console.log('  ' + col.dim('(no diff attached)'));
    console.log('');
  }

  if (p.status === 'pending') {
    console.log(col.dim('  Approve: ') + col.cyan(`ashlr inbox approve ${p.id.slice(0, 12)}`));
    console.log(col.dim('  Reject:  ') + col.cyan(`ashlr inbox reject  ${p.id.slice(0, 12)}`));
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: approve <id> [--yes]
// ---------------------------------------------------------------------------

async function cmdInboxApprove(id: string, yes: boolean, jsonMode: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  // Guard: non-TTY without --yes refuses
  if (!tty && !yes) {
    const msg = 'non-TTY: inbox approve requires --yes to prevent silent auto-approval';
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(col.red('error: ') + msg);
      console.error(col.dim('  Use `ashlr inbox approve <id> --yes` in non-interactive environments.'));
    }
    return 2;
  }

  if (!id) {
    console.error(col.red('error: ') + 'Usage: ashlr inbox approve <id> [--yes]');
    return 2;
  }

  const storeOk = await loadStoreModule();
  if (!storeOk || !_loadProposal || !_setStatus) {
    console.error(col.red('error: ') + 'inbox requires src/core/inbox/store.ts (M23 module not yet built).');
    return 1;
  }

  // Load proposal — resolve by prefix if needed
  const p = resolveProposal(id);
  if (!p) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: `Proposal not found: ${id}` }));
    } else {
      console.error(col.red('error: ') + `Proposal not found: ${id}`);
    }
    return 1;
  }

  // Must be pending OR already-approved (not yet applied) to proceed.
  // A proposal already in 'approved' state (e.g. approved earlier but not yet
  // applied) can still be applied — we skip the re-decision but run the gate.
  // Refuse only terminal/rejected states: rejected / applied / failed.
  if (p.status !== 'pending' && p.status !== 'approved') {
    const msg = `Proposal ${p.id.slice(0, 12)} is ${p.status}, not pending — nothing to approve.`;
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg, status: p.status }));
    } else {
      console.error(col.yellow('warning: ') + msg);
    }
    return p.status === 'applied' ? 0 : 1;
  }

  if (p.isPartial === true) {
    const msg = `Proposal ${p.id.slice(0, 12)} is partial review evidence and cannot be approved or applied.`;
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg, status: p.status }));
    } else {
      console.error(col.yellow('warning: ') + msg);
    }
    return 1;
  }

  // ── Confirm gate ──────────────────────────────────────────────────────────
  if (!jsonMode) {
    const kindColor = KIND_COLORS[p.kind] ?? 'cyan';
    const kindFn    = col[kindColor] as (s: string) => string;
    console.log('');
    console.log(col.bold('  Approve proposal:'));
    console.log('    ' + col.bold('ID:     ') + col.dim(p.id.slice(0, 12)));
    console.log('    ' + col.bold('Kind:   ') + kindFn(p.kind));
    console.log('    ' + col.bold('Title:  ') + p.title);
    console.log('    ' + col.bold('Action: ') + describeApplyAction(p));
    if (p.repo) {
      console.log('    ' + col.bold('Repo:   ') + col.dim(shortRepo(p.repo)));
    }
    console.log('');
    if (p.kind === 'patch') {
      console.log('  ' + col.yellow('Note: a new local branch will be created. No push, no PR. Local only.'));
    } else if (p.kind === 'pr') {
      console.log('  ' + col.yellow('Note: this will create a PR via gh CLI (outward action).'));
    } else if (p.kind === 'deploy') {
      console.log('  ' + col.yellow('Note: this will trigger the ship/deploy gate (outward action).'));
    }
    console.log('');
  }

  if (!yes) {
    const confirmed = await promptConfirmAsync(
      `  Approve and apply this ${p.kind} proposal?`,
    );
    if (!confirmed) {
      if (!jsonMode) {
        console.log(col.dim('  Aborted — proposal remains pending.'));
        console.log('');
      } else {
        console.log(JSON.stringify({ ok: false, error: 'aborted by user' }));
      }
      return 0;
    }
  }

  // ── Transition status to approved ────────────────────────────────────────
  _setStatus(p.id, 'approved');

  // ── Load apply module and run ─────────────────────────────────────────────
  const applyOk = await loadApplyModule();
  if (!applyOk || !_applyProposal) {
    // apply module not built yet — mark back to pending + report
    _setStatus(p.id, 'pending'); // revert
    const msg = 'inbox/apply.ts not yet built — approval reverted to pending';
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(col.red('error: ') + msg);
    }
    return 1;
  }

  if (!jsonMode) {
    process.stdout.write(col.dim('  Applying…') + (tty ? '\r' : '\n'));
  }

  const result = await _applyProposal(p.id, { confirmed: true });

  if (tty && !jsonMode) {
    process.stdout.write('\x1b[2K\r');
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    console.log(col.green('  ✓ Applied: ') + result.detail);
    console.log('');
  } else {
    console.error(col.red('  ✗ Failed: ') + result.detail);
    console.log('');
    return 1;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: reject <id>
// ---------------------------------------------------------------------------

async function cmdInboxReject(id: string, jsonMode: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  if (!id) {
    console.error(col.red('error: ') + 'Usage: ashlr inbox reject <id>');
    return 2;
  }

  const storeOk = await loadStoreModule();
  if (!storeOk || !_setStatus) {
    console.error(col.red('error: ') + 'inbox requires src/core/inbox/store.ts (M23 module not yet built).');
    return 1;
  }

  const p = resolveProposal(id);
  if (!p) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: `Proposal not found: ${id}` }));
    } else {
      console.error(col.red('error: ') + `Proposal not found: ${id}`);
    }
    return 1;
  }

  if (p.status !== 'pending') {
    const msg = `Proposal ${p.id.slice(0, 12)} is already ${p.status}.`;
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg, status: p.status }));
    } else {
      console.error(col.yellow('warning: ') + msg);
    }
    return 1;
  }

  _setStatus(p.id, 'rejected');

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, id: p.id, status: 'rejected' }));
  } else {
    console.log(col.dim('  Proposal ') + col.bold(p.id.slice(0, 12)) + col.dim(' rejected.'));
    console.log('');
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Subcommand: automerge <id> (M47 — tiered-trust merge-to-main gate)
// ---------------------------------------------------------------------------

/**
 * `ashlr inbox automerge <id>` — attempt an autonomous merge of a frontier
 * proposal to the default branch. This is a thin shell: every safety gate
 * (enabled, frontier merge-authority, risk ≤ maxRisk, full verification, kill
 * switch, enrollment) is enforced inside autoMergeProposal, which NEVER throws
 * and mutates NOTHING on any refusal. No bypass flag is offered here.
 */
async function cmdInboxAutoMerge(id: string, jsonMode: boolean): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  if (!id) {
    console.error(col.red('error: ') + 'Usage: ashlr inbox automerge <id> [--json]');
    return 2;
  }

  const storeOk = await loadStoreModule();
  if (!storeOk || !_loadProposal || !_listProposals) {
    console.error(col.red('error: ') + 'inbox requires src/core/inbox/store.ts (M23 module not yet built).');
    return 1;
  }

  const p = resolveProposal(id);
  if (!p) {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: `Proposal not found: ${id}` }));
    } else {
      console.error(col.red('error: ') + `Proposal not found: ${id}`);
    }
    return 1;
  }

  const mergeOk = await loadMergeModule();
  if (!mergeOk || !_autoMerge) {
    const msg = 'inbox/merge.ts not yet built (M47 module unavailable).';
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(col.red('error: ') + msg);
    }
    return 1;
  }

  // Load the active config so the gate can read cfg.foundry.autoMerge / mergeAuthority.
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await import('../core/config.js') as {
      loadConfig: () => import('../core/types.js').AshlrConfig;
    };
    cfg = loadConfig();
  } catch {
    const msg = 'could not load config (src/core/config.ts).';
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: msg }));
    } else {
      console.error(col.red('error: ') + msg);
    }
    return 1;
  }

  if (!jsonMode) {
    process.stdout.write(col.dim('  Evaluating auto-merge gates…') + (tty ? '\r' : '\n'));
  }

  const result = await _autoMerge(p.id, cfg);

  if (tty && !jsonMode) {
    process.stdout.write('\x1b[2K\r');
  }

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (result.merged) {
    console.log(col.green('  ✓ Auto-merged: ') + result.reason);
    if (result.prUrl) console.log(col.dim('    PR: ') + result.prUrl);
    console.log('');
    return 0;
  }

  if (result.handoff) {
    console.log(col.green('  ✓ PR handed off: ') + result.reason);
    if (result.prUrl) console.log(col.dim('    PR: ') + result.prUrl);
    console.log('');
    return 0;
  }

  console.error(col.yellow('  ✗ Not merged: ') + result.reason);
  console.log('');
  return 1;
}

// ---------------------------------------------------------------------------
// ID resolution — accept full id or an unambiguous prefix
// ---------------------------------------------------------------------------

function resolveProposal(idOrPrefix: string): Proposal | null {
  if (!_loadProposal || !_listProposals) return null;

  // Try exact match first
  const exact = _loadProposal(idOrPrefix);
  if (exact) return exact;

  // Try prefix match
  const all = _listProposals();
  const matches = all.filter(p => p.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) {
    console.error(makeColors(process.stdout.isTTY === true).red('error: ') +
      `Ambiguous id prefix "${idOrPrefix}" matches ${matches.length} proposals. Use more characters.`);
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * `ashlr inbox [show|approve|reject] [id] [--yes] [--json]`
 *
 * Returns a process exit code (0 = success, non-zero = error/usage).
 */
export async function cmdInbox(args: string[]): Promise<number> {
  const tty = process.stdout.isTTY === true;
  const col = makeColors(tty);

  // ── Parse args ─────────────────────────────────────────────────────────
  let subcmd = 'list';
  let targetId = '';
  let yes = false;
  let jsonMode = false;
  let openMd = false;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes') {
      yes = true;
    } else if (a === '--json') {
      jsonMode = true;
    } else if (a === '--open' || a === '--md') {
      // M70: open proposal in ashlr-md viewer (show subcommand only)
      openMd = true;
    } else if (a?.startsWith('-')) {
      console.error(col.red('error: ') + `Unknown flag: ${a}`);
      console.error(col.dim('Usage: ashlr inbox [show|approve|reject|automerge] [<id>] [--yes] [--json] [--open]'));
      return 2;
    } else {
      positionals.push(a);
    }
  }

  if (positionals.length > 0) {
    const first = positionals[0];
    if (first === 'show' || first === 'approve' || first === 'reject' || first === 'automerge') {
      subcmd    = first;
      targetId  = positionals[1] ?? '';
    } else {
      // Treat bare positional as an id for show (convenience)
      subcmd   = 'show';
      targetId = first;
    }
  }

  switch (subcmd) {
    case 'list':
      return cmdInboxList(jsonMode);
    case 'show':
      return cmdInboxShow(targetId, jsonMode, openMd);
    case 'approve':
      return cmdInboxApprove(targetId, yes, jsonMode);
    case 'reject':
      return cmdInboxReject(targetId, jsonMode);
    case 'automerge':
      return cmdInboxAutoMerge(targetId, jsonMode);
    default:
      console.error(col.red('error: ') + `Unknown inbox subcommand: ${subcmd}`);
      console.error(col.dim('Usage: ashlr inbox [show|approve|reject|automerge] [<id>] [--yes] [--json] [--open]'));
      return 2;
  }
}

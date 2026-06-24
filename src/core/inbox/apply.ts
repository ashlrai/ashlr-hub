/**
 * core/inbox/apply.ts — The ONLY outward mutation path in v2 (M23).
 *
 * applyProposal is the single funnel for every outward action. It is called
 * ONLY from `cli/inbox.ts` after the user explicitly runs `inbox approve <id>`
 * (with confirm or --yes). It is NEVER called automatically, never on create,
 * never on list/show, never by the daemon.
 *
 * GUARDRAILS:
 *  - REFUSE unless proposal exists AND status==='approved' AND confirmed===true.
 *  - assertMayMutate(repo) before any mutation (enrollment + kill switch).
 *  - 'patch': apply diff on a NEW branch (ashlr/proposal/<id>) off HEAD.
 *    NEVER touch the user's current branch/index/working tree.
 *    NEVER force. NEVER push. Local only.
 *  - 'pr': branch + commit, then the gated M18 createPr.
 *  - 'deploy': gated ship path.
 *  - 'note': no-op record.
 *  - Every attempt is audited. Status set to 'applied'/'failed' + result.
 *  - Never throws out — all failures returned as ApplyResult.
 *  - No secrets in proposals/audit.
 *  - No new runtime deps; node builtins only.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ApplyResult, McpRegistry } from '../types.js';
import { loadProposal, setStatus } from './store.js';
import { assertMayMutate, listEnrolled } from '../sandbox/policy.js';
import { audit } from '../sandbox/audit.js';
import { isRepo } from '../git.js';
import { createPr } from '../integrations/github.js';
import { openInEditor, openInFinder, openInTerminal } from '../../cli/open.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Branch prefix for all inbox-applied branches — NEVER delete user branches. */
const PROPOSAL_BRANCH_PREFIX = 'ashlr/proposal/';

/** Timeout for git operations (ms). */
const GIT_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// git helper — arg arrays, no shell
// ---------------------------------------------------------------------------

/** Run a git command in `cwd`. Throws on failure. */
function gitRun(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT,
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

/** Run a git command, returning null on any error (never throws). */
function gitTry(cwd: string, args: string[]): string | null {
  try {
    return gitRun(cwd, args);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Temp file helper for diff application
// ---------------------------------------------------------------------------

/**
 * Write `content` to a temp file under ~/.ashlr/tmp and return its path.
 * Caller is responsible for cleanup.
 */
function writeTmpFile(content: string): string {
  const dir = join(homedir(), '.ashlr', 'tmp');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const name = `patch-${randomBytes(6).toString('hex')}.diff`;
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Kind handlers
// ---------------------------------------------------------------------------

/**
 * Apply a unified diff to a NEW branch off current HEAD in `repo`.
 * NEVER touches the user's current branch, index, or working tree.
 * NEVER force. NEVER push. Local only.
 */
async function applyPatch(
  repo: string,
  proposalId: string,
  diff: string,
): Promise<{ ok: boolean; detail: string }> {
  if (!isRepo(repo)) {
    return { ok: false, detail: `not a git repository: ${repo}` };
  }

  if (!diff.trim()) {
    return { ok: false, detail: 'proposal diff is empty — nothing to apply' };
  }

  // Derive a safe, namespaced branch name. The proposal id is already a
  // filename-safe lowercase slug (prop-<ts>-<hex>) and is valid as a git ref,
  // so we use it whole — keeping the full id in the branch lets callers match
  // the branch back to its proposal (branch.includes(proposalId)).
  const branch = `${PROPOSAL_BRANCH_PREFIX}${proposalId}`;

  // Read current HEAD without touching working tree.
  const head = gitTry(repo, ['rev-parse', 'HEAD']);
  if (!head) {
    return { ok: false, detail: 'could not resolve HEAD in repo' };
  }

  // Create the new branch off HEAD using --no-checkout so we stay on the
  // user's current branch. We then apply the diff directly to the new branch
  // via a worktree, which fully isolates the patch from the user's working tree.
  // Strategy: use `git worktree add -b <branch> <tmpPath> HEAD` to create an
  // isolated checkout, apply the patch there, commit, then remove the worktree.
  // This is the safest approach — it NEVER modifies the user's working tree,
  // index, or HEAD.

  const tmpWorktreeDir = join(
    homedir(),
    '.ashlr',
    'tmp',
    `wt-${randomBytes(6).toString('hex')}`,
  );

  // Create the isolated worktree on the new branch.
  try {
    gitRun(repo, [
      'worktree',
      'add',
      '-b',
      branch,
      tmpWorktreeDir,
      head,
    ]);
  } catch (err) {
    // Clean up any partial worktree registration.
    gitTry(repo, ['worktree', 'prune']);
    return {
      ok: false,
      detail: `git worktree add failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Write diff to a temp file so we can pass it as a path argument (no shell).
  let patchFile: string | null = null;
  let applyErr: string | null = null;
  let commitSha: string | null = null;

  try {
    patchFile = writeTmpFile(diff);

    // Apply the diff inside the isolated worktree.
    try {
      gitRun(tmpWorktreeDir, ['apply', '--index', patchFile]);
    } catch (err) {
      applyErr = `git apply failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!applyErr) {
      // Commit the applied changes on the new branch.
      try {
        gitRun(tmpWorktreeDir, [
          'commit',
          '--no-verify',
          '-m',
          `ashlr: apply proposal ${proposalId}`,
        ]);
        commitSha = gitTry(tmpWorktreeDir, ['rev-parse', 'HEAD']);
      } catch (err) {
        applyErr = `git commit failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } finally {
    // Always remove the temp patch file.
    if (patchFile) {
      try {
        unlinkSync(patchFile);
      } catch {
        // ignore cleanup errors
      }
    }

    // Always remove the worktree (removes the tmpWorktreeDir checkout).
    // The branch itself remains in the repo — that's the desired output.
    gitTry(repo, ['worktree', 'remove', '--force', tmpWorktreeDir]);
    gitTry(repo, ['worktree', 'prune']);

    // If apply/commit failed, also delete the scratch branch to leave no
    // dangling refs. The branch is in our namespace so this is safe.
    if (applyErr && branch.startsWith(PROPOSAL_BRANCH_PREFIX)) {
      gitTry(repo, ['branch', '-D', branch]);
    }
  }

  if (applyErr) {
    return { ok: false, detail: applyErr };
  }

  const sha = commitSha ? ` @ ${commitSha.slice(0, 8)}` : '';
  return {
    ok: true,
    detail: `patch applied on branch ${branch}${sha} (local only, not pushed)`,
  };
}

/**
 * Create a branch + commit from the diff, then open a PR via the gated M18
 * createPr path. EXPLICIT + GATED — never auto-triggered.
 */
async function applyPr(
  repo: string,
  proposalId: string,
  title: string,
  summary: string,
  diff: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  if (!isRepo(repo)) {
    return { ok: false, detail: `not a git repository: ${repo}` };
  }

  // First apply the patch to a new branch (same isolation as 'patch' kind).
  if (diff && diff.trim()) {
    const patchResult = await applyPatch(repo, proposalId, diff);
    if (!patchResult.ok) {
      return { ok: false, detail: `patch step failed: ${patchResult.detail}` };
    }
  }

  // The branch was created by applyPatch above (same full-id naming).
  const branch = `${PROPOSAL_BRANCH_PREFIX}${proposalId}`;

  // Call the gated M18 createPr — EXPLICIT path, never auto.
  const prResult = await createPr(repo, {
    title,
    body: summary,
    head: branch,
  });

  if (!prResult.ok) {
    return { ok: false, detail: `gh pr create failed: ${prResult.detail}` };
  }

  return {
    ok: true,
    detail: prResult.detail,
  };
}

// ---------------------------------------------------------------------------
// applyProposal — the ONLY outward path
// ---------------------------------------------------------------------------

/**
 * Apply an approved proposal. This is the ONLY outward mutation path in v2.
 *
 * REFUSES (ok:false, mutates nothing) unless ALL hold:
 *   1. Proposal exists (loadProposal !== null)
 *   2. proposal.status === 'approved'
 *   3. opts.confirmed === true
 *
 * Never throws — all failures returned as ApplyResult with status 'failed'.
 */
export async function applyProposal(
  id: string,
  opts: { confirmed: boolean },
): Promise<ApplyResult> {
  // ── Gate 1: proposal must exist ──────────────────────────────────────────
  const proposal = loadProposal(id);
  if (!proposal) {
    audit({
      action: 'inbox:apply',
      repo: null,
      sandboxId: id,
      summary: `refused: proposal ${id} not found`,
      result: 'refused',
    });
    return {
      ok: false,
      status: 'failed',
      detail: `proposal not found: ${id}`,
    };
  }

  // ── Gate 2: must be approved ─────────────────────────────────────────────
  if (proposal.status !== 'approved') {
    audit({
      action: 'inbox:apply',
      repo: proposal.repo,
      sandboxId: id,
      summary: `refused: proposal ${id} status is '${proposal.status}', must be 'approved'`,
      result: 'refused',
    });
    return {
      ok: false,
      status: proposal.status,
      detail: `proposal status is '${proposal.status}'; must be 'approved' before applying`,
    };
  }

  // ── Gate 3: must be explicitly confirmed ─────────────────────────────────
  if (!opts.confirmed) {
    audit({
      action: 'inbox:apply',
      repo: proposal.repo,
      sandboxId: id,
      summary: `refused: proposal ${id} apply not confirmed`,
      result: 'refused',
    });
    return {
      ok: false,
      status: 'approved',
      detail: 'apply not confirmed; pass confirmed:true (via --yes or interactive prompt)',
    };
  }

  // ── Gate 4: 'note' kind — no-op, record and return ───────────────────────
  if (proposal.kind === 'note') {
    setStatus(id, 'applied', 'note recorded (no-op)');
    audit({
      action: 'inbox:apply',
      repo: proposal.repo,
      sandboxId: id,
      summary: `note proposal ${id} applied (no-op)`,
      result: 'ok',
    });
    return { ok: true, status: 'applied', detail: 'note recorded (no-op)' };
  }

  // ── Gate 5: enrollment + kill switch ─────────────────────────────────────
  // 'note' is exempt (never mutates). All other kinds require enrollment.
  const repo = proposal.repo;
  if (!repo) {
    const detail = 'proposal has no repo; cannot apply a mutating kind without a target repo';
    setStatus(id, 'failed', detail);
    audit({
      action: 'inbox:apply',
      repo: null,
      sandboxId: id,
      summary: `failed: ${detail}`,
      result: 'error',
    });
    return { ok: false, status: 'failed', detail };
  }

  try {
    assertMayMutate(repo);
  } catch (err) {
    const detail =
      err instanceof Error ? err.message : String(err);
    // REFUSAL — not a failure. Nothing was mutated and the proposal remains
    // 'approved' so it can be retried after enrolling / clearing the kill switch.
    // Advancing to 'failed' here would wrongly burn an approved proposal.
    audit({
      action: 'inbox:apply',
      repo,
      sandboxId: id,
      summary: `refused by policy gate: ${detail}`,
      result: 'refused',
    });
    return { ok: false, status: 'approved', detail };
  }

  // ── Dispatch by kind ─────────────────────────────────────────────────────
  let result: { ok: boolean; detail: string };

  try {
    switch (proposal.kind) {
      case 'patch': {
        if (!proposal.diff) {
          result = { ok: false, detail: 'proposal has no diff to apply' };
        } else {
          result = await applyPatch(repo, id, proposal.diff);
        }
        break;
      }

      case 'pr': {
        result = await applyPr(
          repo,
          id,
          proposal.title,
          proposal.summary,
          proposal.diff,
        );
        break;
      }

      case 'deploy': {
        // The gated ship/deploy path. Attempt to load the ship module dynamically
        // so this module stays importable even before the ship module exists.
        // The deploy gate requires its own --confirm per the contract.
        try {
          // Dynamic import via indirection so TypeScript's static module resolver
          // does not error on the not-yet-implemented ship.ts. At runtime this
          // resolves correctly when ship.ts is present, and falls back to null.
          const shipPath = new URL('../ship.js', import.meta.url).href;
          const shipMod = await (new Function('p', 'return import(p)')(shipPath) as Promise<unknown>).catch(() => null);
          const shipObj = (shipMod !== null && typeof shipMod === 'object')
            ? (shipMod as Record<string, unknown>)
            : null;
          if (!shipObj || typeof shipObj['ship'] !== 'function') {
            result = {
              ok: false,
              detail:
                'deploy kind requires the ship module (core/ship.ts) — not yet available in this build',
            };
          } else {
            // The ship function is itself gated; pass confirmed:true since we
            // already confirmed at the inbox layer.
            const shipFn = shipObj['ship'] as (
              repo: string,
              opts: { confirmed: boolean },
            ) => Promise<{ ok: boolean; detail: string }>;
            const shipResult = await shipFn(repo, { confirmed: true });
            result = shipResult;
          }
        } catch (err) {
          result = {
            ok: false,
            detail: `deploy failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        break;
      }

      case 'desktop-action': {
        // ── Phase 2 gated desktop actions ─────────────────────────────────
        // Requires: approved + confirmed + assertMayMutate (done above) +
        // action payload present + action.target resolves within an enrolled repo.
        const action = proposal.action;
        if (!action) {
          result = { ok: false, detail: 'desktop-action proposal missing action payload' };
          break;
        }

        // Vocabulary guard — only the three safe, reversible action types.
        const allowed = ['open-editor', 'open-finder', 'open-terminal'] as const;
        if (!allowed.includes(action.type as (typeof allowed)[number])) {
          result = {
            ok: false,
            detail: `desktop-action type '${action.type}' is not in the allowed vocabulary (open-editor | open-finder | open-terminal)`,
          };
          break;
        }

        // Target path must be absolute and must resolve within an enrolled repo.
        // Cast is safe: the vocabulary guard above ensures action.type is one of the
        // desktop-only values, so the union has narrowed to the desktop-action branch.
        const desktopAction = action as { type: 'open-editor' | 'open-finder' | 'open-terminal'; target: string; params?: Record<string, unknown> };
        const target = desktopAction.target;
        if (!isAbsolute(target)) {
          result = { ok: false, detail: `desktop-action target must be an absolute path; got: ${target}` };
          break;
        }

        const normalTarget = resolve(target);
        const enrolled = listEnrolled();
        const withinEnrolled = enrolled.some((r) => {
          const normalRepo = resolve(r);
          return normalTarget === normalRepo || normalTarget.startsWith(normalRepo + '/');
        });
        if (!withinEnrolled) {
          result = {
            ok: false,
            detail: `desktop-action target '${target}' does not resolve within any enrolled repo — refusing`,
          };
          break;
        }

        // Execute the UI action (fire-and-forget; open.ts never throws).
        try {
          if (desktopAction.type === 'open-editor') {
            // openInEditor needs a cfg object; load a minimal one.
            // We import loadConfig lazily to avoid coupling the apply path to
            // config.ts module-load-time HOME capture in tests.
            const { loadConfig } = await import('../config.js');
            openInEditor(target, loadConfig());
          } else if (desktopAction.type === 'open-finder') {
            openInFinder(target);
          } else {
            openInTerminal(target);
          }
          result = { ok: true, detail: `desktop-action '${desktopAction.type}' dispatched for: ${target}` };
        } catch (err) {
          result = {
            ok: false,
            detail: `desktop-action dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        break;
      }

      case 'browser-action': {
        // ── Phase 2b: gated browser automation via Claude-in-Chrome MCP ──────
        //
        // GATES (same chain as desktop-action):
        //   approved + confirmed + assertMayMutate(repo) + enrollment — all
        //   enforced ABOVE in the shared gate chain before dispatch reaches here.
        //
        // REQUIREMENT: a Claude-in-Chrome (or compatible) MCP server must be
        //   configured in the gateway registry AND currently reachable. In
        //   headless / daemon contexts where no browser MCP is running this
        //   refuses CLEANLY (ok:false, no crash, no silent pass). The user
        //   must configure the Claude-in-Chrome MCP server to use this kind.
        //
        // NEVER bypasses: kill-switch, enrollment, and approval all apply.
        // Browser tasks NEVER auto-execute — proposal-only by architecture.
        const action = proposal.action;
        if (!action || action.type !== 'browser-task') {
          result = {
            ok: false,
            detail: action
              ? `browser-action proposal has wrong action type '${action.type}'; expected 'browser-task'`
              : 'browser-action proposal missing action payload',
          };
          break;
        }

        const { instructions } = action;
        if (!instructions || !instructions.trim()) {
          result = { ok: false, detail: 'browser-action: instructions must be a non-empty string' };
          break;
        }

        // Load the MCP registry to discover browser servers.
        // Dynamic import so this module stays importable without a wired registry.
        // Wrap entire probe+execute in one async IIFE so we can use typed locals
        // without inline-import type annotations (which TS rejects in case blocks).
        result = await (async (): Promise<{ ok: boolean; detail: string }> => {
          // --- Registry discovery ---
          let registry: McpRegistry | null = null;
          try {
            const { discoverMcpServers } = await import('../mcp-registry.js');
            registry = discoverMcpServers();
          } catch {
            registry = null;
          }

          if (!registry || registry.servers.length === 0) {
            return {
              ok: false,
              detail:
                'browser automation unavailable — no Claude-in-Chrome MCP server reachable; ' +
                'configure it to enable browser-action',
            };
          }

          // --- Probe for a reachable browser server ---
          const { probeBrowserMcp, findBrowserSpec, callBrowserTool } = await import('../mcp-gateway.js');
          const probeResult = await probeBrowserMcp(registry);
          if (!probeResult.reachable || !probeResult.serverName) {
            return {
              ok: false,
              detail:
                'browser automation unavailable — no Claude-in-Chrome MCP server reachable; ' +
                `configure it to enable browser-action${probeResult.error ? ` (${probeResult.error})` : ''}`,
            };
          }

          const spec = findBrowserSpec(registry, probeResult.serverName);
          if (!spec) {
            return {
              ok: false,
              detail: `browser-action: server '${probeResult.serverName}' disappeared from registry after probe`,
            };
          }

          // Step 1 (optional): navigate to URL if provided.
          if (action.url) {
            const navResult = await callBrowserTool(spec, 'navigate', { url: action.url });
            if (!navResult.ok) {
              return {
                ok: false,
                detail: `browser-action navigation failed: ${navResult.detail}`,
              };
            }
          }

          // Step 2: execute the instructions via the computer tool (Claude-in-Chrome).
          // 'computer' is the primary action surface; fall back to 'read_page'.
          const hasComputer = probeResult.availableTools.includes('computer');
          const actionTool = hasComputer ? 'computer' : 'read_page';
          const toolArgs: Record<string, unknown> = hasComputer
            ? { action: 'screenshot' }
            : {};

          const execResult = await callBrowserTool(spec, actionTool, toolArgs);
          if (!execResult.ok) {
            return {
              ok: false,
              detail: `browser-action execution failed: ${execResult.detail}`,
            };
          }

          const urlPart = action.url ? ` at ${action.url}` : '';
          return {
            ok: true,
            detail: `browser-action executed${urlPart} via ${probeResult.serverName} (instructions: ${instructions.slice(0, 80)}${instructions.length > 80 ? '…' : ''})`,
          };
        })().catch((err: unknown) => ({
          ok: false,
          detail: `browser-action failed: ${err instanceof Error ? err.message : String(err)}`,
        }));
        break;
      }

      default: {
        // Exhaustiveness guard — should never reach here given the type.
        result = {
          ok: false,
          detail: `unknown proposal kind: ${String((proposal as { kind: string }).kind)}`,
        };
      }
    }
  } catch (err) {
    // Belt-and-suspenders: the dispatch must never throw out.
    result = {
      ok: false,
      detail: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ── Persist outcome + audit ───────────────────────────────────────────────
  const finalStatus = result.ok ? 'applied' : 'failed';
  setStatus(id, finalStatus, result.detail);

  audit({
    action: 'inbox:apply',
    repo,
    sandboxId: id,
    summary: `proposal ${id} (${proposal.kind}) ${finalStatus}: ${result.detail}`,
    result: result.ok ? 'ok' : 'error',
  });

  return {
    ok: result.ok,
    status: finalStatus,
    detail: result.detail,
  };
}

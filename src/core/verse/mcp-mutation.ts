/**
 * core/verse/mcp-mutation.ts — adding or editing an MCP server, deliberately
 * made difficult.
 *
 * docs/VERSE-WORKSPACES.md §3: "an MCP server is arbitrary code with the
 * agent's privileges"; "Adding or editing a server is a privileged,
 * outward-facing change. It belongs behind the same mutation gate as the other
 * control-plane writes, and it should show the full command and environment
 * (redacted) before it is saved — never a one-click install of something the
 * operator has not read."
 *
 * ── How "never one-click" is enforced, rather than just intended ────────────
 *
 * A write takes TWO requests, and the second cannot be forged from the first
 * by a client that did not render it:
 *
 *   1. {@link buildVerseMcpProposal} validates the spec, resolves the target,
 *      and returns a PROPOSAL containing the full command and args verbatim,
 *      the env KEYS with every value redacted to '<set>', the warnings, and a
 *      `digest` over exactly what was shown plus the target file's current
 *      contents. Nothing is written.
 *   2. {@link applyVerseMcpProposal} refuses unless it is handed that same
 *      digest back AND the target file is still byte-identical to what the
 *      digest was taken over. A stale digest is a refusal, not a merge.
 *
 * The digest binds the decision to the disclosure. An operator who never saw
 * the command cannot produce it, and a file that changed underneath the
 * proposal invalidates it.
 *
 * ── What this refuses to do ─────────────────────────────────────────────────
 *
 *   - Rewrite TOML. Codex and Grok keep their MCP servers in `config.toml`.
 *     `src/core/integrations/editors.ts` already established the rule for
 *     this repo — Codex "is intentionally delegated to its official CLI so
 *     this module never attempts to parse and rewrite a user's TOML
 *     configuration" — and a half-understood TOML rewrite of an operator's
 *     config is a worse outcome than a refusal.
 *   - Touch ~/.ashlr/config.json, ~/.ashlr/enrollment.json or ~/.ashlr/KILL.
 *     Those are not MCP registries and are explicitly out of bounds.
 *   - Write anywhere the caller names freely. Targets are an enumerated set.
 *
 * ── What may leave this module ──────────────────────────────────────────────
 *
 * Env VALUES never leave, in any form, on any path: not in the proposal, not
 * in the apply result, not in the audit summary, not in an error message. The
 * proposal carries `redactEnv`'d specs only. The real values live in the
 * request body and go straight to disk.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonical, digest } from '../universe/artifacts.js';
import { redactEnv } from '../mcp-registry.js';
import type { McpServerSpec } from '../types.js';
import { homeRelativeSourceRef, projectMcpServerView, resolveAccountStateRoots, type VerseMcpServerView } from './mcp-seat-view.js';
import type { VerseMcpScopeGate } from './mcp-scope.js';

// ---------------------------------------------------------------------------
// Targets — an enumerated set, never a caller-supplied path
// ---------------------------------------------------------------------------

/**
 * Where a server may be written.
 *
 *   `hub`             ~/.ashlr/settings.json — the hub's own aggregated
 *                     gateway registry (M66; `knownConfigPaths()` scans it).
 *   `account:<id>`    that account's private JSON registry. Only accounts
 *                     whose native config is JSON qualify; Codex and Grok keep
 *                     TOML and are refused by name below.
 */
export type VerseMcpTargetId = 'hub' | `account:${string}`;

export type VerseMcpRefusal =
  | 'mcp-target-unknown'
  | 'mcp-target-not-json'
  | 'mcp-target-unresolved'
  | 'mcp-target-forbidden'
  | 'mcp-spec-invalid'
  | 'mcp-digest-mismatch'
  | 'mcp-target-changed'
  | 'mcp-scope-refused'
  | 'mcp-write-failed';

/** Files that must never be written by this module, whatever a caller asks. */
export const VERSE_MCP_FORBIDDEN_FILES: readonly string[] = [
  'config.json',
  'enrollment.json',
  'KILL',
];

export interface VerseMcpTarget {
  id: VerseMcpTargetId;
  /** Absolute path. SERVER-SIDE ONLY — projected to `ref` for transport. */
  path: string;
  /** Path relative to $HOME. What the operator is shown. */
  ref: string;
  /** Human label for the surface. */
  label: string;
}

function hubTargetPath(home: string): string {
  return join(home, '.ashlr', 'settings.json');
}

/**
 * Resolve a target id to a file, or explain why not.
 *
 * `accountsRoot` is only consulted for `account:` targets. Account state
 * directories are private and never published — only `ref` crosses out.
 */
export function resolveVerseMcpTarget(
  id: string,
  options: { accountsRoot: string; home?: string },
): { ok: true; target: VerseMcpTarget } | { ok: false; refusal: VerseMcpRefusal; error: string } {
  const home = options.home ?? homedir();

  if (id === 'hub') {
    const path = hubTargetPath(home);
    return {
      ok: true,
      target: { id: 'hub', path, ref: homeRelativeSourceRef(path, home), label: 'Hub gateway registry' },
    };
  }

  if (!id.startsWith('account:')) {
    return { ok: false, refusal: 'mcp-target-unknown', error: `unknown target: ${id}` };
  }

  const accountId = id.slice('account:'.length);
  if (accountId.length === 0 || accountId.length > 64) {
    return { ok: false, refusal: 'mcp-target-unknown', error: 'target account id is missing or too long' };
  }

  const roots = resolveAccountStateRoots(options.accountsRoot);
  const stateRoot = roots.get(accountId);
  if (stateRoot === undefined) {
    return {
      ok: false,
      refusal: 'mcp-target-unresolved',
      error: `no private profile is resolvable for account ${accountId}`,
    };
  }

  // Only a JSON registry can be edited. A Codex or Grok account keeps TOML,
  // and this module does not rewrite an operator's TOML.
  if (existsSync(join(stateRoot, 'config.toml'))) {
    return {
      ok: false,
      refusal: 'mcp-target-not-json',
      error:
        `account ${accountId} keeps its MCP servers in config.toml. Hub does not rewrite TOML; ` +
        'use the provider CLI\'s own mcp command for this account.',
    };
  }

  const path = join(stateRoot, '.claude.json');
  return {
    ok: true,
    target: {
      id: id as VerseMcpTargetId,
      path,
      // The state directory is private; name the file relative to the account.
      ref: `${accountId}/.claude.json`,
      label: `Account ${accountId} (private profile)`,
    },
  };
}

// ---------------------------------------------------------------------------
// Spec validation — strict, because this is arbitrary code
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_ARGS = 64;
const MAX_ENV_KEYS = 64;
const MAX_STRING_BYTES = 4096;
const MAX_ENV_VALUE_BYTES = 8192;

/** Printable, single-line, within a byte budget. Rejects control characters. */
function printable(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (Buffer.byteLength(value) > maxBytes) return false;
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && (code < 127 || code > 159);
  });
}

export type VerseMcpSpecParse =
  | { ok: true; spec: McpServerSpec; warnings: string[] }
  | { ok: false; error: string };

/**
 * Validate a caller-supplied server spec.
 *
 * Strict by construction: unknown keys are rejected, every string is bounded
 * and printable, and nothing is coerced. Warnings are returned rather than
 * silently swallowed — they are part of what the operator must read.
 */
export function parseVerseMcpSpec(body: unknown): VerseMcpSpecParse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'server must be a JSON object' };
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'name' && key !== 'command' && key !== 'args' && key !== 'env') {
      return { ok: false, error: `unknown key in server: ${key}` };
    }
  }

  const name = raw['name'];
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return { ok: false, error: 'name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}' };
  }

  const command = raw['command'];
  if (!printable(command, MAX_STRING_BYTES)) {
    return { ok: false, error: 'command must be a printable single-line string' };
  }

  const warnings: string[] = [];
  if (!command.startsWith('/')) {
    warnings.push(
      `The command "${command}" is not an absolute path, so it is resolved through PATH at ` +
      'launch time. Whatever appears first on PATH will run with the agent\'s privileges.',
    );
  }

  let args: string[] = [];
  const rawArgs = raw['args'];
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs)) return { ok: false, error: 'args must be an array of strings' };
    if (rawArgs.length > MAX_ARGS) return { ok: false, error: `args may hold at most ${MAX_ARGS} entries` };
    for (const arg of rawArgs) {
      if (!printable(arg, MAX_STRING_BYTES)) {
        return { ok: false, error: 'every arg must be a printable single-line string' };
      }
    }
    args = [...(rawArgs as string[])];
  }

  let env: Record<string, string> | undefined;
  const rawEnv = raw['env'];
  if (rawEnv !== undefined) {
    if (rawEnv === null || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) {
      return { ok: false, error: 'env must be an object of string values' };
    }
    const entries = Object.entries(rawEnv as Record<string, unknown>);
    if (entries.length > MAX_ENV_KEYS) {
      return { ok: false, error: `env may hold at most ${MAX_ENV_KEYS} keys` };
    }
    const safe: Record<string, string> = {};
    for (const [key, value] of entries) {
      if (!ENV_KEY_RE.test(key)) return { ok: false, error: `invalid env key: ${key}` };
      if (!printable(value, MAX_ENV_VALUE_BYTES)) {
        // The offending VALUE is never echoed — only its key.
        return { ok: false, error: `env value for ${key} must be a printable single-line string` };
      }
      safe[key] = value;
    }
    if (entries.length > 0) {
      env = safe;
      warnings.push(
        `${entries.length} environment variable${entries.length === 1 ? '' : 's'} ` +
        `(${Object.keys(safe).join(', ')}) will be passed to this server. Their values are ` +
        'redacted everywhere they are displayed, including here.',
      );
    }
  }

  const spec: McpServerSpec = { name, command, args, source: 'proposal' };
  if (env !== undefined) spec.env = env;
  return { ok: true, spec, warnings };
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

export interface VerseMcpProposal {
  ok: true;
  /** What the operator must read before confirming. Env values are '<set>'. */
  server: VerseMcpServerView;
  target: { id: VerseMcpTargetId; ref: string; label: string };
  /** 'add' when the name is new in the target, 'replace' when it is not. */
  action: 'add' | 'replace';
  /** The server this would overwrite, redacted. Null on an add. */
  replaces: VerseMcpServerView | null;
  /** Everything the operator should weigh. Never empty for a real install. */
  warnings: string[];
  /** The scope this write lands under, and whether Locus permits it. */
  scope: VerseMcpScopeGate;
  /**
   * Binds this exact disclosure to the target's current contents. `apply`
   * refuses without it, and refuses again if the file moved underneath.
   */
  digest: string;
  note: string;
}

export interface VerseMcpRefusalResult {
  ok: false;
  refusal: VerseMcpRefusal;
  error: string;
  note: string;
}

export const VERSE_MCP_PROPOSAL_NOTE =
  'Nothing has been written. An MCP server is arbitrary code that runs with the agent\'s ' +
  'privileges: read the command, arguments and environment keys above, then confirm with the ' +
  'digest shown to apply it.';

/** Read a JSON registry's current bytes and servers. Missing file is not an error. */
function readTarget(path: string): { bytes: string; servers: Record<string, unknown> } {
  let bytes = '';
  try {
    if (existsSync(path)) bytes = readFileSync(path, 'utf8');
  } catch {
    bytes = '';
  }
  let servers: Record<string, unknown> = {};
  if (bytes.length > 0) {
    try {
      const parsed = JSON.parse(bytes) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const existing = (parsed as Record<string, unknown>)['mcpServers'];
        if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
          servers = existing as Record<string, unknown>;
        }
      }
    } catch {
      servers = {};
    }
  }
  return { bytes, servers };
}

/**
 * The digest the operator confirms against.
 *
 * Covers the REDACTED spec (what was shown), the target, and a hash of the
 * target file's current bytes. Env values are deliberately outside it: the
 * digest must be reproducible from what was displayed.
 */
export function verseMcpProposalDigest(input: {
  server: VerseMcpServerView;
  targetId: string;
  targetBytes: string;
}): string {
  return digest(
    canonical({
      schema: 'verse-mcp-proposal/1',
      server: input.server,
      target: input.targetId,
      base: digest(input.targetBytes),
    }),
  );
}

export interface VerseMcpProposalOptions {
  targetId: string;
  server: unknown;
  accountsRoot: string;
  scope: VerseMcpScopeGate;
  home?: string;
}

/**
 * Validate, disclose, and hand back a digest. Writes nothing.
 */
export function buildVerseMcpProposal(
  options: VerseMcpProposalOptions,
): VerseMcpProposal | VerseMcpRefusalResult {
  const home = options.home ?? homedir();

  const parsed = parseVerseMcpSpec(options.server);
  if (!parsed.ok) {
    return { ok: false, refusal: 'mcp-spec-invalid', error: parsed.error, note: VERSE_MCP_PROPOSAL_NOTE };
  }

  const resolved = resolveVerseMcpTarget(options.targetId, { accountsRoot: options.accountsRoot, home });
  if (!resolved.ok) {
    return { ok: false, refusal: resolved.refusal, error: resolved.error, note: VERSE_MCP_PROPOSAL_NOTE };
  }
  const target = resolved.target;

  if (VERSE_MCP_FORBIDDEN_FILES.includes(target.path.split('/').pop() ?? '')) {
    return {
      ok: false,
      refusal: 'mcp-target-forbidden',
      error: `${target.ref} is not an MCP registry and is never written by this surface`,
      note: VERSE_MCP_PROPOSAL_NOTE,
    };
  }

  const current = readTarget(target.path);
  const existing = current.servers[parsed.spec.name];
  const action: 'add' | 'replace' = existing === undefined ? 'add' : 'replace';

  const server = projectMcpServerView({ ...parsed.spec, source: target.path }, home);
  // `source` on the displayed spec should name the TARGET, not the literal
  // string 'proposal' — the operator is reading where it will land.
  server.sourceRef = target.ref;

  let replaces: VerseMcpServerView | null = null;
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) {
    const row = existing as Record<string, unknown>;
    if (typeof row['command'] === 'string') {
      const prior: McpServerSpec = {
        name: parsed.spec.name,
        command: row['command'],
        args: Array.isArray(row['args']) ? (row['args'] as unknown[]).filter((a): a is string => typeof a === 'string') : [],
        source: target.path,
      };
      if (row['env'] !== null && typeof row['env'] === 'object' && !Array.isArray(row['env'])) {
        const priorEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(row['env'] as Record<string, unknown>)) {
          if (typeof v === 'string') priorEnv[k] = v;
        }
        if (Object.keys(priorEnv).length > 0) prior.env = priorEnv;
      }
      replaces = projectMcpServerView(redactEnv(prior), home);
      replaces.sourceRef = target.ref;
    }
  }

  const warnings = [...parsed.warnings];
  if (action === 'replace') {
    warnings.push(
      `A server named "${parsed.spec.name}" already exists in ${target.ref} and would be replaced. ` +
      'Its current command is shown above so the change is legible.',
    );
  }
  if (target.id === 'hub') {
    warnings.push(
      'This registry is aggregated by the hub gateway, so the server becomes reachable to every ' +
      'agent that connects through it — not to one seat.',
    );
  }
  if (target.id.startsWith('account:')) {
    warnings.push(
      'Verse launches Claude seats with --strict-mcp-config and an empty --mcp-config, so a server ' +
      'written here will NOT be loaded by this account\'s Verse turns. It applies to the provider ' +
      'CLI run outside Verse.',
    );
  }
  if (!options.scope.allow) {
    warnings.push(
      'Locus is blocking writes in this scope; the apply step will refuse until the pin is healthy.',
    );
  } else if (options.scope.scope.pinned && options.scope.scope.tenantRef !== null) {
    warnings.push(
      `This write lands under the Locus tenant ${options.scope.scope.tenantRef}` +
      `${options.scope.scope.aliasRef !== null ? ` (alias ${options.scope.scope.aliasRef})` : ''}.`,
    );
  } else if (!options.scope.scope.pinned) {
    warnings.push(
      'Locus reports no pinned tenant, so this write is not attributable to a tenant scope.',
    );
  }

  return {
    ok: true,
    server,
    target: { id: target.id, ref: target.ref, label: target.label },
    action,
    replaces,
    warnings,
    scope: options.scope,
    digest: verseMcpProposalDigest({ server, targetId: target.id, targetBytes: current.bytes }),
    note: VERSE_MCP_PROPOSAL_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface VerseMcpApplyResult {
  ok: true;
  action: 'add' | 'replace';
  target: { id: VerseMcpTargetId; ref: string };
  /** Re-read from disk after the write, redacted. What was actually persisted. */
  server: VerseMcpServerView;
  note: string;
}

export const VERSE_MCP_APPLIED_NOTE =
  'Written. The server is listed above exactly as it was persisted, with every environment value ' +
  'redacted. It takes effect the next time a client that reads this registry starts.';

export interface VerseMcpApplyOptions extends VerseMcpProposalOptions {
  /** The digest returned by the proposal. A mismatch is a refusal. */
  digest: string;
}

/**
 * Apply a proposal the operator confirmed.
 *
 * Refuses unless the supplied digest reproduces from (a) the redacted spec it
 * is about to write and (b) the target file's CURRENT bytes. That second half
 * is what makes a stale confirmation fail instead of quietly clobbering a
 * change made in between.
 *
 * The write is atomic: a sibling temp file, mode 0600, then rename.
 */
export function applyVerseMcpProposal(
  options: VerseMcpApplyOptions,
): VerseMcpApplyResult | VerseMcpRefusalResult {
  const proposal = buildVerseMcpProposal(options);
  if (!proposal.ok) return proposal;

  if (!proposal.scope.allow) {
    return {
      ok: false,
      refusal: 'mcp-scope-refused',
      error: proposal.scope.blockers.join('; ') || 'Locus refused this scope',
      note: 'Nothing was written. Locus owns scope for this surface; resolve the pin and retry.',
    };
  }

  // Recomputed above against the file's CURRENT bytes. If the operator's
  // digest does not match, either they never saw this disclosure or the file
  // changed since they did. Both are refusals, and they are distinguishable
  // only by re-proposing, so say so plainly rather than guessing which.
  if (options.digest !== proposal.digest) {
    return {
      ok: false,
      refusal: 'mcp-digest-mismatch',
      error:
        'the confirmation digest does not match this proposal. Either the target changed since ' +
        'the proposal was shown, or the disclosure was not the one being confirmed.',
      note: 'Nothing was written. Re-read the proposal and confirm the digest it returns.',
    };
  }

  const home = options.home ?? homedir();
  const resolved = resolveVerseMcpTarget(options.targetId, { accountsRoot: options.accountsRoot, home });
  if (!resolved.ok) {
    return { ok: false, refusal: resolved.refusal, error: resolved.error, note: 'Nothing was written.' };
  }
  const target = resolved.target;

  const parsed = parseVerseMcpSpec(options.server);
  /* c8 ignore next -- buildVerseMcpProposal already returned on an invalid spec. */
  if (!parsed.ok) {
    return { ok: false, refusal: 'mcp-spec-invalid', error: parsed.error, note: 'Nothing was written.' };
  }

  const current = readTarget(target.path);
  let root: Record<string, unknown> = {};
  if (current.bytes.length > 0) {
    try {
      const value = JSON.parse(current.bytes) as unknown;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        root = value as Record<string, unknown>;
      }
    } catch {
      return {
        ok: false,
        refusal: 'mcp-target-changed',
        error: `${target.ref} is not readable as JSON, so it will not be rewritten`,
        note: 'Nothing was written.',
      };
    }
  }

  const entry: Record<string, unknown> = { command: parsed.spec.command, args: parsed.spec.args };
  if (parsed.spec.env !== undefined) entry['env'] = parsed.spec.env;

  const servers: Record<string, unknown> =
    root['mcpServers'] !== null && typeof root['mcpServers'] === 'object' && !Array.isArray(root['mcpServers'])
      ? { ...(root['mcpServers'] as Record<string, unknown>) }
      : {};
  servers[parsed.spec.name] = entry;
  const next = { ...root, mcpServers: servers };

  const tmp = `${target.path}.ashlr-mcp-${process.pid}.tmp`;
  try {
    mkdirSync(dirname(target.path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target.path);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return {
      ok: false,
      refusal: 'mcp-write-failed',
      // The message is the filesystem's, which never carries an env value.
      error: `could not write ${target.ref}: ${error instanceof Error ? error.message : 'unknown error'}`,
      note: 'Nothing was written.',
    };
  }

  // Re-read from disk so the caller sees what was actually persisted, not
  // what we intended to persist. Same posture as the caps route.
  const after = readTarget(target.path);
  const persisted = after.servers[parsed.spec.name];
  const spec: McpServerSpec = { name: parsed.spec.name, command: parsed.spec.command, args: parsed.spec.args, source: target.path };
  if (persisted !== null && typeof persisted === 'object' && !Array.isArray(persisted)) {
    const row = persisted as Record<string, unknown>;
    if (typeof row['command'] === 'string') spec.command = row['command'];
    if (Array.isArray(row['args'])) spec.args = (row['args'] as unknown[]).filter((a): a is string => typeof a === 'string');
    if (row['env'] !== null && typeof row['env'] === 'object' && !Array.isArray(row['env'])) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(row['env'] as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      if (Object.keys(env).length > 0) spec.env = env;
    }
  }
  const view = projectMcpServerView(redactEnv(spec), home);
  view.sourceRef = target.ref;

  return {
    ok: true,
    action: proposal.action,
    target: { id: target.id, ref: target.ref },
    server: view,
    note: VERSE_MCP_APPLIED_NOTE,
  };
}

/**
 * routes/verse/apps/McpGroup.tsx — MCP SERVERS, folded in from the old MCP
 * section (SPEC-310C §4): what each seat would ACTUALLY load, the standing
 * caveat that Claude and local seats load none, and an Add that goes through
 * the two-step, digest-bound write the server already enforces
 * (propose → read the disclosure → apply).
 *
 * The rules the old section refused to soften are kept:
 *   - "configured, but unused" is said first when it is true;
 *   - a CLI version drift is an alert quoting the pinned version;
 *   - the unenrolled-folder footgun for Codex/Grok seats is stated;
 *   - an env VALUE is never displayed (the disclosure forces '<set>').
 */
import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../../components/primitives/Button.js';
import { IconChevronDown, IconChevronRight, IconPlus } from '../../../components/primitives/icons.js';
import { Input } from '../../../components/primitives/Input.js';
import { Select } from '../../../components/primitives/Select.js';
import { Sheet } from '../../../components/primitives/Sheet.js';
import { ApiError } from '../../../data/client.js';
import { SCOPE_REASON_COPY, narrowServer, reasonSentence, type CliHealthSnapshot, type McpServer, type McpSnapshot } from '../mcp/mcp-contract.js';
import { McpServerDisclosure } from '../mcp/McpServerDisclosure.js';
import { applyMcpServer, proposeMcpServer, type McpServerInput } from '../mcp/mcp-queries.js';
import { mcpSeatRows, mcpTargets, parseEnvLines, splitArgs, type McpSeatRow } from './apps-model.js';
import { AppGroup, AppRow } from './AppRow.js';
import styles from './Apps.module.css';

/** The token gate the page owns: runs `action` once unlocked; null when dismissed. */
export type GatedRun = <T>(reason: string, action: () => Promise<T>) => Promise<T | null>;

function SeatRow({ row }: { row: McpSeatRow }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const has = row.servers.length > 0;
  return (
    <AppRow
      id={`mcp-${row.seatId}`}
      name={row.label}
      monogram={row.monogram}
      engine={row.engine}
      description={row.sentence}
      health={{ tone: has ? 'success' : 'off', label: row.loads }}
      aside={
        has ? (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={listId}
            icon={open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide servers' : 'Show servers'}
          </Button>
        ) : null
      }
    >
      <span className={styles.reasonCode}>{row.reason}</span>
      {has && open ? (
        <div id={listId} className={styles.servers}>
          {row.servers.map((server) => <McpServerDisclosure key={server.name} server={server} heading={server.name} />)}
        </div>
      ) : null}
    </AppRow>
  );
}

interface Proposal {
  server: McpServer;
  targetRef: string;
  targetLabel: string;
  action: 'add' | 'replace';
  replaces: McpServer | null;
  warnings: string[];
  note: string;
  digest: string;
}

function narrowProposal(raw: unknown): Proposal | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const server = narrowServer(r['server']);
  const target = r['target'] as Record<string, unknown> | undefined;
  if (!server || typeof r['digest'] !== 'string' || !target) return null;
  return {
    server,
    targetRef: typeof target['ref'] === 'string' ? target['ref'] : '',
    targetLabel: typeof target['label'] === 'string' ? target['label'] : '',
    action: r['action'] === 'replace' ? 'replace' : 'add',
    replaces: narrowServer(r['replaces']),
    warnings: Array.isArray(r['warnings']) ? r['warnings'].filter((w): w is string => typeof w === 'string') : [],
    note: typeof r['note'] === 'string' ? r['note'] : '',
    digest: r['digest'],
  };
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.detail ?? `The server refused (HTTP ${err.status}).`;
  if (err instanceof Error && err.name === 'VerseMutationLockedError') return 'Unlock actions with the mutation token first.';
  return 'The request could not be completed.';
}

function AddServerSheet({ open, snapshot, run, onClose, onAdded }: {
  open: boolean;
  snapshot: McpSnapshot | null;
  run: GatedRun;
  onClose: () => void;
  onAdded: (message: string) => void;
}) {
  const titleId = useId();
  const targets = mcpTargets(snapshot);
  const [target, setTarget] = useState('hub');
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<{ input: McpServerInput; target: string; value: Proposal } | null>(null);

  const reset = () => {
    setProposal(null);
    setError(null);
    setBusy(false);
  };

  const review = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsedEnv = parseEnvLines(env);
    if (!parsedEnv.ok) {
      setError(parsedEnv.error);
      return;
    }
    const input: McpServerInput = {
      name: name.trim(),
      command: command.trim(),
      args: splitArgs(args),
      ...(Object.keys(parsedEnv.env).length > 0 ? { env: parsedEnv.env } : {}),
    };
    setBusy(true);
    try {
      const raw = await run('Review an MCP server before adding it', () => proposeMcpServer(target, input));
      if (raw === null) return;
      const value = narrowProposal(raw);
      if (!value) setError('The server answered with something that is not a proposal.');
      else setProposal({ input, target, value });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true);
    setError(null);
    try {
      const done = await run('Add an MCP server', () => applyMcpServer(proposal.target, proposal.input, proposal.value.digest));
      if (done === null) return;
      onAdded(`${proposal.value.action === 'replace' ? 'Replaced' : 'Added'} ${proposal.value.server.name} in ${proposal.value.targetRef}.`);
      setName('');
      setCommand('');
      setArgs('');
      setEnv('');
      reset();
      onClose();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const chosen = targets.find((t) => t.id === target);
  return (
    <Sheet
      open={open}
      onClose={() => { reset(); onClose(); }}
      titleId={titleId}
      title={proposal ? 'Review before adding' : 'Add an MCP server'}
      description="An MCP server is a program that runs with the agent’s permissions. Nothing is written until you confirm what you read."
      width={520}
    >
      {proposal === null ? (
        <form className={styles.dialogBody} onSubmit={(e) => void review(e)}>
          <Select label="Add to" value={target} onChange={(e) => setTarget(e.target.value)}
            hint={chosen?.disabledReason ?? (target === 'hub' ? 'The hub’s own registry.' : 'A Verse chat on a Claude seat still loads none; Claude Code in a terminal does.')}>
            {targets.map((t) => <option key={t.id} value={t.id} disabled={t.disabledReason !== null}>{t.label}</option>)}
          </Select>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="filesystem" autoComplete="off" />
          <Input label="Command" value={command} onChange={(e) => setCommand(e.target.value)} required placeholder="/opt/homebrew/bin/npx" autoComplete="off"
            hint="An absolute path is safest; a bare name is looked up on PATH when the server starts." />
          <Input label="Arguments" value={args} onChange={(e) => setArgs(e.target.value)} placeholder='-y @modelcontextprotocol/server-filesystem "~/code"' autoComplete="off" />
          <label className={styles.fieldLabel}>
            Environment <span className={styles.hint}>One KEY=value per line. Values are sent once and never shown again.</span>
            <textarea className={styles.textarea} value={env} onChange={(e) => setEnv(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.dialogActions}>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy} disabled={name.trim() === '' || command.trim() === '' || chosen?.disabledReason != null}>
              Review
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.dialogBody}>
          <p>
            {proposal.value.action === 'replace' ? 'Replaces' : 'Adds'} <strong>{proposal.value.server.name}</strong> in{' '}
            <code className={styles.inlineCode}>{proposal.value.targetRef}</code>
            {proposal.value.targetLabel ? ` (${proposal.value.targetLabel})` : ''}.
          </p>
          <McpServerDisclosure server={proposal.value.server} heading="This will run" />
          {proposal.value.replaces ? <McpServerDisclosure server={proposal.value.replaces} heading="Replacing" /> : null}
          {proposal.value.warnings.length > 0 ? (
            <ul className={styles.warnings}>{proposal.value.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          ) : null}
          {proposal.value.note ? <p className={styles.hint}>{proposal.value.note}</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.dialogActions}>
            <Button variant="ghost" onClick={() => setProposal(null)}>Back</Button>
            <Button variant="primary" busy={busy} onClick={() => void apply()}>
              {proposal.value.action === 'replace' ? 'Replace server' : 'Add server'}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export function McpGroup({
  snapshot,
  cliHealth,
  unavailable,
  loading,
  run,
  onAdded,
  headingRef,
}: {
  snapshot: McpSnapshot | null;
  cliHealth: CliHealthSnapshot | null;
  /** Why the per-seat read is missing; null when it arrived (or is loading). */
  unavailable: string | null;
  loading: boolean;
  run: GatedRun;
  onAdded: (message: string) => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const [adding, setAdding] = useState(false);
  const rows = snapshot ? mcpSeatRows(snapshot) : [];
  return (
    <AppGroup
      id="mcp-servers"
      title="MCP servers"
      headingRef={headingRef}
      action={
        <Button variant="subtle" size="sm" icon={<IconPlus size={14} />} onClick={() => setAdding(true)} aria-haspopup="dialog">
          Add server
        </Button>
      }
      caveat={
        <>
          Claude and local seats load no MCP servers: Verse starts them with{' '}
          <code>--strict-mcp-config</code> and an empty <code>--mcp-config</code>. Codex and Grok seats load their own
          account’s config — and an <code>ashlr__</code> write through one is refused on a folder that is not enrolled.
        </>
      }
    >
      {snapshot !== null && snapshot.notes.length > 0 ? (
        <div className={styles.loadingLine} role="note">
          <strong>Configured, but unused.</strong> {snapshot.notes.join(' ')} {snapshot.machine.note}
        </div>
      ) : null}
      {cliHealth !== null && cliHealth.driftDetected ? (
        <div className={styles.loadingLine} role="alert">
          <strong>CLI version drift.</strong> {cliHealth.notes.join(' ')}{' '}
          {cliHealth.accounts.filter((a) => a.versionState === 'drift').map((a) => `${a.label}: ${a.version ?? 'unread'}, pinned ${a.pinnedVersion ?? '—'}.`).join(' ')}
        </div>
      ) : null}
      {snapshot === null ? (
        <p className={styles.loadingLine} aria-busy={loading || undefined}>
          {loading ? 'Reading each seat’s configuration…' : (unavailable ?? 'No per-seat reading is available.')}
        </p>
      ) : (
        <ul className={styles.rows}>
          {rows.map((row) => <SeatRow key={row.seatId} row={row} />)}
        </ul>
      )}
      {snapshot?.scope ? (
        <p className={styles.scopeLine}>
          Scope: {reasonSentence(SCOPE_REASON_COPY, snapshot.scope.reason, 'Locus did not report a usable scope.')}
          {snapshot.scope.tenantRef ? ` (${snapshot.scope.tenantRef})` : ''}
        </p>
      ) : null}
      <AddServerSheet open={adding} snapshot={snapshot} run={run} onClose={() => setAdding(false)} onAdded={onAdded} />
    </AppGroup>
  );
}

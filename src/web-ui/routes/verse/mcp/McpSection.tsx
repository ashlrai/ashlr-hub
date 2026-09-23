/**
 * routes/verse/mcp/McpSection.tsx — the MCP and per-account CLI panel.
 *
 * Read-only by construction. There is no install form in this component and
 * no call to `applyMcpServer`: this section answers "what would each seat
 * load, and is any CLI drifting", which is the whole of what
 * docs/VERSE-WORKSPACES.md §3 asks for before mutation.
 *
 * The write path exists on the server and in `mcp-queries.ts`
 * (`proposeMcpServer` → `applyMcpServer`, two calls, digest-bound). It is
 * deliberately not wired to a button here. A one-click "Add server" control
 * is the exact affordance §3 rules out, and the disclosure card it would need
 * is already built and shared — `McpServerDisclosure` — so the remaining work
 * is a form plus a confirm step that shows that card, not a re-think.
 *
 * Two things this panel refuses to soften:
 *
 *   - When every seat loads nothing and the machine has servers configured,
 *     it SAYS SO, at the top, as the first thing on the page. That is the
 *     single most surprising fact about this machine's MCP setup and burying
 *     it under a list of servers would be the same as hiding it.
 *   - A version drift is an alert with the pinned version quoted, not a grey
 *     "unknown". The fix is a one-line constant bump and the operator cannot
 *     make it without being told.
 */
import type { ReactNode } from 'react';
import { useQuery } from '../../../data/hooks.js';
import { StatusBadge, type Tone } from '../../../components/primitives/StatusBadge.js';
import {
  SCOPE_REASON_COPY,
  SEAT_REASON_COPY,
  projectCliHealth,
  projectMcpSnapshot,
  reasonSentence,
  type CliHealthRow,
  type McpSeat,
  type McpSnapshot,
} from './mcp-contract.js';
import { McpServerDisclosure } from './McpServerDisclosure.js';
import { mcpCliHealthQuery, mcpSnapshotQuery } from './mcp-queries.js';
import styles from './mcp.module.css';

function versionTone(state: string): Tone {
  switch (state) {
    case 'drift':
      return 'warning';
    case 'matches-pin':
      return 'success';
    case 'reported':
      return 'info';
    default:
      return 'unknown';
  }
}

function versionLabel(row: CliHealthRow): string {
  if (row.versionState === 'drift') return 'version drift';
  if (row.version !== null) return row.version;
  return 'version not read';
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

function SeatRow({ seat }: { seat: McpSeat }): ReactNode {
  const sentence = reasonSentence(
    SEAT_REASON_COPY,
    seat.reason,
    'Hub cannot say what this seat would load.',
  );

  return (
    <div className={styles.seatRow}>
      <div className={styles.seatHead}>
        <span className={styles.seatLabel}>{seat.label}</span>
        <span className={styles.engineTag}>{seat.engine}</span>
        <StatusBadge
          status={seat.servers.length > 0 ? 'ready' : 'neutral'}
          tone={seat.servers.length > 0 ? 'info' : 'neutral'}
        >
          {seat.servers.length === 0
            ? 'loads no MCP servers'
            : `loads ${seat.servers.length} server${seat.servers.length === 1 ? '' : 's'}`}
        </StatusBadge>
      </div>

      <p className={styles.panelNote}>{sentence}</p>
      {/* The machine code sits beside the sentence — it is what you search
          for in the logs — but it is never the sentence itself. */}
      <p className={styles.code}>{seat.reason}</p>

      {seat.servers.map((server) => (
        <McpServerDisclosure key={server.name} server={server} heading={server.name} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export function McpSection(): ReactNode {
  const snapshotRead = useQuery(mcpSnapshotQuery);
  const healthRead = useQuery(mcpCliHealthQuery);

  const snapshot: McpSnapshot | null =
    snapshotRead.data?.available === true ? projectMcpSnapshot(snapshotRead.data.raw) : null;
  const health =
    healthRead.data?.available === true ? projectCliHealth(healthRead.data.raw) : null;

  const unreachable = snapshotRead.data?.available === false ? snapshotRead.data.reason : null;

  return (
    <section className={styles.section} aria-labelledby="verse-mcp-heading">
      <div className={styles.body}>
        <div className={styles.panelHead}>
          <h2 id="verse-mcp-heading" className={styles.panelTitle}>
            MCP and CLI
          </h2>
          <p className={styles.panelNote}>
            An MCP server is arbitrary code that runs with the agent&rsquo;s privileges. This page
            shows what each seat would actually load — not what is configured somewhere on this
            machine.
          </p>
        </div>

        {unreachable !== null ? <p className={styles.muted}>{unreachable}</p> : null}

        {/* The loudest fact first, when it is true. */}
        {snapshot !== null && snapshot.notes.length > 0 ? (
          <div className={styles.alert} role="note">
            <span className={styles.alertTitle}>Configured, but unused</span>
            {snapshot.notes.map((note) => (
              <p key={note} className={styles.panelNote}>
                {note}
              </p>
            ))}
            <p className={styles.panelNote}>{snapshot.machine.note}</p>
          </div>
        ) : null}

        {/* Version drift, quoted. */}
        {health !== null && health.driftDetected ? (
          <div className={styles.alert} role="alert">
            <span className={styles.alertTitle}>Version drift</span>
            {health.notes.map((note) => (
              <p key={note} className={styles.panelNote}>
                {note}
              </p>
            ))}
          </div>
        ) : null}

        {/* ── Per-seat view ───────────────────────────────────────────── */}
        <section className={styles.panel} aria-labelledby="verse-mcp-seats">
          <div className={styles.panelHead}>
            <h3 id="verse-mcp-seats" className={styles.panelTitle}>
              Per seat
            </h3>
            <p className={styles.panelNote}>
              A server configured for one account does not apply to another. Each seat below is
              answered from its own configuration.
            </p>
          </div>

          {snapshot === null ? (
            <p className={styles.muted}>
              {snapshotRead.status === 'loading'
                ? 'Reading each seat’s configuration…'
                : 'No per-seat reading is available.'}
            </p>
          ) : (
            <div className={styles.seatList}>
              {snapshot.seats.map((seat) => (
                <SeatRow key={seat.seatId} seat={seat} />
              ))}
            </div>
          )}
        </section>

        {/* ── Per-account CLI health ──────────────────────────────────── */}
        <section className={styles.panel} aria-labelledby="verse-mcp-cli">
          <div className={styles.panelHead}>
            <h3 id="verse-mcp-cli" className={styles.panelTitle}>
              Per account
            </h3>
            <p className={styles.panelNote}>
              Authentication, plan and CLI version. A version is only shown when something actually
              read one.
            </p>
          </div>

          {health === null ? (
            <p className={styles.muted}>
              {healthRead.data?.available === false
                ? healthRead.data.reason
                : 'No per-account reading is available.'}
            </p>
          ) : (
            <div className={styles.rowList}>
              {health.accounts.map((row) => (
                <div key={row.accountId} className={styles.healthRow}>
                  <div className={styles.seatHead}>
                    <span className={styles.seatLabel}>{row.label}</span>
                    <span className={styles.engineTag}>{row.provider}</span>
                    <StatusBadge status={row.authentication} tone={
                      row.authentication === 'signed-in' ? 'success'
                        : row.authentication === 'signed-out' ? 'danger' : 'unknown'
                    }>
                      {row.authentication}
                    </StatusBadge>
                    <StatusBadge status={row.versionState} tone={versionTone(row.versionState)}>
                      {versionLabel(row)}
                    </StatusBadge>
                    {row.planType === null ? null : (
                      <span className={styles.count}>plan: {row.planType}</span>
                    )}
                  </div>

                  {row.notes.map((note) => (
                    <p key={note} className={styles.panelNote}>
                      {note}
                    </p>
                  ))}

                  {row.pinnedVersion === null ? null : (
                    <p className={styles.code}>
                      usage probe pinned to {row.pinnedVersion}
                      {row.usageBlockedByPin ? ` · ${row.reason}` : ''}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Scope ───────────────────────────────────────────────────── */}
        <section className={styles.panel} aria-labelledby="verse-mcp-scope">
          <div className={styles.panelHead}>
            <h3 id="verse-mcp-scope" className={styles.panelTitle}>
              Scope
            </h3>
            <p className={styles.panelNote}>
              Scope is owned by Locus, not by Hub. Hub holds the reference Locus publishes and
              nothing else.
            </p>
          </div>
          {snapshot?.scope == null ? (
            <p className={styles.muted}>No scope reading is available.</p>
          ) : (
            <>
              <p className={styles.panelNote}>
                {reasonSentence(
                  SCOPE_REASON_COPY,
                  snapshot.scope.reason,
                  'Locus did not report a usable scope.',
                )}
              </p>
              {snapshot.scope.tenantRef === null ? null : (
                <p className={styles.code}>
                  tenant {snapshot.scope.tenantRef}
                  {snapshot.scope.aliasRef === null ? '' : ` · alias ${snapshot.scope.aliasRef}`}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  );
}

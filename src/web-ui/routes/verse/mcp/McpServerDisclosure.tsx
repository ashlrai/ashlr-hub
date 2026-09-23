/**
 * routes/verse/mcp/McpServerDisclosure.tsx — what an MCP server IS, rendered
 * so it has to be read.
 *
 * Used in two places and identical in both: listing a server a seat already
 * loads, and previewing one that is about to be written. That sameness is the
 * point — the operator reads the same card either way, so "what will run" is
 * never presented differently from "what runs".
 *
 * Three rules this component enforces at the render layer:
 *
 *   1. The COMMAND and ARGS are shown in full, in mono, wrapped rather than
 *      truncated. A command with an ellipsis in the middle is exactly the
 *      one worth reading.
 *   2. Environment variables are listed BY KEY, with the value shown as the
 *      literal `<set>` that `redactEnv` produced. The count is stated, so a
 *      server handing over six credentials cannot look like one handing over
 *      none.
 *   3. The source is a home-relative ref, never an absolute path.
 */
import type { ReactNode } from 'react';
import type { McpServer } from './mcp-contract.js';
import styles from './mcp.module.css';

export function McpServerDisclosure({
  server,
  heading,
}: {
  server: McpServer;
  heading?: string;
}): ReactNode {
  const envKeys = server.env === null ? [] : Object.keys(server.env);

  return (
    <div className={styles.disclosure}>
      {heading === undefined ? null : <p className={styles.alertTitle}>{heading}</p>}

      <p className={styles.commandLine}>
        {server.command}
        {server.args.length > 0 ? ` ${server.args.join(' ')}` : ''}
      </p>

      {envKeys.length === 0 ? (
        <p className={styles.muted}>No environment variables are passed to this server.</p>
      ) : (
        <>
          <p className={styles.muted}>
            {envKeys.length} environment variable{envKeys.length === 1 ? '' : 's'} passed to this
            server. Values are never displayed.
          </p>
          <ul className={styles.envList}>
            {envKeys.map((key) => (
              <li key={key} className={styles.envItem}>
                {key}=&lt;set&gt;
              </li>
            ))}
          </ul>
        </>
      )}

      <p className={styles.code}>configured in {server.sourceRef}</p>
    </div>
  );
}

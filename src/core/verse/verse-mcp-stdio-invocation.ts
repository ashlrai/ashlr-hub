/**
 * How a seat starts `ashlr verse-mcp-stdio` — Verse's stdio bridge to its MCP
 * server (verse-mcp-stdio.ts) — in each shipping runtime, the same three cases
 * as the Devin chat turn process (core/devin/chat-turn-invocation.ts):
 *
 *   dev / tsx   → node --eval, tsx registered, importing the sibling .ts
 *   npm dist    → node <sibling verse-mcp-stdio-process.js>
 *   Bun binary  → this binary re-entered as `verse-mcp-stdio` (no operand)
 *
 * The argv selects one package-owned module and carries nothing else: the
 * credential is found through the environment (a 0600 token file path, or the
 * parent-process lookup Grok needs), never in argv, so it never shows in `ps`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundledIntoSingleFileBinary } from '../resources/probe-helper-invocation.js';

/** The subcommand, matched only as the ENTIRE argv by src/cli/index.ts. */
export const VERSE_MCP_STDIO_COMMAND = 'verse-mcp-stdio';

export function verseMcpStdioArgv(moduleUrl: string = import.meta.url): string[] {
  if (moduleUrl.endsWith('/verse-mcp-stdio-invocation.ts')) {
    const loader = pathToFileURL(createRequire(moduleUrl).resolve('tsx/esm/api')).href;
    const source = new URL('./verse-mcp-stdio-process.ts', moduleUrl).href;
    return [process.execPath, '--input-type=module', '--eval',
      `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`];
  }
  if (bundledIntoSingleFileBinary(moduleUrl)) return [process.execPath, VERSE_MCP_STDIO_COMMAND];
  return [process.execPath, fileURLToPath(new URL('./verse-mcp-stdio-process.js', moduleUrl))];
}

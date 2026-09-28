/**
 * `ashlr verse-mcp-stdio` as a PROCESS — runs on import (see
 * verse-mcp-stdio-invocation.ts for how each runtime reaches it, and
 * verse-mcp-stdio.ts for what it does).
 */
import { runVerseMcpStdio } from './verse-mcp-stdio.js';

void runVerseMcpStdio().then(
  (code) => { process.exitCode = code; },
  () => { process.exitCode = 1; },
);

/**
 * How to start the Devin chat turn process (3.15) in each shipping runtime —
 * the same three cases, and the same operand-free rule, as the account probe
 * helpers (resources/probe-helper-invocation.ts):
 *
 *   dev / tsx   → node --eval, tsx registered, importing the sibling .ts
 *   npm dist    → node <sibling chat-turn-process.js>
 *   Bun binary  → this binary re-entered on DEVIN_CHAT_TURN_FLAG (no operand)
 *
 * The argv selects one package-owned module and carries nothing else; the
 * turn's request travels on stdin.
 */
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundledIntoSingleFileBinary } from '../resources/probe-helper-invocation.js';

/** Internal re-entry flag, matched only as the ENTIRE argv by src/cli/index.ts. */
export const DEVIN_CHAT_TURN_FLAG = '--_devin-chat-turn';

export function devinChatTurnArgv(moduleUrl: string = import.meta.url): string[] {
  if (moduleUrl.endsWith('/chat-turn-invocation.ts')) {
    const loader = pathToFileURL(createRequire(moduleUrl).resolve('tsx/esm/api')).href;
    const source = new URL('./chat-turn-process.ts', moduleUrl).href;
    return [process.execPath, '--input-type=module', '--eval',
      `import { register } from ${JSON.stringify(loader)}; register(); await import(${JSON.stringify(source)});`];
  }
  if (bundledIntoSingleFileBinary(moduleUrl)) return [process.execPath, DEVIN_CHAT_TURN_FLAG];
  return [process.execPath, fileURLToPath(new URL('./chat-turn-process.js', moduleUrl))];
}

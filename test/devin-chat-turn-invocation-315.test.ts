/**
 * The Devin chat turn process is started three ways (core/devin/chat-turn-invocation.ts):
 * tsx in a source checkout, `node <dist .js>` from npm, and — in the Bun-compiled desktop
 * sidecar — the binary re-entering itself on DEVIN_CHAT_TURN_FLAG, which src/cli/index.ts
 * dispatches to the turn process. 3.15 integration: only the tsx branch was exercised, and
 * the CLI matched a hard-coded copy of the flag. This pins the npm and binary branches and
 * the CLI dispatch to the one constant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEVIN_CHAT_TURN_FLAG, devinChatTurnArgv } from '../src/core/devin/chat-turn-invocation.js';

const ROOT = join(__dirname, '..');

describe('Devin chat turn invocation', () => {
  it('inside the Bun binary the child is this binary on the operand-free flag', () => {
    expect(devinChatTurnArgv('file:///$bunfs/root/ashlr')).toEqual([process.execPath, DEVIN_CHAT_TURN_FLAG]);
    expect(DEVIN_CHAT_TURN_FLAG).toMatch(/^--_[a-z-]+$/);
  });

  it('from npm dist the child is node on the sibling compiled module', () => {
    const argv = devinChatTurnArgv('file:///opt/lib/node_modules/@ashlr/hub/dist/core/devin/chat-turn-invocation.js');
    expect(argv).toEqual([process.execPath, '/opt/lib/node_modules/@ashlr/hub/dist/core/devin/chat-turn-process.js']);
  });

  it('the CLI dispatches the flag through the shared constant to the turn process', () => {
    const cli = readFileSync(join(ROOT, 'src', 'cli', 'index.ts'), 'utf8');
    expect(cli).toContain("import { DEVIN_CHAT_TURN_FLAG } from '../core/devin/chat-turn-invocation.js';");
    expect(cli).toMatch(/if \(argv\[0\] === DEVIN_CHAT_TURN_FLAG\) \{\s*await import\('\.\.\/core\/devin\/chat-turn-process\.js'\);/);
    expect(cli).not.toContain(`'${DEVIN_CHAT_TURN_FLAG}'`);
  });
});

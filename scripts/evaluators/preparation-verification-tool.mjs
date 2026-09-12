/** Fixed byte-preserving tool worker; never loads a candidate module. */
import { readSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { readonlyCommand } from './preparation-verification-controller.mjs';
import { exact, MAX_MESSAGE_BYTES } from './preparation-verification-protocol.mjs';

try {
  const bytes = Buffer.alloc(MAX_MESSAGE_BYTES + 1); let size = 0;
  for (;;) {
    const count = readSync(0, bytes, size, bytes.length - size, null);
    if (!count) break;
    size += count; if (size >= bytes.length) throw new Error('TOOL_INPUT_INVALID');
  }
  const input = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, size)));
  if (!exact(input, ['request', 'fixtureRoot', 'scratch']) || typeof input.fixtureRoot !== 'string' ||
      typeof input.scratch !== 'string') throw new Error('TOOL_INPUT_INVALID');
  const selected = readonlyCommand(input.request, input.fixtureRoot, input.scratch);
  const result = spawnSync(selected.file, selected.args, { cwd: selected.options.cwd ?? input.fixtureRoot,
    env: process.env, input: selected.input, encoding: 'buffer', timeout: selected.options.timeoutMs,
    maxBuffer: Math.min(selected.options.maxBuffer, 64 * 1024), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  process.stdout.write(JSON.stringify({ started: Number.isSafeInteger(result.pid) && result.pid > 0,
    status: result.status, signal: result.signal, stdoutBase64: (result.stdout ?? Buffer.alloc(0)).toString('base64'),
    stderrBase64: (result.stderr ?? Buffer.alloc(0)).toString('base64'),
    error: result.error ? { code: ['ETIMEDOUT', 'ENOBUFS', 'ENOENT', 'EACCES', 'EPERM'].includes(result.error.code)
      ? result.error.code : 'BROKER_PROCESS_FAILED' } : null }) + '\n');
} catch { process.exitCode = 1; }

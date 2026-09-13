/** Fixed observation-only child. Its parent exclusively owns this POSIX group. */
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { canonical } from '../universe/artifacts.js';
import { createFirmEngineeringControlHandler } from '../universe/firm-engineering-control-handler.js';
import { readResourceEngineeringOutcomes } from './engineering-outcomes.js';
import { validateEngineeringOutcomesReadRequest } from './engineering-outcomes-reader.js';

// A signal during synchronous filesystem/Git proof is processed on return to the
// event loop. Do not then exit the leader and lose the parent's escalation right.
let terminating = false;
let hold: ReturnType<typeof setInterval> | undefined;
const holdForOwner = () => { terminating = true; hold ??= setInterval(() => {}, 1_000); };
process.on('SIGINT', holdForOwner);
process.on('SIGTERM', holdForOwner);
const chunks: Buffer[] = [];
let bytes = 0, failed = false;
process.stdin.on('data', (chunk: Buffer) => {
  bytes += chunk.length;
  if (bytes <= 256 * 1024 + 2048) chunks.push(chunk);
});
process.stdin.on('error', () => { failed = true; process.exitCode = 1; });
process.stdin.on('end', () => {
  void (async () => {
    await yieldImmediate();
    if (terminating) return;
    if (failed || bytes > 256 * 1024 + 2048) throw new Error('Invalid read');
    const request = validateEngineeringOutcomesReadRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
    const guard = () => {
      if (terminating || Date.now() >= request.deadlineAt || request.deadlineAt - Date.now() > 54_000) throw new Error('Read expired');
      if (canonical(createFirmEngineeringControlHandler(request.input.host).nodeInput) !== canonical(request.expectedNodeInput)) throw new Error('Enrollment changed');
    };
    guard();
    const report = readResourceEngineeringOutcomes(request.input);
    guard();
    await yieldImmediate();
    if (terminating) return;
    if (Date.now() >= request.deadlineAt) throw new Error('Read expired');
    const output = JSON.stringify({ schemaVersion: 1, requestId: request.requestId, scopeDigest: request.scopeDigest, report });
    if (Buffer.byteLength(output) > 192 * 1024 + 2048) throw new Error('Read too large');
    process.stdout.write(output + '\n');
  })().catch(() => { if (!terminating) process.exitCode = 1; });
});

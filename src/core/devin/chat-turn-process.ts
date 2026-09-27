/**
 * The Devin chat turn PROCESS (3.15) — what a Verse turn on a Devin seat
 * spawns, the way a Claude turn spawns `claude -p`. Runs on import.
 *
 * Input: ONE JSON payload on stdin (turn-protocol.ts DevinTurnPayload); argv
 * carries nothing, so the operator's text never shows in `ps` and the process
 * cannot be pointed at anything by its arguments (same rule as the account
 * probe helpers, resources/probe-helper-invocation.ts).
 * Output: turn-protocol lines on stdout, nothing else. stderr stays empty on
 * purpose — the engine shows a failed turn's stderr tail, and nothing here
 * should ever be worth showing raw.
 * Signals: SIGINT / SIGTERM stop the turn (the engine's Stop); Devin's side is
 * left as it is — Stop only stops watching.
 */
import { parseDevinTurnPayload, DEVIN_TURN_PAYLOAD_MAX_BYTES, type DevinTurnLine } from './turn-protocol.js';
import { DEVIN_TURN_EXIT, runDevinCloudTurn, type DevinTurnIo } from './chat-runner.js';
import { runDevinCliTurn } from './acp-bridge.js';

async function readStdin(): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > DEVIN_TURN_PAYLOAD_MAX_BYTES + 64 * 1024) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.stdout.on('error', () => controller.abort());

  const io: DevinTurnIo = {
    emit(line: DevinTurnLine): void {
      try {
        process.stdout.write(`${JSON.stringify(line)}\n`);
      } catch { /* the engine went away */ }
    },
    signal: controller.signal,
    sleep: (ms: number) => new Promise<void>((resolve) => {
      if (controller.signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', done);
        resolve();
      }
      controller.signal.addEventListener('abort', done, { once: true });
    }),
    now: () => Date.now(),
  };

  let raw: string | null;
  try {
    raw = await readStdin();
  } catch {
    raw = null;
  }
  let payload = null;
  try {
    payload = raw === null ? null : parseDevinTurnPayload(JSON.parse(raw));
  } catch {
    payload = null;
  }
  if (!payload) {
    io.emit({ type: 'error', message: 'The Devin turn was started without a valid request.' });
    return DEVIN_TURN_EXIT.badInput;
  }
  return payload.lane === 'cli' ? runDevinCliTurn(payload, io) : runDevinCloudTurn(payload, io);
}

main().then(
  (code) => {
    // Let stdout drain before exiting.
    process.stdout.write('', () => process.exit(code));
  },
  () => process.exit(DEVIN_TURN_EXIT.failed),
);

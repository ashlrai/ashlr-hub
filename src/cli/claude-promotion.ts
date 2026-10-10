import { dirname, isAbsolute, resolve } from 'node:path';
import { parseClaudeApiGrantRecordedObservation, recordClaudeApiGrantObservation } from '../core/resources/claude-api-grant.js';
import { readStableRegularFile } from '../core/util/stable-file-read.js';

const HELP = `Usage: phm resources claude-promotion record
  --observation <absolute-history-json> [--accounts-root <absolute-private-root>] [--json]

Record captured Claude API promotional-credit history in the existing private store.
Only claude-api-promotion-history with null binding and cycleId is accepted.
Keep the original capturedAt, evidenceDigest and expiry precision; do not invent
an organization, credential, cycle or exact expiration time. This validates local
structure, not provider billing authenticity. Automatic use remains Held.
Uses the configured accounts root unless --accounts-root is supplied.
No credentials, provider requests or financial authority are created.
Exit 0: recorded (or identical history already present); 1: store unavailable;
2: invalid arguments or observation.\n`;

export async function cmdClaudePromotion(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write(HELP); return 0;
  }
  const values = new Map<string, string>();
  let json = false;
  const invalid = () => { process.stderr.write('Invalid promotion history arguments; use --help.\n'); return 2; };
  if (args[0] !== 'record' || args.length > 6) return invalid();
  for (let i = 1; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (!['--observation', '--accounts-root'].includes(key) || values.has(key)) return invalid();
    const value = args[++i];
    if (!value || value.length > 4096 || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || !isAbsolute(value) || resolve(value) !== value) return invalid();
    values.set(key, value);
  }
  const file = values.get('--observation');
  if (!file) return invalid();
  const fail = (reason: string, code: number) => {
    if (json) process.stdout.write(JSON.stringify({ recorded: false, automaticAdmission: 'held', reason }) + '\n');
    else process.stderr.write(`Promotion history not recorded: ${reason}. Automatic use held.\n`);
    return code;
  };
  const read = readStableRegularFile(file, { anchorPath: dirname(file), maxFileBytes: 64 * 1024, remainingBytes: 64 * 1024 });
  if (!read.ok) return fail('observation-unavailable', 2);
  const now = Date.now();
  let row: ReturnType<typeof parseClaudeApiGrantRecordedObservation>;
  try { row = parseClaudeApiGrantRecordedObservation(JSON.parse(read.text), now); }
  catch { return fail('proof-invalid', 2); }
  // This local import route cannot mint a bound financial observation.
  if (!row || row.kind !== 'claude-api-promotion-history') return fail('proof-invalid', 2);
  let root = values.get('--accounts-root');
  if (!root) {
    try {
      const { loadConfig } = await import('../core/config.js');
      const { resolveAccountsRoot } = await import('../core/verse/seats.js');
      root = resolveAccountsRoot(loadConfig());
    } catch { return fail('store-unavailable', 1); }
  }
  const recorded = recordClaudeApiGrantObservation(root, row, now);
  if (!recorded.ok) return fail(recorded.reason, recorded.reason === 'proof-invalid' ? 2 : 1);
  if (json) process.stdout.write(JSON.stringify({ recorded: true, automaticAdmission: 'held' }) + '\n');
  else process.stdout.write('Recorded promotion history. Automatic use held.\n');
  return 0;
}

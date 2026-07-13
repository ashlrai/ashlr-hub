import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

import {
  readEffectJournal,
  readEffectRecord,
  resolvePreparedEffect,
  type EffectRecord,
  type EffectResolution,
} from '../core/util/effect-journal.js';
import { isTty, makeColors } from './ui.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

function help(): void {
  const { bold, cyan, dim } = makeColors(isTty());
  process.stdout.write('\n');
  process.stdout.write(bold('  ashlr recovery') + dim(' — inspect and disposition ambiguous effects') + '\n\n');
  process.stdout.write(`    ${cyan('ashlr recovery list')} [--json]\n`);
  process.stdout.write(`    ${cyan('ashlr recovery inspect <effect-id>')} [--json]\n`);
  process.stdout.write(`    ${cyan('ashlr recovery attest <effect-id>')} --outcome committed|no-effect --expect <attestation> --evidence <sha256> --reason <text>\n`);
  process.stdout.write(`    ${cyan('ashlr recovery abandon <effect-id>')} --expect <attestation> --reason <text>\n\n`);
  process.stdout.write(dim('  Mutations require an interactive terminal and exact typed confirmation. They never replay an effect or clear its run lease.\n\n'));
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

function validMutationShape(args: string[], sub: 'attest' | 'abandon'): boolean {
  const allowed = new Set(sub === 'attest'
    ? ['--outcome', '--expect', '--evidence', '--reason']
    : ['--expect', '--reason']);
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !allowed.has(name) || seen.has(name) || !value || value.startsWith('--')) return false;
    seen.add(name);
  }
  return args.length >= 4 && args.length % 2 === 0;
}

function exactRecord(effectId: string): { record?: EffectRecord; degraded: boolean } {
  const result = readEffectRecord(effectId);
  return {
    record: result.records.find((record) => record.effectId === effectId),
    degraded: result.sourceState === 'degraded' || result.limitExceeded,
  };
}

function printRecord(record: EffectRecord): void {
  process.stdout.write(`effect:       ${record.effectId}\n`);
  process.stdout.write(`phase:        ${record.phase}\n`);
  process.stdout.write(`tool:         ${record.toolName}\n`);
  process.stdout.write(`safety:       ${record.safety}\n`);
  process.stdout.write(`prepared:     ${record.preparedAt}\n`);
  process.stdout.write(`attestation:  ${record.attestation}\n`);
  if (record.phase === 'committed') process.stdout.write(`committed:    ${record.committedAt}\n`);
  if (record.phase === 'resolved') {
    process.stdout.write(`resolution:   ${record.resolution}\n`);
    process.stdout.write(`resolved:     ${record.resolvedAt}\n`);
  }
}

function evidenceDigest(input: { resolution: EffectResolution; evidence?: string; reason: string }): string {
  return createHash('sha256').update(JSON.stringify([
    'ashlr:operator-effect-resolution-evidence:v1',
    input.resolution,
    input.evidence ?? null,
    input.reason,
  ])).digest('hex');
}

async function confirmExact(effectId: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(`Type the full effect id to confirm terminal no-replay disposition:\n${effectId}\n> `);
    return answer.trim() === effectId;
  } finally {
    prompt.close();
  }
}

export async function cmdRecovery(args: string[]): Promise<number> {
  const sub = args[0] ?? 'list';
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    help();
    return 0;
  }

  if (sub === 'list') {
    if (args.some((arg, index) => index > 0 && arg !== '--json') || args.filter((arg) => arg === '--json').length > 1) {
      process.stderr.write('error: usage: ashlr recovery list [--json]\n');
      return 2;
    }
    const result = readEffectJournal(1_000);
    if (args.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const unresolved = result.records.filter((record) => record.phase === 'prepared');
      process.stdout.write(`effect journal: ${result.sourceState}; ${unresolved.length} unresolved\n`);
      for (const record of unresolved) {
        process.stdout.write(`${record.effectId}  ${record.safety}  ${record.toolName}  ${record.preparedAt}\n`);
      }
      if (result.limitExceeded) process.stdout.write('warning: bounded read limit exceeded; source is degraded\n');
    }
    return result.sourceState === 'degraded' || result.limitExceeded ? 1 : 0;
  }

  if (sub !== 'inspect' && sub !== 'attest' && sub !== 'abandon') {
    process.stderr.write(`error: unknown recovery subcommand: ${sub}\n`);
    return 2;
  }

  const effectId = args[1];
  if (!effectId || !SHA256_RE.test(effectId)) {
    process.stderr.write(`error: ${sub} requires an exact 64-character effect id\n`);
    return 2;
  }

  if (sub === 'inspect') {
    if (args.slice(2).some((arg) => arg !== '--json') || args.filter((arg) => arg === '--json').length > 1) {
      process.stderr.write('error: usage: ashlr recovery inspect <effect-id> [--json]\n');
      return 2;
    }
    const inspected = exactRecord(effectId);
    if (inspected.degraded) {
      process.stderr.write('error: effect journal is degraded; inspection is not authoritative\n');
      return 1;
    }
    if (!inspected.record) {
      process.stderr.write(`error: effect ${effectId} not found\n`);
      return 1;
    }
    if (args.includes('--json')) process.stdout.write(`${JSON.stringify(inspected.record)}\n`);
    else printRecord(inspected.record);
    return 0;
  }

  if (args.includes('--json') || args.includes('--yes') || args.includes('--force')) {
    process.stderr.write('error: recovery mutations do not support --json, --yes, or --force\n');
    return 2;
  }
  if (!validMutationShape(args, sub)) {
    process.stderr.write('error: unknown, duplicate, or valueless recovery mutation option\n');
    return 2;
  }
  const expectedAttestation = flag(args, '--expect');
  const reason = flag(args, '--reason');
  if (!expectedAttestation || !SHA256_RE.test(expectedAttestation) || !reason ||
    reason.trim().length === 0 || reason.length > 500) {
    process.stderr.write('error: mutation requires --expect <attestation> and --reason <1..500 chars>\n');
    return 2;
  }
  const outcome = flag(args, '--outcome');
  const evidence = flag(args, '--evidence');
  let resolution: EffectResolution;
  if (sub === 'abandon') {
    resolution = 'abandoned';
  } else if (outcome === 'committed') {
    resolution = 'attested-committed';
  } else if (outcome === 'no-effect') {
    resolution = 'attested-no-effect';
  } else {
    process.stderr.write('error: attest requires --outcome committed|no-effect\n');
    return 2;
  }
  if (sub === 'attest' && (!evidence || !SHA256_RE.test(evidence))) {
    process.stderr.write('error: attest requires positive --evidence <sha256>\n');
    return 2;
  }

  const inspected = exactRecord(effectId);
  if (inspected.degraded || !inspected.record || inspected.record.phase !== 'prepared') {
    process.stderr.write('error: exact prepared effect is unavailable or journal is degraded\n');
    return 1;
  }
  if (inspected.record.attestation !== expectedAttestation) {
    process.stderr.write('error: inspected effect changed; inspect again before resolving\n');
    return 1;
  }
  if (!await confirmExact(effectId)) {
    process.stderr.write('error: interactive exact-id confirmation required\n');
    return 1;
  }
  const ok = resolvePreparedEffect({
    effectId,
    expectedAttestation,
    resolution,
    evidenceDigest: evidenceDigest({ resolution, evidence, reason }),
  });
  if (!ok) {
    process.stderr.write('error: effect changed or resolution could not be durably recorded\n');
    return 1;
  }
  process.stdout.write(`resolved effect evidence ${effectId} as ${resolution}; replay and run resumption remain forbidden\n`);
  return 0;
}

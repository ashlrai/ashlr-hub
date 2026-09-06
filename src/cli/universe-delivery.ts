import { resolve } from 'node:path';
import {
  deliverUniverseElite, readUniverseDeliveries, validUniverseDeliveryBranch, type UniverseDeliveryReceipt,
} from '../core/universe/index.js';

const USAGE = `usage: ashlr universe deliver <id> --trial <elite-trial-id> --branch codex/<new-branch>
       ashlr universe deliveries <id>
       [--root <private directory>] [--json]

  deliver       Deliver the exact current elite to a new local Git branch
  deliveries    Read recorded delivery receipts without changing the repository

The destination is the experiment's pinned seed repository. Delivery creates
only a local commit and new branch; it does not switch HEAD, change the checkout
or index, push, merge, or deploy. An unchanged candidate creates no branch.
A pending receipt is not a completed delivery. A delivered branch is not an
accepted production change. --root defaults to ~/.ashlr/universe.
Exit codes: 0 handled, 1 failed/pending/degraded, 2 invalid arguments.
`;

class UsageError extends Error {}

interface Options {
  command: 'deliver' | 'deliveries' | 'help';
  id?: string;
  trialId?: string;
  branch?: string;
  root?: string;
  json: boolean;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function parse(args: string[]): Options {
  const positional: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') { help = true; continue; }
    if (arg === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true;
      continue;
    }
    if (['--root', '--trial', '--branch'].includes(arg)) {
      if (values.has(arg)) throw new UsageError(`${arg} may only be specified once`);
      const value = args[++index];
      if (!value?.trim() || value.startsWith('-') || hasControlCharacters(value)) {
        throw new UsageError(`${arg} requires a value`);
      }
      values.set(arg, value);
    } else if (arg.startsWith('-')) throw new UsageError(`Unknown option: ${arg}`);
    else positional.push(arg);
  }
  const [command, id] = positional;
  if (!['deliver', 'deliveries', 'help'].includes(command ?? '')) throw new UsageError('Expected deliver or deliveries');
  if (positional.length > (command === 'help' ? 1 : 2)) throw new UsageError(`Too many arguments for ${command}`);
  if (help || command === 'help') return { command: 'help', json: false };
  if (!id) throw new UsageError(`${command} requires a universe id`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new UsageError('Invalid universe id');
  const trialId = values.get('--trial');
  const branch = values.get('--branch');
  if (command === 'deliveries' && (trialId !== undefined || branch !== undefined)) {
    throw new UsageError('--trial and --branch are only valid with deliver');
  }
  if (command === 'deliver') {
    if (!trialId) throw new UsageError('deliver requires --trial <elite-trial-id>');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(trialId)) throw new UsageError('Invalid elite trial id');
    if (!branch) throw new UsageError('deliver requires --branch codex/<new-branch>');
    if (!validUniverseDeliveryBranch(branch)) throw new UsageError('Invalid delivery branch; use a new codex/<branch> name (at most 192 characters)');
  }
  const root = values.get('--root');
  return { command: command as 'deliver' | 'deliveries', id, trialId, branch,
    root: root === undefined ? undefined : resolve(root), json };
}

function renderReceipt(receipt: UniverseDeliveryReceipt, verified = true): string {
  return [
    `${receipt.universeId} · ${verified ? receipt.status : `recorded ${receipt.status} (unverified)`} · trial ${receipt.trialId}`,
    `Repository: ${receipt.repo}`,
    `Branch: ${receipt.branch} · commit ${receipt.commit}`,
    `Pinned base: ${receipt.baseCommit} · files changed: ${receipt.changedFiles.length}`,
    `Receipt: ${receipt.id}`,
    !verified ? 'Recorded receipt only; delivery evidence could not be fully verified.' :
      receipt.status === 'unchanged' ? 'Candidate matches the pinned base; no branch was created.' :
      receipt.status === 'pending' ? 'Delivery intent recorded; branch creation is not confirmed.' :
        'Local branch delivered. Checkout, index, and HEAD were not changed.',
    'Not pushed, merged, deployed, or accepted as a production change.',
  ].join('\n');
}

/** Delivery is an explicit repository mutation; receipt reads never dispatch it. */
export async function cmdUniverseDelivery(args: string[]): Promise<number> {
  try {
    const options = parse(args);
    if (options.command === 'help') { console.log(USAGE); return 0; }
    if (options.command === 'deliver') {
      const receipt = await deliverUniverseElite(options.id!, {
        trialId: options.trialId!, branch: options.branch!, root: options.root,
      });
      console.log(options.json ? JSON.stringify(receipt, null, 2) : renderReceipt(receipt));
      return receipt.status === 'pending' ? 1 : 0;
    }
    const result = readUniverseDeliveries(options.id!, { root: options.root });
    const counts = result.sourceState === 'degraded' ?
      'Branch-delivered count: unavailable (degraded evidence)' :
      `Branch-delivered: ${result.deliveries.filter((receipt) => receipt.status === 'delivered').length}` +
      ` · unchanged: ${result.deliveries.filter((receipt) => receipt.status === 'unchanged').length}` +
      ` · pending: ${result.deliveries.filter((receipt) => receipt.status === 'pending').length}`;
    console.log(options.json ? JSON.stringify(result, null, 2) : [
      `${options.id} · delivery source ${result.sourceState}`,
      counts,
      ...(result.deliveries.length ? result.deliveries.map((receipt) => renderReceipt(receipt, result.sourceState !== 'degraded')) :
        ['No recorded deliveries.']),
      ...result.reasons,
      'Delivery counts are local branch receipts, not production acceptance.',
    ].join('\n\n'));
    return result.sourceState === 'degraded' || result.deliveries.some((receipt) => receipt.status === 'pending') ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe delivery: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

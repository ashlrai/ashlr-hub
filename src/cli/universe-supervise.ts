import { isAbsolute, parse as parsePath, resolve } from 'node:path';
import type { UniverseCampaignSupervisorOptions } from '../core/universe/campaign-supervisor.js';

const USAGE = `usage: ashlr universe campaign supervise <id> [id ...] --root <absolute> --max-duration-ms <N>
  [--max-concurrent <1..4>] [--poll-interval-ms <50..60000>]
  [--resource-runtime <private absolute JSON>] [--json]
  [--delivery-plan <private absolute JSON>]

Runs a fixed queue of 1-32 explicitly registered campaigns in this process.
Each never-started campaign can dispatch once; its original budgets still apply.
The supervisor may wait for a busy Universe, but never resumes owner-held,
resource-withheld, uncertain, interrupted or failed campaigns automatically.
No daemon is installed and no newly registered campaign is added to this queue.
An opt-in delivery plan names campaign IDs, codex/ branches and full pinned seed
commits. Completed planned campaigns reconcile local delivery without rerunning
workers; new campaigns keep their original resource and admission checks.
Plan JSON: {"schemaVersion":1,"deliveries":[{"campaignId":"search",
"branch":"codex/result","baseCommit":"<full pinned seed commit>"}]}
The plan must be a private mode-0600 regular file (at most 64 KiB); every target
is checked before dispatch. No merge, push, checkout or service activation occurs.

--root must be canonical and absolute; there is no default store.
--max-duration-ms is required (1..86400000); cancellation awaits owned cleanup.
--max-concurrent defaults to 1. --poll-interval-ms defaults to 500.
Resource-pool campaigns require the explicit private runtime option.
Text mode emits state transitions to stderr; JSON mode emits one final report.
The normal campaign status/console continues to show durable run evidence.
Exit codes: 0 all campaigns completed, 1 incomplete/failed/timed-out,
2 invalid arguments, 130 caller cancellation. Completion is not project success.
`;

class UsageError extends Error {}

function canonicalPath(value: string): boolean {
  return isAbsolute(value) && resolve(value) === value && parsePath(value).root !== value &&
    Buffer.byteLength(value) <= 4096 && ![...value].some((character) => {
      const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
    });
}

function parse(args: string[]): { ids: string[]; options: UniverseCampaignSupervisorOptions; json: boolean; deliveryPlanPath?: string } {
  const ids: string[] = []; const seen = new Set<string>();
  const values: Record<string, string> = {}; let json = false;
  const names = ['--root', '--resource-runtime', '--delivery-plan', '--max-duration-ms', '--max-concurrent', '--poll-interval-ms'];
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--json') {
      if (json) throw new UsageError('--json may only be specified once');
      json = true; continue;
    }
    if (names.includes(key)) {
      if (seen.has(key)) throw new UsageError(`${key} may only be specified once`);
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new UsageError(`${key} requires a value`);
      seen.add(key); values[key] = value;
    } else if (key.startsWith('-')) throw new UsageError('Unknown supervision option');
    else ids.push(key);
  }
  if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id))) throw new UsageError('supervise requires 1-32 unique valid campaign ids');
  const root = values['--root']; const resourceRuntime = values['--resource-runtime'];
  if (!root || !canonicalPath(root)) throw new UsageError('supervise requires --root <canonical absolute private directory>');
  if (resourceRuntime !== undefined && !canonicalPath(resourceRuntime)) throw new UsageError('--resource-runtime requires a canonical absolute JSON path');
  const deliveryPlanPath = values['--delivery-plan'];
  if (deliveryPlanPath !== undefined && !canonicalPath(deliveryPlanPath)) throw new UsageError('--delivery-plan requires a canonical absolute JSON path');
  const integer = (key: string, minimum: number, maximum: number, fallback?: number): number => {
    const value = values[key];
    if (value === undefined && fallback !== undefined) return fallback;
    if (value === undefined || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) ||
      Number(value) < minimum || Number(value) > maximum) throw new UsageError(`${key} requires an integer from ${minimum} to ${maximum}`);
    return Number(value);
  };
  return { ids, json, deliveryPlanPath, options: { root, maxDurationMs: integer('--max-duration-ms', 1, 86_400_000),
    maxConcurrent: integer('--max-concurrent', 1, 4, 1), pollIntervalMs: integer('--poll-interval-ms', 50, 60_000, 500),
    ...(resourceRuntime ? { resourceRuntime } : {}) } };
}

export async function cmdUniverseSupervise(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const controller = new AbortController(); const abort = (): void => controller.abort();
  try {
    const { ids, options, json, deliveryPlanPath } = parse(args);
    if (deliveryPlanPath) {
      const { readResourceJson } = await import('../core/resources/pool-runtime.js');
      const { validateUniverseCampaignDeliveryPlan } = await import('../core/universe/campaign-delivery.js');
      try { options.deliveryPlan = validateUniverseCampaignDeliveryPlan(readResourceJson(deliveryPlanPath, 64 * 1024), ids); }
      catch { throw new UsageError('Invalid or unavailable private campaign delivery plan'); }
    }
    const { superviseUniverseCampaigns } = await import('../core/universe/campaign-supervisor.js');
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    const report = await superviseUniverseCampaigns(ids, { ...options, signal: controller.signal,
      ...(json ? {} : { onTransition: (event) => console.error(`${event.campaignId} · ${event.status} · ${event.reasonCode}`) }),
    });
    if (json) console.log(JSON.stringify(report, null, 2));
    else console.log([
      `Universe supervision · ${report.status} · foreground explicit queue`,
      ...report.outcomes.map((outcome) => `${outcome.campaignId} · ${outcome.status} · ${outcome.reasonCode} · attempted=${outcome.attempted}` +
        (outcome.delivery ? ` · delivery=${outcome.delivery.status}` + (outcome.delivery.status === 'delivered'
          ? ` ${outcome.delivery.receipt.branch} ${outcome.delivery.receipt.commit}` : ` (${outcome.delivery.reason})`) : '')),
      'Owned work has settled before return. Campaign completion is not proof of project success.',
      'No daemon, automatic resource-hold recovery or new budget was created.',
    ].join('\n'));
    return report.status === 'completed' ? 0 : report.status === 'cancelled' ? 130 : 1;
  } catch (error) {
    const message = error instanceof UsageError ? error.message : 'Campaign supervision unavailable; inspect the scoped campaign evidence';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(`universe campaign supervise: ${message}`);
    return error instanceof UsageError ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
  }
}

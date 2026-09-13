import { runFirmDemo, readFirmDemo, queryFirmDemo } from '../core/universe/firm-demo.js';
import { readFirmGraph, queryFirmGraph } from '../core/universe/firm-graph.js';
import { queryDecisionTracesV1, type DecisionTraceQueryV1 } from '../core/universe/decision-trace.js';
import { cmdUniverseFirmEngineering } from './universe-firm-engineering.js';

const COMMANDS = ['demo', 'status', 'query', 'graph', 'traces'];
const HELP = `Usage: ashlr universe firm <demo|status|query|graph|traces> --root <existing-private-dir> [--json]
       ashlr universe firm engineer --help
       ashlr universe firm query --root <existing-private-dir> [--entity <id>] [--limit <1..256>] [--json]
       ashlr universe firm traces --root <existing-private-dir> [--entity <id>] [--action <action>]
           [--since <UTC-ISO-time>] [--until <UTC-ISO-time>] [--limit <1..256>] [--json]

graph and traces inspect any persisted signed control graph, read-only.
engineer explicitly enrolls existing campaigns for bounded evaluated local delivery.
Use engineer --check to inspect enrollment before execution; see its dedicated help.
traces defaults to 100 results in history order; time bounds are inclusive UTC ISO timestamps.
Healthy incomplete graphs remain inspectable; missing/unverifiable history exits 1 with no traces.
Invalid options exit 2. Inspection never executes a graph or acquires execution ownership.
Signatures verify loaded history integrity, not authority, liveness or rollback protection.

demo runs only a fixed, inert plan -> artifact -> cold-check -> signed-trace fixture.
The intentionally lying candidate must be rejected for the demo to be accepted.
No models, provider requests, candidate commands, account access, deliveries or process isolation.
Requires an absolute canonical private root and existing host provenance key; never creates a key.
status and query are read-only. Repeating demo preserves prior durable graph history.
Signatures prove integrity, not authority. Use a dedicated root for this fixed graph.`;

export async function cmdUniverseFirm(args: string[]): Promise<number> {
  if (args[0] === 'engineer') return cmdUniverseFirmEngineering(args.slice(1));
  if (!args.length || args.length === 1 && ['help', '--help', '-h'].includes(args[0]!) ||
      args.length === 2 && COMMANDS.includes(args[0]!) && ['--help', '-h'].includes(args[1]!)) {
    console.log(HELP); return 0;
  }
  const command = args[0];
  if (!command || !COMMANDS.includes(command)) { console.error(HELP); return 2; }
  const inspection = command === 'graph' || command === 'traces';
  let root: string | undefined; let json = false;
  const query: DecisionTraceQueryV1 = {};
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) { console.error('Duplicate firm option. Use --help.'); return 2; }
    seen.add(flag);
    if (flag === '--json') { json = true; continue; }
    if (!['--root', ...(command === 'query' ? ['--entity', '--limit'] :
      command === 'traces' ? ['--entity', '--action', '--since', '--until', '--limit'] : [])].includes(flag)) {
      console.error('Unknown firm option. Use --help.'); return 2;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) { console.error('Missing firm option value. Use --help.'); return 2; }
    if (flag === '--root') root = value;
    if (flag === '--entity') query.entity = value;
    if (flag === '--action') query.action = value;
    if (flag === '--since') query.since = value;
    if (flag === '--until') query.until = value;
    if (flag === '--limit') {
      if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 256) { console.error('Query limit must be 1..256.'); return 2; }
      query.limit = Number(value);
    }
  }
  if (!root) { console.error('An existing private --root is required. Use --help.'); return 2; }
  if (command === 'traces') {
    try { queryDecisionTracesV1([], query); }
    catch { console.error('Invalid trace filters: use entity/action tokens, UTC ISO times, since <= until, and limit 1..256.'); return 2; }
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (command === 'demo') { process.once('SIGINT', cancel); process.once('SIGTERM', cancel); }
  try {
    if (inspection) {
      const result = command === 'graph' ? readFirmGraph({ root }) : queryFirmGraph({ root }, query);
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        const graph = 'graph' in result ? result.graph : result;
        console.log(`Firm graph: ${result.status}\nSource: ${graph.sourceState}\nGraph: ${graph.graphId ?? 'none'}\n` +
          `Execution: ${'graph' in result ? result.graph.status : result.graphStatus}\n` +
          `Signatures: ${result.signatureVerification} (${result.keyScope})`);
        if ('graph' in result) {
          for (const node of result.graph.nodes) console.log(`Node ${node.id}: ${node.kind}, ${node.state}`);
          for (const edge of result.graph.edges) console.log(`Edge ${edge.from} -> ${edge.to}: ${edge.artifactDigest}`);
        } else {
          console.log(`Traces: ${result.query.traces.length} of ${result.query.total}${result.query.truncated ? ' (truncated)' : ''}`);
          for (const trace of result.query.traces) console.log(JSON.stringify(trace));
        }
        console.log(`${result.guidance}\n${result.scope}`);
      }
      return result.status === 'available' ? 0 : 1;
    }
    const result = command === 'demo' ? await runFirmDemo({ root, signal: controller.signal }) : command === 'status' ? readFirmDemo({ root }) : queryFirmDemo({ root }, query);
    if (json) console.log(JSON.stringify(result, null, 2));
    else if ('graph' in result) {
      console.log(`Firm demo: ${result.status}\nGraph: ${result.graph.status} (${result.graph.sourceState})\n` +
        `Positive verified: ${result.checks.positiveVerified}\nIntentional liar rejected: ${result.checks.intentionalLiarRejected}\n` +
        `Planted conflict retained: ${result.checks.plantedConflictPreserved}\n` +
        `Recorded traces: ${result.counts.traces}\n${result.scope}`);
    } else console.log(JSON.stringify(result, null, 2));
    return result.status === 'accepted-fixture' ? 0 : 1;
  } catch {
    // Never emit paths, raw filesystem errors or key material from a failed read.
    const error = { schemaVersion: 1, status: 'unavailable', reason: inspection ? 'firm-graph-input-or-evidence-unavailable' : 'firm-demo-input-or-evidence-unavailable' };
    if (json) console.log(JSON.stringify(error)); else console.error(`Firm ${inspection ? 'graph' : 'demo'} unavailable: check the explicit private root and existing evidence.`);
    return 1;
  } finally {
    if (command === 'demo') { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
}

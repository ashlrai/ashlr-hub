import { canonical, digest, inspectPrivateDirectory } from '../core/universe/artifacts.js';
import { readResourceJson } from '../core/resources/pool-runtime.js';
import { createFirmEngineeringControlHandler, type FirmEngineeringControlHost } from '../core/universe/firm-engineering-control-handler.js';
import { runControlGraph, validateControlGraph } from '../core/universe/control-graph.js';
import { isAbsolute, resolve } from 'node:path';

export const FIRM_ENGINEERING_HELP = `Usage: ashlr universe firm engineer --root <existing-private-graph-dir>
       --enrollment <private-canonical-json> [--check] [--json]
       [--expected-enrollment-digest <sha256-from-check>]

--check reads the explicit enrollment and existing campaign/runtime evidence only.
It returns the canonical enrollment digest needed for execution. No provider or
evaluator is contacted, no graph/controller is created, and no branch is written.
Without --check the expected digest is REQUIRED. This starts a bounded foreground
engineering portfolio: resource-accounted generation, confined file operations,
fixed evaluation, and strict-improvement delivery to explicitly named local
codex/ branches. All campaigns and their evaluator/runtime configuration must
already exist. Each portfolio task requires a delivery target. Command variants
and unaccounted direct-local generation are not enrolled by this adapter.

Enrollment JSON: {"schemaVersion":1,"graphId":"engineering-run","host":{...}}
host fields: nodeId, root (Universe store, NOT the graph directory),
constitutionVersion, policyEpoch, definition (existing campaign portfolio),
deliveryPlan, resourceRuntime (private file), expectedRuntimeDigest (canonical
validated runtime SHA-256). File must be owner-only 0600 in a private directory.
The expected digest pins configuration, not authority or correctness.

SIGINT/SIGTERM and existing KILL controls stop new effects and await settlement.
Repeating a completed graph reads its signed result without another dispatch.
Unresolved graph intents remain held unless exact completed child evidence can be
reconciled read-only within the original graph deadline and stop controls. Recovery
does not rerun a controller or provider. Do not use a new ID to replay uncertain work.
The first execution requires a NEW controller ID; preexisting controllers cannot
be adopted. Existing graph/controller/campaign deadlines are not renewed.
No merge, checkout, remote push, deployment, account-policy change, resident
service, key creation, or production acceptance. Existing host provenance key
required to execute. Local evaluation acceptance is limited to its fixed checks.
Exit: 0 validated check/completed graph; 1 withheld/incomplete; 2 invalid options.
`;

export async function cmdUniverseFirmEngineering(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
    console.log(FIRM_ENGINEERING_HELP); return 0;
  }
  const values = new Map<string, string>();
  let check = false; let json = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) { console.error('Duplicate engineering option. Use --help.'); return 2; }
    seen.add(flag);
    if (flag === '--check') { check = true; continue; }
    if (flag === '--json') { json = true; continue; }
    if (!['--root', '--enrollment', '--expected-enrollment-digest'].includes(flag)) {
      console.error('Unknown engineering option. Use --help.'); return 2;
    }
    const value = args[++index];
    if (!value || value.startsWith('-') || value.length > 4096 || [...value].some((character) => {
      const code = character.charCodeAt(0); return code < 32 || code >= 127 && code <= 159;
    })) {
      console.error('Missing or invalid engineering option value. Use --help.'); return 2;
    }
    values.set(flag, value);
  }
  const root = values.get('--root'); const file = values.get('--enrollment');
  const expected = values.get('--expected-enrollment-digest');
  if (!root || !file || !check && !expected || expected !== undefined && !/^[a-f0-9]{64}$/.test(expected)) {
    console.error('Engineering requires --root, --enrollment and an exact digest unless --check is supplied.'); return 2;
  }
  if (![root, file].every((path) => isAbsolute(path) && resolve(path) === path && resolve(path, '..') !== path)) {
    console.error('Engineering paths must be explicit canonical absolute paths.'); return 2;
  }
  const controller = new AbortController(); const cancel = () => controller.abort();
  if (!check) { process.once('SIGINT', cancel); process.once('SIGTERM', cancel); }
  try {
    inspectPrivateDirectory(root);
    const enrollment = readResourceJson(file, 256 * 1024) as {
      schemaVersion: 1; graphId: string; host: FirmEngineeringControlHost;
    };
    if (!enrollment || typeof enrollment !== 'object' || Array.isArray(enrollment) ||
        Object.keys(enrollment).sort().join(',') !== 'graphId,host,schemaVersion' || enrollment.schemaVersion !== 1) {
      throw new Error('Invalid engineering enrollment');
    }
    const enrollmentDigest = digest(canonical(enrollment));
    if (expected !== undefined && expected !== enrollmentDigest) throw new Error('Engineering enrollment changed');
    const binding = createFirmEngineeringControlHandler(enrollment.host);
    const definition = validateControlGraph({ schemaVersion: 1, id: enrollment.graphId, maxConcurrent: 1,
      maxDurationMs: enrollment.host.definition.maxDurationMs,
      nodes: [{ id: enrollment.host.nodeId, kind: 'deliver', requires: [], input: binding.nodeInput }] });
    if (check) {
      const result = { schemaVersion: 1, status: 'validated-enrollment', enrollmentDigest,
        graphId: definition.id, bindingDigest: binding.nodeInput.bindingDigest,
        campaigns: enrollment.host.definition.tasks.map((task) => task.campaignId),
        effectsExecuted: false, providerContacted: false,
        scope: 'Enrollment only; not authentication, capacity, authority, evaluation or delivery acceptance.' };
      console.log(json ? JSON.stringify(result, null, 2) : `Engineering enrollment validated\nDigest: ${enrollmentDigest}\n${result.scope}`);
      return 0;
    }
    const report = await runControlGraph(definition, { root, signal: controller.signal, handlers: { deliver: binding.handler } });
    console.log(json ? JSON.stringify(report, null, 2) : `Engineering graph: ${report.status}\nSource: ${report.sourceState}\n` +
      report.nodes.map((node) => `${node.id}: ${node.state}`).join('\n') +
      '\nAcceptance scope: fixed evaluator and explicit local branch only. No production deployment.');
    return report.status === 'completed' && report.sourceState === 'healthy' ? 0 : 1;
  } catch {
    const result = { schemaVersion: 1, status: 'unavailable', reason: 'engineering-enrollment-or-evidence-unavailable' };
    console.log(json ? JSON.stringify(result) : 'Engineering unavailable: inspect the explicit enrollment, existing evidence and host controls.');
    return 1;
  } finally {
    if (!check) { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  }
}

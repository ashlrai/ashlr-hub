/** Fixed diagnostic adapter. Shared execution is bundled into this installed file.
 * Standalone leaf mode retains its original eight-check, non-evaluation output.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { runPreparationWorkload } from './preparation-workload.mjs';
import { openBuiltinActivityTracker } from './preparation-verification-activity.mjs';
import { resolvePreparationGit } from './preparation-verification-native.mjs';

export { runPreparationWorkload };

export async function runPreparationMeasurement() {
  const stop = new globalThis.AbortController();
  const onStop = () => stop.abort();
  process.on('SIGINT', onStop); process.on('SIGTERM', onStop);
  let activity; let measurement;
  try {
    try {
      const bridgePath = fileURLToPath(new URL('./preparation-bridge.mjs', import.meta.url));
      if (process.argv.length !== 3 || process.argv[2] !== bridgePath) throw new Error('Invalid fixed invocation');
      if (process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY) activity = await openBuiltinActivityTracker(process.env.ASHLR_UNIVERSE_BUILTIN_ACTIVITY, stop.signal);
      let gitPin;
      if (activity) {
        const text = process.env.ASHLR_UNIVERSE_BUILTIN_GIT;
        if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) throw new Error('Invalid fixed Git identity');
        gitPin = JSON.parse(text);
      } else gitPin = resolvePreparationGit();
      const deadlineAt = activity ? Date.parse(activity.owner.deadlineAt) : Infinity;
      const deadlineMonotonicMs = performance.now() + (deadlineAt - Date.now());
      measurement = await runPreparationWorkload({ mode: activity ? 'preparation-workflows-v2' : 'preparation-leaf-v1',
        candidateRoot: process.env.ASHLR_UNIVERSE_CANDIDATE, scratchRoot: process.env.HOME, gitPin,
        activity, signal: stop.signal, deadlineAt, deadlineMonotonicMs });
    } catch {
      measurement = { schemaVersion: 1, kind: 'preparation-verification-measurement',
        ...(activity ? { workload: 'preparation-workflows-v2', workflows: [], qualifications: [] } : {}),
        checksPassed: false, metrics: { correctness_checks: 0 }, diagnostics: [{ code: 'HARNESS_INITIALIZATION_FAILED',
          message: activity ? 'Pinned verification workload did not satisfy its fixed checks at initialize.'
            : 'Pinned verification prototype did not satisfy its fixed checks.' }] };
    }
    try { activity?.complete(); }
    catch { measurement.checksPassed = false; measurement.diagnostics = [{ code: 'PROCESS_SETTLEMENT_UNCONFIRMED', message: 'Owned process settlement remains unconfirmed.' }]; }
    return measurement;
  } finally {
    process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.stdout.write(JSON.stringify(await runPreparationMeasurement()) + '\n');
}

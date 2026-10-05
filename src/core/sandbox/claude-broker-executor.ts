/** Tools cross the trusted-native boundary only through a separate empty-auth OS jail. */
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import type { AshlrConfig } from '../types.js';
import { spawnEngine } from '../run/engines.js';
import { prepareAutonomousSpawn, finishAutonomousSpawn, disposeAutonomousSpawn, type AutonomousSpawnFinish } from './autonomous-run.js';
import { autonomousConfinementProfile } from './confine.js';
import { resolveClaudeBrokerToolInvocation } from './claude-broker-tool-invocation.js';
import type { ClaudeBrokerExecutor } from './claude-native-broker.js';

export function claudeBrokerToolExecutor(options: { worktree: string; cfg: AshlrConfig;
  recordEvidence(finish: AutonomousSpawnFinish): Promise<void> | void; retainCleanupFailure(): void }): ClaudeBrokerExecutor {
  const worktree = realpathSync(options.worktree);
  const execute: ClaudeBrokerExecutor = async (call, signal, admission) => {
    if (signal.aborted || !admission()) throw new Error('tool authority unavailable');
    const worker = resolveClaudeBrokerToolInvocation();
    const underWorktree = (path: string): boolean => {
      const part = relative(worktree, path);
      return part === '' || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
    };
    // A source-owned helper must never be writable as an agent worktree file.
    if ([worker.bin, ...worker.readOnlyPaths].some(underWorktree)) throw new Error('tool source cannot be inside the agent worktree');
    const request = JSON.stringify({ schemaVersion: 1, root: worktree, call });
    if (Buffer.byteLength(request) > 128 * 1024) throw new Error('tool request too large');
    const owned = prepareAutonomousSpawn({ engine: 'local', worktree, bin: worker.bin,
      baseEnv: { PATH: process.env.PATH, LANG: 'C' }, extraReadOnly: worker.readOnlyPaths,
      profile: { ...autonomousConfinementProfile('local'), loopbackPorts: [] }, nodeToolchain: false });
    let finished = false;
    try {
      if (owned.evidence?.ready !== true) throw new Error('tool confinement evidence unavailable');
      if (!worker.isCurrent() || signal.aborted || !admission()) throw new Error('tool source or authority changed');
      const result = await spawnEngine({ bin: owned.bin, args: worker.args, cwd: worktree }, options.cfg,
        { env: owned.env, launcher: owned.launcher, signal, stdin: request,
          selectedOutcomeAdmission: () => owned.evidence?.ready === true && worker.isCurrent() && admission(), timeoutMs: 15_000 });
      if (result.terminationReason === 'error-exit' && /(?:termination authority lost|termination deadline elapsed|(?:closure|exit).*unconfirmed)/i.test(result.error ?? '')) {
        options.retainCleanupFailure();
        // The child may still read its private request/environment. Preserve that
        // private root; no cleanup or clean-evidence assertion on an unsettled tree.
        owned.evidence?.abort(); finished = true;
        await options.recordEvidence({ violations: [], vendor: { committed: [], skipped: [] },
          violationsKnown: false, kernelEvidence: { source: 'kernel-log', state: 'incomplete', reason: 'tool process cleanup unconfirmed', denials: [] } });
        throw new Error('tool process cleanup unconfirmed');
      }
      const evidence = finishAutonomousSpawn(owned, { output: `${result.output}\n${result.error ?? ''}` });
      finished = true; await options.recordEvidence(evidence);
      if (!worker.isCurrent() || !result.ok || !evidence.violationsKnown || evidence.violations.length || signal.aborted || !admission()) throw new Error('tool request refused');
      return result.output;
    } finally { if (!finished) disposeAutonomousSpawn(owned); }
  };
  return serializeClaudeToolMutations(execute);
}

/** Run-owned ordering only; external writers still require expected-SHA checks. */
export function serializeClaudeToolMutations(execute: ClaudeBrokerExecutor): ClaudeBrokerExecutor {
  // One run owns this queue; directory creation can overlap any file path, so
  // serialize all our mutations. This is not a lock against external editors.
  let mutations: Promise<void> = Promise.resolve();
  return async (call, signal, admission) => {
    if (!['write_file', 'edit_file', 'create_directory'].includes(call.name)) return execute(call, signal, admission);
    const previous = mutations;
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    mutations = previous.then(() => done);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('tool authority unavailable'));
        signal.addEventListener('abort', abort, { once: true });
        void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
        if (signal.aborted) abort();
      });
      return await execute(call, signal, admission);
    } finally { release(); }
  };
}

/** One foreground mission owner composed with the existing human workspace. */
import { randomBytes } from 'node:crypto';
import type { ResourceConsoleWorkspaceHandle } from '../web/resource-console-server.js';
import { missionData, missionExact, missionHash, validateResourceEngineeringMissionConfig, type ResourceEngineeringMissionConfig } from './engineering-mission-store.js';
import { readEngineeringMissionControl, setEngineeringMissionControl, pinEngineeringMissionControlRoot } from './engineering-mission-control.js';
import type { EngineeringMissionCommand, EngineeringMissionSnapshot } from './engineering-mission-manager-types.js';
import { readResourceJson } from './pool-runtime.js';
import { runResourceEngineeringMission } from './engineering-mission.js';

export function createEngineeringMissionManager(options: {
  config: ResourceEngineeringMissionConfig; configFile: string; autoStart: boolean;
  workspace: ResourceConsoleWorkspaceHandle; isStopped(): boolean;
}) {
  const config = validateResourceEngineeringMissionConfig(options.config), configDigest = missionHash(config);
  const pinned = pinEngineeringMissionControlRoot(config.root);
  let control = readEngineeringMissionControl(config);
  const controllerId = randomBytes(16).toString('hex');
  let state: EngineeringMissionSnapshot['state'] = 'idle', phase: string | null = null, scope = 0;
  let lastOutcome: EngineeringMissionSnapshot['lastOutcome'] = null;
  let active: { abort: AbortController; done: Promise<void> } | null = null;
  let closing: Promise<void> | null = null;
  let controlFaulted = false, startupAttempted = false;
  const snapshot = (): EngineeringMissionSnapshot => ({ schemaVersion: 1, missionId: config.id, configDigest, controllerId,
    revision: control.revision, enabled: control.enabled, autoStart: options.autoStart, state, phase, scope,
    maxScopes: config.maxScopes, deadlineAt: config.deadlineAt, sampledAt: new Date().toISOString(),
    remainingMs: Math.max(0, Date.parse(config.deadlineAt) - Date.now()), lastOutcome: lastOutcome ? { ...lastOutcome } : null });
  const checkIdentity = (input: EngineeringMissionCommand) => {
    const command = missionData<EngineeringMissionCommand>(input);
    if (!missionExact(command, ['expectedControllerId', 'expectedConfigDigest', 'expectedRevision']) ||
      command.expectedControllerId !== controllerId || command.expectedConfigDigest !== configDigest ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== control.revision || closing) throw new Error('Mission control changed');
  };
  const check = (input: EngineeringMissionCommand) => {
    checkIdentity(input); pinned(); const observed = readEngineeringMissionControl(config);
    if (observed.digest !== control.digest) throw new Error('Mission control changed');
  };
  const launch = (expectedAttachment: ReturnType<ResourceConsoleWorkspaceHandle['engineeringAttachment']>) => {
    // Claim the slot synchronously, before any asynchronous proof or admission.
    state = 'running'; phase = 'startup'; scope = 0; lastOutcome = null;
    const abort = new AbortController();
    const invocation = { abort, done: Promise.resolve() }; active = invocation;
    invocation.done = Promise.resolve().then(async () => {
      const report = await runResourceEngineeringMission(config, { signal: abort.signal,
        workspace: { handle: options.workspace, expectedAttachment },
        onProgress: value => { if (active === invocation && !abort.signal.aborted) { phase = value.phase; scope = value.scope; } } });
      lastOutcome = controlFaulted ? { state: 'held', reason: 'mission-control-unavailable', scopesReserved: report.scopesReserved }
        : { state: report.state, reason: report.reason, scopesReserved: report.scopesReserved };
      state = lastOutcome.state; scope = report.scopesReserved;
    }).catch(() => { state = 'held'; lastOutcome = { state: 'held', reason: 'mission-unavailable', scopesReserved: scope }; })
      .finally(() => { if (active === invocation) active = null; });
  };
  const start = (command: EngineeringMissionCommand) => {
    check(command);
    if (active || options.isStopped() || Date.now() >= Date.parse(config.deadlineAt) || state === 'held' || state === 'completed') throw new Error('Mission start unavailable');
    if (missionHash(validateResourceEngineeringMissionConfig(readResourceJson(options.configFile, 512 * 1024))) !== configDigest) throw new Error('Mission configuration changed');
    const expectedAttachment = options.workspace.engineeringAttachment();
    if (expectedAttachment && expectedAttachment.state() !== 'closed') throw new Error('Mission workspace already has active engineering');
    control = setEngineeringMissionControl(config, true, control.revision); launch(expectedAttachment); return snapshot();
  };
  return {
    snapshot, start,
    stop(command: EngineeringMissionCommand) {
      checkIdentity(command);
      // Persist intent before reporting acceptance. A lost HTTP response or host
      // restart must not silently re-enable autonomous generation.
      try { check(command); control = setEngineeringMissionControl(config, false, control.revision); }
      catch (error) { controlFaulted = true; active?.abort.abort(); state = 'held'; throw error; }
      if (active) { state = 'stopping'; active.abort.abort(); }
      else if (state !== 'held') state = 'stopped';
      return snapshot();
    },
    startConfigured() {
      // One startup attempt, never a loop that retries held or failed work.
      if (startupAttempted) return; startupAttempted = true;
      if (!options.autoStart || control.revision > 0 && !control.enabled) return;
      try { start({ expectedControllerId: controllerId, expectedConfigDigest: configDigest, expectedRevision: control.revision }); }
      catch { state = 'held'; lastOutcome = { state: 'held', reason: 'mission-start-unavailable', scopesReserved: 0 }; }
    },
    close(): Promise<void> {
      if (closing) return closing;
      const invocation = active;
      if (invocation) { state = 'stopping'; invocation.abort.abort(); }
      closing = Promise.resolve().then(async () => {
        await invocation?.done;
        if (state === 'held') throw new Error('Mission shutdown uncertain');
        state = 'closed';
      });
      return closing;
    },
  };
}
export type EngineeringMissionManager = ReturnType<typeof createEngineeringMissionManager>;

/** The official native CLI owns its credentials. Only model-directed tools enter
 * the separate empty-auth worker jail; this is not a credential proxy. */
import { constants, accessSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AshlrConfig } from '../types.js';
import { enginePermitted } from '../policy/local-only.js';
import { spawnEngine, type RunEvent, type SpawnEngineOptions, type SpawnEngineResult } from '../run/engines.js';
import { prepareAutonomousSpawn, finishAutonomousSpawn, type AutonomousSpawn, type AutonomousSpawnFinish } from './autonomous-run.js';
import { autonomousConfinementProfile, buildAutonomousSbplProfile, escapeSbplPath, SANDBOX_EXEC_PATH, type SandboxLauncher } from './confine.js';
import { observeClaudeNativeBinding, readClaudeNativeBinding, sameClaudeNativeBinding, type ClaudeNativeBinding } from './claude-native-admission.js';
import { claudeBrokerCommand, claudeBrokerNativeEnvironment, startClaudeNativeBroker, type ClaudeBrokerObservation } from './claude-native-broker.js';
import { claudeBrokerToolExecutor } from './claude-broker-executor.js';

const NATIVE_AUTH_HELPERS = ['/usr/bin/security','/bin/sh'] as const;
const cleanupUnknown = (r: SpawnEngineResult): boolean => r.terminationReason === 'error-exit' &&
  /(?:termination authority lost|termination deadline elapsed|(?:closure|exit).*unconfirmed)/i.test(r.error ?? '');
function trustedNativeAuthHelperEpoch(): string {
  return NATIVE_AUTH_HELPERS.map(path => {
    const s = lstatSync(path, { bigint: true });
    if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0n || (s.mode & 0o022n) !== 0n || realpathSync(path) !== path) throw new Error('Native auth helper unavailable');
    accessSync(path, constants.X_OK);
    return [path,s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':');
  }).join('|');
}
/** Native auth is a deliberately separate, source-owned privilege. Never use
 * this launcher for a model-authored program or a generic autonomous worker. */
export function claudeNativeOuterLauncher(owned: AutonomousSpawn, binding: ClaudeNativeBinding, brokerPort: number, scratch: string): SandboxLauncher {
  if (process.platform !== 'darwin' || !Number.isInteger(brokerPort) || brokerPort < 1 || brokerPort > 65535) throw new Error('Native Claude confinement unavailable');
  trustedNativeAuthHelperEpoch();
  const profileRoot = dirname(binding.launch.command[1]);
  const nativeWrites = [binding.launch.nativeStatePath, join(profileRoot, 'anthropic-state')];
  // Only the official CLI can write its own runtime state; the model has no
  // built-in file/shell tools, and the outer cwd has no project settings.
  const overlay = { ...owned.overlay, writablePaths: [...owned.overlay.writablePaths, ...nativeWrites] };
  const base = buildAutonomousSbplProfile({ ...autonomousConfinementProfile('local'), loopbackPorts: [] },
    { worktree: scratch, home: owned.home, env: owned.env, overlay,
      ...(owned.evidence ? { violationTag: owned.evidence.tag } : {}) });
  const literal = (value: string) => `(literal "${escapeSbplPath(value)}")`;
  const rules = [
    '; Trusted official native auth outer process only; tool workers retain the original jail.',
    '(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))',
    '(allow network-outbound (remote ip "*:*"))',
    '(deny network-outbound (remote ip "localhost:*"))',
    `(allow network-outbound (remote ip "localhost:${brokerPort}"))`,
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    '(deny process-exec)',
    `(allow process-exec ${[...binding.launch.command.slice(0,1),binding.launch.executable,...NATIVE_AUTH_HELPERS].map(literal).join(' ')})`,
  ];
  return { bin: SANDBOX_EXEC_PATH, prefixArgs: ['-p', `${base}\n${rules.join('\n')}`] };
}
export type ClaudeNativeAdapterResult = SpawnEngineResult & { captureDenied?: boolean };
export interface ClaudeNativeAdapterOptions {
  cfg: AshlrConfig; runId: string; seatId: string; model: string; prompt: string; worktree: string;
  signal: AbortSignal; admission(): boolean; onEvent?(event: RunEvent): void; timeoutMs: number;
  recordEvidence(finish: AutonomousSpawnFinish): Promise<void> | void;
  /** Existing capture retains the worktree when an owned process cannot settle. */
  retainCleanupFailure(): void;
  /** Harness tuning is source-selected; only the native effort flag is carried. */
  effort?: string;
}
export async function runClaudeNativeAdapter(options: ClaudeNativeAdapterOptions): Promise<ClaudeNativeAdapterResult> {
  let providerContacted = false;
  const held = (reason: string): ClaudeNativeAdapterResult => ({ providerContacted,ok:false, output:'', error:reason, terminationReason:'error-exit',captureDenied:true });
  if (options.signal === undefined) return held('Native Claude producer cancellation ownership unavailable');
  if (options.signal.aborted) return { ...held('run cancelled'), terminationReason:'cancelled' };
  if (!enginePermitted('claude', options.cfg).permitted || !options.admission()) return held('Selected Claude account authority unavailable');
  if (process.platform !== 'darwin') return held('Native Claude tool confinement requires macOS');
  if (Buffer.byteLength(options.prompt) > 1024 * 1024) return held('Native Claude stdin exceeds bounded protocol');
  const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ashlr-claude-native-')));
  const stop = new AbortController();
  const signal = AbortSignal.any([options.signal, stop.signal]);
  let retained = false;
  let evidenceComplete = true;
  const evidence = async (finish: AutonomousSpawnFinish): Promise<void> => {
    if (finish.violations.length || !finish.violationsKnown) { evidenceComplete=false; stop.abort(); }
    await options.recordEvidence(finish);
  };
  let owned: AutonomousSpawn | null = null;
  let broker: Awaited<ReturnType<typeof startClaudeNativeBroker>> | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refresh: Promise<void> | null = null;
  let refreshEnabled = true;
  let proof: Awaited<ReturnType<typeof observeClaudeNativeBinding>> = null;
  let observation: ClaudeBrokerObservation | null = null;
  let result: SpawnEngineResult | null = null;
  let authHelperEpoch: string;
  const current = (): boolean => {
    try {
      const fresh = readClaudeNativeBinding(options.cfg, options.seatId);
      return !signal.aborted && options.admission() && observation !== null && observation.expiresAtMs > Date.now() && proof !== null && fresh !== null &&
        (fresh.localAccountDigest === null || fresh.localAccountDigest === observation.accountDigest) &&
        (owned === null || owned.evidence?.ready === true) &&
        sameClaudeNativeBinding(proof.binding,fresh) && trustedNativeAuthHelperEpoch() === authHelperEpoch;
    } catch { return false; }
  };
  const retain = () => { retained = true; options.retainCleanupFailure(); stop.abort(); };
  // Ownership/Stop is polled independently of native stdout or model progress.
  const stopTimer = setInterval(() => {
    try { if (!options.admission() || proof !== null && !current()) stop.abort(); } catch { stop.abort(); }
  }, 100);
  stopTimer.unref();
  try {
    authHelperEpoch = trustedNativeAuthHelperEpoch();
    proof = await observeClaudeNativeBinding(options.cfg,options.seatId,options.runId,options.model,scratch,signal,options.admission);
    observation = proof?.observation ?? null;
    if (!proof || !current()) return held('Selected Claude native identity, allowance or credit protection unconfirmed');
    owned = prepareAutonomousSpawn({ engine:'local', worktree:scratch, bin:proof.binding.launch.command[0],
      baseEnv:claudeBrokerNativeEnvironment(), extraReadOnly:[dirname(proof.binding.launch.command[1]),proof.binding.launch.executable],
      profile:{...autonomousConfinementProfile('local'),loopbackPorts:[]} });
    if (owned.evidence?.ready !== true) return held('Native Claude confinement evidence unavailable before contact');
    const execute = claudeBrokerToolExecutor({ worktree:options.worktree,cfg:options.cfg,
      recordEvidence:evidence, retainCleanupFailure:retain });
    broker = await startClaudeNativeBroker({scope:proof.observation,observation:()=>observation,admission:current,execute,signal});
    const config = join(scratch,'broker.json');
    writeFileSync(config,JSON.stringify({mcpServers:{'ashlr-fleet-broker':{type:'http',url:broker.url,
      headers:{Authorization:`Bearer ${broker.capability}`}}}}),{mode:0o600,flag:'wx'});
    // Metadata refresh is owned and zero-inference. It never renews a failed or
    // changed observation from local time, and never changes the pinned scope.
    const schedule = () => { refreshTimer = setTimeout(() => {
      refresh = (async () => {
        const next = await observeClaudeNativeBinding(options.cfg,options.seatId,options.runId,options.model,scratch,signal,options.admission);
        if (!next || !proof || !sameClaudeNativeBinding(proof.binding,next.binding) ||
          next.observation.accountDigest !== proof.observation.accountDigest) { observation=null; stop.abort(); return; }
        observation=next.observation;
      })().catch(() => { observation=null;stop.abort(); }).finally(() => { refresh=null;if(refreshEnabled && !signal.aborted)schedule(); });
    },Math.max(0,Math.min(20_000,(observation?.expiresAtMs ?? Date.now()) - Date.now() - 25_000))); refreshTimer.unref(); };
    schedule();
    const command = claudeBrokerCommand(proof.binding.launch,proof.observation,config);
    if (options.effort !== undefined) {
      if (!['low','medium','high','xhigh','max'].includes(options.effort)) return held('Unsupported native Claude harness effort');
      command.args.push('--effort',options.effort);
    }
    const launcher = claudeNativeOuterLauncher(owned,proof.binding,Number(new URL(broker.url).port),scratch);
    const spawnOptions: SpawnEngineOptions = { env:{...owned.env,...claudeBrokerNativeEnvironment(),TMPDIR:owned.env.TMPDIR},
      launcher,signal,stdin:options.prompt,nativeEngine:'claude',timeoutMs:options.timeoutMs,
      selectedOutcomeAdmission:current,onEvent:options.onEvent,onSpawn:() => {providerContacted=true;} };
    result = {...await spawnEngine({...command,cwd:scratch},options.cfg,spawnOptions),providerContacted};
    if (cleanupUnknown(result)) { retain(); return {...result,captureDenied:true}; }
    refreshEnabled=false;
    if (refreshTimer) clearTimeout(refreshTimer);
    await refresh;
    await broker.close(); broker=null;
    if (retained) return {...result,ok:false,error:'tool process cleanup unconfirmed',terminationReason:'error-exit',captureDenied:true};
    // A settled failure can still leave capture-eligible partial edits. Every
    // non-cancelled result needs fresh native identity/billing proof.
    if (signal.aborted || result.terminationReason === 'cancelled') return {...result,captureDenied:true};
    {
      const after = await observeClaudeNativeBinding(options.cfg,options.seatId,options.runId,options.model,scratch,signal,options.admission);
      if (!after || !proof || !sameClaudeNativeBinding(proof.binding,after.binding) ||
        after.observation.accountDigest !== proof.observation.accountDigest) return { ...result,ok:false,error:'Selected Claude native identity or billing boundary changed',terminationReason:'error-exit',captureDenied:true };
    }
    if (owned) {
      await evidence(finishAutonomousSpawn(owned,{output:`${result.output}\n${result.error ?? ''}`})); owned=null;
    }
    return evidenceComplete ? result : {...result,ok:false,error:'Native Claude confinement evidence unconfirmed',terminationReason:'error-exit',captureDenied:true};
  } catch { return held('Native Claude producer preparation or execution failed'); }
  finally {
    refreshEnabled=false;
    if (refreshTimer) clearTimeout(refreshTimer);
    clearInterval(stopTimer); stop.abort();
    await broker?.close(); await refresh;
    if (owned) {
      if (retained) {
        owned.evidence?.abort();
        await evidence({violations:[],vendor:{committed:[],skipped:[]},violationsKnown:false,
          kernelEvidence:{source:'kernel-log',state:'incomplete',reason:'native process cleanup unconfirmed',denials:[]}});
      } else await evidence(finishAutonomousSpawn(owned,{output:result ? `${result.output}\n${result.error ?? ''}` : ''}));
    }
    if (!retained) rmSync(scratch,{recursive:true,force:true});
  }
}

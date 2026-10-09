/** Host-owned native role completions. Account/model authority is rechecked
 * before contact and throughout the owned process. No global CLI login, API
 * credential fallback or model-authored transport configuration is accepted. */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AshlrConfig, EngineCommand } from '../types.js';
import { currentStandingPolicy } from '../authority/effective-config.js';
import { canonical } from '../universe/artifacts.js';
import { resolveAccountsRoot } from '../verse/seats.js';
import { resolveNativeSeatLaunch, type NativeSeatLaunch } from '../resources/native-profile.js';
import { prepareAutonomousSpawn, finishAutonomousSpawn, type AutonomousSpawn } from '../sandbox/autonomous-run.js';
import { autonomousVendorIdentityCurrent, autonomousDevinIdentityCurrent } from '../sandbox/autonomous-env.js';
import { runClaudeNativeAdapter } from '../sandbox/claude-native-adapter.js';
import { claudeBrokerNativeEnvironment } from '../sandbox/claude-native-broker.js';
import { acquireOutwardMutationFenceAsync, releaseOutwardMutationFence } from '../sandbox/mutation-fence.js';
import { registerExecutionLease, type ExecutionLease } from '../sandbox/execution-leases.js';
import { spawnEngine, type SpawnEngineResult } from './engines.js';
import { compileArgv, GROK_CLI_HEADLESS_ARGV, extractGrokStreamText } from './engine-registry.js';
import { codexAdapter } from '../verse/adapters/codex.js';
import { refreshDevinCliExecutionBinding, devinCliBindingCurrent, type DevinCliExecutionBinding } from '../devin/cli-admission.js';
import { enginePermitted } from '../policy/local-only.js';
import { observeRoleAccount, roleAccountEpoch } from './role-account.js';

export type NativeRoleEngine = 'claude' | 'codex' | 'grok' | 'devin';
export type AgentRole = 'leader' | 'manager' | 'worker';
export interface RoleCompletionRequest {
  cfg: AshlrConfig; role: AgentRole; seatId: string; engine: NativeRoleEngine; model: string; timeoutMs: number;
  /** Opaque principal of the selected native allowance; never a credential. */
  accountHint?: string;
  /** Source-owned selected account/model capacity fence, never saved or parsed from a request. */
  admitted(): boolean;
  signal?: AbortSignal;
}
export interface RoleCompletionMetrics {
  role: AgentRole; seatId: string; engine: NativeRoleEngine; model: string; runId: string;
  elapsedMs: number; tokensIn: number | null; tokensOut: number | null;
  /** Whole-invocation throughput, not generation tokens/sec. */
  outputTokensPerWallSecond: number | null;
  providerContacted: boolean; outcome: 'completed' | 'failed' | 'unknown';
}
const grantEngine = { claude:'claude-cli', codex:'codex', grok:'grok-cli', devin:'devin' } as const;
function policyEpoch(req: RoleCompletionRequest): string | null {
  try {
    const p=currentStandingPolicy();
    const seat=p?.spend.seats[req.seatId];
    if (!p || !p.engines.includes(grantEngine[req.engine]) || !seat?.enabled ||
        !seat.roles.includes(req.role === 'leader' ? 'leader' : 'producer') ||
        Date.parse(p.expiresAt) <= Date.now() || !req.admitted()) return null;
    return canonical({grantId:p.grantId,grantSeq:p.grantSeq,rollout:p.rollout,spend:p.spend,engines:p.engines});
  } catch { return null; }
}
function launchEpoch(launch: NativeSeatLaunch): string {
  return canonical([launch, ...[...launch.command,launch.executable,join(dirname(launch.command[1]),'profile.json')].map(path => {
    const s=lstatSync(path,{bigint:true});
    if (!s.isFile() || s.isSymbolicLink()) throw new Error('Native launch identity unavailable');
    return [path,s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String);
  })]);
}
/** Strict completion framing. A message before a failed/truncated turn is not
 * a successful plan. The existing Codex parser owns its message vocabulary. */
export function parseRoleCompletion(engine: NativeRoleEngine, output: string, runId: string): string {
  if (Buffer.byteLength(output) > 1024*1024) throw new Error('Native completion exceeds bounded protocol');
  if (engine === 'devin') {
    if (!output.trim()) throw new Error('Native Devin returned no completion');
    return output.trim();
  }
  const frames=output.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as Record<string,unknown>);
  if (!frames.length) throw new Error('Native completion frame missing');
  if (engine === 'claude' || engine === 'grok') {
    const result=frames.at(-1)!;
    if (result.type !== 'result' || result.is_error === true || result.subtype !== 'success' || typeof result.result !== 'string' || !result.result.trim()) {
      throw new Error('Native Claude completion unconfirmed');
    }
    if(engine === 'grok'){
      const parsed=extractGrokStreamText(output);
      if(parsed.error || !parsed.text)throw new Error('Native Grok completion failed');
      return parsed.text;
    }
    return result.result;
  }
  if (frames.at(-1)?.type !== 'turn.completed' || frames.some(frame => ['turn.failed','error'].includes(String(frame.type)))) {
    throw new Error('Native Codex completion unconfirmed');
  }
  const parser=codexAdapter.createParser(runId);
  const events=[...output.split(/\r?\n/).flatMap(line => parser.push(line)),...parser.finish(0)];
  if (events.some(event => event.type === 'error')) throw new Error('Native Codex completion failed');
  const messages=events.filter(event => event.type === 'assistant-message');
  const message=messages.at(-1);
  if (!message || !('text' in message) || !message.text.trim()) throw new Error('Native Codex returned no completion');
  return message.text;
}
function cleanupUnconfirmed(result: SpawnEngineResult): boolean {
  return /(?:termination authority lost|termination deadline elapsed|(?:closure|exit).*unconfirmed)/i.test(result.error ?? '');
}
/** This closure is created by host code for one exact tuple. JSON or model
 * output cannot supply a launch, process environment, lease or credential. */
export function nativeRoleCompletion(req: RoleCompletionRequest, record?: (metrics: RoleCompletionMetrics) => void): (system: string,user: string) => Promise<string> {
  return async (system,user) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(req.model) || !Number.isFinite(req.timeoutMs) || req.timeoutMs <= 0 ||
        !enginePermitted(grantEngine[req.engine],req.cfg).permitted) throw new Error('Selected native role unavailable');
    const initialPolicy=policyEpoch(req);
    if (initialPolicy === null || req.signal?.aborted) throw new Error('Selected native role authority unavailable');
    if (req.engine !== 'devin' && (!req.accountHint || !/^[a-f0-9]{64}$/.test(req.accountHint))) throw new Error('Selected native account allowance unbound');
    const scratch=realpathSync(mkdtempSync(join(tmpdir(),'phantom-role-')));
    const runId=`role-${randomUUID()}`;
    const started=Date.now();
    let lease:ExecutionLease|null=null, owned:AutonomousSpawn|null=null, retained=false, contacted=false;
    let result:SpawnEngineResult|null=null;
    let native:NativeSeatLaunch|null=null, epoch:string|null=null, devin:DevinCliExecutionBinding|null=null;
    let accountEpoch:string|null=null;
    const stop=new AbortController();
    let outcome:RoleCompletionMetrics['outcome']='failed';
    const current=():boolean => {
      try {
        if (stop.signal.aborted || req.signal?.aborted || lease?.signal.aborted || policyEpoch(req) !== initialPolicy) return false;
        if (native) {
          const fresh=resolveNativeSeatLaunch({accountsRoot:resolveAccountsRoot(req.cfg),provider:native.provider,seatId:req.seatId,
            ...(native.provider === 'claude' ? {requireClaudeBrokerSafety:true} : {})});
          if (!fresh.ok || launchEpoch(fresh.launch) !== epoch) return false;
          if (accountEpoch && roleAccountEpoch(req.cfg,native,req.accountHint!) !== accountEpoch) return false;
        }
        if (devin && (!devinCliBindingCurrent(devin,req.model) || owned && !autonomousDevinIdentityCurrent(owned.overlay))) return false;
        return owned === null || req.engine === 'devin' || autonomousVendorIdentityCurrent(owned.overlay);
      } catch { return false; }
    };
    let timer:ReturnType<typeof setInterval>|null=null;
    let refreshTimer:ReturnType<typeof setInterval>|null=null;
    let refreshing=false;
    try {
      const fence=await acquireOutwardMutationFenceAsync(2_000,{signal:stop.signal});
      try {
        if (!fence || !current()) throw new Error('Role execution admission unavailable');
        const registration=registerExecutionLease(fence,{runId,repoKey:`role:${req.seatId}`,engine:grantEngine[req.engine],
          ...(req.signal ? {parentSignal:req.signal} : {}),shouldAbort:()=> current() ? null : 'Role admission changed'});
        if (!registration.ok) throw new Error('Role execution lease unavailable');
        lease=registration.lease;
      } finally { if(fence)releaseOutwardMutationFence(fence); }
      const signal=AbortSignal.any([stop.signal,lease.signal]);
      timer=setInterval(()=>{if(!current())stop.abort();},100);timer.unref();
      const prompt=`${system}\n\n${user}`;
      if (req.engine === 'claude') {
        result=await runClaudeNativeAdapter({cfg:req.cfg,runId,seatId:req.seatId,model:req.model,prompt,worktree:scratch,
          expectedAccountHint:req.accountHint,
          signal,timeoutMs:req.timeoutMs,admission:current,recordEvidence:finish=>{
            if(finish.violations.length || !finish.violationsKnown)stop.abort();
          },retainCleanupFailure:()=>{retained=true;stop.abort();}});
        contacted=result.providerContacted === true;
      } else {
        let command:EngineCommand;
        if (req.engine === 'devin') {
          // Current source supports one exact native Devin account. Cloud ACU
          // sessions and invented parallel account IDs are not this adapter.
          if(req.seatId !== 'devin-cli')throw new Error('Selected Devin native account unavailable');
          devin=await refreshDevinCliExecutionBinding(req.model,{signal,admitted:current});
          if(!devin || !current())throw new Error('Selected Devin account or included pricing unconfirmed');
          const initialDevin=devin;
          refreshTimer=setInterval(()=>{
            if(refreshing || !current())return;
            refreshing=true;
            void refreshDevinCliExecutionBinding(req.model,{signal,admitted:current,forceRefresh:true}).then(fresh=>{
              if(!fresh || fresh.executableEpoch !== initialDevin.executableEpoch || fresh.credentialsEpoch !== initialDevin.credentialsEpoch ||
                  fresh.principalDigest !== initialDevin.principalDigest || fresh.originDigest !== initialDevin.originDigest ||
                  fresh.teamDigest !== initialDevin.teamDigest)stop.abort();
              else devin=fresh;
            }).finally(()=>{refreshing=false;});
          },20_000);refreshTimer.unref();
          owned=prepareAutonomousSpawn({engine:'devin-cli',worktree:scratch,bin:devin.executable,baseEnv:claudeBrokerNativeEnvironment(),devinExecutionBinding:devin});
          command={bin:owned.bin,args:['-p','--model',req.model,'--permission-mode','dangerous','--respect-workspace-trust','false','--',prompt],cwd:scratch};
        } else {
          const found=resolveNativeSeatLaunch({accountsRoot:resolveAccountsRoot(req.cfg),provider:req.engine,seatId:req.seatId});
          if(!found.ok)throw new Error('Selected native account launch unavailable');
          native=found.launch;epoch=launchEpoch(native);
          const account=await observeRoleAccount({cfg:req.cfg,launch:native,accountHint:req.accountHint!,cwd:scratch,signal,admitted:current});
          if(account.uncertain){retained=true;outcome='unknown';throw new Error('Native account metadata process cleanup unconfirmed');}
          accountEpoch=account.epoch;
          if(!accountEpoch || !current())throw new Error('Selected native account does not match its allowance');
          owned=prepareAutonomousSpawn({engine:grantEngine[req.engine],worktree:scratch,bin:native.executable,
            baseEnv:claudeBrokerNativeEnvironment(),seatId:req.seatId,nativeStatePath:native.nativeStatePath,
            extraReadOnly:[dirname(native.command[1]),native.command[0]]});
          if(req.engine === 'codex') {
            // The OS-owned worktree jail replaces the CLI's nested sandbox.
            // Built-in tools remain inside this empty assigned workspace.
            command={bin:owned.bin,args:['exec','--json','--skip-git-repo-check','--model',req.model,
              '--dangerously-bypass-approvals-and-sandbox','--cd',scratch,'-'],cwd:scratch};
          } else {
            command={bin:owned.bin,args:compileArgv([...GROK_CLI_HEADLESS_ARGV],{goal:prompt,cwd:scratch,model:req.model}),cwd:scratch};
          }
        }
        if(!current() || owned.evidence?.ready !== true)throw new Error('Native role confinement or account continuity unavailable');
        result=await spawnEngine(command,req.cfg,{env:owned.env,launcher:owned.launcher,signal,timeoutMs:req.timeoutMs,
          selectedOutcomeAdmission:current,...(req.engine === 'codex' ? {stdin:prompt} : {}),onSpawn:()=>{contacted=true;}});
        if(cleanupUnconfirmed(result)){retained=true;outcome='unknown';throw new Error('Native role process cleanup unconfirmed');}
        if(!current())throw new Error('Selected native role admission changed');
        const finish=finishAutonomousSpawn(owned,{output:result.output});owned=null;
        if(finish.violations.length || !finish.violationsKnown)throw new Error('Native role execution evidence unconfirmed');
      }
      if(!result.ok || !current() || retained || 'captureDenied' in result && result.captureDenied === true)throw new Error('Native role completion failed');
      const text=parseRoleCompletion(req.engine,result.output,runId);
      outcome='completed';return text;
    } finally {
      if(timer)clearInterval(timer);
      if(refreshTimer)clearInterval(refreshTimer);
      if(owned && !retained){
        try{finishAutonomousSpawn(owned,{output:result?.output ?? ''});}
        catch{retained=true;outcome='unknown';}
      }
      if(retained){outcome='unknown';owned?.evidence?.abort();}
      else {rmSync(scratch,{recursive:true,force:true});lease?.release();}
      // A retained process retains its drain lease; it must never masquerade
      // as quiescent merely because the parent returned a failure.
      stop.abort();
      const elapsedMs=Math.max(0,Date.now()-started);
      const reported=(value:unknown):number|null=>typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
      const tokensIn=reported(result?.usage?.tokensIn),tokensOut=reported(result?.usage?.tokensOut);
      try{record?.({role:req.role,seatId:req.seatId,engine:req.engine,model:req.model,runId,elapsedMs,tokensIn,tokensOut,
        outputTokensPerWallSecond:tokensOut !== null && elapsedMs > 0 ? tokensOut*1000/elapsedMs : null,providerContacted:contacted,outcome});}catch{/* Telemetry cannot authorize a run. */}
    }
  };
}

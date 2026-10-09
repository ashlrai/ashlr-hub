/** Production dispatcher and real inert child protocol. No provider or native
 * account is contacted: profiles, login files and grants are test fixtures. */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import { prepareResourceNativeProfile } from '../src/core/resources/native-profile.js';
import * as autonomousRuntime from '../src/core/sandbox/autonomous-run.js';
import { setKernelEvidenceWatcherForTest, type AutonomousSpawn } from '../src/core/sandbox/autonomous-run.js';
import { countLiveExecutionLeases, type ExecutionLease } from '../src/core/sandbox/execution-leases.js';
import * as leaseRuntime from '../src/core/sandbox/execution-leases.js';
import { nativeRoleCompletion, parseRoleCompletion, type NativeRoleEngine, type RoleCompletionMetrics } from '../src/core/run/role-completion.js';
import * as engineRuntime from '../src/core/run/engines.js';
import { supportsRoleExecution } from '../src/core/run/role-invocation.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import { roleAccountEpoch } from '../src/core/run/role-account.js';
import { resolveNativeSeatLaunch } from '../src/core/resources/native-profile.js';
import * as codexMetadata from '../src/core/resources/codex-account-probe.js';
import * as capacityStore from '../src/core/routing/budget-store.js';
import { defaultLeaderTransports } from '../src/core/vision/leader-seat.js';

const host=vi.hoisted(()=>({policy:null as EffectivePolicy|null}));
vi.mock('../src/core/authority/effective-config.js',async importOriginal=>({
  ...await importOriginal<typeof import('../src/core/authority/effective-config.js')>(),
  currentStandingPolicy:()=>host.policy,
}));
const line=(value:unknown)=>JSON.stringify(value)+'\n';
const codex=(text='completed')=>line({type:'item.completed',item:{id:'message',type:'agent_message',text}})+
  line({type:'turn.completed',usage:{input_tokens:11,output_tokens:5}});
const result=(text='completed')=>line({type:'result',subtype:'success',is_error:false,result:text});

describe('native role completion protocol',()=>{
  it.each(['claude','grok'] as const)('accepts %s terminal completion, rejects partial/error/malformed frames',engine=>{
    expect(parseRoleCompletion(engine,result(),'turn')).toBe('completed');
    expect(()=>parseRoleCompletion(engine,line({type:'assistant',message:{content:[{type:'text',text:'partial'}]}}),'turn')).toThrow();
    expect(()=>parseRoleCompletion(engine,line({type:'result',subtype:'error',is_error:true,result:'failed'}),'turn')).toThrow();
    expect(()=>parseRoleCompletion(engine,result()+'{broken','turn')).toThrow();
  });
  it('uses Codex actual assistant vocabulary and requires completed turn',()=>{
    expect(parseRoleCompletion('codex',codex(),'turn')).toBe('completed');
    expect(()=>parseRoleCompletion('codex',line({type:'item.completed',item:{type:'agent_message',text:'partial'}}),'turn')).toThrow();
    expect(()=>parseRoleCompletion('codex',codex()+line({type:'turn.failed',error:{message:'failed'}}),'turn')).toThrow();
    expect(()=>parseRoleCompletion('codex',line({type:'turn.completed'}),'turn')).toThrow();
  });
  it('rejects empty or oversized output for every native protocol',()=>{
    for(const engine of ['claude','grok','codex','devin'] as NativeRoleEngine[]){
      expect(()=>parseRoleCompletion(engine,'','turn')).toThrow();
      expect(()=>parseRoleCompletion(engine,'x'.repeat(1024*1024+1),'turn')).toThrow();
    }
    expect(parseRoleCompletion('devin',' plain native completion \n','turn')).toBe('plain native completion');
  });
  it('qualifies real registered local and native worker implementations, not generic remote/CLI labels',()=>{
    const cfg=defaultConfig();
    for(const engine of ['claude','codex','grok-cli','devin-cli','local-coder','llama-server'])
      expect(supportsRoleExecution(engine,cfg),engine).toBe(true);
    for(const engine of ['unknown','claude-cli','nim','grok','devin-cloud'])expect(supportsRoleExecution(engine,cfg),engine).toBe(false);
  });
});

let root:string;
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'phantom-native-role-fixture-')));host.policy=null;});
afterEach(()=>{setKernelEvidenceWatcherForTest();vi.restoreAllMocks();host.policy=null;vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
function fixture(){
  const home=join(root,'home');mkdirSync(home,{mode:0o700});vi.stubEnv('HOME',home);
  const executable=join(root,'inert-codex');
  const script=`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),state=process.env.CODEX_HOME;
const auth=JSON.parse(fs.readFileSync(path.join(state,'auth.json'),'utf8')),account=auth.tokens.account_id;
if(args.includes('app-server')){
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);if(!q.id)return;
  const result=q.method==='initialize'?{codexHome:state,userAgent:'fixture',platformFamily:'unix',platformOs:'darwin'}:
   q.method==='account/read'?{account:{type:'chatgpt',email:auth.email,planType:'pro'},requiresOpenaiAuth:true}:
   {rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:10,windowDurationMins:300,resetsAt:1999999999},secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:2000000000}}}};
  console.log(JSON.stringify({id:q.id,result}));
 });process.stdin.on('end',()=>process.exit(0));
}else{
if(args[0]!=='exec'||!args.includes('--json')||!args.includes('--dangerously-bypass-approvals-and-sandbox'))process.exit(12);
if(process.env.ANTHROPIC_API_KEY||process.env.OPENAI_API_KEY)process.exit(13);
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{
 console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:JSON.stringify({model:args[args.indexOf('--model')+1],account,state,prompt,cwd:process.cwd()})}}));
 if(prompt.includes('STALL')){setInterval(()=>{},1000);return;}
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:5}}));
});
}
`;
  const quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  writeFileSync(executable,'#!/bin/sh\nexec '+quote(realpathSync(process.execPath))+' -e '+quote(script)+' fixture "$@"\n',{mode:0o700});
  const profile=prepareResourceNativeProfile({provider:'codex',directory:join(root,'profile'),executable});
  const auth={email:'fixture@example.invalid',tokens:{account_id:'fixture-selected-account',id_token:'h.'+Buffer.from(JSON.stringify({sub:'fixture-user'})).toString('base64url')+'.s',refresh_token:'fixture-refresh',access_token:'fixture-access'}};
  writeFileSync(join(profile.nativeStatePath,'auth.json'),JSON.stringify(auth),{mode:0o600});
  const accountsRoot=join(root,'accounts');mkdirSync(accountsRoot,{mode:0o700});
  writeFileSync(join(accountsRoot,'connections.json'),JSON.stringify({schemaVersion:1,intervalMs:30000,accounts:[{id:'codex-a',label:'Fixture Codex',provider:'codex',command:profile.command}]}),{mode:0o600});
  const cfg=defaultConfig();cfg.verse={...cfg.verse,accountsRoot};
  host.policy={grantId:'fixture-grant',grantSeq:1,engines:['codex'],expiresAt:new Date(Date.now()+60_000).toISOString(),rollout:{stageId:'fixture'},
    spend:{seats:{'codex-a':{enabled:true,roles:['leader','producer']}}}} as unknown as EffectivePolicy;
  setKernelEvidenceWatcherForTest(tag=>({tag,ready:true,finish:()=>({source:'kernel-log',state:'complete',reason:null,denials:[]}),abort(){}}));
  const accountHint=digest(canonical({schemaVersion:1,type:'chatgpt',email:auth.email,planType:'pro'}));
  return {cfg,profile,accountHint};
}
describe.runIf(process.platform === 'darwin' && typeof process.execve === 'function')('actual owned native role dispatcher',()=>{
  it('refuses an already cancelled native call before metadata or process contact',async()=>{
    const f=fixture();const controller=new AbortController();controller.abort();
    const probe=vi.spyOn(codexMetadata,'probeCodexResourceAccount');
    const spawn=vi.spyOn(engineRuntime,'spawnEngine');
    const complete=nativeRoleCompletion({cfg:f.cfg,role:'leader',seatId:'codex-a',engine:'codex',model:'gpt-fixture',accountHint:f.accountHint,timeoutMs:5000,admitted:()=>true,signal:controller.signal});
    await expect(complete('SYSTEM','USER')).rejects.toThrow(/authority unavailable/);
    expect(probe).not.toHaveBeenCalled();expect(spawn).not.toHaveBeenCalled();expect(countLiveExecutionLeases()).toBe(0);
  });
  it('passes caller cancellation through the production Leader transport to an actual owned native child',async()=>{
    const f=fixture();const controller=new AbortController();
    vi.spyOn(capacityStore,'readCapacitySnapshot').mockReturnValue({publishedAt:new Date().toISOString(),seats:[{seatId:'codex-a',accountHint:f.accountHint}]} as ReturnType<typeof capacityStore.readCapacitySnapshot>);
    const started=Promise.withResolvers<void>();
    const original=engineRuntime.spawnEngine;
    let scratch:string|undefined,lease:ExecutionLease|undefined,owned:AutonomousSpawn|undefined,childSignal:AbortSignal|undefined;
    const prepare=autonomousRuntime.prepareAutonomousSpawn;
    vi.spyOn(autonomousRuntime,'prepareAutonomousSpawn').mockImplementation((...args)=>{owned=prepare(...args);return owned;});
    const register=leaseRuntime.registerExecutionLease;
    vi.spyOn(leaseRuntime,'registerExecutionLease').mockImplementation((...args)=>{const r=register(...args);if(r.ok)lease=r.lease;return r;});
    vi.spyOn(engineRuntime,'spawnEngine').mockImplementation(async(command,cfg,options)=>{
      scratch=command.cwd;childSignal=options?.signal;
      return original(command,cfg,{...options,onSpawn:()=>{options?.onSpawn?.();started.resolve();}});
    });
    const complete=defaultLeaderTransports(f.cfg).native!('codex-a','codex','gpt-fixture',()=>true,{timeoutMs:5000});
    const running=complete('SYSTEM','STALL',controller.signal);
    // The child readiness hook is causal: no arbitrary 2-second sleep or inference.
    await started.promise;controller.abort();
    try {
      await expect(running).rejects.toThrow();
      expect(childSignal?.aborted).toBe(true);
      expect(countLiveExecutionLeases()).toBe(1);
      expect(scratch && existsSync(scratch)).toBe(true);
    } finally {
      // Cancellation reaches the real process, while unproven group cleanup
      // remains unknown. This inert fixture alone may use test-owned cleanup.
      lease?.release();if(owned)autonomousRuntime.finishAutonomousSpawn(owned,{output:''});if(scratch)rmSync(scratch,{recursive:true,force:true});
    }
  });
  it('executes pinned selected account/model in private copied state, records reported tokens and releases its lease',async()=>{
    const f=fixture();const metrics:RoleCompletionMetrics[]=[];
    const launch=resolveNativeSeatLaunch({accountsRoot:f.cfg.verse!.accountsRoot!,provider:'codex',seatId:'codex-a'});
    expect(launch.ok && roleAccountEpoch(f.cfg,launch.launch,f.accountHint)).not.toBeNull();
    const probe=codexMetadata.probeCodexResourceAccount;
    vi.spyOn(codexMetadata,'probeCodexResourceAccount').mockImplementation(async options=>{
      const result=await probe(options);expect(result.reason).toBe('probe-observed');return result;
    });
    const complete=nativeRoleCompletion({cfg:f.cfg,role:'leader',seatId:'codex-a',engine:'codex',model:'gpt-fixture',accountHint:f.accountHint,timeoutMs:5000,admitted:()=>true},m=>metrics.push(m));
    const output=JSON.parse(await complete('SYSTEM','USER')) as Record<string,string>;
    expect(output).toMatchObject({account:'fixture-selected-account',model:'gpt-fixture',prompt:'SYSTEM\n\nUSER'});
    expect(output.state).not.toBe(f.profile.nativeStatePath);
    expect(existsSync(output.cwd!)).toBe(false);expect(countLiveExecutionLeases()).toBe(0);
    expect(metrics).toHaveLength(1);expect(metrics[0]).toMatchObject({seatId:'codex-a',model:'gpt-fixture',engine:'codex',role:'leader',providerContacted:true,outcome:'completed',tokensIn:11,tokensOut:5});
    expect(metrics[0]!.outputTokensPerWallSecond).toBe(5000/metrics[0]!.elapsedMs);
  });
  it('holds missing exact seat role; Stop retains its lease when group cleanup cannot be proven',async()=>{
    const f=fixture();host.policy!.spend.seats['codex-a']!.roles=['producer'];
    const metrics:RoleCompletionMetrics[]=[];
    const denied=nativeRoleCompletion({cfg:f.cfg,role:'leader',seatId:'codex-a',engine:'codex',model:'gpt-fixture',accountHint:f.accountHint,timeoutMs:5000,admitted:()=>true},m=>metrics.push(m));
    await expect(denied('SYSTEM','USER')).rejects.toThrow(/authority/);expect(metrics).toEqual([]);expect(countLiveExecutionLeases()).toBe(0);
    host.policy!.spend.seats['codex-a']!.roles=['producer','leader'];
    const original=engineRuntime.spawnEngine;
    let scratch:string|undefined,lease:ExecutionLease|undefined,owned:AutonomousSpawn|undefined;
    const prepare=autonomousRuntime.prepareAutonomousSpawn;
    vi.spyOn(autonomousRuntime,'prepareAutonomousSpawn').mockImplementation((...args)=>{owned=prepare(...args);return owned;});
    const register=leaseRuntime.registerExecutionLease;
    vi.spyOn(leaseRuntime,'registerExecutionLease').mockImplementation((...args)=>{const r=register(...args);if(r.ok)lease=r.lease;return r;});
    vi.spyOn(engineRuntime,'spawnEngine').mockImplementation(async(...args)=>{scratch=args[0].cwd;return original(...args);});
    let active=true;
    const running=nativeRoleCompletion({cfg:f.cfg,role:'leader',seatId:'codex-a',engine:'codex',model:'gpt-fixture',accountHint:f.accountHint,timeoutMs:5000,admitted:()=>active},m=>metrics.push(m));
    const timer=setTimeout(()=>{active=false;},2000);
    try{await expect(running('SYSTEM','STALL')).rejects.toThrow();}finally{clearTimeout(timer);}
    try{
      expect(metrics.at(-1)).toMatchObject({providerContacted:true,outcome:'unknown'});
      expect(countLiveExecutionLeases()).toBe(1);expect(scratch && existsSync(scratch)).toBe(true);
    }finally{
      // This inert fixture never creates descendants. Test-owned cleanup only;
      // production must retain uncertain leases for the existing drain path.
      lease?.release();if(owned)autonomousRuntime.finishAutonomousSpawn(owned,{output:''});if(scratch)rmSync(scratch,{recursive:true,force:true});
    }
  });
  it('joins real native metadata to the selected allowance before model contact',async()=>{
    const f=fixture();const metrics:RoleCompletionMetrics[]=[];
    const spawn=vi.spyOn(engineRuntime,'spawnEngine');
    const accountHint=digest(canonical({schemaVersion:1,type:'chatgpt',email:'other@example.invalid',planType:'pro'}));
    const complete=nativeRoleCompletion({cfg:f.cfg,role:'leader',seatId:'codex-a',engine:'codex',model:'gpt-fixture',accountHint,timeoutMs:5000,admitted:()=>true},m=>metrics.push(m));
    await expect(complete('SYSTEM','USER')).rejects.toThrow(/does not match its allowance/);
    expect(spawn).not.toHaveBeenCalled();expect(countLiveExecutionLeases()).toBe(0);
    expect(metrics).toHaveLength(1);expect(metrics[0]).toMatchObject({providerContacted:false,outcome:'failed'});
  });
});

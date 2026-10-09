/** Real inert Codex processes and captured Git work: no provider, login or live configuration. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import type { EffectivePolicy } from '../src/core/authority/types.js';
import { prepareResourceNativeProfile, repinResourceNativeProfile } from '../src/core/resources/native-profile.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';
import * as autonomous from '../src/core/sandbox/autonomous-run.js';
import * as leases from '../src/core/sandbox/execution-leases.js';
import * as engines from '../src/core/run/engines.js';
import * as accounts from '../src/core/run/role-account.js';
import * as worktree from '../src/core/sandbox/worktree.js';
import * as rollout from '../src/core/authority/rollout.js';
import { ledgerSnapshot, resetLedgerCachesForTest } from '../src/core/authority/ledger.js';
import { runEngineSandboxed } from '../src/core/run/sandboxed-engine.js';
import { runCompletenessGate } from '../src/core/run/completeness-gate.js';
import { makeGrant } from './helpers/authority-310b.js';

const host = vi.hoisted(() => ({policy:null as EffectivePolicy | null}));
vi.mock('../src/core/authority/effective-config.js',async original => ({
  ...await original<typeof import('../src/core/authority/effective-config.js')>(),currentStandingPolicy:() => host.policy,
}));
vi.mock('../src/core/run/completeness-gate.js',() => ({runCompletenessGate:vi.fn()}));
let root:string;
beforeEach(() => {vi.mocked(runCompletenessGate).mockReset();root=realpathSync(mkdtempSync(join(tmpdir(),'phantom-codex-producer-')));});
afterEach(() => {autonomous.setKernelEvidenceWatcherForTest();vi.restoreAllMocks();vi.unstubAllEnvs();host.policy=null;rmSync(root,{recursive:true,force:true});});

function fixture() {
  const home=join(root,'home');mkdirSync(home,{mode:0o700});vi.stubEnv('HOME',home);vi.stubEnv('ASHLR_HOME',join(home,'.ashlr'));
  vi.stubEnv('ASHLR_TEST_ALLOW_ANY_REPO','1');
  const repo=join(root,'repo');mkdirSync(repo,{mode:0o700});
  execFileSync('git',['init','-q','-b','main',repo]);
  execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd:repo});
  execFileSync('git',['config','user.name','Fixture'],{cwd:repo});
  writeFileSync(join(repo,'input.txt'),'real source fixture\n');
  execFileSync('git',['add','.'],{cwd:repo});execFileSync('git',['commit','-q','-m','fixture','--no-gpg-sign'],{cwd:repo});
  const quote=(v:string) => "'"+v.replaceAll("'","'\"'\"'")+"'";
  const profiles=['A','B'].map(id => {
    const executable=join(root,`codex-version-${id}`);
    const script=`const fs=require('node:fs'),p=require('node:path'),args=process.argv.slice(2),state=process.env.CODEX_HOME;
const auth=JSON.parse(fs.readFileSync(p.join(state,'auth.json'),'utf8'));
if(args.includes('app-server')){
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const q=JSON.parse(line);if(!q.id)return;
  const result=q.method==='initialize'?{codexHome:state,userAgent:'fixture',platformFamily:'unix',platformOs:'darwin'}:
   q.method==='account/read'?{account:{type:'chatgpt',email:auth.email,planType:'pro'},requiresOpenaiAuth:true}:
   {rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:10,windowDurationMins:300,resetsAt:1999999999},secondary:{usedPercent:20,windowDurationMins:10080,resetsAt:2000000000}}}};
  console.log(JSON.stringify({id:q.id,result}));
 });process.stdin.on('end',()=>process.exit(0));
}else{
 if(args.some(value=>value.includes('CONFIG_RECOVERY'))&&!args.some(value=>value.includes('model_reasoning_effort'))){console.error('error loading config: model_reasoning_effort unknown variant');process.exit(1);}
 if(args[0]!=='exec'||!args.includes('--dangerously-bypass-approvals-and-sandbox'))process.exit(12);
 if(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_API_KEY)process.exit(13);
 const input=fs.readFileSync('input.txt','utf8'),repair=fs.existsSync('edited.ts');
 fs.writeFileSync('edited.ts','export const result = '+JSON.stringify('${id}:'+auth.tokens.account_id+':'+(repair?'repair:':'initial:')+input)+';\\n');
 console.log(JSON.stringify({type:'item.completed',item:{id:'read',type:'command_execution',command:'cat input.txt',aggregated_output:input,exit_code:0,status:'completed'}}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'edit',type:'file_change',changes:[{path:'edited.ts',kind:'add'}],status:'completed'}}));
 console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:JSON.stringify({binary:'${id}',account:auth.tokens.account_id,state,cwd:process.cwd(),input,repair})}}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,output_tokens:5}}));
}`;
    writeFileSync(executable,'#!/bin/sh\nexec '+quote(realpathSync(process.execPath))+' -e '+quote(script)+' fixture "$@"\n',{mode:0o700});
    const profile=prepareResourceNativeProfile({provider:'codex',directory:join(root,`profile-${id}`),executable});
    const email=`${id.toLowerCase()}@example.invalid`;
    writeFileSync(join(profile.nativeStatePath,'auth.json'),JSON.stringify({email,tokens:{account_id:`fixture-${id}`,id_token:'h.'+Buffer.from(JSON.stringify({sub:`fixture-user-${id}`})).toString('base64url')+'.s',refresh_token:'fixture-refresh',access_token:'fixture-access'}}),{mode:0o600});
    return {id,executable,profile,accountHint:digest(canonical({schemaVersion:1,type:'chatgpt',email,planType:'pro'}))};
  });
  const a=profiles[0]!,b=profiles[1]!;
  const accountsRoot=join(root,'accounts');mkdirSync(accountsRoot,{mode:0o700});
  writeFileSync(join(accountsRoot,'connections.json'),JSON.stringify({schemaVersion:1,intervalMs:30000,
    accounts:profiles.map(f=>({id:`codex-${f.id.toLowerCase()}`,label:f.id,provider:'codex',command:f.profile.command}))}),{mode:0o600});
  const poison=join(root,'poison');mkdirSync(poison);writeFileSync(join(poison,'codex'),readFileSync(a.executable),{mode:0o700});
  vi.stubEnv('PATH',poison+':'+process.env.PATH);
  const cfg=defaultConfig();cfg.verse={...cfg.verse,accountsRoot};cfg.phantom={...cfg.phantom,enabled:false};
  cfg.foundry={...cfg.foundry,fleetMcp:false,dispatchRetries:0,completenessGate:false};
  host.policy={grantId:'fixture-grant',grantSeq:1,engines:['codex'],expiresAt:new Date(Date.now()+60_000).toISOString(),rollout:{stageId:'fixture'},
    spend:{seats:{'codex-b':{enabled:true,roles:['producer']}}}} as unknown as EffectivePolicy;
  autonomous.setKernelEvidenceWatcherForTest(tag=>({tag,ready:true,finish:()=>({source:'kernel-log',state:'complete',reason:null,denials:[]}),abort(){}}));
  const spawns: Array<{cmd:Parameters<typeof engines.spawnEngine>[0];result:Awaited<ReturnType<typeof engines.spawnEngine>>}> = [];
  const actual=engines.spawnEngine;
  vi.spyOn(engines,'spawnEngine').mockImplementation(async(cmd,...rest)=>{const result=await actual(cmd,...rest);spawns.push({cmd,result});return result;});
  const diffs:string[]=[];const diff=worktree.sandboxDiff;
  vi.spyOn(worktree,'sandboxDiff').mockImplementation(sb=>{const d=diff(sb);diffs.push(d.patch);return d;});
  const opts={sourceRepo:repo,model:'gpt-fixture',seatId:'codex-b',selectedCodexAccount:{accountHint:b.accountHint,admitted:()=>true}};
  const reply=(index=0) => JSON.parse(JSON.parse(spawns[index]!.result.output.trim().split('\n').find(line=>JSON.parse(line).item?.id==='reply')!).item.text) as {binary:string;account:string;state:string;cwd:string;input:string;repair:boolean};
  return {a,b,cfg,opts,spawns,diffs,repo,reply,actual};
}

describe.runIf(process.platform==='darwin' && typeof process.execve==='function')('selected Codex producer binding',() => {
  it('executes versioned B with B private login despite PATH A and captures its real read/edit',async() => {
    const f=fixture();const result=await runEngineSandboxed('codex','Read input.txt and edit edited.ts',f.cfg,{...f.opts,propose:false});
    expect(result.state.status).toBe('done');expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]!.cmd.bin).toBe(f.b.executable);
    expect(f.reply()).toMatchObject({binary:'B',account:'fixture-B',input:'real source fixture\n',repair:false});
    expect(f.reply().state).not.toBe(f.b.profile.nativeStatePath);expect(existsSync(f.reply().state)).toBe(false);
    expect(f.diffs.join('\n')).toContain('B:fixture-B:initial:real source fixture');
    expect(existsSync(join(f.repo,'edited.ts'))).toBe(false);
    expect(result.state.usage).toMatchObject({tokensIn:11,tokensOut:5,steps:1});expect(leases.countLiveExecutionLeases()).toBe(0);
  });
  it('refuses an original account admission change before metadata despite a valid pinned profile',async() => {
    const f=fixture();let current=true;
    f.opts.selectedCodexAccount.admitted=()=>current;
    // The routed principal is unchanged in the binding; the host reports replacement.
    current=false;
    const probe=vi.spyOn(accounts,'observeRoleAccount');
    const result=await runEngineSandboxed('codex','Read and edit',f.cfg,{...f.opts,propose:false});
    expect(result.state.status).toBe('failed');expect(probe).not.toHaveBeenCalled();expect(f.spawns).toEqual([]);
  });
  it('refuses false independent outcome authority before metadata with account admission true',async() => {
    const f=fixture(),probe=vi.spyOn(accounts,'observeRoleAccount');
    const result=await runEngineSandboxed('codex','Read and edit',f.cfg,{...f.opts,propose:false,selectedOutcomeAdmission:()=>false});
    expect(result.state.status).toBe('aborted');expect(probe).not.toHaveBeenCalled();expect(f.spawns).toEqual([]);
    expect(result.state.usage.steps).toBe(0);expect(leases.countLiveExecutionLeases()).toBe(0);
  });
  it('keeps the independent outcome fence at actual contact even when account admission remains true',async() => {
    const f=fixture(),actual=f.actual;let outcome=true;
    vi.mocked(engines.spawnEngine).mockImplementation(async(cmd,cfg,opts)=>{
      outcome=false;const result=await actual(cmd,cfg,opts);f.spawns.push({cmd,result});return result;
    });
    const result=await runEngineSandboxed('codex','Read and edit',f.cfg,{...f.opts,propose:false,selectedOutcomeAdmission:()=>outcome});
    expect(result.state.status).toBe('aborted');expect(f.spawns[0]!.result.output).toBe('');expect(result.state.usage.steps).toBe(0);
  });
  it('refuses a re-pin after private copy setup before any inference child',async() => {
    const f=fixture(),prepare=autonomous.prepareAutonomousSpawn;
    vi.spyOn(autonomous,'prepareAutonomousSpawn').mockImplementation(input=>{const value=prepare(input);repinResourceNativeProfile({directory:dirname(f.b.profile.command[1]),executable:f.a.executable});return value;});
    const result=await runEngineSandboxed('codex','Read and edit',f.cfg,{...f.opts,propose:false});
    expect(result.state.status).toBe('failed');expect(f.spawns).toEqual([]);expect(existsSync(join(f.repo,'edited.ts'))).toBe(false);
    expect(leases.countLiveExecutionLeases()).toBe(0);
  });
  it('refuses a re-pin at the actual spawn admission boundary without a model step',async() => {
    const f=fixture(),actual=f.actual;
    vi.mocked(engines.spawnEngine).mockImplementation(async(cmd,cfg,opts)=>{
      repinResourceNativeProfile({directory:dirname(f.b.profile.command[1]),executable:f.a.executable});
      const result=await actual(cmd,cfg,opts);f.spawns.push({cmd,result});return result;
    });
    const result=await runEngineSandboxed('codex','Read and edit',f.cfg,{...f.opts,propose:false});
    expect(result.state.status).toBe('aborted');expect(f.spawns[0]!.result.output).toBe('');
    expect(result.state.usage.steps).toBe(0);expect(f.diffs.join('\n')).not.toContain('+B:');
  });
  it('uses a fresh B copy for repair after original cleanup and captures the repaired diff',async() => {
    const f=fixture();f.cfg.foundry!.completenessGate=true;f.cfg.foundry!.verifyToGreen={enabled:true,maxIterations:1};
    vi.mocked(runCompletenessGate).mockResolvedValueOnce({pass:false,reason:'fixture needs repair'}).mockResolvedValueOnce({pass:false,reason:'fixture needs repair'}).mockResolvedValue({pass:true});
    const result=await runEngineSandboxed('codex','Read input and edit',f.cfg,f.opts);
    expect(result.state.status).toBe('done');expect(f.spawns).toHaveLength(2);
    expect(f.reply(1)).toMatchObject({binary:'B',account:'fixture-B',repair:true});
    expect(f.reply(1).state).not.toBe(f.reply(0).state);expect(existsSync(f.reply(0).state)).toBe(false);expect(existsSync(f.reply(1).state)).toBe(false);
    expect(f.diffs.join('\n')).toContain('B:fixture-B:repair:real source fixture');
    expect(result.state.usage).toMatchObject({tokensIn:22,tokensOut:10,steps:2});expect(leases.countLiveExecutionLeases()).toBe(0);
  });
  it('refuses a re-pin before repair, preserving the initial contact without fallback',async() => {
    const f=fixture();f.cfg.foundry!.completenessGate=true;f.cfg.foundry!.verifyToGreen={enabled:true,maxIterations:1};
    vi.mocked(runCompletenessGate).mockImplementation(async()=>{repinResourceNativeProfile({directory:dirname(f.b.profile.command[1]),executable:f.a.executable});return {pass:false,reason:'fixture needs repair'};});
    const result=await runEngineSandboxed('codex','Read input and edit',f.cfg,f.opts);
    expect(f.spawns).toHaveLength(1);expect(f.reply()).toMatchObject({binary:'B',repair:false});expect(result.proposalId).toBeUndefined();
    expect(result.state.status).toBe('failed');expect(result.state.usage.steps).toBe(1);expect(leases.countLiveExecutionLeases()).toBe(0);
  });
  it('records unknown kernel evidence when a prepared repair is refused before inference',async() => {
    const f=fixture(),prepare=autonomous.prepareAutonomousSpawn;
    host.policy={...host.policy!,grantId:makeGrant().grantId};
    resetLedgerCachesForTest();
    let watchers=0;
    autonomous.setKernelEvidenceWatcherForTest(tag=>{
      const repair=++watchers===2;
      return {tag,ready:true,finish:()=>({source:'kernel-log',state:repair?'incomplete':'complete',reason:repair?'fixture repair end barrier unavailable':null,denials:[]}),abort(){}};
    });
    const recordUnknown=rollout.recordSandboxEvidenceUnknown;
    // The recorder's dynamic effective-config import does not inherit Vitest's
    // module mock. Use its existing standing-grant seam, retaining the real
    // durable writer rather than replacing evidence with a mock result.
    const unknown=vi.spyOn(rollout,'recordSandboxEvidenceUnknown').mockImplementation(input=>
      recordUnknown(input,{standingGrantId:()=>host.policy?.grantId??null}));
    const prepared=vi.spyOn(autonomous,'prepareAutonomousSpawn').mockImplementation(input=>{
      const value=prepare(input);
      if(watchers===2)repinResourceNativeProfile({directory:dirname(f.b.profile.command[1]),executable:f.a.executable});
      return value;
    });
    f.cfg.foundry!.completenessGate=true;f.cfg.foundry!.verifyToGreen={enabled:true,maxIterations:1};
    vi.mocked(runCompletenessGate).mockResolvedValue({pass:false,reason:'fixture needs repair'});
    try {
      const result=await runEngineSandboxed('codex','Read input and edit',f.cfg,f.opts);
      expect(prepared).toHaveBeenCalledTimes(2);expect(f.spawns).toHaveLength(1);
      expect(f.reply()).toMatchObject({binary:'B',repair:false});
      expect(result.state.status).toBe('failed');expect(result.state.usage.steps).toBe(1);expect(result.proposalId).toBeUndefined();
      expect(unknown).toHaveBeenCalledExactlyOnceWith({engine:'codex',sourceRepo:f.repo,runId:result.state.id,evidence:expect.objectContaining({state:'incomplete',reason:'fixture repair end barrier unavailable'})});
      expect(ledgerSnapshot().index.evidence.map(row=>row.kind)).toEqual(['sandbox:evidence-unknown']);
      expect(leases.countLiveExecutionLeases()).toBe(0);
    } finally {resetLedgerCachesForTest();}
  });
  it('recovers supported Codex config for a versioned B executable with unchanged account and capture',async() => {
    const f=fixture();const result=await runEngineSandboxed('codex','CONFIG_RECOVERY Read and edit',f.cfg,{...f.opts,propose:false});
    expect(result.state.status).toBe('done');expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]!.result.configRecoveryAttempts).toBe(1);
    expect(f.reply()).toMatchObject({binary:'B',account:'fixture-B'});expect(result.state.usage).toMatchObject({tokensIn:11,tokensOut:5,steps:2});
  });
  it('rechecks the launch before internal config recovery and never runs the re-pinned executable',async() => {
    const f=fixture(),actual=f.actual;let contacts=0;
    vi.mocked(engines.spawnEngine).mockImplementation(async(cmd,cfg,opts)=>{
      const result=await actual(cmd,cfg,{...opts,onSpawn:()=>{
        contacts++;opts?.onSpawn?.();
        repinResourceNativeProfile({directory:dirname(f.b.profile.command[1]),executable:f.a.executable});
      }});f.spawns.push({cmd,result});return result;
    });
    const result=await runEngineSandboxed('codex','CONFIG_RECOVERY Read and edit',f.cfg,{...f.opts,propose:false});
    expect(contacts).toBe(1);expect(f.spawns[0]!.result.output).toBe('');expect(result.state.usage.steps).toBe(1);
    expect(f.diffs.join('\n')).not.toContain('export const result');
  });
  it('retains repair metadata uncertainty after the original private home was cleaned',async() => {
    const f=fixture(),observe=accounts.observeRoleAccount,register=leases.registerExecutionLease;
    let retained:leases.ExecutionLease | undefined;
    vi.spyOn(leases,'registerExecutionLease').mockImplementation((...args)=>{const r=register(...args);if(r.ok)retained=r.lease;return r;});
    vi.spyOn(accounts,'observeRoleAccount').mockImplementationOnce(observe).mockResolvedValue({epoch:null,uncertain:true});
    f.cfg.foundry!.completenessGate=true;f.cfg.foundry!.verifyToGreen={enabled:true,maxIterations:1};
    vi.mocked(runCompletenessGate).mockResolvedValue({pass:false,reason:'fixture needs repair'});
    try {
      const result=await runEngineSandboxed('codex','Read and edit',f.cfg,f.opts);
      expect(result.state.status).toBe('failed');expect(f.spawns).toHaveLength(1);expect(result.proposalId).toBeUndefined();
      expect(existsSync(f.reply().state)).toBe(false);
      expect(result.sandboxRetention?.status).toBe('retained');expect(existsSync(result.sandboxRetention!.worktreePath)).toBe(true);
      expect(retained?.isHeld()).toBe(true);expect(leases.countLiveExecutionLeases()).toBe(1);
    } finally {retained?.release();}
  });
  it('retains the drain lease and files on uncertain metadata without inference or false quiescence',async() => {
    const f=fixture(),register=leases.registerExecutionLease;let retained:leases.ExecutionLease | undefined;
    vi.spyOn(leases,'registerExecutionLease').mockImplementation((...args)=>{const r=register(...args);if(r.ok)retained=r.lease;return r;});
    vi.spyOn(accounts,'observeRoleAccount').mockResolvedValue({epoch:null,uncertain:true});
    try {
      const result=await runEngineSandboxed('codex','Read and edit',f.cfg,{...f.opts,propose:false});
      expect(result.state.status).toBe('failed');expect(f.spawns).toEqual([]);
      expect(result.sandboxRetention?.status).toBe('retained');expect(existsSync(result.sandboxRetention!.worktreePath)).toBe(true);
      expect(retained?.isHeld()).toBe(true);expect(leases.countLiveExecutionLeases()).toBe(1);
    } finally {retained?.release();}
  });
});

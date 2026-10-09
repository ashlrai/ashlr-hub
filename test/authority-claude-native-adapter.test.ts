/** Real inert native process + HTTP + OS jail seams. No vendor executable or credential is used. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import { prepareResourceNativeProfile } from '../src/core/resources/native-profile.js';
import { readClaudeNativeBinding, sameClaudeNativeBinding, claudeNativeObservation, observeClaudeNativeBinding } from '../src/core/sandbox/claude-native-admission.js';
import { runClaudeNativeAdapter } from '../src/core/sandbox/claude-native-adapter.js';
import { setKernelEvidenceWatcherForTest, type AutonomousSpawnFinish } from '../src/core/sandbox/autonomous-run.js';
import { spawnEngine } from '../src/core/run/engines.js';
import type { ClaudeAccountUsageResult } from '../src/core/resources/claude-account-usage.js';

let base: string;
beforeEach(() => { base=realpathSync(mkdtempSync(join(tmpdir(),'claude-native-inert-'))); });
afterEach(() => {setKernelEvidenceWatcherForTest();vi.unstubAllEnvs();rmSync(base,{recursive:true,force:true});});
const identity = {email:'native-fixture@example.invalid',orgId:'fixture-org'};
const accountDigest = createHash('sha256').update(JSON.stringify(['claude-native-auth-v1',identity.email,identity.orgId])).digest('hex');
function fixture() {
  const executable=join(base,'inert-native');
  writeFileSync(executable, `#!${realpathSync(process.execPath)}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),state=process.env.CLAUDE_CONFIG_DIR;
const data=JSON.parse(fs.readFileSync(path.join(state,'fixture.json'),'utf8'));
if(args[0]==='auth') {console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',email:data.email,orgId:data.orgId}));process.exit(0);}
if(args[0]==='--version') {console.log((data.version||'2.1.280')+' (Claude Code)');process.exit(0);}
if(args.at(-1)==='/usage') {
 const sid='native-local';
 const usage={input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};
 const row=(kind,group)=>({kind,group,scope:null,percent:12,is_active:true,severity:'normal',resets_at:null});
 console.log(JSON.stringify({type:'assistant',session_id:sid,parent_tool_use_id:null,uuid:'local-usage',usage_report:{session:{total_cost_usd:0,total_api_duration_ms:0,model_usage:{}},rate_limits:{limits:[row('session','session'),row('weekly_all','weekly')],extra_usage:{is_enabled:data.credits}}}}));
 console.log(JSON.stringify({type:'result',session_id:sid,uuid:'local-result',num_turns:0,subtype:'success',is_error:false,total_cost_usd:0,duration_api_ms:0,usage,modelUsage:{},result:'local usage'}));process.exit(0);
}
const required=['--safe-mode','--restricted','--strict-mcp-config','--no-chrome','--no-session-persistence','--verbose','--allowedTools=mcp__ashlr-fleet-broker'];
if(required.some(x=>!args.includes(x))||args[args.indexOf('--tools')+1]!==''||args[args.indexOf('--output-format')+1]!=='stream-json'||!args.includes('-p'))process.exit(12);
const forbidden=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','NODE_OPTIONS','HTTPS_PROXY'];
if(forbidden.some(k=>process.env[k]!==undefined))process.exit(13);
fs.writeFileSync(path.join(state,'contact.json'),JSON.stringify({args,environmentProtected:true}));
let prompt='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',async()=>{
 try {
 const body=JSON.parse(prompt);
 if(body.networkProbes){const results=[];for(const url of body.networkProbes){try{await fetch(url,{signal:AbortSignal.timeout(1000)});results.push('connected');}catch{results.push('blocked');}}console.log(JSON.stringify({type:'result',subtype:'success',result:JSON.stringify(results)}));return;}
 const server=JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers['ashlr-fleet-broker'];
 const call=async(method,params)=>{const res=await fetch(server.url,{method:'POST',headers:{...server.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(res.status!==200)throw Error('refused');return res.json();};
 await call('initialize',{protocolVersion:'2025-03-26'});await call('tools/list',{});
 if(body.partialMetadata){fs.writeFileSync(path.join(state,'.claude.json'),'{',{mode:0o600});}
 if(body.stall){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'started'}]}}));setInterval(()=>{},1000);return;}
 const response=await call('tools/call',{name:'write_file',arguments:{path:'written.txt',text:body.text}});
 if(response.result.content[0].text!=='Written')process.exit(14);
 if(body.afterIdentity){fs.writeFileSync(path.join(state,'fixture.json'),JSON.stringify({...data,...body.afterIdentity}));}
 if(body.fail){process.exitCode=17;return;}
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'native fixture complete'}]}}));
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'native fixture complete',usage:{input_tokens:9,output_tokens:4}}));
 }catch{process.exitCode=15;}
});
`,{mode:0o700});
  const profile=prepareResourceNativeProfile({provider:'claude',directory:join(base,'profile'),executable});
  writeFileSync(join(profile.nativeStatePath,'fixture.json'),JSON.stringify({...identity,credits:false}),{mode:0o600});
  const accountsRoot=join(base,'accounts');mkdirSync(accountsRoot,{mode:0o700});
  writeFileSync(join(accountsRoot,'connections.json'),JSON.stringify({schemaVersion:1,intervalMs:30_000,accounts:[{id:'claude-a',provider:'claude',label:'Fixture',command:profile.command,expectedAccountHint:accountDigest}]}),{mode:0o600});
  const cfg=defaultConfig();cfg.verse={...(cfg.verse??{}),accountsRoot};
  const worktree=join(base,'worktree');mkdirSync(worktree,{mode:0o700});
  return {cfg,profile,executable,worktree};
}
const report = (patch: Partial<ClaudeAccountUsageResult> = {}):ClaudeAccountUsageResult => ({scope:'claude-native-auth-status',status:'observed',reason:'usage-native-current',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),loggedIn:true,authMethod:'claude.ai',subscriptionType:'max',accountHint:accountDigest,windows:[],quotaFresh:true,extraUsageEnabled:false,...patch});
function readyWatch() {setKernelEvidenceWatcherForTest(tag=>({tag,ready:true,finish:()=>({source:'kernel-log',state:'complete',reason:null,denials:[]}),abort() {}}));}
function publishLocalMetadata(nativeStatePath: string) {
  const temporary=join(nativeStatePath,'.claude.json.fixture-tmp');
  writeFileSync(temporary,JSON.stringify({oauthAccount:{emailAddress:identity.email,organizationUuid:identity.orgId}}),{mode:0o600});
  renameSync(temporary,join(nativeStatePath,'.claude.json'));
}

describe.skipIf(process.platform === 'win32' || typeof process.execve !== 'function')('native principal and immutable launch binding',()=>{
  it('admits authoritative same-principal native before/after metadata without a local OAuth file',async()=>{
    const f=fixture();expect(readClaudeNativeBinding(f.cfg,'claude-a')?.localAccountDigest).toBeNull();
    const proof=await observeClaudeNativeBinding(f.cfg,'claude-a','native-fixture','claude-sonnet-4-5',base,new AbortController().signal,()=>true);
    expect(proof?.observation).toMatchObject({accountDigest,authMethod:'claude.ai',extraUsageEnabled:false});
    expect(existsSync(join(f.profile.nativeStatePath,'contact.json'))).toBe(false);
  });
  it('allows absent metadata becoming the same native principal but refuses different/unsafe metadata',async()=>{
    const f=fixture();const first=readClaudeNativeBinding(f.cfg,'claude-a')!;
    const metadata=join(f.profile.nativeStatePath,'.claude.json');
    writeFileSync(metadata,JSON.stringify({oauthAccount:{emailAddress:identity.email,organizationUuid:identity.orgId}}),{mode:0o600});
    const same=readClaudeNativeBinding(f.cfg,'claude-a')!;
    expect(sameClaudeNativeBinding(first,same)).toBe(true);expect(claudeNativeObservation(same,report(),'native-fixture','claude-sonnet-4-5')).not.toBeNull();
    writeFileSync(metadata,JSON.stringify({oauthAccount:{emailAddress:'foreign@example.invalid',organizationUuid:identity.orgId}}),{mode:0o600});
    const foreign=readClaudeNativeBinding(f.cfg,'claude-a')!;
    expect(claudeNativeObservation(foreign,report(),'native-fixture','claude-sonnet-4-5')).toBeNull();
    expect(await observeClaudeNativeBinding(f.cfg,'claude-a','native-fixture','claude-sonnet-4-5',base,new AbortController().signal,()=>true)).toBeNull();
    chmodSync(metadata,0o644);expect(readClaudeNativeBinding(f.cfg,'claude-a')).toBeNull();
    chmodSync(metadata,0o600);writeFileSync(metadata,'{}');expect(readClaudeNativeBinding(f.cfg,'claude-a')).toBeNull();
  });
  it('does not treat benign mutable display-cache stat as credential identity; real principal and launch changes hold',()=>{
    const f=fixture();const metadata=join(f.profile.nativeStatePath,'.claude.json');
    writeFileSync(metadata,JSON.stringify({oauthAccount:{emailAddress:identity.email,organizationUuid:identity.orgId},cache:1}),{mode:0o600});
    const first=readClaudeNativeBinding(f.cfg,'claude-a')!;
    writeFileSync(metadata,JSON.stringify({oauthAccount:{emailAddress:identity.email,organizationUuid:identity.orgId},cache:2}),{mode:0o600});
    expect(sameClaudeNativeBinding(first,readClaudeNativeBinding(f.cfg,'claude-a')!)).toBe(true);
    writeFileSync(metadata,JSON.stringify({oauthAccount:{emailAddress:'other@example.invalid',organizationUuid:identity.orgId}}),{mode:0o600});
    const other=readClaudeNativeBinding(f.cfg,'claude-a')!;expect(sameClaudeNativeBinding(first,other)).toBe(false);expect(claudeNativeObservation(other,report(),'native-fixture','claude-sonnet-4-5')).toBeNull();
    writeFileSync(f.profile.launcherPath,readFileSync(f.profile.launcherPath,'utf8')+'\n// changed\n');expect(readClaudeNativeBinding(f.cfg,'claude-a')).toBeNull();
  });
  it.each([{extraUsageEnabled:true},{extraUsageEnabled:null},{quotaFresh:false},{accountHint:'d'.repeat(64)},{startedAt:new Date(0).toISOString()},{authMethod:'api-key'}] as Partial<ClaudeAccountUsageResult>[])('holds unknown/changed/credit-enabled metadata %j',patch=>{
    const f=fixture();expect(claudeNativeObservation(readClaudeNativeBinding(f.cfg,'claude-a')!,report(patch),'native-fixture','claude-sonnet-4-5')).toBeNull();
  });
  it('stops unsupported versions before usage or model contact',async()=>{
    const f=fixture();writeFileSync(join(f.profile.nativeStatePath,'fixture.json'),JSON.stringify({...identity,credits:false,version:'99.0.0'}),{mode:0o600});
    expect(await observeClaudeNativeBinding(f.cfg,'claude-a','native-fixture','claude-sonnet-4-5',base,new AbortController().signal,()=>true)).toBeNull();
    expect(existsSync(join(f.profile.nativeStatePath,'contact.json'))).toBe(false);
  });
});

describe.runIf(process.platform === 'darwin' && typeof process.execve === 'function')('real inert native CLI and separately jailed tools',()=>{
  it('holds a role when current native identity differs from the selected allowance',async()=>{
    const f=fixture();readyWatch();
    const result=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',
      expectedAccountHint:'d'.repeat(64),prompt:JSON.stringify({text:'must not run'}),signal:new AbortController().signal,
      admission:()=>true,timeoutMs:4000,recordEvidence:()=>{},retainCleanupFailure:()=>{throw Error('unexpected retention');}});
    expect(result).toMatchObject({ok:false,providerContacted:false,captureDenied:true});
    expect(existsSync(join(f.profile.nativeStatePath,'contact.json'))).toBe(false);
    expect(existsSync(join(f.worktree,'written.txt'))).toBe(false);
  });
  it('passes bounded stdin/accepted flags and actual MCP read/write; preserves streamed text and token usage',async()=>{
    const f=fixture();readyWatch();const evidence:AutonomousSpawnFinish[]=[];
    for(const key of ['ANTHROPIC_API_KEY','NODE_OPTIONS','HTTPS_PROXY'])vi.stubEnv(key,'fixture-ambient-must-not-pass');
    const events:unknown[]=[];
    const result=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',prompt:JSON.stringify({text:'real tool π'}),signal:new AbortController().signal,admission:()=>true,timeoutMs:4000,recordEvidence:finish=>{evidence.push(finish);},retainCleanupFailure:()=>{throw Error('unexpected retention');},onEvent:event=>{events.push(event);}});
    expect(result).toMatchObject({ok:true,providerContacted:true,usage:{tokensIn:9,tokensOut:4}});expect(result.captureDenied).not.toBe(true);
    expect(readFileSync(join(f.worktree,'written.txt'),'utf8')).toBe('real tool π');
    const contact=JSON.parse(readFileSync(join(f.profile.nativeStatePath,'contact.json'),'utf8'));expect(contact.environmentProtected).toBe(true);expect(contact.args.join(' ')).not.toContain('real tool π');
    expect(events.length).toBeGreaterThan(0);expect(evidence.length).toBe(2);expect(evidence.every(x=>x.violationsKnown)).toBe(true);
    // A later repair attempt must obtain a new vendor proof; the initial run's
    // successful observation never authorizes a second contact after billing changes.
    const priorContact=readFileSync(join(f.profile.nativeStatePath,'contact.json'));
    writeFileSync(join(f.profile.nativeStatePath,'fixture.json'),JSON.stringify({...identity,credits:true}),{mode:0o600});
    const repair=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',prompt:JSON.stringify({text:'repair must not run'}),signal:new AbortController().signal,admission:()=>true,timeoutMs:4000,recordEvidence() {},retainCleanupFailure() {}});
    expect(repair).toMatchObject({ok:false,captureDenied:true});expect(readFileSync(join(f.profile.nativeStatePath,'contact.json'))).toEqual(priorContact);
    expect(readFileSync(join(f.worktree,'written.txt'),'utf8')).toBe('real tool π');
  });
  it.each([null,{email:'changed@example.invalid'},{orgId:'changed-org'},{credits:true}])('rechecks settled partial failures before capture: %j',async afterIdentity=>{
    const f=fixture();readyWatch();
    // Isolate the post-edit identity/billing recheck. Publishing metadata during
    // admission polling can correctly hold a partial read before any tool edit.
    publishLocalMetadata(f.profile.nativeStatePath);
    const result=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',
      prompt:JSON.stringify({text:'partial edit',fail:true,afterIdentity}),signal:new AbortController().signal,admission:()=>true,
      timeoutMs:4000,recordEvidence() {},retainCleanupFailure(){throw Error('unexpected retention');}});
    const diagnostic=JSON.stringify({ok:result.ok,providerContacted:result.providerContacted,captureDenied:result.captureDenied,error:result.error,terminationReason:result.terminationReason});
    expect(existsSync(join(f.worktree,'written.txt')),diagnostic).toBe(true);
    expect(readFileSync(join(f.worktree,'written.txt'),'utf8')).toBe('partial edit');expect(result.ok).toBe(false);expect(result.providerContacted).toBe(true);
    if(afterIdentity===null)expect(result.captureDenied).not.toBe(true);
    else expect(result).toMatchObject({captureDenied:true,error:expect.stringContaining('identity or billing boundary changed')});
  });
  it('holds malformed metadata published before a real tool mutation',async()=>{
    const f=fixture();readyWatch();
    const result=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',
      prompt:JSON.stringify({text:'must not write',partialMetadata:true}),signal:new AbortController().signal,admission:()=>true,
      timeoutMs:4000,recordEvidence() {},retainCleanupFailure(){throw Error('unexpected retention');}});
    expect(result).toMatchObject({ok:false,providerContacted:true,captureDenied:true});
    expect(readFileSync(join(f.profile.nativeStatePath,'.claude.json'),'utf8')).toBe('{');
    expect(readClaudeNativeBinding(f.cfg,'claude-a')).toBeNull();
    expect(existsSync(join(f.worktree,'written.txt'))).toBe(false);
  });
  it('the native outer jail denies other IPv4 and IPv6 loopback listeners while retaining only its broker exception',async()=>{
    const f=fixture();const servers=[createServer((_q,r)=>r.end('unexpected')),createServer((_q,r)=>r.end('unexpected'))];
    const urls:string[]=[];
    try{
      for(const [index,host] of ['127.0.0.1','::1'].entries()){
        const server=servers[index]!;await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,host,()=>resolve());});
        const address=server.address();if(!address||typeof address==='string')throw Error('fixture address unavailable');urls.push(`http://${host==='::1'?'[::1]':host}:${address.port}`);
      }
      setKernelEvidenceWatcherForTest(tag=>({tag,ready:true,finish:()=>({source:'kernel-log',state:'incomplete',reason:'intentional test-only denial evidence',denials:[]}),abort() {}}));
      const result=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',prompt:JSON.stringify({networkProbes:urls}),signal:new AbortController().signal,admission:()=>true,timeoutMs:4000,recordEvidence() {},retainCleanupFailure() {}});
      expect(result.output).toContain('blocked');expect(result.output).not.toContain('connected');expect(result.captureDenied).toBe(true);
    }finally{await Promise.all(servers.map(server=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})));}
  });
  it('refuses missing kernel readiness before native contact and credit-enabled accounts before launch',async()=>{
    const f=fixture();const run=()=>runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',prompt:'{}',signal:new AbortController().signal,admission:()=>true,timeoutMs:4000,recordEvidence() {},retainCleanupFailure() {}});
    expect(await run()).toMatchObject({ok:false,providerContacted:false,captureDenied:true,error:expect.stringContaining('evidence unavailable before contact')});
    const noOwner=await runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',prompt:'{}',signal:undefined as unknown as AbortSignal,admission:()=>true,timeoutMs:4000,recordEvidence() {},retainCleanupFailure() {}});
    expect(noOwner).toMatchObject({ok:false,providerContacted:false,captureDenied:true,error:expect.stringContaining('cancellation ownership unavailable')});
    expect(existsSync(join(f.profile.nativeStatePath,'contact.json'))).toBe(false);
    let reads=0;
    setKernelEvidenceWatcherForTest(tag=>({tag,get ready(){return ++reads===1;},finish:()=>({source:'kernel-log',state:'complete',reason:null,denials:[]}),abort() {}}));
    expect(await run()).toMatchObject({ok:false,providerContacted:false,captureDenied:true});
    expect(reads).toBeGreaterThan(1);expect(existsSync(join(f.profile.nativeStatePath,'contact.json'))).toBe(false);
    readyWatch();writeFileSync(join(f.profile.nativeStatePath,'fixture.json'),JSON.stringify({...identity,credits:true}),{mode:0o600});
    expect(await run()).toMatchObject({ok:false,providerContacted:false,captureDenied:true});expect(existsSync(join(f.profile.nativeStatePath,'contact.json'))).toBe(false);
  });
  it('Stop closes the capability and holds capture when leader exit prevents authenticated group settlement',async()=>{
    const f=fixture();readyWatch();let retained=false;const stop=new AbortController();let started!:()=>void;const began=new Promise<void>(r=>{started=r;});
    const run=runClaudeNativeAdapter({...f,runId:'native-fixture',seatId:'claude-a',model:'claude-sonnet-4-5',prompt:JSON.stringify({stall:true}),signal:stop.signal,admission:()=>!stop.signal.aborted,timeoutMs:4000,recordEvidence() {},retainCleanupFailure(){retained=true;},onEvent(){started();}});
    await began;stop.abort();const result=await run;expect(result.ok).toBe(false);expect(result).toMatchObject({terminationReason:'error-exit',captureDenied:true,error:expect.stringContaining('termination authority lost')});expect(retained).toBe(true);expect(existsSync(join(f.worktree,'written.txt'))).toBe(false);
    const config=JSON.parse(readFileSync(join(f.profile.nativeStatePath,'contact.json'),'utf8')).args;const configPath=config[config.indexOf('--mcp-config')+1];expect(existsSync(configPath)).toBe(true);
    const server=JSON.parse(readFileSync(configPath,'utf8')).mcpServers['ashlr-fleet-broker'];await expect(fetch(server.url,{method:'POST',headers:server.headers,body:'{}'})).rejects.toThrow();
    // The known inert fixture leader exited; manually remove only its private retained cwd.
    rmSync(join(configPath,'..'),{recursive:true,force:true});
  });
});

describe('bounded source-owned stdin transport',()=>{
  it('rejects oversized stdin before spawning and reports streamed usage from a real inert Node child',async()=>{
    const bin=realpathSync(process.execPath);const cfg=defaultConfig();
    const large=await spawnEngine({bin,args:['-e','process.exit(99)'],cwd:base},cfg,{stdin:'x'.repeat(1024*1024+1),signal:new AbortController().signal});expect(large.ok).toBe(false);
    const program=`let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'success',result:s,usage:{input_tokens:3,output_tokens:2}}));});`;
    const result=await spawnEngine({bin,args:['-e',program,'--','--output-format','stream-json'],cwd:base},cfg,{stdin:'private-stdin-prompt',nativeEngine:'claude',signal:new AbortController().signal});
    expect(result).toMatchObject({ok:true,usage:{tokensIn:3,tokensOut:2}});expect(result.output).toContain('private-stdin-prompt');
  });
});

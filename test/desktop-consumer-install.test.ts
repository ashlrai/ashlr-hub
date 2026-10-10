/** Original signed bytes and real shared filesystem transaction; macOS and network ports are inert. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {Header} from 'tar';
import {canonicalJson} from '../src/core/authority/canonical-json.js';
import {authoritySurfaceDigest} from '../src/core/authority/surface.js';
import {extractSignedAppArchive} from '../src/core/desktop/qualified-update.js';
import {applyConsumerDesktopInstall,consumerInstallerOsCommand,createConsumerInstallDependencies,inspectConsumerDesktopInstall,parseConsumerShellTargets,type ConsumerInstallDependencies,type ConsumerTransaction} from '../src/core/desktop/consumer-install.js';
import {cmdDesktop,parseDesktopInstallArgs} from '../src/cli/desktop.js';
import type {CompatibleUpdateManifest,UpdateTrust} from '../src/core/desktop/update-manifest.js';
const transaction=await import('../scripts/local-app-transaction.mjs' as string);
const roots:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519'),keyId=Buffer.from('0102030405060708','hex');
const publicText=Buffer.from(`untrusted comment: disposable fixture\n${Buffer.concat([Buffer.from('Ed'),keyId,publicKey.export({format:'der',type:'spki'}).subarray(-32)]).toString('base64')}\n`).toString('base64');
function signature(data:Uint8Array) {
  const s=sign(null,createHash('blake2b512').update(data).digest(),privateKey),comment='synthetic consumer fixture';
  return Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from('ED'),keyId,s]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null,Buffer.concat([s,Buffer.from(comment)]),privateKey).toString('base64')}\n`).toString('base64');
}
function archive(rows:{path:string;data:string|Buffer;mode?:number;directory?:boolean}[]) {
  const parts:Buffer[]=[];
  for(const row of rows) {
    const data=Buffer.from(row.data),header=new Header({path:row.path,type:row.directory?'Directory':'File',size:data.length,mode:row.mode??0o644,uid:0,gid:0,mtime:new Date(0)});
    header.encode();parts.push(header.block!,data,Buffer.alloc((512-data.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]));
}
function write(path:string,data:string|Buffer,mode=0o600) {fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,data,{mode});fs.chmodSync(path,mode);}
function fixture(version='3.29.3') {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'consumer-install-')));fs.chmodSync(root,0o700);roots.push(root);
  const home=join(root,'home'),applications=join(root,'Applications');for(const dir of [home,applications])fs.mkdirSync(dir,{mode:0o700});
  const revision='b'.repeat(40),tree='c'.repeat(40),code=Buffer.from('throw new Error("fixture never executes candidate code");');
  const core={v:1 as const,roots:['dist/core/authority/fixture.js'],missingRoots:[],files:[{path:'dist/core/authority/fixture.js',sha256:sha(code),bytes:code.length}],packages:[],unresolved:[]};
  const surface={...core,digest:authoritySurfaceDigest(core)},launcher=fs.readFileSync(resolve(import.meta.dirname,'../bin/ashlr'));
  const cli=archive([
    {path:'package/package.json',data:JSON.stringify({name:'@ashlr/phantom',version,type:'module',bin:{ashlr:'bin/ashlr',phm:'bin/ashlr'}})},
    {path:'package/bin/ashlr',data:launcher,mode:0o755},
    {path:'package/dist/build-identity.json',data:JSON.stringify({schemaVersion:1,packageVersion:version,revision,dirty:false,provenance:'git'})},
    {path:'package/dist/cli/index.js',data:code},{path:'package/dist/core/universe/index.js',data:code},
    {path:'package/dist/core/authority/fixture.js',data:code},{path:'package/dist/authority-surface.json',data:JSON.stringify(surface)}]);
  const artifact=(filename:string,data:Buffer)=>({filename,url:`https://github.com/ashlrai/phantom/releases/download/v${version}/${filename}`,bytes:data.length,sha256:sha(data),signature:signature(data)});
  const manifest={schemaVersion:2,kind:'phantom-paired-release',channel:'stable',platform:'darwin-aarch64',version,
    repository:{nameWithOwner:'ashlrai/phantom',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerId:258113726,ownerLogin:'ashlrai',defaultBranch:'master'},source:{revision,tree},authoritySurfaceDigest:surface.digest,
    cli:{...artifact(`ashlr-phantom-${version}.tgz`,cli),packageName:'@ashlr/phantom',binName:'ashlr'},
    app:{...artifact(`Phantom_${version}_aarch64.app.tar.gz`,Buffer.from('pending')),bundleIdentifier:'ai.ashlr.desktop',executable:'ashlr-desktop',inventorySha256:'e'.repeat(64),signer:'F'.repeat(40)},
    qualification:{manifestSha256:'0'.repeat(64),archiveSha256:'1'.repeat(64),packageSha256:sha(cli),qualificationSha256:'2'.repeat(64),producer:{runId:10,runAttempt:1,eventSha:revision},attestor:{revision:'a'.repeat(40),runId:20,runAttempt:1},audit:{revision,runId:30,runAttempt:1}}} as CompatibleUpdateManifest;
  const marker=canonicalJson({schemaVersion:1,version,source:manifest.source,authoritySurfaceDigest:surface.digest,packageSha256:sha(cli)});
  const app=archive([
    ...['Phantom.app','Phantom.app/Contents','Phantom.app/Contents/MacOS','Phantom.app/Contents/Resources'].map(path=>({path,data:'',directory:true,mode:0o755})),
    {path:'Phantom.app/Contents/Info.plist',data:JSON.stringify({CFBundleName:'Phantom',CFBundleDisplayName:'Phantom',CFBundleIdentifier:'ai.ashlr.desktop',CFBundleExecutable:'ashlr-desktop',CFBundleShortVersionString:version,CFBundleVersion:version})},
    {path:'Phantom.app/Contents/MacOS/ashlr-desktop',data:code,mode:0o755},{path:'Phantom.app/Contents/MacOS/ashlr',data:code,mode:0o755},
    {path:'Phantom.app/Contents/Resources/phantom-release.json',data:marker}]);
  Object.assign(manifest.app,artifact(manifest.app.filename,app));
  const source=join(root,'source');fs.mkdirSync(source,{mode:0o700});const appRoot=extractSignedAppArchive(app,source);
  const base=transaction.createLocalAppTransactionIo({packageRoot:resolve(import.meta.dirname,'..'),home});manifest.app.inventorySha256=base.appInventory(appRoot);
  const trust:UpdateTrust={publicKey:publicText,repository:{fullName:'ashlrai/phantom',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerLogin:'ashlrai',ownerId:258113726,ownerNodeId:'O_kgDOD2KAvg'},channel:'stable',platform:'darwin-aarch64'};
  const published=new Map<string,Buffer>();
  function publish() {const manifestText=canonicalJson(manifest);published.set(`https://github.com/ashlrai/phantom/releases/download/v${version}/latest.json`,Buffer.from(canonicalJson({version,platforms:{'darwin-aarch64':{url:manifest.app.url,signature:manifest.app.signature}},phantom:{manifestText,signature:signature(Buffer.from(manifestText))}})));}
  published.set(manifest.app.url,app);published.set(manifest.cli.url,cli);publish();
  let now=0,live=false,health=true,spawnFailure=false;
  const census={leases:[] as unknown[],unknown:0,reaped:0},mapped=(path:string)=>path.startsWith('/Applications/')?join(applications,path.slice('/Applications/'.length)):path;
  const io={...base,platform:'darwin',clock:()=>now,sleep:async(ms:number)=>{now+=ms;},fetchStatus:vi.fn(async()=>health?200:503),log:vi.fn(),executionLeaseCensus:vi.fn(async()=>census),exclusiveRenamePreflight:vi.fn()};
  for(const name of ['lstat','exists','appInventory','readBoundedFile']) {const fn=base[name].bind(base);io[name]=(path:string,...args:unknown[])=>fn(mapped(path),...args);}
  io.makeInstallStage=()=>'/Applications/'+basename(fs.mkdtempSync(join(applications,'.phantom-install-')));
  io.writeInstallJournal=vi.fn((owner:string,value:unknown)=>write(join(mapped(owner),'transaction.json'),JSON.stringify(value)));
  io.renameExclusive=vi.fn((from:string,to:string,expected:{dev:number;ino:number})=> {const s=fs.lstatSync(mapped(from));expect([s.dev,s.ino]).toEqual([expected.dev,expected.ino]);expect(fs.existsSync(mapped(to))).toBe(false);fs.renameSync(mapped(from),mapped(to));});
  io.removeInstallTree=(path:string,owner:string)=> {expect(dirname(path)).toBe(owner);fs.rmSync(mapped(path),{recursive:true,force:true});};
  io.exec=vi.fn((bin:string,args:string[])=> {
    expect(consumerInstallerOsCommand(bin,args)).toBe(true);
    if(bin==='/usr/bin/plutil')return {status:0,stdout:JSON.parse(fs.readFileSync(mapped(args.at(-1)!),'utf8'))[args[1]]+'\n'};
    if(bin==='/usr/bin/codesign') {expect(args[0]).toBe('--verify');expect(args[3]).toContain(manifest.app.signer);return {status:0,stdout:''};}
    if(bin==='/usr/bin/ditto') {expect(args).toHaveLength(2);fs.cpSync(mapped(args[0]),mapped(args[1]),{recursive:true,preserveTimestamps:true});return {status:0,stdout:''};}
    if(bin==='/usr/bin/open') {if(spawnFailure)return {status:1,stdout:''};live=true;write(join(home,'.ashlr/.desktop-sidecar.json'),JSON.stringify({desktopPid:100,sidecarPid:101,port:7777,sidecarPath:'/Applications/Phantom.app/Contents/MacOS/ashlr'}));return {status:0,stdout:''};}
    if(bin==='/bin/ps')return {status:0,stdout:live?'100 1 Thu Oct 8 00:00:00 2026 /Applications/Phantom.app/Contents/MacOS/ashlr-desktop\n101 100 Thu Oct 8 00:00:00 2026 /Applications/Phantom.app/Contents/MacOS/ashlr verse --port 7777 --no-open --json\n':''};
    if(bin==='/usr/sbin/lsof')return {status:0,stdout:health?'p101\nf8\n':'p999\nf8\n'};
    throw new Error('unexpected OS port');
  });
  write(join(home,'.ashlr/KILL'),'');
  const helper={...transaction,createLocalAppTransactionIo:vi.fn(()=>io)} as ConsumerTransaction;
  const deps:ConsumerInstallDependencies={home,platform:'darwin',architecture:'arm64',packageRoot:resolve(import.meta.dirname,'..'),version,revision,authoritySurfaceDigest:surface.digest,trust,
    assertRunning:vi.fn(),download:vi.fn(async(url)=>{const bytes=published.get(url);if(!bytes)throw new Error('unpublished fixture');return Buffer.from(bytes);}),
    transaction:vi.fn(async()=>helper),readManagedVersion:vi.fn(async()=>version),discover:vi.fn(async managed=>(['phm','ashlr'] as const).map(name=>({name,target:managed,version,versionSource:'executed-managed' as const})))};
  const current=join(home,'.local/share/ashlr/current');
  return {root,home,applications,version,manifest,published,publish,deps,helper,io,census,current,appRoot,setLive:(value:boolean)=>{live=value;},setHealth:(value:boolean)=>{health=value;},failOpen:()=>{spawnFailure=true;}};
}

describe('public consumer first installation',()=> {
  it('defaults to inspection; accepts only explicit apply and no authority/path/key overrides',()=> {
    expect(parseDesktopInstallArgs(['install'])).toEqual({apply:false});expect(parseDesktopInstallArgs(['install','--apply'])).toEqual({apply:true});
    expect(parseDesktopInstallArgs([])).toBeNull();
    for(const args of [['apply'],['install','--url'],['install','--apply','--apply'],['install','--trust'],['install','--force']])expect(()=>parseDesktopInstallArgs(args)).toThrow();
  });
  it('ignores fixed-marker startup banners and accepts only the actual nonce-bound two-row discovery',()=> {
    const nonce='a'.repeat(32),prefix=`PHANTOM_DESKTOP_${nonce}_`;
    expect(parseConsumerShellTargets(`PHM=/synthetic/managed\nASHLR=/synthetic/managed\n${prefix}PHM=/synthetic/npm-global\n${prefix}ASHLR=\n`,nonce)).toEqual({phm:'/synthetic/npm-global',ashlr:null});
    expect(parseConsumerShellTargets(`${prefix}ASHLR=/synthetic/path with spaces\n${prefix}PHM=/synthetic/managed\n`,nonce)).toEqual({phm:'/synthetic/managed',ashlr:'/synthetic/path with spaces'});
  });
  it('refuses duplicate, missing, malformed, foreign-marker and oversized discovery without executing any target',()=> {
    const nonce='b'.repeat(32),prefix=`PHANTOM_DESKTOP_${nonce}_`,good=`${prefix}PHM=/synthetic/managed\n${prefix}ASHLR=/synthetic/managed\n`;
    for(const text of [good+`${prefix}PHM=/synthetic/global\n`,`${prefix}PHM=/synthetic/managed\n`,`${prefix}PHM=/synthetic/managed\n${prefix}PHM=/synthetic/global\n`,good.replace('ASHLR=/','ASHLR=relative/'),good.replace('ASHLR=/','ASHLR=\r/'),good.replace('ASHLR=/synthetic/managed\n','ASHLR=/synthetic/managed\r\n'),good.replaceAll(nonce,'c'.repeat(32)),good+'x'.repeat(16*1024)])expect(parseConsumerShellTargets(text,nonce)).toBeNull();
    expect(parseConsumerShellTargets(good,'invalid')).toBeNull();
  });
  it('refuses source-checkout bootstrap rather than building or accepting an unqualified package',()=> {
    expect(()=>createConsumerInstallDependencies()).toThrow('compiled-package-required');
  });
  it('downloads and stages original verified data but inspection changes no installation or Stop',async()=> {
    const f=fixture(),output=vi.fn();expect(await cmdDesktop(['install'],f.deps,output)).toBe(0);
    expect(output).toHaveBeenCalledWith(expect.objectContaining({state:'ready',installationAccepted:false,authorityResumed:false}));
    expect(f.io.renameExclusive).not.toHaveBeenCalled();expect(fs.existsSync(f.current)).toBe(false);expect(fs.existsSync(join(f.applications,'Phantom.app'))).toBe(false);
    expect(fs.readFileSync(join(f.home,'.ashlr/KILL'),'utf8')).toBe('');expect(fs.readdirSync(join(f.home,'.ashlr/updates/consumer-staging'))).toHaveLength(1);
    expect(JSON.stringify(output.mock.calls)).not.toContain(f.root);
  });
  it('installs the exact signed app and original CLI once; owned managed discovery is separate and Stop remains',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);expect(ready.state).toBe('ready');
    const applied=await applyConsumerDesktopInstall(ready);expect(applied).toMatchObject({state:'installed',installationAccepted:true,authorityResumed:false,reason:null,shell:[{name:'phm',state:'managed',version:f.version},{name:'ashlr',state:'managed',version:f.version}]});
    expect(fs.realpathSync(f.current)).toBe(join(f.home,'.local/share/ashlr/releases',f.manifest.source.revision));
    expect(fs.realpathSync(join(f.home,'.local/bin/phm'))).toBe(join(fs.realpathSync(f.current),'bin/ashlr'));
    expect(f.io.appInventory('/Applications/Phantom.app')).toBe(f.manifest.app.inventorySha256);
    expect(fs.existsSync(join(f.home,'.ashlr/KILL'))).toBe(true);
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'held',reason:'inspection-required'});
    expect(await applyConsumerDesktopInstall(JSON.parse(JSON.stringify(ready)))).toMatchObject({state:'held',reason:'inspection-required'});
    expect(f.io.exec.mock.calls.every(([bin,args]:[string,string[]])=>consumerInstallerOsCommand(bin,args))).toBe(true);
  });
  it('explicit apply uses a fresh inspection, and unavailable output cannot replay installation',async()=> {
    const f=fixture();expect(await cmdDesktop(['install','--apply'],f.deps,()=>{throw new Error('private sink');})).toBe(1);
    const stage=fs.readdirSync(f.applications).find(name=>name.startsWith('.phantom-install-'))!;expect(JSON.parse(fs.readFileSync(join(f.applications,stage,'transaction.json'),'utf8'))).toMatchObject({phase:'accepted'});expect(f.deps.download).toHaveBeenCalledTimes(3);
  });
  it('requires the exact managed CLI execution version independently of shell discovery',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);vi.mocked(f.deps.readManagedVersion).mockResolvedValue(null);
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'rollback-held',installationAccepted:false});expect(f.deps.discover).not.toHaveBeenCalled();
    const g=fixture(),other=await inspectConsumerDesktopInstall(g.deps);expect(await applyConsumerDesktopInstall(other)).toMatchObject({state:'installed'});
    expect(g.deps.readManagedVersion).toHaveBeenCalledWith(join(fs.realpathSync(g.current),'bin/ashlr'));
  });
  it('captures trust and selected identity before an asynchronous download',async()=> {
    const f=fixture(),download=f.deps.download;
    f.deps.download=vi.fn(async(url,max)=>{f.deps.home=join(f.root,'changed-home');f.deps.trust={...f.deps.trust,publicKey:'invalid replacement'};return download(url,max);});
    const ready=await inspectConsumerDesktopInstall(f.deps);expect(ready.state).toBe('ready');
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'installed'});expect(fs.existsSync(join(f.root,'changed-home'))).toBe(false);
  });
  it.each(['3.29.3','3.30.0'])('preserves an unmanaged global CLI when managed release is %s, without implying it tracks updates',async version=> {
    const f=fixture(version),global=join(f.root,'npm-global-phm');write(global,'unrelated global 3.29.3');
    f.deps.discover=vi.fn(async()=>[{name:'phm',target:global,version:'3.29.3',versionSource:'unknown'},{name:'ashlr',target:null,version:null,versionSource:'unknown'}]);
    expect(await applyConsumerDesktopInstall(await inspectConsumerDesktopInstall(f.deps))).toMatchObject({state:'installed',reason:'shell-setup-required',shell:[{name:'phm',state:'setup-required',version:null},{name:'ashlr',state:'setup-required',version:null}]});
    expect(fs.readFileSync(global,'utf8')).toBe('unrelated global 3.29.3');
  });
  it.each(['file','directory','reachable-link','dangling-link'])('never replaces a managed %s collision',async kind=> {
    const f=fixture(),alias=join(f.home,'.local/bin/phm');fs.mkdirSync(dirname(alias),{recursive:true,mode:0o700});
    if(kind==='file')write(alias,'unrelated managed collision');
    if(kind==='directory')fs.mkdirSync(alias);
    if(kind==='reachable-link') {const target=join(f.root,'global');write(target,'global');fs.symlinkSync(target,alias);}
    if(kind==='dangling-link')fs.symlinkSync('/absent',alias);
    const before=fs.lstatSync(alias);expect((await inspectConsumerDesktopInstall(f.deps)).state).toBe('held');
    const after=fs.lstatSync(alias);expect([after.dev,after.ino,after.mode]).toEqual([before.dev,before.ino,before.mode]);expect(f.io.renameExclusive).not.toHaveBeenCalled();
  });
  it('preserves existing user configuration and refuses a second first-install invocation',async()=> {
    const f=fixture(),config=join(f.home,'.ashlr/config.json'),bytes='{"fixture":"existing account settings"}';write(config,bytes);
    expect(await applyConsumerDesktopInstall(await inspectConsumerDesktopInstall(f.deps))).toMatchObject({state:'installed'});
    expect(fs.readFileSync(config,'utf8')).toBe(bytes);expect((await inspectConsumerDesktopInstall(f.deps)).state).toBe('held');
    expect(f.io.renameExclusive).toHaveBeenCalledTimes(1);
  });
  it.each(['missing-stop','unknown-lease','live-process','alias','current','app'] as const)('holds %s before private artifact staging or mutation',async kind=> {
    const f=fixture();
    if(kind==='missing-stop')fs.unlinkSync(join(f.home,'.ashlr/KILL'));
    if(kind==='unknown-lease')f.census.unknown=1;
    if(kind==='live-process')f.setLive(true);
    if(kind==='alias') {fs.mkdirSync(join(f.home,'.local/bin'),{recursive:true,mode:0o700});fs.symlinkSync('/absent',join(f.home,'.local/bin/phm'));}
    if(kind==='current') {fs.mkdirSync(dirname(f.current),{recursive:true,mode:0o700});fs.symlinkSync('/absent',f.current);}
    if(kind==='app')fs.cpSync(f.appRoot,join(f.applications,'Phantom.app'),{recursive:true});
    expect((await inspectConsumerDesktopInstall(f.deps)).state).toBe('held');expect(f.deps.download).toHaveBeenCalledTimes(1);expect(f.io.renameExclusive).not.toHaveBeenCalled();
  });
  it.each(['platform','signature','bytes','source','surface'] as const)('refuses unqualified %s evidence',async kind=> {
    const f=fixture();
    if(kind==='platform')f.deps.platform='linux';
    if(kind==='signature') {const url=[...f.published.keys()].find(key=>key.endsWith('latest.json'))!;const discovery=JSON.parse(f.published.get(url)!.toString());discovery.phantom.signature=signature(Buffer.from('wrong'));f.published.set(url,Buffer.from(JSON.stringify(discovery)));}
    if(kind==='bytes')f.published.set(f.manifest.cli.url,Buffer.from('wrong'));
    if(kind==='source') {f.manifest.source.revision='d'.repeat(40);f.publish();}
    if(kind==='surface') {f.manifest.authoritySurfaceDigest='d'.repeat(64);f.publish();}
    expect((await inspectConsumerDesktopInstall(f.deps)).state).toBe('held');expect(f.io.renameExclusive).not.toHaveBeenCalled();
  });
  it('rejects a correctly signed unsafe app archive rather than treating authentication as extraction permission',async()=> {
    const f=fixture(),unsafe=archive([{path:'Phantom.app/../../escape',data:'not permitted'}]);
    Object.assign(f.manifest.app,{bytes:unsafe.length,sha256:sha(unsafe),signature:signature(unsafe)});f.published.set(f.manifest.app.url,unsafe);f.publish();
    expect((await inspectConsumerDesktopInstall(f.deps)).state).toBe('held');expect(f.io.renameExclusive).not.toHaveBeenCalled();expect(fs.existsSync(join(f.root,'escape'))).toBe(false);
  });
  it('refuses changed Stop and newly occupied managed alias after an otherwise valid inspection',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);fs.unlinkSync(join(f.home,'.ashlr/KILL'));
    expect((await applyConsumerDesktopInstall(ready)).state).toBe('held');expect(f.io.renameExclusive).not.toHaveBeenCalled();
    const g=fixture(),other=await inspectConsumerDesktopInstall(g.deps);write(join(g.home,'.local/bin/phm'),'unrelated');
    expect((await applyConsumerDesktopInstall(other)).state).toBe('held');expect(fs.readFileSync(join(g.home,'.local/bin/phm'),'utf8')).toBe('unrelated');expect(g.io.renameExclusive).not.toHaveBeenCalled();
  });
  it('freshly refuses original stage drift and running-source drift at apply without moving any app',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);expect(ready.state).toBe('ready');
    const stage=join(f.home,'.ashlr/updates/consumer-staging',fs.readdirSync(join(f.home,'.ashlr/updates/consumer-staging'))[0]!);fs.appendFileSync(join(stage,'package.tgz'),'tamper');
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'held',reason:'unsafe-stage'});expect(f.io.renameExclusive).not.toHaveBeenCalled();
    const g=fixture(),other=await inspectConsumerDesktopInstall(g.deps);vi.mocked(g.deps.assertRunning).mockImplementation(()=>{throw new Error('private source changed');});expect((await applyConsumerDesktopInstall(other)).state).toBe('held');expect(g.io.renameExclusive).not.toHaveBeenCalled();
  });
  it('rechecks late app absence and holds instead of overwriting a newly appeared app',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);fs.cpSync(f.appRoot,join(f.applications,'Phantom.app'),{recursive:true});
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'held',reason:'existing-app'});expect(f.io.renameExclusive).not.toHaveBeenCalled();
  });
  it('holds a managed link appearing during slow app staging before the exclusive app move',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps),exec=f.io.exec;
    f.io.exec=(bin:string,args:string[])=>{const value=exec(bin,args);if(bin==='/usr/bin/ditto')write(join(f.home,'.local/bin/phm'),'late unrelated link');return value;};
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'rolled-back',installationAccepted:false});
    expect(f.io.renameExclusive).not.toHaveBeenCalled();expect(fs.readFileSync(join(f.home,'.local/bin/phm'),'utf8')).toBe('late unrelated link');expect(fs.existsSync(f.current)).toBe(false);
  });
  it('rolls a failed non-live launch back to absence, preserving original bytes and evidence',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);f.failOpen();
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'rolled-back',installationAccepted:false,authorityResumed:false});
    expect(fs.existsSync(f.current)).toBe(false);expect(fs.existsSync(join(f.applications,'Phantom.app'))).toBe(false);expect(fs.existsSync(join(f.home,'.local/bin/phm'))).toBe(false);
    const stage=fs.readdirSync(f.applications).find(name=>name.startsWith('.phantom-install-'))!;expect(fs.existsSync(join(f.applications,stage,'failed-bundle'))).toBe(true);
  });
  it('keeps a live failed replacement and pointer for normal Quit/recovery instead of killing or moving it',async()=> {
    const f=fixture(),ready=await inspectConsumerDesktopInstall(f.deps);f.setHealth(false);
    expect(await applyConsumerDesktopInstall(ready)).toMatchObject({state:'rollback-held',installationAccepted:false,authorityResumed:false});
    expect(fs.existsSync(f.current)).toBe(true);expect(fs.existsSync(join(f.applications,'Phantom.app'))).toBe(true);expect(f.io.renameExclusive).toHaveBeenCalledTimes(1);
  });
  it('rejects mutation/signing/elevation commands while retaining original verify/copy/read commands',()=> {
    for(const [bin,args] of [['/usr/bin/security',[]],['/usr/bin/sudo',[]],['/usr/bin/codesign',['--sign']],['/usr/bin/plutil',['-replace']],['/usr/bin/xattr',[]]])expect(consumerInstallerOsCommand(bin as string,args as string[])).toBe(false);
    expect(consumerInstallerOsCommand('/usr/bin/codesign',['--verify','--deep','--strict','-R=identifier "ai.ashlr.desktop" and certificate leaf = H"'+ 'F'.repeat(40)+'"','/synthetic/Phantom.app'])).toBe(true);
    expect(consumerInstallerOsCommand('/usr/bin/codesign',['--verify','--sign','private'])).toBe(false);
    expect(consumerInstallerOsCommand('/usr/bin/ditto',['-c','/synthetic.zip'])).toBe(false);
    expect(consumerInstallerOsCommand('/usr/bin/open',['https://untrusted.example'])).toBe(false);
  });
});

/** Real private files/parsers/transaction, with inert GitHub and macOS command ports. No live admission claim. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import * as fs from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {Header} from 'tar';
import {canonicalJson} from '../src/core/authority/canonical-json.js';
import {authoritySurfaceDigest,verifyAuthoritySurfaceAt} from '../src/core/authority/surface.js';
import {readPinnedRuntimeArchive,extractPinnedRuntimeArchive} from '../src/core/local-runtime/archive.js';
import {verifyUpdateManifest,verifyMinisign,verifyUpdateBundleRecord} from '../src/core/desktop/update-manifest.js';
import {inspectSignedAppArchive,extractSignedAppArchive,verifyInstalledRuntimeArchive} from '../src/core/desktop/qualified-update.js';
import {applyInspectedDesktopArtifacts,assertPairedHostedProof,inspectDesktopArtifactInstall,parseArtifactInstallArguments,readFinalizedDesktopArtifacts,verifyManualDesktopSource} from '../scripts/install-desktop-artifacts.mjs';
import type {UpdateManifest,UpdateTrust} from '../src/core/desktop/update-manifest.js';

const ports=vi.hoisted(()=>({verify:vi.fn(),audit:vi.fn(),source:vi.fn(),createIo:vi.fn(),spawn:vi.fn()}));
vi.mock('../scripts/hosted-build-artifact.mjs',async actual=>({...await actual<any>(),verifyArtifact:ports.verify,sourceBinding:ports.source}));
vi.mock('../scripts/finalize-desktop-update.mjs',async actual=>({...await actual<any>(),verifyUpdateAudit:ports.audit}));
vi.mock('../scripts/local-app-transaction.mjs',async actual=>({...await actual<any>(),createLocalAppTransactionIo:ports.createIo}));
vi.mock('node:child_process',async actual=>({...await actual<any>(),spawnSync:ports.spawn}));
const originalTransaction=await vi.importActual<any>('../scripts/local-app-transaction.mjs');
const roots:string[]=[];
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const keyId=Buffer.from('0102030405060708','hex');
const key=Buffer.from(`untrusted comment: disposable fixture key\n${Buffer.concat([Buffer.from('Ed'),keyId,publicKey.export({format:'der',type:'spki'}).subarray(-32)]).toString('base64')}\n`).toString('base64');
function signature(data:Uint8Array) {
  const s=sign(null,createHash('blake2b512').update(data).digest(),privateKey),comment='inert test fixture only';
  return Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from('ED'),keyId,s]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null,Buffer.concat([s,Buffer.from(comment)]),privateKey).toString('base64')}\n`).toString('base64');
}
const trust:UpdateTrust={publicKey:key,repository:{fullName:'ashlrai/ashlr-hub',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerLogin:'ashlrai',ownerId:258113726,ownerNodeId:'O_kgDOD2KAvg'},channel:'stable',platform:'darwin-aarch64'};
function tar(rows:{path:string;data:Buffer|string;mode?:number;directory?:boolean}[]) {
  const parts:Buffer[]=[];
  for(const row of rows) {
    const data=Buffer.from(row.data);const h=new Header({path:row.path,type:row.directory?'Directory':'File',size:data.length,mode:row.mode??0o644,uid:0,gid:0,mtime:new Date(0)});
    h.encode();parts.push(h.block!,data,Buffer.alloc((512-data.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]));
}
function write(path:string,data:Buffer|string,mode=0o600) {fs.mkdirSync(dirname(path),{recursive:true,mode:0o700});fs.writeFileSync(path,data,{mode});fs.chmodSync(path,mode);}
function fileIdentity(path:string) {const s=fs.lstatSync(path);return {dev:s.dev,ino:s.ino,ctimeMs:s.ctimeMs,mode:s.mode};}
beforeEach(()=>{for(const spy of Object.values(ports))spy.mockReset();});
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function fixture() {
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'artifact-installer-')));fs.chmodSync(root,0o700);roots.push(root);
  const home=join(root,'home'),artifacts=join(root,'paired'),candidateRoot=join(root,'candidate'),bundle=join(root,'bundle');
  for(const path of [home,artifacts,candidateRoot,bundle])fs.mkdirSync(path,{mode:0o700});
  const revision='b'.repeat(40),tree='c'.repeat(40),version='3.25.2';
  const code=Buffer.from('throw new Error("candidate helpers must never execute");');
  const core={v:1 as const,roots:['dist/core/authority/fixture.js'],missingRoots:[],files:[{path:'dist/core/authority/fixture.js',sha256:hash(code),bytes:code.length}],packages:[],unresolved:[]};
  const surface={...core,digest:authoritySurfaceDigest(core)};
  const launcher=fs.readFileSync(resolve(import.meta.dirname,'../bin/ashlr'));
  const cli=tar([
    {path:'package/package.json',data:JSON.stringify({name:'@ashlr/hub',version,type:'module',bin:{ashlr:'bin/ashlr',phm:'bin/ashlr'}})},
    {path:'package/bin/ashlr',data:launcher,mode:0o755},
    {path:'package/dist/build-identity.json',data:JSON.stringify({schemaVersion:1,packageVersion:version,revision,dirty:false,provenance:'git'})},
    {path:'package/dist/cli/index.js',data:code},{path:'package/dist/core/universe/index.js',data:code},
    {path:'package/dist/core/authority/fixture.js',data:code},{path:'package/dist/authority-surface.json',data:JSON.stringify(surface)},
  ]);
  const make=(filename:string,data:Buffer)=>({filename,url:`https://github.com/ashlrai/ashlr-hub/releases/download/v${version}/${filename}`,bytes:data.length,sha256:hash(data),signature:signature(data)});
  const m:UpdateManifest={schemaVersion:1,kind:'phantom-paired-release',channel:'stable',platform:'darwin-aarch64',version,
    repository:{nameWithOwner:'ashlrai/ashlr-hub',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerId:258113726,ownerLogin:'ashlrai',defaultBranch:'master'},source:{revision,tree},authoritySurfaceDigest:surface.digest,
    cli:{...make(`ashlr-hub-${version}.tgz`,cli),packageName:'@ashlr/hub',binName:'ashlr'},
    app:{...make(`Phantom_${version}_aarch64.app.tar.gz`,Buffer.from('pending')),bundleIdentifier:'ai.ashlr.desktop',executable:'ashlr-desktop',inventorySha256:'e'.repeat(64),signer:'F'.repeat(40)},
    qualification:{manifestSha256:'0'.repeat(64),archiveSha256:'1'.repeat(64),packageSha256:hash(cli),qualificationSha256:'2'.repeat(64),producer:{runId:10,runAttempt:1,eventSha:revision},attestor:{revision:'a'.repeat(40),runId:20,runAttempt:1},audit:{revision,runId:30,runAttempt:1}}};
  const marker=canonicalJson({schemaVersion:1,version,source:m.source,authoritySurfaceDigest:m.authoritySurfaceDigest,packageSha256:m.cli.sha256});
  const appRows=[...['Phantom.app','Phantom.app/Contents','Phantom.app/Contents/MacOS','Phantom.app/Contents/Resources'].map(path=>({path,data:'',mode:0o755,directory:true})),
    {path:'Phantom.app/Contents/Info.plist',data:JSON.stringify({CFBundleName:'Phantom',CFBundleDisplayName:'Phantom',CFBundleIdentifier:'ai.ashlr.desktop',CFBundleExecutable:'ashlr-desktop',CFBundleShortVersionString:version,CFBundleVersion:version})},
    {path:'Phantom.app/Contents/MacOS/ashlr-desktop',data:code,mode:0o755},{path:'Phantom.app/Contents/MacOS/ashlr',data:code,mode:0o755},
    {path:'Phantom.app/Contents/Resources/phantom-release.json',data:marker}];
  const app=tar(appRows);Object.assign(m.app,make(m.app.filename,app));
  const source=fs.mkdtempSync(join(root,'source-app-'));fs.chmodSync(source,0o700);
  const appRoot=extractSignedAppArchive(app,source);
  const base=originalTransaction.createLocalAppTransactionIo({packageRoot:resolve(import.meta.dirname,'..'),home});
  m.app.inventorySha256=base.appInventory(appRoot);
  const publish=()=> {
    const manifestText=canonicalJson(m),s=signature(Buffer.from(manifestText));
    write(join(artifacts,'manifest.json'),manifestText);write(join(artifacts,'manifest.json.sig'),s,0o644);
    write(join(artifacts,'latest.json'),canonicalJson({version,platforms:{'darwin-aarch64':{url:m.app.url,signature:m.app.signature}},phantom:{manifestText,signature:s}}));
  };
  for(const [a,data] of [[m.app,app],[m.cli,cli]] as const){write(join(artifacts,a.filename),data);write(join(artifacts,a.filename+'.sig'),a.signature,0o644);}
  fs.mkdirSync(join(artifacts,'tools'),{mode:0o700});fs.symlinkSync('/not/a/trusted/executable',join(artifacts,'tools','node'));publish();
  write(join(bundle,m.cli.filename),cli,0o644);
  const proof={source:m.source,manifestSha256:m.qualification.manifestSha256,archiveSha256:m.qualification.archiveSha256,packageSha256:m.cli.sha256,qualificationSha256:m.qualification.qualificationSha256,
    official:m.qualification.producer,attestor:m.qualification.attestor};
  ports.verify.mockImplementation(()=>structuredClone(proof));ports.audit.mockImplementation(()=>structuredClone(m.qualification.audit));
  ports.source.mockImplementation(()=>({revision,tree,tracked:[],inputs:[]}));
  const initialImplementation={source:'exact independently qualified installer',build:'fixed compiled snapshot'};
  const implementationSnapshot=vi.fn(async()=>structuredClone(initialImplementation));
  const primitives={verifyUpdateManifest,verifyMinisign,verifyUpdateBundleRecord,inspectSignedAppArchive,extractSignedAppArchive,verifyInstalledRuntimeArchive,readPinnedRuntimeArchive,extractPinnedRuntimeArchive,verifyAuthoritySurfaceAt,trust,appleSigner:m.app.signer};
  const deps={home,environment:{HOME:home,PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'},primitives,implementationSnapshot,initialImplementation,
    transport:{githubRead:vi.fn(()=>{throw new Error('live network forbidden');}),attestRun:vi.fn(()=>{throw new Error('live network forbidden');})}};
  const oldRevision='a'.repeat(40),old=join(home,'.local/share/ashlr/releases',oldRevision),current=join(home,'.local/share/ashlr/current');
  write(join(old,'package.json'),JSON.stringify({name:'@ashlr/hub',version:'3.25.1'}),0o644);write(join(old,'bin/ashlr'),launcher,0o755);
  write(join(old,'dist/build-identity.json'),JSON.stringify({schemaVersion:1,provenance:'git',dirty:false,revision:oldRevision,packageVersion:'3.25.1'}),0o644);
  fs.symlinkSync(old,current);write(join(home,'.ashlr/KILL'),'');
  const applications=join(root,'Applications');fs.mkdirSync(applications,{mode:0o700});fs.cpSync(appRoot,join(applications,'Phantom.app'),{recursive:true,preserveTimestamps:true});
  const oldPlist=join(applications,'Phantom.app/Contents/Info.plist'),oldContents=JSON.parse(fs.readFileSync(oldPlist,'utf8'));oldContents.CFBundleVersion='3.25.1';oldContents.CFBundleShortVersionString='3.25.1';write(oldPlist,JSON.stringify(oldContents),0o644);
  const retained=join(applications,'.phantom-install-existing-held');write(join(retained,'transaction.json'),'old HELD evidence');write(join(retained,'previous-app.zip'),'old full backup');
  let now=0,live=false,health=true;const census={leases:[] as unknown[],unknown:0,reaped:0};
  const mapped=(path:string)=>path.startsWith('/Applications/')?join(applications,path.slice('/Applications/'.length)):path;
  const io={...base,platform:'darwin',clock:()=>now,sleep:async(ms:number)=>{now+=ms;},fetchStatus:vi.fn(async()=>health?200:503),log:vi.fn(),executionLeaseCensus:vi.fn(async()=>census)};
  for(const name of ['lstat','exists','appInventory','readBoundedFile']){const method=base[name].bind(base);io[name]=(path:string,...args:any[])=>method(mapped(path),...args);}
  const stages=new Map<string,ReturnType<typeof fileIdentity>>();
  io.makeInstallStage=()=>{const actual=fs.mkdtempSync(join(applications,'.phantom-install-')),logical='/Applications/'+basename(actual);stages.set(logical,fileIdentity(actual));return logical;};
  io.writeInstallJournal=(owner:string,value:unknown)=>{expect(fileIdentity(mapped(owner))).toMatchObject({dev:stages.get(owner)!.dev,ino:stages.get(owner)!.ino});write(join(mapped(owner),'transaction.json'),JSON.stringify(value));};
  io.renameExclusive=(from:string,to:string,expected:any)=>{const s=fs.lstatSync(mapped(from));expect({dev:s.dev,ino:s.ino}).toEqual({dev:expected.dev,ino:expected.ino});expect(fs.existsSync(mapped(to))).toBe(false);fs.renameSync(mapped(from),mapped(to));};
  io.removeInstallTree=(path:string,owner:string)=>{expect(dirname(path)).toBe(owner);expect(stages.has(owner)).toBe(true);fs.rmSync(mapped(path),{recursive:true,force:true});};
  ports.createIo.mockReturnValue(io);
  const archives=new Map<string,string>();
  ports.spawn.mockImplementation((bin:string,args:string[],options:any)=> {
    if(bin==='/usr/bin/python3'){
      expect(args.slice(0,3)).toEqual(['-I','-S','-c']);expect(args.at(-1)).toBe('check');
      expect(options.env).toEqual({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});return {status:0,stdout:''};
    }
    expect(options.env).toEqual(deps.environment);
    if(bin==='/usr/bin/plutil')return {status:0,stdout:JSON.parse(fs.readFileSync(mapped(args.at(-1)!),'utf8'))[args[1]]+'\n'};
    if(bin==='/usr/bin/codesign'){expect(args[0]).toBe('--verify');return {status:0,stdout:''};}
    if(bin==='/usr/bin/ditto') {
      if(args[0]==='-c'){const source=args.at(-2)!,archive=args.at(-1)!,saved=fs.mkdtempSync(join(root,'archive-copy-'));fs.cpSync(mapped(source),join(saved,basename(source)),{recursive:true,preserveTimestamps:true});archives.set(archive,saved);write(mapped(archive),'inert macOS zip port');}
      else if(args[0]==='-x'){fs.mkdirSync(mapped(args.at(-1)!),{mode:0o700});fs.cpSync(archives.get(args[2])!,mapped(args.at(-1)!),{recursive:true,preserveTimestamps:true});}
      else fs.cpSync(mapped(args[0]),mapped(args[1]),{recursive:true,preserveTimestamps:true});
      return {status:0,stdout:''};
    }
    if(bin==='/usr/bin/open') {live=true;write(join(home,'.ashlr/.desktop-sidecar.json'),JSON.stringify({desktopPid:100,sidecarPid:101,port:7777,sidecarPath:'/Applications/Phantom.app/Contents/MacOS/ashlr'}));return {status:0,stdout:''};}
    if(bin==='/bin/ps')return {status:0,stdout:live?'100 1 Thu Oct 8 00:00:00 2026 /Applications/Phantom.app/Contents/MacOS/ashlr-desktop\n101 100 Thu Oct 8 00:00:00 2026 /Applications/Phantom.app/Contents/MacOS/ashlr verse --port 7777 --no-open --json\n':''};
    if(bin==='/usr/sbin/lsof')return {status:0,stdout:health?'p101\nf8\n':'p999\nf8\n'};
    throw new Error(`unexpected inert command ${bin}`);
  });
  return {root,home,artifacts,candidateRoot,bundle,input:{candidateRoot,bundle,artifacts,apply:false},deps,m,cli,app,publish,proof,io,census,current,old,applications,retained,stages,setLive:(v:boolean)=>{live=v;},setHealth:(v:boolean)=>{health=v;}};
}

describe.skipIf(process.platform==='win32')('manual original paired artifact installer',()=> {
  it('requires exact data-directory flags and explicit apply, without URL/tool/proof overrides',()=> {
    expect(parseArtifactInstallArguments(['--candidate-source','/a','--bundle','/b','--artifacts','/c'])).toEqual({candidateRoot:'/a',bundle:'/b',artifacts:'/c',apply:false});
    expect(parseArtifactInstallArguments(['--apply','--candidate-source','/a','--bundle','/b','--artifacts','/c']).apply).toBe(true);
    for(const args of [['--force'],['--proof','/fake'],['--candidate-source','relative'],['--candidate-source','/a','--bundle','/a','--artifacts','/c'],['--apply','--apply']])expect(()=>parseArtifactInstallArguments(args)).toThrow();
  });
  it('uses direct normal verifier/Audit forwarding of signed run/source policy, not caller proof',()=> {
    const f=fixture();verifyManualDesktopSource({...f.input,policy:{runId:999},receipt:f.proof},f.m,f.deps.transport);
    expect(ports.verify).toHaveBeenCalledWith({root:f.candidateRoot,revision:f.m.source.revision,bundle:f.bundle,policy:{runId:10,runAttempt:1,attestorSha:'a'.repeat(40),attestorRun:20,attestorAttempt:1},githubRead:f.deps.transport.githubRead,attestRun:f.deps.transport.attestRun});
    expect(ports.audit).toHaveBeenCalledWith({root:f.candidateRoot,repository:'ashlrai/ashlr-hub',revision:f.m.source.revision,runId:30,runAttempt:1,read:f.deps.transport.githubRead});
  });
  it('default inspection verifies real signatures/archive/resource with public signature modes and unused tools, without stages/census or candidate execution',async()=> {
    const f=fixture(),before=fs.readdirSync(f.home).sort(),inputs=fs.readdirSync(f.artifacts).map(n=>[n,fileIdentity(join(f.artifacts,n))]);
    expect(await inspectDesktopArtifactInstall(f.input,f.deps)).toMatchObject({state:'verified-artifacts',version:'3.25.2',installationPerformed:false,authorityResumed:false});
    expect(ports.createIo).not.toHaveBeenCalled();expect(f.io.executionLeaseCensus).not.toHaveBeenCalled();expect(ports.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.home).sort()).toEqual(before);expect(fs.readdirSync(f.artifacts).map(n=>[n,fileIdentity(join(f.artifacts,n))])).toEqual(inputs);
  });
  it.each(['manifest','archive','qualification','package','producer','attestor','audit','source'])('refuses mixed %s proof before IO',async kind=> {
    const f=fixture(),p=structuredClone(f.proof);
    if(kind==='producer')p.official.runId++;else if(kind==='attestor')p.attestor.runId++;else if(kind==='audit')ports.audit.mockReturnValue({...f.m.qualification.audit,runId:99});else if(kind==='source')p.source={...p.source,tree:'f'.repeat(40)};else p[`${kind}Sha256` as keyof typeof p]='f'.repeat(64) as never;
    ports.verify.mockReturnValue(p);await expect(inspectDesktopArtifactInstall(f.input,f.deps)).rejects.toThrow();expect(ports.createIo).not.toHaveBeenCalled();
  });
  it.each(['signature','app-byte','cli-byte','latest','extra','leaf-link','hardlink','writable-signature','ancestor-link'])('refuses %s finalized input without any installation',async kind=> {
    const f=fixture();
    if(kind==='signature')write(join(f.artifacts,'manifest.json.sig'),signature(Buffer.from('wrong')),0o644);
    if(kind==='app-byte')write(join(f.artifacts,f.m.app.filename),'wrong');
    if(kind==='cli-byte')write(join(f.artifacts,f.m.cli.filename),'wrong');
    if(kind==='latest')write(join(f.artifacts,'latest.json'),'{}');
    if(kind==='extra')write(join(f.artifacts,'extra.json'),'{}');
    if(kind==='leaf-link'){fs.renameSync(join(f.artifacts,f.m.cli.filename),join(f.root,'original'));fs.symlinkSync(join(f.root,'original'),join(f.artifacts,f.m.cli.filename));}
    if(kind==='hardlink')fs.linkSync(join(f.artifacts,'manifest.json'),join(f.root,'another-link'));
    if(kind==='writable-signature')fs.chmodSync(join(f.artifacts,'manifest.json.sig'),0o666);
    if(kind==='ancestor-link'){fs.renameSync(f.artifacts,f.artifacts+'-real');fs.symlinkSync(f.artifacts+'-real',f.artifacts);}
    await expect(inspectDesktopArtifactInstall(f.input,f.deps)).rejects.toThrow();expect(ports.createIo).not.toHaveBeenCalled();
  });
  it('rejects reused/saved admission and an implementation change after imported code was captured',async()=> {
    const f=fixture(),r=await inspectDesktopArtifactInstall(f.input,f.deps);
    await expect(applyInspectedDesktopArtifacts(JSON.parse(JSON.stringify(r)))).rejects.toThrow(/in-process/);
    f.deps.implementationSnapshot.mockResolvedValue({source:'changed',build:'fixed compiled snapshot'});
    await expect(inspectDesktopArtifactInstall(f.input,f.deps)).rejects.toThrow(/compiled imports/);
  });
  it.each(['stop','active-lease','unknown-lease','native','alias','old-version'])('refuses %s preflight before creating a release/journal',async kind=> {
    const f=fixture(),r=await inspectDesktopArtifactInstall(f.input,f.deps);
    if(kind==='stop')fs.unlinkSync(join(f.home,'.ashlr/KILL'));
    if(kind==='active-lease')f.census.leases.push({runId:'held'});
    if(kind==='unknown-lease')f.census.unknown=1;
    if(kind==='native')f.setLive(true);
    if(kind==='alias')write(join(f.home,'.local/bin/phm'),'unrelated user file');
    if(kind==='old-version'){
      write(join(f.old,'package.json'),JSON.stringify({name:'@ashlr/hub',version:'3.25.3'}));
      write(join(f.old,'dist/build-identity.json'),JSON.stringify({schemaVersion:1,provenance:'git',dirty:false,revision:'a'.repeat(40),packageVersion:'3.25.3'}),0o644);
    }
    await expect(applyInspectedDesktopArtifacts(r)).rejects.toThrow();expect(f.stages.size).toBe(0);expect(fs.existsSync(join(f.home,'.local/share/ashlr/releases',f.m.source.revision))).toBe(false);
  });
  it('runs the real preserveSigned transaction on inert macOS ports and original bytes, with four fresh proofs and actual owned health',async()=> {
    const f=fixture(),held=fs.readFileSync(join(f.retained,'transaction.json')),r=await inspectDesktopArtifactInstall(f.input,f.deps);
    expect(await applyInspectedDesktopArtifacts(r)).toMatchObject({state:'installed',installationPerformed:true,authorityResumed:false,requiresOperatorAuthorityReview:true});
    const destination=join(f.home,'.local/share/ashlr/releases',f.m.source.revision);
    expect(fs.readlinkSync(f.current)).toBe(destination);await verifyInstalledRuntimeArchive(destination,{artifactPath:join(f.artifacts,f.m.cli.filename),sha256:f.m.cli.sha256,revision:f.m.source.revision,version:f.m.version});
    expect(fs.readlinkSync(join(f.home,'.local/bin/phm'))).toBe(join(f.current,'bin/ashlr'));expect(fs.readlinkSync(join(f.home,'.local/bin/ashlr'))).toBe(join(f.current,'bin/ashlr'));
    expect(ports.verify).toHaveBeenCalledTimes(4);expect(fs.readFileSync(join(f.retained,'transaction.json'))).toEqual(held);expect(fs.existsSync(join(f.home,'.ashlr/KILL'))).toBe(true);
    expect(ports.spawn.mock.calls.every(([bin,args])=>!['npm','cargo','node','bun'].includes(bin) && !(bin==='/usr/bin/codesign' && args[0]!=='--verify') && !(bin==='/usr/bin/plutil' && args[0]!=='-extract'))).toBe(true);
    await expect(applyInspectedDesktopArtifacts(r)).rejects.toThrow(/replayed/);
  });
  it.each([3,4])('refuses actual candidate byte mutation during late proof%d, restores old app/current and preserves held evidence',async contact=> {
    const f=fixture(),r=await inspectDesktopArtifactInstall(f.input,f.deps),oldApp=f.io.appInventory('/Applications/Phantom.app');
    const original=ports.verify.getMockImplementation()!;ports.verify.mockImplementation((...args)=>{if(ports.verify.mock.calls.length===contact)write(join(f.home,'.local/share/ashlr/releases',f.m.source.revision,'dist/core/authority/fixture.js'),'changed');return original(...args);});
    await expect(applyInspectedDesktopArtifacts(r)).rejects.toThrow();expect(fs.readlinkSync(f.current)).toBe(f.old);expect(f.io.appInventory('/Applications/Phantom.app')).toBe(oldApp);
    expect([...f.stages.keys()].map(owner=>JSON.parse(fs.readFileSync(join(f.applications,basename(owner),'transaction.json'),'utf8')).phase)).toEqual(['rolled-back']);
    expect(fs.readFileSync(join(f.retained,'transaction.json'),'utf8')).toBe('old HELD evidence');
  });
  it('holds a failed live replacement without falsely restoring current/app or changing older HELD history',async()=> {
    const f=fixture(),r=await inspectDesktopArtifactInstall(f.input,f.deps);f.setHealth(false);
    await expect(applyInspectedDesktopArtifacts(r)).rejects.toThrow();
    expect([...f.stages.keys()].map(owner=>JSON.parse(fs.readFileSync(join(f.applications,basename(owner),'transaction.json'),'utf8')).phase)).toEqual(['rollback-held']);
    expect(fs.readFileSync(join(f.retained,'transaction.json'),'utf8')).toBe('old HELD evidence');
  });
  it('refuses same-byte replacement after inspect and source/implementation drift before staging',async()=> {
    for(const change of ['same-bytes','candidate-source','implementation']) {
      const f=fixture(),r=await inspectDesktopArtifactInstall(f.input,f.deps);
      if(change==='same-bytes'){fs.renameSync(join(f.bundle,f.m.cli.filename),join(f.root,'retained-original.tgz'));write(join(f.bundle,f.m.cli.filename),f.cli,0o644);}
      if(change==='candidate-source')ports.source.mockReturnValue({revision:f.m.source.revision,tree:f.m.source.tree,tracked:[{changed:true}],inputs:[]});
      if(change==='implementation')f.deps.implementationSnapshot.mockResolvedValue({source:'changed',build:'fixed compiled snapshot'});
      await expect(applyInspectedDesktopArtifacts(r)).rejects.toThrow();expect(f.stages.size).toBe(0);
    }
  });
  it('bounded extractor refuses nonempty/link destinations and original package verifier rejects added members and modes',async()=> {
    const f=fixture(),dest=join(f.root,'extract');fs.mkdirSync(dest,{mode:0o700});write(join(dest,'foreign'),'leave alone');
    expect(()=>extractSignedAppArchive(f.app,dest)).toThrow(/destination/);expect(fs.readFileSync(join(dest,'foreign'),'utf8')).toBe('leave alone');
    const archive=await readPinnedRuntimeArchive({artifactPath:join(f.artifacts,f.m.cli.filename),sha256:f.m.cli.sha256,revision:f.m.source.revision,version:f.m.version});
    const pkg=join(f.root,'package');fs.mkdirSync(pkg,{mode:0o700});extractPinnedRuntimeArchive(archive,pkg);
    const pins={artifactPath:join(f.artifacts,f.m.cli.filename),sha256:f.m.cli.sha256,revision:f.m.source.revision,version:f.m.version};await verifyInstalledRuntimeArchive(pkg,pins);
    write(join(pkg,'extra'),'not in original');await expect(verifyInstalledRuntimeArchive(pkg,pins)).rejects.toThrow();fs.unlinkSync(join(pkg,'extra'));
    fs.chmodSync(join(pkg,'bin/ashlr'),0o600);await expect(verifyInstalledRuntimeArchive(pkg,pins)).rejects.toThrow();
    expect(()=>assertPairedHostedProof(f.m,JSON.parse(JSON.stringify({...f.proof,source:{revision:'e'.repeat(40),tree:f.m.source.tree}})),f.m.qualification.audit)).toThrow();
    await readFinalizedDesktopArtifacts(f.artifacts,f.deps.primitives);
  });
});

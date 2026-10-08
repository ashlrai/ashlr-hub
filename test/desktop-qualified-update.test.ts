import { cmdDesktopUpdate } from '../src/cli/desktop-update.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Header, type HeaderData } from 'tar';
import { canonicalJson } from '../src/core/authority/canonical-json.js';
import { applyQualifiedDesktopUpdate, desktopUpdateStagePath, downloadQualifiedUpdateArtifact,
  inspectQualifiedDesktopUpdate, inspectSignedAppArchive, readQualifiedDesktopUpdateResult,
  loadInstalledDesktopTransaction,
  type DesktopUpdateDependencies, type UpdateAdmission } from '../src/core/desktop/qualified-update.js';
import { authoritySurfaceDigest } from '../src/core/authority/surface.js';
import * as authoritySurface from '../src/core/authority/surface.js';
import {getDesktopUpdateProfile, type DesktopUpdateProfileName, type CompatibleUpdateManifest, type UpdateTrust } from '../src/core/desktop/update-manifest.js';

const roots: string[] = [];
afterEach(() => {vi.unstubAllGlobals(); for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true});});
const {publicKey,privateKey} = generateKeyPairSync('ed25519'); const keyId = Buffer.from('1122334455667788','hex');
const key = Buffer.from(`untrusted comment: ephemeral test key\n${Buffer.concat([Buffer.from('Ed'),keyId,publicKey.export({format:'der',type:'spki'}).subarray(-32)]).toString('base64')}\n`).toString('base64');
function signature(data: Uint8Array): string {
  const signed = sign(null, createHash('blake2b512').update(data).digest(), privateKey), comment = 'test-only';
  return Buffer.from(`untrusted comment: test\n${Buffer.concat([Buffer.from('ED'),keyId,signed]).toString('base64')}\ntrusted comment: ${comment}\n${sign(null,Buffer.concat([signed,Buffer.from(comment)]),privateKey).toString('base64')}\n`).toString('base64');
}
const trust: UpdateTrust = {publicKey:key,repository:{fullName:'ashlrai/ashlr-hub',repositoryId:1263526319,repositoryNodeId:'R_kgDOS0_hrw',ownerLogin:'ashlrai',ownerId:258113726,ownerNodeId:'O_kgDOD2KAvg'},channel:'stable',platform:'darwin-aarch64'};
function tar(rows: {path:string;data?:string;type?:HeaderData['type'];mode?:number;linkpath?:string}[]): Buffer {
  const parts:Buffer[]=[];
  for (const row of rows) {
    const data=Buffer.from(row.data??'');const header=new Header({path:row.path,type:row.type??'File',size:data.length,mode:row.mode??0o644,uid:0,gid:0,mtime:new Date(0),linkpath:row.linkpath});
    header.encode();parts.push(header.block!,data,Buffer.alloc((512-data.length%512)%512));
  }
  return gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]));
}
const files = ['Phantom.app/Contents/Info.plist','Phantom.app/Contents/MacOS/ashlr-desktop','Phantom.app/Contents/MacOS/ashlr'];
function fixture(profileName: DesktopUpdateProfileName = 'legacy-v1', currentRoot?: string, version = '3.25.1') {
  const profile = getDesktopUpdateProfile(profileName);
  const home=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'update-consumer-')));roots.push(home);fs.chmodSync(home,0o700);
  const current=currentRoot ?? join(home,'current-release');
  if (!currentRoot) {
    fs.mkdirSync(join(current,'dist'),{recursive:true,mode:0o700});
    fs.writeFileSync(join(current,'dist/build-identity.json'),JSON.stringify({schemaVersion:1,packageVersion:'3.25.0',revision:'a'.repeat(40),dirty:false,provenance:'git'}),{mode:0o600});
    fs.writeFileSync(join(current,'package.json'),JSON.stringify({name:'@ashlr/hub',version:'3.25.0',type:'module',bin:{ashlr:'bin/ashlr'}}),{mode:0o600});
  }
  const id='a'.repeat(32);const stage=desktopUpdateStagePath(home,id);fs.mkdirSync(stage,{recursive:true,mode:0o700});
  const cli=Buffer.from('signed test package'); const hash=createHash('sha256').update(cli).digest('hex');
  const make=(filename:string)=>({filename,url:`https://github.com/${profile.repository}/releases/download/v${version}/${filename}`,bytes:cli.length,sha256:hash,signature:signature(cli)});
  const manifest={schemaVersion:profile.schemaVersion,kind:'phantom-paired-release',channel:'stable',platform:'darwin-aarch64',version,
    repository:{nameWithOwner:profile.repository,repositoryId:trust.repository.repositoryId,repositoryNodeId:trust.repository.repositoryNodeId,ownerId:trust.repository.ownerId,ownerLogin:'ashlrai',defaultBranch:'master'},
    source:{revision:'b'.repeat(40),tree:'c'.repeat(40)},authoritySurfaceDigest:'d'.repeat(64),
    app:{...make(`Phantom_${version}_aarch64.app.tar.gz`),bundleIdentifier:'ai.ashlr.desktop',executable:'ashlr-desktop',inventorySha256:'e'.repeat(64),signer:'F'.repeat(40)},
    cli:{...make(`${profile.archivePrefix}-${version}.tgz`),packageName:profile.packageName,binName:'ashlr'},
    qualification:{manifestSha256:'0'.repeat(64),archiveSha256:'1'.repeat(64),packageSha256:hash,qualificationSha256:'2'.repeat(64),producer:{runId:1,runAttempt:1,eventSha:'b'.repeat(40)},attestor:{revision:'b'.repeat(40),runId:2,runAttempt:1},audit:{revision:'b'.repeat(40),runId:3,runAttempt:1}}} as CompatibleUpdateManifest;
  const record=canonicalJson({schemaVersion:1,version,source:manifest.source,authoritySurfaceDigest:manifest.authoritySurfaceDigest,packageSha256:hash});
  const app=tar([...files.map(path=>({path,data:'signed test bytes'})),{path:'Phantom.app/Contents/Resources/phantom-release.json',data:record}]);
  manifest.app.bytes=app.length;manifest.app.sha256=createHash('sha256').update(app).digest('hex');manifest.app.signature=signature(app);
  function publish() {const text=canonicalJson(manifest);fs.writeFileSync(join(stage,'manifest.json'),text,{mode:0o600});fs.writeFileSync(join(stage,'manifest.sig'),signature(Buffer.from(text)),{mode:0o600});}
  publish();fs.writeFileSync(join(stage,'app.tar.gz'),app,{mode:0o600});
  const admission:UpdateAdmission={grantId:'valid-test-grant',envelopeDigest:'3'.repeat(64),surfaceDigest:manifest.authoritySurfaceDigest,active:true,stop:true,leaseCount:0,unknownLeases:0};
  const parent={pid:123,ppid:1,started:'Wed Oct 7 12:00:00 2026',executable:'/Applications/Phantom.app/Contents/MacOS/ashlr-desktop'};
  let now=0;const deps:DesktopUpdateDependencies={home,platform:'darwin',architecture:'arm64',packageRoot:current,trust,
    admission:()=>({...admission}),currentPackageRoot:()=>current,captureParent:()=>parent,verifyParent:async()=>true,parentState:()=> 'gone',
    now:()=>now,sleep:async(ms)=>{now+=ms;},download:async()=>{throw new Error('network forbidden');}};
  return {home,id,stage,app,manifest,publish,admission,parent,deps};
}

describe.skipIf(process.platform === 'win32')('signed paired installed update admission',()=>{
  it('inspects a signed private stage without downloading, changing Stop or running tools',()=>{
    const f=fixture();const download=vi.fn(f.deps.download);
    expect(inspectQualifiedDesktopUpdate(f.id,{...f.deps,download})).toMatchObject({state:'ready',version:'3.25.1',requiresReapproval:false});
    expect(download).not.toHaveBeenCalled();expect(fs.readdirSync(f.stage).sort()).toEqual(['app.tar.gz','manifest.json','manifest.sig']);
  });
  it.each(['../other','A'.repeat(32),'a'.repeat(31),'a'.repeat(33)])('refuses nonopaque stage %s', id=>{
    const f=fixture();expect(inspectQualifiedDesktopUpdate(id,f.deps).state).toBe('blocked');
  });
  it.each(['trust','platform','arch','source'])('refuses unavailable %s installed boundaries',kind=>{
    const f=fixture();const deps={...f.deps};if(kind==='trust')deps.trust=null;if(kind==='platform')deps.platform='linux';if(kind==='arch')deps.architecture='x64';if(kind==='source')deps.packageRoot=null;
    expect(inspectQualifiedDesktopUpdate(f.id,deps).state).toBe('blocked');
  });
  it.each(['ancestor-link','leaf-link','hardlink','public-mode','wrong-signature','changed-app'])('refuses %s without installation',kind=>{
    const f=fixture();
    if(kind==='ancestor-link'){fs.renameSync(f.stage,f.stage+'-real');fs.symlinkSync(f.stage+'-real',f.stage);}
    if(kind==='leaf-link'){fs.renameSync(join(f.stage,'app.tar.gz'),join(f.stage,'original'));fs.symlinkSync(join(f.stage,'original'),join(f.stage,'app.tar.gz'));}
    if(kind==='hardlink')fs.linkSync(join(f.stage,'app.tar.gz'),join(f.stage,'linked'));
    if(kind==='public-mode')fs.chmodSync(join(f.stage,'manifest.json'),0o644);
    if(kind==='wrong-signature')fs.writeFileSync(join(f.stage,'manifest.sig'),signature(Buffer.from('other')));
    if(kind==='changed-app')fs.writeFileSync(join(f.stage,'app.tar.gz'),Buffer.from('substituted'));
    expect(inspectQualifiedDesktopUpdate(f.id,f.deps).state).toBe('blocked');
  });
  it.each(['surface','expired','stop','leases','unknown'])('keeps %s refusal explicit and never starts apply',async kind=>{
    const f=fixture();if(kind==='surface')f.admission.surfaceDigest='0'.repeat(64);if(kind==='expired')f.admission.active=false;if(kind==='stop')f.admission.stop=false;if(kind==='leases')f.admission.leaseCount=1;if(kind==='unknown')f.admission.unknownLeases=1;
    const install=vi.fn(async()=> 'applied' as const);const observed=await applyQualifiedDesktopUpdate(f.id,f.deps,install);
    expect(observed.state).toBe('blocked');expect(observed.requiresReapproval).toBe(['surface','expired'].includes(kind));expect(install).not.toHaveBeenCalled();
  });
  it('admits the supported installed identity0644 while refusing writable replacement files',async()=>{
    const f=fixture(),identity=join(f.deps.packageRoot!,'dist/build-identity.json');fs.chmodSync(identity,0o644);
    expect(inspectQualifiedDesktopUpdate(f.id,f.deps).state).toBe('ready');
    const install=vi.fn(async()=> 'applied' as const);expect((await applyQualifiedDesktopUpdate(f.id,f.deps,install)).state).toBe('applied');
    expect(install).toHaveBeenCalledOnce();fs.chmodSync(identity,0o666);
    expect(inspectQualifiedDesktopUpdate(f.id,f.deps)).toMatchObject({state:'blocked',reason:'installed-current-unverified'});
    const g=fixture();fs.chmodSync(join(g.deps.packageRoot!,'dist/build-identity.json'),0o666);
    expect(inspectQualifiedDesktopUpdate(g.id,g.deps)).toMatchObject({state:'blocked',reason:'installed-current-unverified'});
  });
  it.each(['3.25.1','3.25.2','4.0.0'])('refuses equal/older candidates against actual current %s before ACK or mutation',async current=>{
    const f=fixture();fs.writeFileSync(join(f.deps.packageRoot!,'dist/build-identity.json'),JSON.stringify({schemaVersion:1,packageVersion:current,revision:'a'.repeat(40),dirty:false,provenance:'git'}));
    fs.writeFileSync(join(f.deps.packageRoot!,'package.json'),JSON.stringify({name:'@ashlr/hub',version:current,type:'module',bin:{ashlr:'bin/ashlr'}}));
    const progress=vi.fn(), install=vi.fn(async()=> 'applied' as const);
    expect(inspectQualifiedDesktopUpdate(f.id,f.deps)).toMatchObject({state:'blocked',reason:'candidate-not-newer'});
    expect(await applyQualifiedDesktopUpdate(f.id,f.deps,install,progress)).toMatchObject({state:'blocked',reason:'candidate-not-newer'});
    expect(progress).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
  });
  it('refuses an unavailable actual current version and independently checks signed native source before handoff',async()=>{
    const f=fixture();fs.writeFileSync(join(f.deps.packageRoot!,'dist/build-identity.json'),'unverified');
    expect(inspectQualifiedDesktopUpdate(f.id,f.deps).reason).toBe('current-version-unverified');
    const wrong=tar(files.map(path=>({path,data:'signed incomplete source'})));
    f.manifest.app.bytes=wrong.length;f.manifest.app.sha256=createHash('sha256').update(wrong).digest('hex');f.manifest.app.signature=signature(wrong);
    fs.writeFileSync(join(f.stage,'app.tar.gz'),wrong);f.publish();const progress=vi.fn(),install=vi.fn(async()=> 'applied' as const);
    expect(await applyQualifiedDesktopUpdate(f.id,f.deps,install,progress)).toMatchObject({state:'blocked',reason:'app-source-unverified'});
    expect(progress).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
  });
  it('requires matching installed current before acknowledging the actual native parent',async()=>{
    const f=fixture();const progress=vi.fn();const install=vi.fn(async()=> 'applied' as const);
    expect(await applyQualifiedDesktopUpdate(f.id,{...f.deps,currentPackageRoot:()=>'/different'},install,progress)).toMatchObject({state:'blocked',reason:'running-current-mismatch'});
    expect(progress).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
  });
  it.each(['invalid','slow','error'])('holds %s exact native bundle proof before ACK',async kind=>{
    const f=fixture();const progress=vi.fn(), install=vi.fn(async()=> 'applied' as const);
    f.deps.verifyParent=async()=>{if(kind==='error')throw new Error('private signature failure');if(kind==='slow')await f.deps.sleep(9000);return kind!=='invalid';};
    const observed=await applyQualifiedDesktopUpdate(f.id,f.deps,install,progress);
    expect(observed.state).toBe('blocked');expect(progress).not.toHaveBeenCalled();expect(install).not.toHaveBeenCalled();
  });
  it('acknowledges capture once, waits normal exit, then requires fresh unchanged admission',async()=>{
    const f=fixture();let calls=0;const deps={...f.deps,parentState:()=>++calls===1?'same' as const:'gone' as const};
    const events:string[]=[];const install=vi.fn(async()=>{events.push('install');return 'applied' as const;});
    const observed=await applyQualifiedDesktopUpdate(f.id,deps,install,value=>events.push(value.state));
    expect(observed).toMatchObject({state:'applied',reason:'operator-restart-required'});expect(events).toEqual(['waiting-native-exit','install']);expect(calls).toBe(2);
  });
  it.each(['parent-missing','reused','unknown','still-running','grant-changed','stop-cleared','new-lease'])('holds %s before the installer is contacted',async kind=>{
    const f=fixture();let reads=0;const deps={...f.deps};
    if(kind==='parent-missing')deps.captureParent=()=>null;
    if(kind==='reused')deps.parentState=()=> 'changed';if(kind==='unknown')deps.parentState=()=> 'unknown';if(kind==='still-running')deps.parentState=()=> 'same';
    if(['grant-changed','stop-cleared','new-lease'].includes(kind))deps.admission=()=>{reads++;return {...f.admission,...(reads>1?(kind==='grant-changed'?{envelopeDigest:'4'.repeat(64)}:kind==='stop-cleared'?{stop:false}:{leaseCount:1}):{})};};
    const install=vi.fn(async()=> 'applied' as const);expect((await applyQualifiedDesktopUpdate(f.id,deps,install)).state).toBe('blocked');expect(install).not.toHaveBeenCalled();
  });
  it('preserves uncertain previous attempts and a concurrently held claim without replay or deletion',async()=>{
    const f=fixture();const install=vi.fn(async()=> 'applied' as const);
    fs.writeFileSync(join(f.stage,'consumer-attempt.json'),'uncertain',{mode:0o600});
    expect((await applyQualifiedDesktopUpdate(f.id,f.deps,install)).reason).toBe('update-attempt-already-recorded');
    fs.mkdirSync(join(f.stage,'consumer-lock'),{mode:0o700});fs.writeFileSync(join(f.stage,'consumer-lock','owner'),'existing');
    expect((await applyQualifiedDesktopUpdate(f.id,f.deps,install)).state).toBe('blocked');expect(fs.readFileSync(join(f.stage,'consumer-lock','owner'),'utf8')).toBe('existing');expect(install).not.toHaveBeenCalled();
  });
});

function pairedFixture(profile: DesktopUpdateProfileName = 'legacy-v1', currentRoot?: string, version = '3.25.1') {
  const f=fixture(profile, currentRoot, version);

  const core=Buffer.from('export const trusted = true;');
  const surfaceCore={v:1 as const,roots:['dist/core/authority/fixture.js'],missingRoots:[],files:[{path:'dist/core/authority/fixture.js',sha256:createHash('sha256').update(core).digest('hex'),bytes:core.length}],packages:[],unresolved:[]};
  const surface={...surfaceCore,digest:authoritySurfaceDigest(surfaceCore)};
  f.manifest.authoritySurfaceDigest=surface.digest;f.admission.surfaceDigest=surface.digest;
  const cli=tar([
    {path:'package/package.json',data:JSON.stringify({name:f.manifest.cli.packageName,version:f.manifest.version,type:'module',bin:{ashlr:'bin/ashlr'}})},
    {path:'package/dist/build-identity.json',data:JSON.stringify({schemaVersion:1,packageVersion:f.manifest.version,revision:f.manifest.source.revision,dirty:false,provenance:'git'})},
    {path:'package/bin/ashlr',data:'#!/usr/bin/env node\n',mode:0o755},
    {path:'package/dist/cli/index.js',data:'export {};'},
    {path:'package/dist/core/universe/index.js',data:'export {};'},
    {path:'package/dist/core/authority/fixture.js',data:core.toString()},
    {path:'package/dist/authority-surface.json',data:JSON.stringify(surface)},
  ]);
  f.manifest.cli.bytes=cli.length;f.manifest.cli.sha256=createHash('sha256').update(cli).digest('hex');f.manifest.cli.signature=signature(cli);
  f.manifest.qualification.packageSha256=f.manifest.cli.sha256;
  const record=canonicalJson({schemaVersion:1,version:f.manifest.version,source:f.manifest.source,authoritySurfaceDigest:surface.digest,packageSha256:f.manifest.cli.sha256});
  const app=tar([...files.map(path=>({path,data:'signed file'})),{path:'Phantom.app/Contents/Resources/phantom-release.json',data:record}]);
  f.manifest.app.bytes=app.length;f.manifest.app.sha256=createHash('sha256').update(app).digest('hex');f.manifest.app.signature=signature(app);
  fs.writeFileSync(join(f.stage,'app.tar.gz'),app);f.publish();
  const previous={target:f.deps.packageRoot!};let pointer=previous;let held=false;let installations=0;let mutation:string|null=null;let beforeSwitch:(()=>Promise<void>)|null=null;
  const io={home:f.home,clock:()=>0,sleep:async()=>{},fetchStatus:async()=>200,readCurrentPointer:()=>pointer,
    switchCurrentPointer:(_path:string,_before:unknown,target:string)=>{pointer={target};return pointer;},restoreCurrentPointer:()=>{pointer=previous;},
    writeInstallJournal:(_owner:string,_value:{phase:string})=>{},readBoundedFile:()=>record};
  const transaction={createLocalAppTransactionIo:()=>io,
    selectLocalApp:()=>({path:'/Applications/Phantom.app',inventory:f.manifest.app.inventorySha256,dev:1,ino:2,signer:f.manifest.app.signer}),
    inspectLocalApp:(path:string)=>({path,inventory:f.manifest.app.inventorySha256,dev:1,ino:2,signer:f.manifest.app.signer}),
    inspectLocalAliases:()=>[],createLocalAliases:()=>[],removeCreatedAliases:()=>{},launchedAppIsOwned:()=>true,
    installLocalApp:async(input:Record<string,unknown>)=>{
      installations++;expect(input.preserveSigned).toBe(true);expect(input.prepare).toBeUndefined();
      beforeSwitch=input.beforeSwitch as ()=>Promise<void>;
      if(held)f.admission.active=false;
      const mutate=()=>fs.writeFileSync(join(f.home,'.local/share/ashlr/releases',f.manifest.source.revision,'dist/core/authority/fixture.js'),'changed after initial signed-package proof');
      if(mutation==='beforeSwitch')mutate();
      await beforeSwitch();
      if(mutation==='beforePointer'||mutation==='beforePointerChangedCurrent')mutate();
      if(mutation==='beforePointerChangedCurrent')pointer={target:join(f.home,'external-release')};
      try {await (input.commitPointer as ()=>Promise<void>)();}
      catch(error) {
        try {await (input.rollbackPointer as ()=>Promise<void>)();io.writeInstallJournal('',{phase:'rolled-back'});}
        catch {io.writeInstallJournal('',{phase:'rollback-held'});}
        throw error;
      }
      expect(await (input.health as ()=>Promise<boolean>)()).toBe(true);
    }};
  f.deps.download=async(url)=>{expect(url).toBe(f.manifest.cli.url);return cli;};f.deps.transaction=async()=>transaction;
  return {...f,cli,record,getPointer:()=>pointer,installations:()=>installations,revokeBeforeSwitch:()=>{held=true;},mutateCandidateAt:(phase:string)=>{mutation=phase;}};
}

describe.skipIf(process.platform === 'win32')('original package extraction and installed-byte readback',()=>{
  it('extracts original signed package without lifecycle execution, binds native record, and verifies final installed bytes',async()=>{
    const f=pairedFixture();
    expect(await applyQualifiedDesktopUpdate(f.id,f.deps)).toMatchObject({state:'applied',reason:'operator-restart-required'});
    expect(f.installations()).toBe(1);expect(fs.readFileSync(join(f.stage,'package.tgz'))).toEqual(f.cli);
    const root=f.getPointer().target;expect(fs.readFileSync(join(root,'dist/core/authority/fixture.js'),'utf8')).toContain('trusted');
    expect(fs.lstatSync(join(root,'bin/ashlr')).mode&0o777).toBe(0o700);
    const deps={...f.deps,packageRoot:root,currentPackageRoot:()=>root};
    // Ordinary supported npm extraction retains readable0644 and executable0755.
    const publicModes=(path:string)=>{for(const name of fs.readdirSync(path)){const child=join(path,name);if(fs.statSync(child).isDirectory())publicModes(child);else fs.chmodSync(child,fs.statSync(child).mode&0o111?0o755:0o644);}};
    publicModes(root);
    expect(await readQualifiedDesktopUpdateResult(f.id,deps)).toMatchObject({state:'applied',reason:'operator-restart-required'});
    // A saved success cannot hide either a substituted file or extra candidate bytes.
    fs.writeFileSync(join(root,'unexpected.js'),'export {};');
    expect((await readQualifiedDesktopUpdateResult(f.id,deps)).state).toBe('blocked');
    fs.unlinkSync(join(root,'unexpected.js'));fs.writeFileSync(join(root,'dist/core/authority/fixture.js'),'changed');
    expect((await readQualifiedDesktopUpdateResult(f.id,deps)).state).toBe('blocked');
  });
  it('adopts original legacy bridge bytes then canonical bytes, and rechecks both installed memberships',async()=>{
    const bridge=pairedFixture();
    expect((await applyQualifiedDesktopUpdate(bridge.id,bridge.deps)).state).toBe('applied');
    const bridgeRoot=bridge.getPointer().target;
    expect(fs.readFileSync(join(bridge.stage,'package.tgz'))).toEqual(bridge.cli);
    expect((await readQualifiedDesktopUpdateResult(bridge.id,{...bridge.deps,packageRoot:bridgeRoot,currentPackageRoot:()=>bridgeRoot})).state).toBe('applied');
    const canonical=pairedFixture('canonical-v2',bridgeRoot,'3.26.0');
    expect(inspectQualifiedDesktopUpdate(canonical.id,canonical.deps)).toMatchObject({state:'ready',version:'3.26.0'});
    expect((await applyQualifiedDesktopUpdate(canonical.id,canonical.deps)).state).toBe('applied');
    const canonicalRoot=canonical.getPointer().target;
    expect(fs.readFileSync(join(canonical.stage,'package.tgz'))).toEqual(canonical.cli);
    expect(JSON.parse(fs.readFileSync(join(canonicalRoot,'package.json'),'utf8')).name).toBe('@ashlr/phantom');
    expect((await readQualifiedDesktopUpdateResult(canonical.id,{...canonical.deps,packageRoot:canonicalRoot,currentPackageRoot:()=>canonicalRoot})).state).toBe('applied');
    const regression=pairedFixture('legacy-v1',canonicalRoot,'3.27.0');
    const progress=vi.fn();
    expect(inspectQualifiedDesktopUpdate(regression.id,regression.deps)).toMatchObject({state:'blocked',reason:'candidate-identity-regression'});
    expect(await applyQualifiedDesktopUpdate(regression.id,regression.deps,undefined,progress)).toMatchObject({state:'blocked',reason:'candidate-identity-regression'});
    expect(regression.installations()).toBe(0);expect(progress).not.toHaveBeenCalled();
  });
  it.each(['@foreign/phantom','unknown'])('refuses actual current package %s without ACK or transaction',async name=>{
    const f=pairedFixture('canonical-v2');
    fs.writeFileSync(join(f.deps.packageRoot!,'package.json'),JSON.stringify({name,version:'3.25.0',type:'module',bin:{ashlr:'bin/ashlr'}}));
    expect(inspectQualifiedDesktopUpdate(f.id,f.deps).reason).toBe('installed-current-unverified');
    expect((await applyQualifiedDesktopUpdate(f.id,f.deps)).state).toBe('blocked');expect(f.installations()).toBe(0);
  });
  it('withholds mutation on a fresh revocation at the final transaction boundary',async()=>{
    const f=pairedFixture();f.revokeBeforeSwitch();
    expect(await applyQualifiedDesktopUpdate(f.id,f.deps)).toMatchObject({state:'rollback-held'});
    expect(f.getPointer().target).toBe(f.deps.packageRoot);
    expect(fs.existsSync(join(f.stage,'consumer-attempt.json'))).toBe(true);
    expect((await applyQualifiedDesktopUpdate(f.id,f.deps)).reason).toBe('grant-unavailable');
  });
  it.each(['beforeSwitch','beforePointer'])('holds actual late candidate mutation at %s without publishing current',async phase=>{
    const f=pairedFixture();f.mutateCandidateAt(phase);
    expect(await applyQualifiedDesktopUpdate(f.id,f.deps)).toMatchObject({state:phase==='beforePointer'?'rolled-back':'rollback-held',reason:'installation-recovery-required'});
    expect(f.getPointer().target).toBe(f.deps.packageRoot);expect(f.installations()).toBe(1);
    expect(fs.existsSync(join(f.stage,'consumer-attempt.json'))).toBe(true);
  });
  it('holds recovery when a late guard observes a different current pointer',async()=>{
    const f=pairedFixture();f.mutateCandidateAt('beforePointerChangedCurrent');
    expect(await applyQualifiedDesktopUpdate(f.id,f.deps)).toMatchObject({state:'rollback-held'});
    expect(f.getPointer().target).toBe(join(f.home,'external-release'));
  });
  it('awaits failed ACK before parent wait and any installation, without creating an attempt',async()=>{
    const f=pairedFixture();const wait=vi.fn(f.deps.parentState);f.deps.parentState=wait;
    expect((await applyQualifiedDesktopUpdate(f.id,f.deps,undefined,async()=>{throw Object.assign(new Error('closed ACK'),{code:'EPIPE'});})).state).toBe('blocked');
    expect(wait).not.toHaveBeenCalled();expect(f.installations()).toBe(0);expect(fs.existsSync(join(f.stage,'consumer-attempt.json'))).toBe(false);
  });
  it('retains the completed fsynced receipt when normal native exit closes terminal stdout',async()=>{
    const f=pairedFixture();let writes=0;
    expect(await cmdDesktopUpdate(['apply','--stage',f.id,'--json'],f.deps,async()=>{if(++writes===2)throw Object.assign(new Error('normal close'),{code:'EPIPE'});})).toBe(0);
    expect(writes).toBe(2);expect(JSON.parse(fs.readFileSync(join(f.stage,'consumer-result.json'),'utf8')).state).toBe('applied');
    const root=f.getPointer().target;
    expect((await readQualifiedDesktopUpdateResult(f.id,{...f.deps,packageRoot:root,currentPackageRoot:()=>root})).state).toBe('applied');
  });
  it('rejects corrupted original npm before contacting the app transaction',async()=>{
    const f=pairedFixture();f.deps.download=async()=>Buffer.from('wrong bytes');
    expect((await applyQualifiedDesktopUpdate(f.id,f.deps)).state).toBe('blocked');expect(f.installations()).toBe(0);
    expect(fs.existsSync(join(f.stage,'consumer-attempt.json'))).toBe(false);
  });
  it('never accepts a saved success with absent or mismatched current bytes',async()=>{
    const f=fixture();fs.writeFileSync(join(f.stage,'consumer-attempt.json'),JSON.stringify({schemaVersion:1,manifestDigest:'unverified',state:'installation-attempted'}),{mode:0o600});
    fs.writeFileSync(join(f.stage,'consumer-result.json'),JSON.stringify({schema:'phantom-desktop-update-result/v1',state:'applied',version:f.manifest.version,reason:'operator-restart-required',requiresReapproval:false}),{mode:0o600});
    expect((await readQualifiedDesktopUpdateResult(f.id,f.deps)).state).toBe('blocked');
  });
});

describe('unsupported installed host refusal',()=>{
  it('rejects Windows before any stage, admission, parent or transport access',async()=>{
    const noRead=()=>{throw new Error('unsupported host must not read');};
    const deps:DesktopUpdateDependencies={home:'/unavailable',platform:'win32',architecture:'arm64',packageRoot:'/unavailable',trust,
      admission:noRead,currentPackageRoot:noRead,captureParent:noRead,verifyParent:async()=>noRead(),parentState:noRead,
      now:noRead,sleep:async()=>noRead(),download:async()=>noRead()};
    expect(inspectQualifiedDesktopUpdate('a'.repeat(32),deps)).toMatchObject({state:'blocked',reason:'unsupported-installed-runtime'});
    expect(await applyQualifiedDesktopUpdate('a'.repeat(32),deps)).toMatchObject({state:'blocked',reason:'unsupported-installed-runtime'});
  });
});
describe('fixed installed Node transaction helper',()=>{
  function diskHelper() {
    const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'update-disk-helper-')));roots.push(root);
    fs.mkdirSync(join(root,'scripts'));
    const marker=`fixed-helper-${root}`;
    fs.writeFileSync(join(root,'scripts/local-app-transaction.mjs'),
      `globalThis[${JSON.stringify(marker)}] = true; export function createLocalAppTransactionIo(options) { return options; }`);
    return {root,marker};
  }
  it('loads the fixed helper from the actual running disk package',async()=>{
    const f=diskHelper();const running=vi.spyOn(authoritySurface,'runningPackageRoot').mockReturnValue(f.root);
    try {
      const helper=await loadInstalledDesktopTransaction(f.root);
      expect(helper.createLocalAppTransactionIo({packageRoot:f.root,home:f.root})).toEqual({packageRoot:f.root,home:f.root});
      expect(Reflect.get(globalThis,f.marker)).toBe(true);
    } finally {running.mockRestore();Reflect.deleteProperty(globalThis,f.marker);}
  });
  it.each(['no-disk-package','different-running-package'])('refuses %s before executing helper code',async shape=>{
    const f=diskHelper();const running=vi.spyOn(authoritySurface,'runningPackageRoot').mockReturnValue(shape==='no-disk-package'?null:join(f.root,'other'));
    try {
      await expect(loadInstalledDesktopTransaction(f.root)).rejects.toThrow('unsupported-installed-runtime');
      expect(Reflect.get(globalThis,f.marker)).toBeUndefined();
    } finally {running.mockRestore();Reflect.deleteProperty(globalThis,f.marker);}
  });
});
describe('strict signed app archive interpretation',()=>{
  it('accepts bounded regular files/directories and retains executable modes',()=>{
    const archive=tar([{path:'Phantom.app',type:'Directory',mode:0o755},...files.map(path=>({path,data:'x',mode:path.endsWith('plist')?0o644:0o755}))]);
    const entries=inspectSignedAppArchive(archive);expect(entries).toHaveLength(4);expect(entries.at(-1)?.mode).toBe(0o755);
  });
  it.each(['traversal','symlink','hardlink','PAX','duplicate','case-parent','writable','missing-native','truncated'])('refuses %s archives',kind=>{
    let rows:{path:string;data?:string;type?:HeaderData['type'];mode?:number;linkpath?:string}[]=files.map(path=>({path,data:'x'}));
    if(kind==='traversal')rows.push({path:'Phantom.app/../escape',data:'x'});
    if(kind==='symlink'||kind==='hardlink')rows.push({path:'Phantom.app/link',type:kind==='symlink'?'SymbolicLink':'Link',linkpath:'target'});
    if(kind==='PAX')rows.push({path:'Phantom.app/meta',type:'ExtendedHeader',data:'x'});
    if(kind==='duplicate')rows.push(rows[0]!);if(kind==='case-parent')rows.push({path:'Phantom.app/contents/other',data:'x'});
    if(kind==='writable')rows[0]!.mode=0o666;if(kind==='missing-native')rows=rows.slice(0,1);
    let archive=tar(rows);if(kind==='truncated')archive=archive.subarray(0,archive.length-4);
    expect(()=>inspectSignedAppArchive(archive)).toThrow();
  });
});

describe('closed signed artifact downloader',()=>{
  it('allows official asset redirect only, bounds bytes and never includes credentials',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/asset'}})).mockResolvedValueOnce(new Response('bytes'));
    vi.stubGlobal('fetch',fetch);expect((await downloadQualifiedUpdateArtifact('https://github.com/ashlrai/ashlr-hub/releases/download/v3.25.1/package',5)).toString()).toBe('bytes');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({redirect:'manual',credentials:'omit'});
  });
  it.each(['https://evil.test/a','http://github.com/a','https://user@github.com/a'])('refuses destination %s before contact',async url=>{
    const fetch=vi.fn(()=>{throw new Error('no real requests');});vi.stubGlobal('fetch',fetch);await expect(downloadQualifiedUpdateArtifact(url,5)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses redirect escape and streamed oversize without executing payload',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://evil.test/asset'}}));vi.stubGlobal('fetch',fetch);
    await expect(downloadQualifiedUpdateArtifact('https://github.com/a',5)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockReset().mockResolvedValue(new Response('oversized'));
    await expect(downloadQualifiedUpdateArtifact('https://github.com/a',5)).rejects.toThrow('size');
  });
});

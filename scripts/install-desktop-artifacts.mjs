#!/usr/bin/env node
/** Maintainer manual adoption of original paired bytes. No build, pack, sign, grant or resume. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import {execFileSync, spawnSync} from 'node:child_process';
import {userInfo} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observeBuild} from '../.github/scripts/ci-pack-smoke.mjs';
import {computeAuthoritySurface, canonicalJson} from './authority-surface.mjs';
import {sourceBinding, verifyArtifact, inspectCommissionedManualPublication, verifyPublishedManualArtifact} from './hosted-build-artifact.mjs';
import {desktopPublisherGithub, verifyUpdateAudit} from './finalize-desktop-update.mjs';
import {getDesktopReleaseToolchain} from './desktop-release-policy.mjs';
import * as transaction from './local-app-transaction.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const admissions = new WeakMap();
const digest = data => createHash('sha256').update(data).digest('hex');
const same = (a, b) => ['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].every(k => a[k] === b[k]);
// These labels identify the failed boundary, never the error's private details.
const FAILURE_PHASES = new Set(['preflight','implementation','finalized-artifacts','manifest-signature','artifact-bytes','artifact-signature','app-record','package-archive','source','hosted-proof','current','app-identity','aliases','quiescence','staging','package','late-artifacts','late-source','late-implementation','late-hosted-proof','late-package','late-current','late-aliases','late-quiescence','app-transaction','app-move','app-signature','app-launch','owned-health','pointer-switch','alias-create','pointer-recovery','destination','late-destination']);
function phaseError(phase,error) {
  const failure=error instanceof Error?error:new Error('Installer boundary refused');
  if (!FAILURE_PHASES.has(failure.installerPhase)) failure.installerPhase=phase;
  return failure;
}
function boundary(phase,operation) {
  try {
    const result=operation();
    return result && typeof result.then==='function'?result.catch(error=>{throw phaseError(phase,error);}):result;
  } catch(error) {throw phaseError(phase,error);}
}
export function artifactInstallFailure(error) {
  return {state:['rolled-back','rollback-held'].includes(error?.installationState)?error.installationState:'held',
    phase:FAILURE_PHASES.has(error?.installerPhase)?error.installerPhase:'preflight',installationAccepted:false,authorityResumed:false};
}
const USAGE = 'node scripts/install-desktop-artifacts.mjs --candidate-source <qualified-checkout> --bundle <signed-hosted-bundle> --artifacts <private-finalizer-output> [--published-release] [--apply]';

export function parseArtifactInstallArguments(argv) {
  if (argv.length === 1 && ['--help','-h'].includes(argv[0])) return {help:true};
  const flags = {}; let apply = false, publishedRelease = false;
  for (let i=0;i<argv.length;i++) {
    const flag = argv[i];
    if (flag === '--apply') {assert.equal(apply,false,'duplicate apply');apply=true;continue;}
    if (flag === '--published-release') {assert.equal(publishedRelease,false,'duplicate published release');publishedRelease=true;continue;}
    assert.ok(['--candidate-source','--bundle','--artifacts'].includes(flag) && !Object.hasOwn(flags,flag),'unknown or duplicate argument');
    const value = argv[++i];
    assert.ok(typeof value === 'string' && value.length > 0 && resolve(value) === value && !value.startsWith('--'),'expected canonical absolute directory');
    flags[flag] = value;
  }
  assert.equal(Object.keys(flags).length,3,'all three input directories are required');
  assert.ok(new Set(Object.values(flags)).size === 3,'input directories must be distinct');
  return {candidateRoot:flags['--candidate-source'],bundle:flags['--bundle'],artifacts:flags['--artifacts'],apply,...(publishedRelease?{publishedRelease:true}:{})};
}

function directory(path, privateMode = true) {
  assert.equal(fs.realpathSync(path),path,'directory path is not canonical');
  const s = fs.lstatSync(path);
  assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && !(s.mode & (privateMode ? 0o077 : 0o022)),'unsafe owned directory');
  return s;
}
function parents(path) {
  const rows = [];
  for (let p=dirname(path);;) {
    const s=fs.lstatSync(p);assert.ok(s.isDirectory() && !s.isSymbolicLink(),'unsafe ancestor');
    rows.push({path:p,dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode});
    if (p===dirname(p)) break;p=dirname(p);
  }
  return rows;
}
function ownedBytes(path, maximum, privateMode = true) {
  assert.equal(fs.realpathSync(path),path,'file path is not canonical');
  const before=fs.lstatSync(path);
  assert.ok(before.isFile() && before.nlink===1 && before.uid===process.getuid() && !(before.mode&(privateMode?0o077:0o022)) && before.size>0 && before.size<=maximum,'unsafe owned artifact');
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    assert.ok(same(before,fs.fstatSync(fd)),'artifact replaced before read');
    const data=fs.readFileSync(fd);
    assert.ok(data.length===before.size && same(before,fs.fstatSync(fd)) && same(before,fs.lstatSync(path)),'artifact changed while read');
    return {data,identity:before,sha256:digest(data)};
  } finally {fs.closeSync(fd);}
}
function text(data) {const value=data.toString('utf8');assert.ok(Buffer.from(value).equals(data),'invalid UTF8');return value;}

/** Pure byte admission using the same commissioned parsers as the automatic consumer. */
export async function readFinalizedDesktopArtifacts(path, primitives) {
  const identity=directory(path), ancestors=parents(path), files=new Map();
  const read=(name,max)=>{const privateMode=!name.endsWith('.sig');const row=ownedBytes(join(path,name),max,privateMode);files.set(name,{...row,privateMode});return row.data;};
  const manifestText=text(read('manifest.json',64*1024)), signature=text(read('manifest.json.sig',8192));
  const verified=boundary('manifest-signature',()=>primitives.verifyCompatibleUpdateManifest({manifestText,signature},primitives.trust)), m=verified.manifest;
  boundary('app-signature',()=>assert.equal(m.app.signer,primitives.appleSigner,'uncommissioned Apple signer'));
  for (const a of [m.app,m.cli]) {
    const data=read(a.filename,a.bytes);
    boundary('artifact-bytes',()=>{assert.equal(data.length,a.bytes,'artifact size differs');assert.equal(digest(data),a.sha256,'artifact digest differs');});
    assert.equal(text(read(`${a.filename}.sig`,8192)),a.signature,'signature sidecar differs');
    boundary('artifact-signature',()=>primitives.verifyMinisign(data,a.signature,primitives.trust.publicKey));
  }
  const expected={version:m.version,platforms:{'darwin-aarch64':{url:m.app.url,signature:m.app.signature}},phantom:{manifestText,signature}};
  assert.equal(text(read('latest.json',128*1024)),canonicalJson(expected),'discovery metadata differs from signed envelope');
  const names=[...files.keys()];
  // The producer retains its private tools directory. It is metadata only: no
  // child, symlink target or executable from that directory is ever inspected.
  const actual=fs.readdirSync(path).sort();
  if (actual.includes('tools')) {directory(join(path,'tools'));names.push('tools');}
  assert.deepEqual(actual,names.sort(),'unexpected finalizer output');
  const entries=primitives.inspectSignedAppArchive(files.get(m.app.filename).data);
  const marker=entries.find(e=>e.path==='Phantom.app/Contents/Resources/phantom-release.json' && !e.directory);
  boundary('app-record',()=>{assert.ok(marker,'app source record missing');primitives.verifyUpdateBundleRecord(text(marker.data),m);});
  const archive=await boundary('package-archive',()=>primitives.readPinnedRuntimeArchive({artifactPath:join(path,m.cli.filename),sha256:m.cli.sha256,revision:m.source.revision,version:m.version,identityProfile:primitives.desktopUpdateProfileForPackage(m.cli.packageName).name}));
  assert.equal(archive.pins.size,m.cli.bytes,'original archive size differs');
  assert.ok(same(identity,directory(path)),'finalizer directory changed');assert.deepEqual(parents(path),ancestors,'artifact ancestor changed');
  return {path,identity,ancestors,files,manifest:m,digest:verified.digest};
}

function unchangedArtifacts(observed) {
  assert.ok(same(observed.identity,directory(observed.path)),'finalizer directory replaced');
  assert.deepEqual(parents(observed.path),observed.ancestors,'artifact ancestor replaced');
  for (const [name,row] of observed.files) {
    const fresh=ownedBytes(join(observed.path,name),row.data.length,row.privateMode);
    assert.ok(same(row.identity,fresh.identity) && fresh.sha256===row.sha256,'finalized artifact changed');
  }
}
function proofInput(input,manifest,transport) {
  const q=manifest.qualification;
  return {root:input.candidateRoot,revision:manifest.source.revision,bundle:input.bundle,
    policy:{runId:q.producer.runId,runAttempt:q.producer.runAttempt,attestorSha:q.attestor.revision,attestorRun:q.attestor.runId,attestorAttempt:q.attestor.runAttempt},
    githubRead:transport.githubRead,attestRun:transport.attestRun};
}
export function assertPairedHostedProof(manifest,receipt,audit) {
  assert.deepEqual(receipt.source,manifest.source,'qualified candidate source differs');
  const q=manifest.qualification;
  for (const key of ['manifestSha256','archiveSha256','packageSha256','qualificationSha256']) assert.equal(receipt[key],q[key],'hosted subject differs');
  assert.deepEqual({runId:receipt.official.runId,runAttempt:receipt.official.runAttempt,eventSha:receipt.official.eventSha},q.producer,'producer differs');
  assert.deepEqual(receipt.attestor,q.attestor,'attestor differs');assert.deepEqual(audit,q.audit,'Audit differs');
}

/** Default transport calls the real verifier, not adopt/validate or a saved JSON receipt. */
export async function verifyManualDesktopSource(input,manifest,transport,envelope) {
  // Public observation follows Audit, and is coherently reread after original
  // attestation verification. No prior mutable master anchor is reused.
  const auditInput={root:input.candidateRoot,repository:manifest.repository.nameWithOwner,revision:manifest.source.revision,
    runId:manifest.qualification.audit.runId,runAttempt:manifest.qualification.audit.runAttempt,read:transport.githubRead};
  const historicalAudit=input.publishedRelease?verifyUpdateAudit(auditInput):null;
  const receipt=input.publishedRelease?verifyPublishedManualArtifact(proofInput(input,manifest,transport),
    await inspectCommissionedManualPublication({...envelope,githubRead:transport.githubRead,downloadRead:transport.downloadRead})):
    verifyArtifact(proofInput(input,manifest,transport));
  const audit=historicalAudit??verifyUpdateAudit(auditInput);
  assertPairedHostedProof(manifest,receipt,audit);
  return receipt;
}

/** Internal IO ports follow existing publisher tests; the command accepts no callbacks or policy overrides. */
export async function inspectDesktopArtifactInstall(input,dependencies) {
  assert.notEqual(input.candidateRoot,ROOT,'candidate checkout must be distinct from implementation');
  directory(input.candidateRoot,false);directory(input.bundle);directory(input.artifacts);
  const observed=await boundary('finalized-artifacts',()=>readFinalizedDesktopArtifacts(input.artifacts,dependencies.primitives));
  const source=boundary('source',()=>sourceBinding(input.candidateRoot,observed.manifest.source.revision));
  boundary('source',()=>assert.equal(source.tree,observed.manifest.source.tree,'candidate source tree differs'));
  const proof=await boundary('hosted-proof',()=>verifyManualDesktopSource(input,observed.manifest,dependencies.transport,
    {manifestText:text(observed.files.get('manifest.json').data),signature:text(observed.files.get('manifest.json.sig').data)}));
  const hosted=ownedBytes(join(input.bundle,observed.manifest.cli.filename),observed.manifest.cli.bytes,false);
  assert.equal(hosted.sha256,observed.manifest.cli.sha256,'not the original hosted package');
  assert.ok(hosted.data.equals(observed.files.get(observed.manifest.cli.filename).data),'paired package differs from original hosted bytes');
  const implementation=await boundary('implementation',async()=>{const value=await dependencies.implementationSnapshot();assert.deepEqual(value,dependencies.initialImplementation,'installer changed since its compiled imports');return value;});
  unchangedArtifacts(observed);
  const result=Object.freeze({state:'verified-artifacts',version:observed.manifest.version,installationPerformed:false,authorityResumed:false,...(input.publishedRelease?{verificationMode:'published-release'}:{})});
  admissions.set(result,{input:{...input},dependencies,observed,source,proof,implementation,hosted,attempted:false});
  return result;
}

function safeInstallParents(home,path) {
  assert.ok(path.startsWith(home+'/'),'installation path outside account home');directory(home,false);
  let at=home;
  for (const part of path.slice(home.length+1).split('/')) {
    at=join(at,part);
    try {directory(at,false);} catch(error) {
      if (error.code!=='ENOENT') throw error;
      fs.mkdirSync(at,{mode:0o700});directory(at);
    }
  }
}
function newerCurrent(previous,manifest,io) {
  assert.ok(previous,'a verified existing current release is required');
  const identity=JSON.parse(io.readBoundedFile(join(previous.target,'dist/build-identity.json'),65536));
  const pkg=JSON.parse(io.readBoundedFile(join(previous.target,'package.json'),65536));
  assert.ok(identity.schemaVersion===1 && identity.provenance==='git' && identity.dirty===false && /^[a-f0-9]{40}$/.test(identity.revision) && identity.packageVersion===pkg.version && ['@ashlr/hub','@ashlr/phantom'].includes(pkg.name),'current build identity unavailable');
  assert.ok(pkg.name!=='@ashlr/phantom' || manifest.cli.packageName==='@ashlr/phantom','candidate identity regresses');
  assert.match(pkg.version,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const old=pkg.version.split('.').map(BigInt),next=manifest.version.split('.').map(BigInt),i=next.findIndex((n,j)=>n!==old[j]);
  assert.ok(i>=0 && next[i]>old[i],'candidate is not newer');
}
function sameApp(actual,expected) {assert.ok(actual && actual.path===expected.path && actual.dev===expected.dev && actual.ino===expected.ino && actual.inventory===expected.inventory,'app changed');}

export async function applyInspectedDesktopArtifacts(result) {
  const admitted=admissions.get(result);assert.ok(admitted && !admitted.attempted,'missing or replayed in-process admission');
  admitted.attempted=true; // every uncertain/failed attempt is non-replayable
  const {input,dependencies:d,observed,implementation,proof,source,hosted}=admitted,m=observed.manifest;
  const io=transaction.createLocalAppTransactionIo({packageRoot:ROOT,home:d.home});
  // Child commands see only the normal OS account and system tools, never
  // ambient signing credentials, candidate arguments or candidate executables.
  io.exec=(bin,argv)=> {
    assert.ok(['/usr/bin/ditto','/usr/bin/plutil','/usr/bin/codesign','/usr/bin/open','/bin/ps','/usr/sbin/lsof'].includes(bin),'unsupported installer command');
    if (bin==='/usr/bin/codesign') assert.ok(argv[0]==='--verify','signing is not an installer operation');
    if (bin==='/usr/bin/plutil') assert.ok(argv[0]==='-extract','plist modification is not an installer operation');
    const child=spawnSync(bin,argv,{cwd:ROOT,encoding:'utf8',timeout:120_000,maxBuffer:1024*1024,env:d.environment});
    const status=child.error?1:child.status??1;
    if (status!==0 && !['/bin/ps','/usr/sbin/lsof'].includes(bin)) throw phaseError(bin==='/usr/bin/open'?'app-launch':bin==='/usr/bin/codesign'?'app-signature':bin==='/usr/bin/plutil'?'app-identity':'app-transaction',new Error('Installer command refused'));
    return {status,stdout:child.stdout??''};
  };
  // Fresh hosted proof may be slow. Reprove each exact app immediately at the
  // existing exclusive-move boundary, including rollback; never move a merely
  // inode-matching bundle whose contents changed during that earlier proof.
  const rename=io.renameExclusive.bind(io);
  io.renameExclusive=(from,to,expected)=>boundary('app-move',()=>{sameApp(transaction.inspectLocalApp(from,m.app.signer,io),{...expected,path:from});rename(from,to,expected);});
  const current=join(d.home,'.local/share/ashlr/current'),destination=join(d.home,'.local/share/ashlr/releases',m.source.revision),previous=boundary('current',()=>io.readCurrentPointer(current));
  boundary('current',()=>{assert.notEqual(previous?.target,destination,'candidate destination is already current');newerCurrent(previous,m,io);});
  const selected=boundary('app-identity',()=>{const value=transaction.selectLocalApp(m.app.signer,io);assert.ok(value,'existing app unavailable');return value;});
  const aliases=boundary('aliases',()=>transaction.inspectLocalAliases(io));
  await boundary('quiescence',()=>transaction.requireLocalQuiescence(io));
  const freshInputs=async()=> {
    boundary('late-artifacts',()=>unchangedArtifacts(observed));
    boundary('late-artifacts',()=>{const original=ownedBytes(join(input.bundle,m.cli.filename),m.cli.bytes,false);
      assert.ok(same(hosted.identity,original.identity) && original.sha256===hosted.sha256,'original hosted package replaced');});
    boundary('late-source',()=>assert.deepEqual(sourceBinding(input.candidateRoot,m.source.revision),source,'qualified source changed'));
    await boundary('late-implementation',async()=>assert.deepEqual(await d.implementationSnapshot(),implementation,'installer implementation changed'));
    await boundary('late-hosted-proof',async()=>assert.deepEqual(await verifyManualDesktopSource(input,m,d.transport,
      {manifestText:text(observed.files.get('manifest.json').data),signature:text(observed.files.get('manifest.json.sig').data)}),proof,'fresh hosted proof changed'));
    // Network/signature reads cannot leave bytes trusted from before the read.
    boundary('late-artifacts',()=>unchangedArtifacts(observed));
    boundary('late-artifacts',()=>{const after=ownedBytes(join(input.bundle,m.cli.filename),m.cli.bytes,false);
      assert.ok(same(hosted.identity,after.identity) && after.sha256===hosted.sha256,'original hosted package changed after proof');});
    boundary('late-source',()=>assert.deepEqual(sourceBinding(input.candidateRoot,m.source.revision),source,'qualified source changed after proof'));
    await boundary('late-implementation',async()=>assert.deepEqual(await d.implementationSnapshot(),implementation,'implementation changed after proof'));
  };
  await freshInputs();
  const releases=join(d.home,'.local/share/ashlr/releases');safeInstallParents(d.home,releases);
  const createdDestination=boundary('destination',()=>{
    try {fs.mkdirSync(destination,{mode:0o700});return true;} catch(error) {if(error.code!=='EEXIST')throw error;return false;}
  });
  const archivePins={artifactPath:join(input.artifacts,m.cli.filename),sha256:m.cli.sha256,revision:m.source.revision,version:m.version,identityProfile:d.primitives.desktopUpdateProfileForPackage(m.cli.packageName).name};
  if(createdDestination) {
    const archive=await boundary('package-archive',()=>d.primitives.readPinnedRuntimeArchive(archivePins));
    boundary('staging',()=>d.primitives.extractPinnedRuntimeArchive(archive,destination));
  }
  // A retained release is data, not a replayed stage or saved admission. Never
  // overwrite it: fresh original-package proof and stable ownership are required.
  const destinationIdentity=boundary('destination',()=>directory(destination)),destinationAncestors=parents(destination);
  const destinationStable=()=>{
    assert.ok(same(destinationIdentity,directory(destination)),'candidate release directory changed');
    assert.deepEqual(parents(destination),destinationAncestors,'candidate release ancestors changed');
  };
  const packageReady=async(phase='destination')=> {
    boundary(phase,destinationStable);
    await d.primitives.verifyInstalledRuntimeArchive(destination,archivePins);
    const surface=d.primitives.verifyAuthoritySurfaceAt(destination,'installed',{fresh:true});
    assert.ok(surface.ok && surface.digest===m.authoritySurfaceDigest,'candidate authority surface differs');
    boundary(phase,destinationStable);
  };
  await boundary('package',packageReady);
  const stageParent=join(d.home,'.ashlr/updates/manual-staging');safeInstallParents(d.home,stageParent);
  const stage=fs.mkdtempSync(join(stageParent,'paired-'));fs.chmodSync(stage,0o700);
  const appRoot=d.primitives.extractSignedAppArchive(observed.files.get(m.app.filename).data,stage);
  const app=transaction.inspectLocalApp(appRoot,m.app.signer,io);assert.equal(app.inventory,m.app.inventorySha256,'app inventory differs');
  let switched=null,created=[],phase=null;
  const journal=io.writeInstallJournal.bind(io);
  io.writeInstallJournal=(owner,value)=>{journal(owner,value);phase=value.phase;};
  const beforePublication=async()=> {
    await freshInputs();await boundary('late-package',()=>packageReady('late-destination'));
    boundary('late-current',()=>{assert.deepEqual(io.readCurrentPointer(current),previous,'current pointer changed');newerCurrent(previous,m,io);});
    boundary('late-aliases',()=>assert.deepEqual(transaction.inspectLocalAliases(io),aliases,'CLI aliases changed'));
    await boundary('late-quiescence',()=>transaction.requireLocalQuiescence(io));
  };
  try {
    await boundary('app-transaction',()=>transaction.installLocalApp({selected,source:appRoot,sourceProof:app,signer:m.app.signer,version:m.version,native:true,preserveSigned:true,previousCurrent:previous.target,
      beforeSwitch:async()=>{await beforePublication();sameApp(transaction.selectLocalApp(m.app.signer,io),selected);},
      commitPointer:async()=>{await beforePublication();switched=boundary('pointer-switch',()=>io.switchCurrentPointer(current,previous,destination));created=boundary('alias-create',()=>transaction.createLocalAliases(aliases,io));},
      rollbackPointer:async()=>boundary('pointer-recovery',()=>{transaction.removeCreatedAliases(created,io);if(switched) io.restoreCurrentPointer(current,previous,switched);else assert.deepEqual(io.readCurrentPointer(current),previous,'unchanged pointer recovery unknown');}),
      health:async()=>boundary('owned-health',async()=>{
        const deadline=io.clock()+30_000;
        while(io.clock()<deadline) {
          if(transaction.launchedAppIsOwned(io) && await io.fetchStatus('http://127.0.0.1:7777/verse/')===200) {
            await packageReady();assert.deepEqual(io.readCurrentPointer(current),switched,'launched current pointer changed');return true;
          }
          await io.sleep(1000);
        }
        throw new Error('Owned launch health refused');
      })},io));
    return Object.freeze({state:'installed',version:m.version,installationPerformed:true,authorityResumed:false,requiresOperatorAuthorityReview:true});
  } catch(error) {
    error.installationState=phase==='rolled-back'?'rolled-back':'rollback-held';throw error;
  }
  // Exclusive release/stage trees are preserved on all outcomes. Existing held
  // transactions are never read, rewritten, removed or treated as acceptance.
}

/** Own code/build closure is qualified separately from the release being installed. */
export async function productionInstallerDependencies() {
  const tools=getDesktopReleaseToolchain();
  assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');
  assert.equal(fs.realpathSync(process.execPath),tools.node,'use the commissioned Node binary');
  const environment={HOME:tools.home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C'};
  const revision=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',env:environment,timeout:10_000}).trim();
  const implementationSnapshot=async()=>({source:sourceBinding(ROOT,revision),build:observeBuild(ROOT,revision)});
  const initial=await implementationSnapshot();
  const surface=await computeAuthoritySurface({packageRoot:ROOT});
  assert.deepEqual(JSON.parse(fs.readFileSync(join(ROOT,'dist/authority-surface.json'),'utf8')),surface,'installer compiled closure is not qualified');
  // Literal imports from the fixed implementation, never CandidateSource/dist.
  const [manifest,trust,qualified,archive,authority]=await Promise.all([
    import('../dist/core/desktop/update-manifest.js'),import('../dist/core/desktop/update-trust.js'),
    import('../dist/core/desktop/qualified-update.js'),import('../dist/core/local-runtime/archive.js'),import('../dist/core/authority/surface.js')]);
  assert.deepEqual(await implementationSnapshot(),initial,'implementation changed before imports completed');
  const github=desktopPublisherGithub(ROOT,tools);
  return {home:tools.home,environment,implementationSnapshot,initialImplementation:initial,
    transport:{githubRead:github.read,attestRun:github.attestRun},
    primitives:{...manifest,...qualified,...archive,...authority,trust:trust.getDesktopUpdateTrust(),appleSigner:tools.appleSigner}};
}

async function main() {
  try {
    const input=boundary('preflight',()=>parseArtifactInstallArguments(process.argv.slice(2)));
    if(input.help){console.log(USAGE);console.log('Inspect by default. Apply requires prior Stop, drained leases and normal Quit. No build/sign/pack, grants or resume.');return;}
    // The existing census uses homedir(); bind it and Git to the OS account,
    // while the gh child uses its separately closed normal-profile environment.
    const home=userInfo().homedir;for(const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env,{HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C'});
    const deps=await boundary('implementation',productionInstallerDependencies), inspected=await boundary('preflight',()=>inspectDesktopArtifactInstall(input,deps));
    console.log(JSON.stringify(input.apply?await applyInspectedDesktopArtifacts(inspected):inspected));
  } catch(error) {
    console.error(JSON.stringify(artifactInstallFailure(error)));process.exitCode=1;
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await main();

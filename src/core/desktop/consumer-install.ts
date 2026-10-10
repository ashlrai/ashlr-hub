/** Manual public-artifact first installation. Never signs, stops work or resumes authority. */
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {userInfo} from 'node:os';
import {dirname, join} from 'node:path';
import {parseBuildIdentity} from '../build-identity.js';
import {runningPackageRoot, verifyAuthoritySurfaceAt} from '../authority/surface.js';
import {canonicalJson} from '../authority/canonical-json.js';
import {readPinnedRuntimeArchive, extractPinnedRuntimeArchive, type PinnedRuntimeArchiveOptions} from '../local-runtime/archive.js';
import {fsyncDirectory} from '../util/durability.js';
import {getDesktopUpdateTrustForProfile} from './update-trust.js';
import {verifyCompatibleUpdateManifest, verifyMinisign, verifyUpdateBundleRecord, type CompatibleUpdateManifest, type UpdateTrust} from './update-manifest.js';
import {downloadQualifiedUpdateArtifact, extractSignedAppArchive, loadInstalledDesktopTransaction, verifyInstalledRuntimeArchive} from './qualified-update.js';

type Pointer = {target: string; [key: string]: unknown};
type AppProof = {path: string; inventory: string; dev: number; ino: number; signer: string};
type Alias = {path: string; target: string; identity: unknown};
export interface ConsumerInstallIo extends Record<string, unknown> {
  home: string; log(line: string): void;
  readCurrentPointer(path: string): Pointer | null;
  switchCurrentPointer(path: string, before: Pointer | null, target: string): Pointer;
  restoreCurrentPointer(path: string, before: Pointer | null, expected: Pointer): void;
  writeInstallJournal(owner: string, value: {phase: string}): void;
  clock(): number; sleep(ms: number): Promise<void>; fetchStatus(url: string): Promise<number | null>;
}
export interface ConsumerTransaction {
  createLocalAppTransactionIo(options: {packageRoot: string; home: string}): ConsumerInstallIo;
  selectLocalApp(signer: string, io: ConsumerInstallIo): AppProof | null;
  inspectLocalApp(path: string, signer: string, io: ConsumerInstallIo): AppProof;
  inspectLocalAliases(io: ConsumerInstallIo): Alias[];
  createLocalAliases(aliases: Alias[], io: ConsumerInstallIo): Alias[];
  removeCreatedAliases(aliases: Alias[], io: ConsumerInstallIo): void;
  requireLocalQuiescence(io: ConsumerInstallIo): Promise<void>;
  launchedAppIsOwned(io: ConsumerInstallIo): boolean;
  installLocalApp(input: Record<string, unknown>, io: ConsumerInstallIo): Promise<unknown>;
}
export interface ShellCliObservation {
  name: 'phm' | 'ashlr'; target: string | null; version: string | null;
  versionSource: 'executed-managed' | 'unknown';
}
export interface ConsumerInstallDependencies {
  home: string; platform: NodeJS.Platform; architecture: string; packageRoot: string;
  version: string; revision: string; authoritySurfaceDigest: string; trust: UpdateTrust;
  assertRunning(): void;
  download(url: string, maximum: number): Promise<Buffer>;
  transaction(): Promise<ConsumerTransaction>;
  /** Exact path is verified before any --version execution; other targets remain unknown. */
  readManagedVersion(managedLauncher: string): Promise<string|null>;
  discover(managedLauncher: string): Promise<readonly ShellCliObservation[]>;
}
export interface ConsumerInstallResult {
  state: 'ready' | 'installed' | 'held' | 'rolled-back' | 'rollback-held';
  version: string | null; reason: string | null; installationAccepted: boolean;
  authorityResumed: false;
  shell: readonly {name: 'phm' | 'ashlr'; state: 'managed' | 'setup-required'; version: string | null}[];
}
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const same = (a: fs.Stats, b: fs.Stats) => ['dev','ino','uid','mode','nlink','size','mtimeMs','ctimeMs'].every(key => a[key as keyof fs.Stats] === b[key as keyof fs.Stats]);
class Held extends Error { constructor(readonly reason: string) {super(reason);} }
function require(condition: unknown, reason: string): asserts condition {if (!condition) throw new Held(reason);}
function directory(path: string, privateMode = true): fs.Stats {
  const s=fs.lstatSync(path);
  require(s.isDirectory() && !s.isSymbolicLink() && s.uid===process.getuid?.() && !(s.mode & (privateMode ? 0o077 : 0o022)), 'unsafe-local-path');
  require(fs.realpathSync(path)===path,'unsafe-local-path'); return s;
}
function parents(home: string, path: string, create: boolean): readonly fs.Stats[] {
  require(path.startsWith(home+'/'),'unsafe-local-path'); const rows=[directory(home,false)]; let at=home;
  for(const part of path.slice(home.length+1).split('/')) {
    at=join(at,part);
    try {rows.push(directory(at));} catch(error) {
      if (!create || (error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
      fs.mkdirSync(at,{mode:0o700});fsyncDirectory(dirname(at));rows.push(directory(at));
    }
  }
  return rows;
}
function owned(path: string, maximum: number): {data: Buffer; identity: fs.Stats} {
  const before=fs.lstatSync(path);
  require(before.isFile() && before.nlink===1 && before.uid===process.getuid?.() && !(before.mode&0o077) && before.size>0 && before.size<=maximum,'unsafe-stage');
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    require(same(before,fs.fstatSync(fd)),'stage-changed');const data=fs.readFileSync(fd);
    require(data.length===before.size && same(before,fs.fstatSync(fd)) && same(before,fs.lstatSync(path)),'stage-changed');return {data,identity:before};
  } finally {fs.closeSync(fd);}
}
function write(path: string, data: Buffer): void {
  const fd=fs.openSync(path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try {fs.writeFileSync(fd,data);fs.fchmodSync(fd,0o600);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function result(state: ConsumerInstallResult['state'], version: string|null, reason: string|null = null,
  shell: ConsumerInstallResult['shell'] = []): ConsumerInstallResult {
  return Object.freeze({state,version,reason,installationAccepted:state==='installed',authorityResumed:false,shell});
}
interface Admission {
  deps: ConsumerInstallDependencies; helper: ConsumerTransaction; io: ConsumerInstallIo;
  manifest: CompatibleUpdateManifest; stage: string; appRoot: string; app: AppProof;
  files: ReadonlyMap<string,{identity: fs.Stats; digest: string; maximum: number}>;
  stageParents: readonly fs.Stats[]; pins: PinnedRuntimeArchiveOptions; inspectedPackage: string;
  aliases: Alias[]; attempted: boolean;
}
const admissions=new WeakMap<ConsumerInstallResult,Admission>();
async function absence(a: Pick<Admission,'helper'|'io'|'deps'|'manifest'>): Promise<Alias[]> {
  const {helper,io,deps,manifest}=a;
  require(helper.selectLocalApp(manifest.app.signer,io)===null,'existing-app');
  require(io.readCurrentPointer(join(deps.home,'.local/share/ashlr/current'))===null,'existing-current');
  const aliases=helper.inspectLocalAliases(io);
  require(aliases.length===2 && aliases.every(alias=>alias.identity===null),'alias-collision');
  await helper.requireLocalQuiescence(io);return aliases;
}
function original(a: Admission): void {
  a.deps.assertRunning(); const observed=parents(a.deps.home,a.stage,false);
  require(observed.length===a.stageParents.length && observed.every((s,i)=>s.dev===a.stageParents[i]!.dev && s.ino===a.stageParents[i]!.ino && s.mode===a.stageParents[i]!.mode),'stage-changed');
  for(const [name,pin] of a.files) {
    const fresh=owned(join(a.stage,name),pin.maximum);require(same(fresh.identity,pin.identity) && sha(fresh.data)===pin.digest,'stage-changed');
  }
  const checked=verifyCompatibleUpdateManifest(JSON.parse(owned(join(a.stage,'envelope.json'),128*1024).data.toString('utf8')),a.deps.trust);
  require(canonicalJson(checked.manifest)===canonicalJson(a.manifest),'manifest-changed');
}
async function packageReady(root: string, a: Admission): Promise<void> {
  await verifyInstalledRuntimeArchive(root,a.pins);
  const surface=verifyAuthoritySurfaceAt(root,'installed',{fresh:true});
  require(surface.ok && surface.digest===a.manifest.authoritySurfaceDigest,'package-surface');
}
/** Inspection persists only fresh private downloaded/staged data, never an installation. */
export async function inspectConsumerDesktopInstall(input: ConsumerInstallDependencies): Promise<ConsumerInstallResult> {
  // Capture invocation inputs before the first await; caller mutation cannot
  // replace the selected public trust or stage/current installation identity.
  const deps=Object.freeze({...input,trust:Object.freeze({...input.trust,repository:Object.freeze({...input.trust.repository})})});
  let version:string|null=null;
  try {
    require(deps.platform==='darwin' && deps.architecture==='arm64','unsupported-platform');
    require(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(deps.version) && /^[a-f0-9]{40}$/.test(deps.revision),'running-release');
    deps.assertRunning();const raw=await deps.download(`https://github.com/ashlrai/phantom/releases/download/v${deps.version}/latest.json`,128*1024);
    require(raw.length<=128*1024,'discovery-size');const latest=JSON.parse(raw.toString('utf8')) as {phantom: {manifestText:string;signature:string}};
    const checked=verifyCompatibleUpdateManifest(latest.phantom,deps.trust),m=checked.manifest;version=m.version;
    require(m.schemaVersion===2 && m.version===deps.version && m.source.revision===deps.revision && m.authoritySurfaceDigest===deps.authoritySurfaceDigest,'release-mismatch');
    require(canonicalJson(latest)===canonicalJson({version:m.version,platforms:{'darwin-aarch64':{url:m.app.url,signature:m.app.signature}},phantom:latest.phantom}),'discovery-mismatch');
    const helper=await deps.transaction(),io=helper.createLocalAppTransactionIo({home:deps.home,packageRoot:deps.packageRoot});io.log=()=>{};
    const aliases=await absence({helper,io,deps,manifest:m});
    const downloaded=await Promise.all([deps.download(m.app.url,m.app.bytes),deps.download(m.cli.url,m.cli.bytes)]);
    for(const [i,artifact] of [m.app,m.cli].entries()) {
      const data=downloaded[i]!;require(data.length===artifact.bytes && sha(data)===artifact.sha256,'artifact-mismatch');verifyMinisign(data,artifact.signature,deps.trust.publicKey);
    }
    await absence({helper,io,deps,manifest:m});deps.assertRunning();
    const staging=join(deps.home,'.ashlr/updates/consumer-staging');parents(deps.home,staging,true);
    const stage=fs.mkdtempSync(join(staging,'first-'));fs.chmodSync(stage,0o700);
    write(join(stage,'envelope.json'),Buffer.from(JSON.stringify(latest.phantom)));
    write(join(stage,'app.tar.gz'),downloaded[0]!);write(join(stage,'package.tgz'),downloaded[1]!);fsyncDirectory(stage);
    const files=new Map<string,{identity:fs.Stats;digest:string;maximum:number}>();
    for(const [name,maximum] of [['envelope.json',128*1024],['app.tar.gz',m.app.bytes],['package.tgz',m.cli.bytes]] as const) {
      const file=owned(join(stage,name),maximum);files.set(name,{identity:file.identity,digest:sha(file.data),maximum});
    }
    const appStage=join(stage,'app');fs.mkdirSync(appStage,{mode:0o700});
    const appRoot=extractSignedAppArchive(owned(join(stage,'app.tar.gz'),m.app.bytes).data,appStage);
    const app=helper.inspectLocalApp(appRoot,m.app.signer,io);require(app.inventory===m.app.inventorySha256,'app-inventory');
    verifyUpdateBundleRecord(ioRead(appRoot),m);
    const pins={artifactPath:join(stage,'package.tgz'),sha256:m.cli.sha256,revision:m.source.revision,version:m.version,identityProfile:'canonical-v2' as const};
    const archive=await readPinnedRuntimeArchive(pins),inspectedPackage=join(stage,'package');fs.mkdirSync(inspectedPackage,{mode:0o700});extractPinnedRuntimeArchive(archive,inspectedPackage);
    const a:Admission={deps,helper,io,manifest:m,stage,appRoot,app,files,stageParents:parents(deps.home,stage,false),pins,inspectedPackage,aliases,attempted:false};
    original(a);await packageReady(inspectedPackage,a);await absence(a);
    const observed=result('ready',version);admissions.set(observed,a);return observed;
  } catch(error) {return result('held',version,error instanceof Held?error.reason:'inspection-unavailable');}
}
function regular(path: string, maximum: number): {data: Buffer; identity: fs.Stats} {
  const before=fs.lstatSync(path);
  require(before.isFile() && before.nlink===1 && before.size>0 && before.size<=maximum && !(before.mode&0o022),'unsafe-release-file');
  const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try {
    require(same(before,fs.fstatSync(fd)),'release-file-changed');const data=fs.readFileSync(fd);
    require(same(before,fs.fstatSync(fd)) && same(before,fs.lstatSync(path)),'release-file-changed');return {data,identity:before};
  } finally {fs.closeSync(fd);}
}
function ioRead(appRoot: string): string {
  return regular(join(appRoot,'Contents/Resources/phantom-release.json'),8192).data.toString('utf8');
}

/** Admission is invocation-owned, consumed once, and not reconstructible from saved JSON. */
export async function applyConsumerDesktopInstall(observed: ConsumerInstallResult): Promise<ConsumerInstallResult> {
  const a=admissions.get(observed);if(!a || a.attempted)return result('held',observed.version,'inspection-required');a.attempted=true;
  const {deps,helper,io,manifest:m}=a;let phase:string|null=null;let switched:Pointer|null=null;let created:Alias[]=[];
  const journal=io.writeInstallJournal.bind(io);io.writeInstallJournal=(owner,value)=>{journal(owner,value);phase=value.phase;};
  try {
    original(a);await packageReady(a.inspectedPackage,a);await absence(a);
    const releases=join(deps.home,'.local/share/ashlr/releases');parents(deps.home,releases,true);
    const destination=join(releases,m.source.revision);fs.mkdirSync(destination,{mode:0o700});
    const archive=await readPinnedRuntimeArchive(a.pins);extractPinnedRuntimeArchive(archive,destination);
    const dest=directory(destination),parentPins=parents(deps.home,releases,false);
    const current=join(deps.home,'.local/share/ashlr/current');
    const before=async(installed=false)=> {
      original(a);require(same(dest,directory(destination)),'destination-changed');
      require(parents(deps.home,releases,false).every((s,i)=>s.dev===parentPins[i]!.dev && s.ino===parentPins[i]!.ino && s.mode===parentPins[i]!.mode),'destination-changed');
      await packageReady(destination,a);
      if (!installed) assert.deepEqual(await absence(a),a.aliases);
      else {
        // The shared transaction has moved its verified bundle, but has not
        // opened it or published the CLI pointer yet. Do not require app absence
        // after that owned move; verify the same original inventory instead.
        const active=helper.selectLocalApp(m.app.signer,io);
        require(active?.path==='/Applications/Phantom.app' && active.inventory===m.app.inventorySha256,'installed-app-changed');
        verifyUpdateBundleRecord(ioRead(a.appRoot),m);
        require(io.readCurrentPointer(current)===null,'existing-current');
        assert.deepEqual(helper.inspectLocalAliases(io),a.aliases);
        await helper.requireLocalQuiescence(io);
      }
      const app=helper.inspectLocalApp(a.appRoot,m.app.signer,io);assert.deepEqual(app,a.app);verifyUpdateBundleRecord(ioRead(a.appRoot),m);
    };
    await before();
    await helper.installLocalApp({selected:null,source:a.appRoot,sourceProof:a.app,signer:m.app.signer,version:m.version,native:true,preserveSigned:true,previousCurrent:null,
      beforeSwitch:()=>before(),
      commitPointer:async()=>{await before(true);switched=io.switchCurrentPointer(current,null,destination);created=helper.createLocalAliases(a.aliases,io);},
      rollbackPointer:async()=>{helper.removeCreatedAliases(created,io);if(switched)io.restoreCurrentPointer(current,null,switched);else require(io.readCurrentPointer(current)===null,'pointer-recovery');},
      health:async()=> {
        const deadline=io.clock()+30_000;
        while(io.clock()<deadline) {
          if(helper.launchedAppIsOwned(io) && await io.fetchStatus('http://127.0.0.1:7777/verse/')===200) {
            original(a);await packageReady(destination,a);assert.deepEqual(io.readCurrentPointer(current),switched);
            require(await deps.readManagedVersion(join(destination,'bin/ashlr'))===m.version,'managed-version-unconfirmed');
            original(a);await packageReady(destination,a);return true;
          }
          await io.sleep(1000);
        }
        throw new Held('launch-health');
      }},io);
    const launcher=join(destination,'bin/ashlr');let shell:ConsumerInstallResult['shell'];
    try {
      const readings=await deps.discover(launcher);
      shell=['phm','ashlr'].map(name=>{
        const reading=readings.find(row=>row.name===name);
        const managed=reading?.target===launcher && reading.version===m.version && reading.versionSource==='executed-managed';
        return {name:name as 'phm'|'ashlr',state:managed?'managed':'setup-required',version:managed?m.version:null};
      });
    } catch {shell=[{name:'phm',state:'setup-required',version:null},{name:'ashlr',state:'setup-required',version:null}];}
    original(a);await packageReady(destination,a);assert.deepEqual(io.readCurrentPointer(current),switched);
    return result('installed',m.version,shell.every(row=>row.state==='managed')?null:'shell-setup-required',shell);
  } catch(error) {return result(phase==='rolled-back'?'rolled-back':phase===null?'held':'rollback-held',m.version,error instanceof Held?error.reason:'installation-unavailable');}
}

/** Closed verify/copy/open adapter; no signing, plist write, sudo or credential command. */
export function consumerInstallerOsCommand(bin: string, argv: readonly string[]): boolean {
  if (bin==='/usr/bin/ditto') return argv.length===2 && argv.every(path=>path.startsWith('/'));
  if (bin==='/usr/bin/open') return argv.length===1 && argv[0]==='/Applications/Phantom.app';
  if (bin==='/bin/ps') return canonicalJson(argv)===canonicalJson(['-axww','-o','pid=,ppid=,lstart=,args=']);
  if (bin==='/usr/sbin/lsof') return argv.length===7 && argv[0]==='-nP' && argv[1]==='-a' && argv[2]==='-p' &&
    /^[1-9]\d*$/.test(argv[3]!) && argv[4]==='-iTCP:7777' && argv[5]==='-sTCP:LISTEN' && argv[6]==='-Fp';
  if (bin==='/usr/bin/codesign') return argv.length===5 && argv[0]==='--verify' && argv[1]==='--deep' && argv[2]==='--strict' &&
    /^-R=identifier "ai\.ashlr\.desktop" and certificate leaf = H"[A-F0-9]{40}"$/.test(argv[3]!) && argv[4]!.startsWith('/');
  if (bin==='/usr/bin/plutil') return argv.length===6 && argv[0]==='-extract' &&
    ['CFBundleIdentifier','CFBundleExecutable','CFBundleName','CFBundleDisplayName','CFBundleShortVersionString','CFBundleVersion'].includes(argv[1]!) &&
    argv[2]==='raw' && argv[3]==='-o' && argv[4]==='-' && argv[5]!.startsWith('/');
  return false;
}

/** Startup output is untrusted discovery data; only this invocation's two rows count. */
export function parseConsumerShellTargets(text: string, nonce: string): Readonly<Record<'phm'|'ashlr',string|null>> | null {
  if (!/^[a-f0-9]{32}$/.test(nonce) || Buffer.byteLength(text)>16*1024) return null;
  const prefix=`PHANTOM_DESKTOP_${nonce}_`,rows=text.split('\n').filter(row=>row.startsWith(prefix));
  if (rows.length!==2) return null;
  const targets:{phm:string|null;ashlr:string|null}={phm:null,ashlr:null},seen=new Set<string>();
  for(const row of rows) {
    const body=row.slice(prefix.length),match=/^(PHM|ASHLR)=(\/.*|)$/.exec(body);
    if (!match || match[0]!==body || [...body].some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127) || seen.has(match[1]!)) return null;
    seen.add(match[1]!);targets[match[1]!.toLowerCase() as 'phm'|'ashlr']=match[2]||null;
  }
  return Object.freeze(targets);
}
export function createConsumerInstallDependencies(): ConsumerInstallDependencies {
  const packageRoot=runningPackageRoot();require(packageRoot,'compiled-package-required');
  const packageFile=join(packageRoot,'package.json'),identityFile=join(packageRoot,'dist/build-identity.json');
  const pinnedPackage=regular(packageFile,1024*1024),pinnedIdentity=regular(identityFile,128*1024);
  const pkg=JSON.parse(pinnedPackage.data.toString('utf8')) as {name: string;version:string};
  const identity=parseBuildIdentity(pinnedIdentity.data.toString('utf8'));
  require(pkg.name==='@ashlr/phantom' && identity?.packageVersion===pkg.version && identity.provenance==='git' && identity.dirty===false && identity.revision,'running-release');
  const home=userInfo().homedir,env={HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C',LC_ALL:'C'};
  const initialSurface=verifyAuthoritySurfaceAt(packageRoot,'running',{fresh:true});require(initialSurface.ok,'running-source-changed');
  const assertRunning=()=> {
    const checked=verifyAuthoritySurfaceAt(packageRoot,'running',{fresh:true});
    require(checked.ok && checked.digest===initialSurface.digest &&
      same(regular(packageFile,1024*1024).identity,pinnedPackage.identity) &&
      regular(packageFile,1024*1024).data.equals(pinnedPackage.data) &&
      same(regular(identityFile,128*1024).identity,pinnedIdentity.identity) &&
      regular(identityFile,128*1024).data.equals(pinnedIdentity.data),'running-source-changed');
  };
  assertRunning();
  const readManagedVersion=async(managed:string):Promise<string|null>=> {
    const read=spawnSync(process.execPath,[managed,'--version'],{encoding:'utf8',timeout:5000,maxBuffer:1024,env});
    return !read.error && read.status===0 && read.stdout.trim()===pkg.version?pkg.version:null;
  };
  return {home,platform:process.platform,architecture:process.arch,packageRoot,version:pkg.version,revision:identity.revision,authoritySurfaceDigest:initialSurface.digest!,trust:getDesktopUpdateTrustForProfile('canonical-v2'),assertRunning,
    download:downloadQualifiedUpdateArtifact,readManagedVersion,
    transaction:async()=> {
      const helper=await loadInstalledDesktopTransaction(packageRoot) as unknown as ConsumerTransaction;
      return {...helper,createLocalAppTransactionIo:options=> {
        const io=helper.createLocalAppTransactionIo(options);io.exec=(bin:string,argv:string[])=> {
          require(consumerInstallerOsCommand(bin,argv),'os-command-refused');
          const child=spawnSync(bin,argv,{cwd:packageRoot,encoding:'utf8',timeout:120_000,maxBuffer:1024*1024,env});
          return {status:child.error?1:child.status??1,stdout:child.stdout??''};
        };return io;
      }};
    },
    discover:async(managed)=> {
      const shell=userInfo().shell;require(typeof shell==='string' && shell.startsWith('/'),'shell-discovery');
      const nonce=randomBytes(16).toString('hex'),prefix=`PHANTOM_DESKTOP_${nonce}_`;
      const probe=spawnSync(shell,['-l','-c',`printf "\\n${prefix}PHM=%s\\n${prefix}ASHLR=%s\\n" "$(command -v phm)" "$(command -v ashlr)"`],{encoding:'utf8',timeout:5000,maxBuffer:16*1024,env});
      if(probe.error||probe.status!==0)throw new Held('shell-discovery');
      const targets=parseConsumerShellTargets(probe.stdout,nonce);require(targets,'shell-discovery');
      const managedVersion=await readManagedVersion(managed);
      return (['phm','ashlr'] as const).map(name=> {
        let target:string|null=null,version:string|null=null;
        try {if(targets[name])target=fs.realpathSync(targets[name]);} catch { /* Unknown paths stay setup required. */ }
        if(target===managed) {
          // The fixed launcher is proved immediately before entering discovery.
          // Do not execute a login-shell target outside that managed release.
          version=managedVersion;
        }
        return {name,target,version,versionSource:version?'executed-managed':'unknown'};
      });
    }};
}

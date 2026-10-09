/** Host-owned, exec-in-place launcher for metadata collection only.
 * Its child publishes identity before exec, independently of the collector's
 * spawn callback. No command, environment, input or provider result is stored. */
import { constants, fstatSync, lstatSync, openSync, closeSync, readSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { verifiedProcessStartIdentity } from '../fleet/local-store-lock.js';
import { inspectPrivateDirectory } from '../universe/artifacts.js';
import { fsyncDirectory } from '../util/durability.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BYTES = 4096;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

// Builtins only, like the existing native-profile launcher. Node's execve
// retains the registered PID/group and the original stdio; there is no shell
// or second process leader between identity publication and provider exec.
export const NATIVE_METADATA_LAUNCH_SOURCE = String.raw`import * as fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {Socket} from 'node:net';
import {execFileSync} from 'node:child_process';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const hash=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const file=p=>{const s=fs.lstatSync(p,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1n||s.uid!==BigInt(process.getuid())||(s.mode&511n)!==384n||s.size<1n||s.size>65536n)throw Error();return s;};
const read=p=>{const s=file(p),fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{if(!same(s,fs.fstatSync(fd,{bigint:true})))throw Error();const b=Buffer.alloc(65537),n=fs.readSync(fd,b,0,b.length,0);if(n<1||n>65536||!same(s,file(p))||!same(s,fs.fstatSync(fd,{bigint:true})))throw Error();return b.subarray(0,n);}finally{fs.closeSync(fd);}};
const directory=p=>{const s=fs.lstatSync(p,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(p)!==p||s.uid!==BigInt(process.getuid())||(s.mode&511n)!==448n)throw Error();return s;};
const sync=p=>{const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const write=(p,v)=>{const tmp=p+'.'+randomUUID()+'.tmp',b=Buffer.from(JSON.stringify(v)+'\n');if(b.length>4096)throw Error();let fd;try{fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,384);let n=0;while(n<b.length){const w=fs.writeSync(fd,b,n,b.length-n);if(w<1)throw Error();n+=w;}fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.linkSync(tmp,p);fs.unlinkSync(tmp);sync(dirname(p));}finally{if(fd!==undefined)fs.closeSync(fd);}};
const ps=pid=>{const value=execFileSync('/bin/ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:1000,maxBuffer:4096,stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}}).trim();const second=Math.floor(Date.parse(value)/1000);if(!Number.isSafeInteger(second)||second<1)throw Error();return BigInt(second).toString(16).padStart(64,'0');};
let ticket,registration;
try{
 if(process.platform!=='darwin'||typeof process.execve!=='function')throw Error();
 const ticketPath=process.argv[2],script=fileURLToPath(import.meta.url),root=dirname(ticketPath);
 const original=read(ticketPath);ticket=JSON.parse(original);const ticketDigest=hash(original);
 const check=()=>{const d=directory(root);if(d.dev.toString()!==ticket.root.dev||d.ino.toString()!==ticket.root.ino||hash(read(ticketPath))!==ticketDigest||hash(read(script))!==ticket.launcher.sha256)throw Error();
  const pending=root+'/.resource-quota-refresh-pending.json',s=file(pending);if(s.dev.toString()!==ticket.pending.dev||s.ino.toString()!==ticket.pending.ino||hash(read(pending))!==ticket.pending.bytesDigest)throw Error();};
 const reservation=phase=>{const a=JSON.parse(read(root+'/.resource-quota-refresh-activity.json'));if(a.schemaVersion!==3||a.ownerToken!==ticket.owner.token||a.ownerIdentity?.pid!==ticket.owner.pid||a.ownerIdentity?.startRef!==ticket.owner.startRef||a.pending?.dev!==ticket.pending.dev||a.pending?.ino!==ticket.pending.ino||!Array.isArray(a.reservations)||a.reservations.length>2)throw Error();const entries=a.reservations.filter(v=>v.id===ticket.id);if(entries.length!==1||entries[0].launchId!==ticket.id||entries[0].phase!==phase||entries[0].pgid!==(phase==='registered'?process.pid:null))throw Error();};
 check();reservation('preparing');
 const self=ps(process.pid);registration={schemaVersion:1,scope:'native-metadata-child',ticketDigest,pid:process.pid,pgid:process.pid,startRef:self,startRefSource:'ps-lstart'};
 const group=execFileSync('/bin/ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8',timeout:1000,maxBuffer:4096,stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}}).trim();if(Number(group)!==process.pid)throw Error();
 write(ticketPath+'.registered',registration);
 const notStarted=()=>{check();write(ticketPath+'.not-started',{schemaVersion:1,scope:'native-metadata-not-started',ticketDigest,registrationDigest:hash(read(ticketPath+'.registered'))});};
 // The control pipe is separate from provider stdin. EOF after owner death
 // never authorizes exec. Publish identity even when its notification fails.
 const control=new Socket({fd:3,readable:true,writable:true});
 const packet=await new Promise((resolve,reject)=>{let data=Buffer.alloc(0);const stopped=()=>{try{notStarted();}catch{}process.exit(125);};
  control.once('end',stopped);control.once('error',stopped);
  control.on('data',b=>{data=Buffer.concat([data,b]);if(data.length>1048576){reject(Error());return;}const end=data.indexOf(10);if(end>=0){try{if(end!==data.length-1)throw Error();resolve(JSON.parse(data.subarray(0,end)));}catch{reject(Error());}}});
  control.write(ticketDigest+'\n');});
 control.removeAllListeners('end');control.removeAllListeners('error');control.on('error',()=>{});
 check();
 if(!packet||typeof packet!=='object'||Array.isArray(packet)||Object.keys(packet).length!==3||packet.ticketDigest!==ticketDigest||packet.pid!==process.pid||!Array.isArray(packet.argv)||packet.argv.length<1||packet.argv.some(v=>typeof v!=='string'||v.includes('\0'))||!packet.argv[0].startsWith('/'))throw Error();
 const lock=root+'/.resource-quota-refresh.lock',s=file(lock),owner=JSON.parse(read(lock));
 if(s.dev.toString()!==ticket.owner.dev||s.ino.toString()!==ticket.owner.ino||owner.token!==ticket.owner.token||owner.pid!==ticket.owner.pid||owner.startRef!==ticket.owner.startRef)throw Error();
 const current=ps(owner.pid),expected=BigInt('0x'+owner.startRef);if((BigInt('0x'+current)-expected>1n)||(expected-BigInt('0x'+current)>1n))throw Error();
 const boot=execFileSync('/usr/sbin/sysctl',['-n','kern.bootsessionuuid'],{encoding:'utf8',timeout:1000,maxBuffer:4096,stdio:['ignore','pipe','ignore'],env:{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'}}).trim().toLowerCase();if(boot!==ticket.bootIdentity.bootId)throw Error();
 check();reservation('registered');await new Promise(resolve=>{control.once('close',resolve);control.destroy();});process.execve(packet.argv[0],packet.argv,{...process.env});
}catch{process.stderr.write('Native metadata launch unavailable\n');process.exit(126);}
`;

export interface NativeMetadataLaunchBinding {
  owner: { token: string; pid: number; startRef: string; startRefSource: string; dev: string; ino: string };
  pending: { dev: string; ino: string; bytesDigest: string };
  bootIdentity: { bootId: string; machineDigest: string };
}
export interface NativeMetadataLaunchDescriptor {
  nodeExecutable: string; scriptPath: string; ticketPath: string; ticketDigest: string;
}
interface Ticket extends NativeMetadataLaunchBinding {
  schemaVersion: 1; scope: 'native-metadata-launch'; id: string;
  root: { dev: string; ino: string }; launcher: { sha256: string; dev: string; ino: string };
}
export interface NativeMetadataChildIdentity {
  schemaVersion: 1; scope: 'native-metadata-child'; ticketDigest: string;
  pid: number; pgid: number; startRef: string; startRefSource: 'ps-lstart';
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function privateStat(stat: BigIntStats, max: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(max) &&
    (stat.mode & 0o777n) === 0o600n && stat.uid === BigInt(process.getuid!());
}
function same(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function read(path: string, max = MAX_BYTES): { bytes: Buffer; stat: BigIntStats } {
  const before = lstatSync(path, { bigint: true }); if (!privateStat(before, max)) throw new Error('Native launch evidence unavailable');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!same(before, fstat(fd))) throw new Error();
    const bytes = Buffer.alloc(max + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count < 1 || count > max || !same(before, fstat(fd)) || !same(before, lstatSync(path, { bigint: true }))) throw new Error();
    return { bytes: bytes.subarray(0, count), stat: before };
  } finally { closeSync(fd); }
}
// Kept separate so the standalone launcher has no dependency on the broad
// collector/worker graph. Both readers pin fd and named inode around bytes.
const fstat = (fd: number) => fstatSync(fd, { bigint: true });
const paths = (root: string, id: string) => {
  if (!UUID.test(id)) throw new Error('Invalid native launch reservation');
  const ticketPath = join(root, `.resource-quota-launch-${id}.json`);
  return { ticketPath, scriptPath: `${ticketPath}.mjs`, registrationPath: `${ticketPath}.registered`, cancelPath: `${ticketPath}.not-started` };
};
export function nativeMetadataLaunchSupported(): boolean {
  // A compiled Bun sidecar's execPath is the application, not a Node .mjs
  // interpreter. execve presence alone cannot establish that launch contract.
  return process.platform === 'darwin' && process.release.name === 'node' &&
    process.versions.bun === undefined && typeof process.execve === 'function';
}
export function createNativeMetadataLaunch(root: string, id: string, binding: NativeMetadataLaunchBinding): NativeMetadataLaunchDescriptor {
  if (!nativeMetadataLaunchSupported() || !isAbsolute(root) || resolve(root) !== root) throw new Error('Native launch unsupported');
  inspectPrivateDirectory(root);
  const p = paths(root, id), st = lstatSync(root, { bigint: true });
  const script = NATIVE_METADATA_LAUNCH_SOURCE;
  // Exclusive final names: retained unknown tickets are never reused/replaced.
  for (const path of Object.values(p)) { try { lstatSync(path); throw new Error('Native launch already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  writePrivateFileAtomically(`${p.scriptPath}.${randomUUID()}.tmp`, p.scriptPath, script,
    { anchorPath: root, label: 'Native metadata launcher' });
  const image = read(p.scriptPath, 65536);
  const ticket: Ticket = { schemaVersion: 1, scope: 'native-metadata-launch', id, ...structuredClone(binding),
    root: { dev: st.dev.toString(), ino: st.ino.toString() },
    launcher: { sha256: sha(script), dev: image.stat.dev.toString(), ino: image.stat.ino.toString() } };
  const bytes = JSON.stringify(ticket) + '\n'; if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error();
  writePrivateFileAtomically(`${p.ticketPath}.${randomUUID()}.tmp`, p.ticketPath, bytes,
    { anchorPath: root, label: 'Native metadata launch ticket' });
  return Object.freeze({ nodeExecutable: realpathSync(process.execPath), scriptPath: p.scriptPath, ticketPath: p.ticketPath, ticketDigest: sha(bytes) });
}

/** Recovery evidence only. Never contacts a provider, acquires a lease or signals a child. */
export function inspectNativeMetadataLaunch(root: string, id: string, binding: NativeMetadataLaunchBinding): NativeMetadataChildIdentity & { registrationDigest: string } {
  inspectPrivateDirectory(root);
  const p = paths(root, id), raw = read(p.ticketPath), ticket: unknown = JSON.parse(raw.bytes.toString('utf8'));
  if (!exact(ticket, ['schemaVersion', 'scope', 'id', 'owner', 'pending', 'bootIdentity', 'root', 'launcher']) ||
    ticket.schemaVersion !== 1 || ticket.scope !== 'native-metadata-launch' || ticket.id !== id ||
    JSON.stringify(ticket.owner) !== JSON.stringify(binding.owner) || JSON.stringify(ticket.pending) !== JSON.stringify(binding.pending) ||
    JSON.stringify(ticket.bootIdentity) !== JSON.stringify(binding.bootIdentity) ||
    !exact(ticket.root, ['dev', 'ino']) || !exact(ticket.launcher, ['sha256', 'dev', 'ino']) ||
    ticket.launcher.sha256 !== sha(NATIVE_METADATA_LAUNCH_SOURCE)) throw new Error('Native launch binding changed');
  const directory = lstatSync(root, { bigint: true }), image = read(p.scriptPath, 65536);
  if (directory.dev.toString() !== ticket.root.dev || directory.ino.toString() !== ticket.root.ino ||
    image.stat.dev.toString() !== ticket.launcher.dev || image.stat.ino.toString() !== ticket.launcher.ino ||
    sha(image.bytes) !== ticket.launcher.sha256) throw new Error('Native launcher changed');
  const registered = read(p.registrationPath), identity: unknown = JSON.parse(registered.bytes.toString('utf8'));
  if (!exact(identity, ['schemaVersion', 'scope', 'ticketDigest', 'pid', 'pgid', 'startRef', 'startRefSource']) ||
    identity.schemaVersion !== 1 || identity.scope !== 'native-metadata-child' || identity.ticketDigest !== sha(raw.bytes) ||
    !Number.isSafeInteger(identity.pid) || Number(identity.pid) < 1 || identity.pgid !== identity.pid ||
    typeof identity.startRef !== 'string' || !HASH.test(identity.startRef) || identity.startRefSource !== 'ps-lstart') throw new Error('Native child identity unavailable');
  try {
    const cancelled: unknown = JSON.parse(read(p.cancelPath).bytes.toString('utf8'));
    if (!exact(cancelled, ['schemaVersion', 'scope', 'ticketDigest', 'registrationDigest']) || cancelled.schemaVersion !== 1 ||
      cancelled.scope !== 'native-metadata-not-started' || cancelled.ticketDigest !== sha(raw.bytes) ||
      cancelled.registrationDigest !== sha(registered.bytes)) throw new Error('Native child settlement changed');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { ...identity as unknown as NativeMetadataChildIdentity, registrationDigest: sha(registered.bytes) };
}
export function confirmNativeMetadataLaunch(root: string, id: string, binding: NativeMetadataLaunchBinding, pid: number): void {
  const identity = inspectNativeMetadataLaunch(root, id, binding);
  const observed = verifiedProcessStartIdentity(pid, { requiredSource: 'ps-lstart' });
  if (identity.pid !== pid || observed?.ref !== identity.startRef) throw new Error('Native child registration changed');
}
/** Called only after exact group absence and ordinary lease ownership checks. */
export function retireNativeMetadataLaunch(root: string, id: string): void {
  const p = paths(root, id);
  for (const path of [p.cancelPath, p.registrationPath, p.ticketPath, p.scriptPath]) {
    try { const before = read(path, path === p.scriptPath ? 65536 : MAX_BYTES); if (!same(before.stat, lstatSync(path, { bigint: true }))) throw new Error(); unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  fsyncDirectory(root);
}

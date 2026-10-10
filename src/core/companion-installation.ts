/** Explicit offline installation into a fresh version slot. Never executes companion payloads. */
import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { COMPANION_RELEASES } from './companion-inventory.js';
import { planCompanionProvisioning, type CompanionProvisioningOptions,
  type CompanionProvisioningPlan } from './companion-provisioning.js';

export interface CompanionInstallationOptions extends CompanionProvisioningOptions {
  /** Existing, reviewed absolute Python interpreter. No PATH lookup or runtime installation. */
  pythonPath: string;
}
export interface CompanionInstallationResult {
  schemaVersion: 1;
  status: 'installed' | 'blocked' | 'indeterminate';
  installed: boolean;
  runtimeCapability: 'not-inspected';
  effects: string[];
  blockers: string[];
  artifact: CompanionProvisioningPlan['artifact'];
  destination: string | null;
  entrypoint: string | null;
  manifestSha256: string | null;
  /** Operations address this directory inode, even if another same-UID process relocates it. */
  anchor: { device: number; inode: number } | null;
}

// Node has no openat/mkdirat/renameat-with-no-replace API. This follows the isolated Python/native
// syscall pattern in scripts/local-app-transaction.mjs; all artifact/destination I/O is fd-relative.
// The security boundary excludes a hostile process with the same UID (which can mutate any owned
// inode). Private directories and held descriptors stop other principals and pathname redirection;
// they cannot guarantee that a same-UID process preserves an ancestor's absolute pathname.
const INSTALLER = String.raw`
import ctypes, hashlib, json, os, secrets, stat, sys

class Blocked(Exception): pass
def refuse(reason): raise Blocked(reason)
def identity(s): return (s.st_dev, s.st_ino)
def unchanged(a, b):
 return (a.st_dev,a.st_ino,a.st_mode,a.st_size,a.st_mtime_ns,a.st_ctime_ns,a.st_nlink) == (b.st_dev,b.st_ino,b.st_mode,b.st_size,b.st_mtime_ns,b.st_ctime_ns,b.st_nlink)
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
def root(path):
 fd = os.open('/', DIR)
 try:
  for part in path.split('/')[1:]:
   nxt = os.open(part, DIR, dir_fd=fd); os.close(fd); fd = nxt
  return fd
 except BaseException:
  os.close(fd); raise
def descend(fd, parts, create=False):
 current = os.dup(fd)
 try:
  for part in parts:
   if create:
    try: os.mkdir(part, 0o700, dir_fd=current)
    except FileExistsError: pass
   nxt = os.open(part, DIR, dir_fd=current)
   info = os.fstat(nxt)
   if create and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
    os.close(nxt); refuse('unsafe-staging-directory')
   os.close(current); current = nxt
  return current
 except BaseException:
  os.close(current); raise
def read_verified(fd, relative, expected, size, mode=None):
 parts = relative.split('/'); parent = descend(fd, parts[:-1]); filefd = None
 try:
  before = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
  if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1: refuse('unsafe-source-file')
  if before.st_size > size: refuse('artifact-size-limit')
  if mode is not None and stat.S_IMODE(before.st_mode) != mode: refuse('source-mode-mismatch')
  filefd = os.open(parts[-1], READ, dir_fd=parent)
  if not unchanged(before,os.fstat(filefd)): refuse('source-changed-during-installation')
  data = bytearray(); digest = hashlib.sha256()
  while True:
   chunk = os.read(filefd, min(65536,size + 1 - len(data)))
   if not chunk: break
   data.extend(chunk); digest.update(chunk)
   if len(data) > size: refuse('artifact-size-limit')
  after = os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
  if not unchanged(before,after) or not unchanged(before,os.fstat(filefd)): refuse('source-changed-during-installation')
  if digest.hexdigest() != expected or (mode is not None and len(data) != size): refuse('artifact-digest-mismatch')
  return bytes(data)
 finally:
  if filefd is not None: os.close(filefd)
  os.close(parent)
def no_replace():
 try:
  if sys.platform == 'darwin':
   lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True); fn = lib.renameatx_np; flags = 4
  elif sys.platform.startswith('linux'):
   lib = ctypes.CDLL(None,use_errno=True); fn = lib.renameat2; flags = 1
  else: refuse('unsupported-native-platform')
 except (AttributeError,OSError): refuse('exclusive-publication-unavailable')
 fn.argtypes = [ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]; fn.restype = ctypes.c_int
 return lambda fd, source, target: fn(fd,os.fsencode(source),fd,os.fsencode(target),flags)
def verify_stage(fd, files):
 expected = {f['path'] for f in files}; found = set()
 def visit(directory, prefix):
  for name in os.listdir(directory):
   path = prefix + name; info = os.stat(name,dir_fd=directory,follow_symlinks=False)
   if stat.S_ISDIR(info.st_mode):
    if not any(f.startswith(path + '/') for f in expected): refuse('unexpected-staging-content')
    child = os.open(name,DIR,dir_fd=directory)
    try: visit(child,path + '/')
    finally: os.close(child)
   elif stat.S_ISREG(info.st_mode) and info.st_nlink == 1: found.add(path)
   else: refuse('unsafe-staging-content')
  os.fsync(directory)
 visit(fd,'')
 if found != expected: refuse('unexpected-staging-content')
 for file in files: read_verified(fd,file['path'],file['sha256'],file['bytes'],file['mode'])
def clean_stage(fd, files):
 # Remove only our known names through held descriptors. Never recursively remove an unknown tree.
 for file in reversed(files):
  try: parent = descend(fd,file['path'].split('/')[:-1])
  except FileNotFoundError: continue
  try: os.unlink(file['path'].split('/')[-1],dir_fd=parent)
  except FileNotFoundError: pass
  finally: os.close(parent)
 dirs = set()
 for file in files:
  parts = file['path'].split('/')[:-1]
  for i in range(1,len(parts)+1): dirs.add('/'.join(parts[:i]))
 for directory in sorted(dirs,key=lambda p:p.count('/'),reverse=True):
  parts = directory.split('/')
  try: parent = descend(fd,parts[:-1])
  except FileNotFoundError: continue
  try: os.rmdir(parts[-1],dir_fd=parent)
  except FileNotFoundError: pass
  finally: os.close(parent)

request = json.load(sys.stdin); sourcefd = destinationfd = stagefd = None
stage = None; published = False; effects = []; anchor = None; files = []
try:
 rename = no_replace()
 sourcefd = root(request['artifactRoot']); destinationfd = root(request['destinationRoot'])
 info = os.fstat(destinationfd); anchor = {'device':info.st_dev,'inode':info.st_ino}
 if info.st_uid != os.geteuid() or info.st_mode & 0o077: refuse('destination-must-be-owned-and-private')
 raw = read_verified(sourcefd,request['manifestPath'],request['trustedManifestSha256'],262144)
 manifest = json.loads(raw)
 # Node's strictly parsed plan is bound to the exact manifest digest again inside this process.
 if manifest != request['manifest']: refuse('manifest-changed-during-installation')
 files = manifest['files']; target = request['targetName']
 try: os.stat(target,dir_fd=destinationfd,follow_symlinks=False); refuse('destination-already-exists')
 except FileNotFoundError: pass
 # Capture all verified bytes before creating anything. Payloads remain data, never executed.
 payloads = [read_verified(sourcefd,f['path'],f['sha256'],f['bytes'],f['mode']) for f in files]
 stage = '.phm-stage-' + secrets.token_hex(16); os.mkdir(stage,0o700,dir_fd=destinationfd)
 effects.append('temporary-staging-created'); stagefd = os.open(stage,DIR,dir_fd=destinationfd)
 stage_identity = identity(os.fstat(stagefd))
 for file,data in zip(files,payloads):
  parts = file['path'].split('/'); parent = descend(stagefd,parts[:-1],True); filefd = None
  try:
   filefd = os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=parent)
   offset = 0
   while offset < len(data):
    count = os.write(filefd,data[offset:offset+65536])
    if count <= 0: refuse('artifact-write-failed')
    offset += count
   os.fchmod(filefd,file['mode']); os.fsync(filefd)
   if os.fstat(filefd).st_nlink != 1: refuse('unsafe-staging-content')
  finally:
   if filefd is not None: os.close(filefd)
   os.close(parent)
 verify_stage(stagefd,files); os.fsync(stagefd)
 if identity(os.stat(stage,dir_fd=destinationfd,follow_symlinks=False)) != stage_identity: refuse('staging-identity-changed')
 # Refuse a relocated destination before publication; final authority remains the held inode.
 checkfd = root(request['destinationRoot'])
 try:
  if identity(os.fstat(checkfd)) != identity(info): refuse('destination-anchor-changed')
 finally: os.close(checkfd)
 if rename(destinationfd,stage,target) != 0:
  error = ctypes.get_errno()
  if error in (17,39,66): refuse('destination-already-exists')
  refuse('exclusive-publication-failed')
 published = True; effects.append('immutable-release-directory-created')
 if identity(os.stat(target,dir_fd=destinationfd,follow_symlinks=False)) != stage_identity: refuse('published-identity-changed')
 verify_stage(stagefd,files); os.fsync(destinationfd)
 print(json.dumps({'status':'installed','installed':True,'blockers':[],'effects':effects,'anchor':anchor}))
except BaseException as error:
 reason = str(error) if isinstance(error,Blocked) else 'native-filesystem-operation-failed'
 if stage is not None and stagefd is not None and not published:
  try:
   clean_stage(stagefd,files)
   if identity(os.stat(stage,dir_fd=destinationfd,follow_symlinks=False)) != identity(os.fstat(stagefd)):
    refuse('staging-identity-changed')
   os.rmdir(stage,dir_fd=destinationfd); effects.append('temporary-staging-removed')
  except BaseException: effects.append('staging-cleanup-held')
 elif stage is not None and not published: effects.append('staging-cleanup-held')
 status = 'indeterminate' if published or 'staging-cleanup-held' in effects else 'blocked'
 print(json.dumps({'status':status,'installed':False,'blockers':[reason],'effects':effects,'anchor':anchor}))
finally:
 for fd in (stagefd,destinationfd,sourcefd):
  if fd is not None: os.close(fd)
`;

/** Fresh-slot-only, explicitly selected runtime. No downloads, PATH edits, secrets or trust grants. */
export async function installCompanionArtifact(options: CompanionInstallationOptions): Promise<CompanionInstallationResult> {
  const plan = planCompanionProvisioning(options);
  const result: CompanionInstallationResult = { schemaVersion: 1, status: 'blocked', installed: false,
    runtimeCapability: 'not-inspected', effects: [], blockers: plan.blockers, artifact: plan.artifact,
    destination: plan.destination, entrypoint: null, manifestSha256: plan.manifestSha256, anchor: null };
  if (plan.status !== 'verified-plan') return result;
  if (!['darwin', 'linux'].includes(process.platform)) return { ...result, blockers: ['unsupported-native-platform'] };
  try {
    if (!isAbsolute(options.pythonPath) || resolve(options.pythonPath) !== options.pythonPath ||
      realpathSync(options.pythonPath) !== options.pythonPath) throw new Error('unsafe-runtime');
    let runtimeParent = '/';
    for (const component of options.pythonPath.split('/').slice(1, -1)) {
      runtimeParent = join(runtimeParent, component);
      const directory = lstatSync(runtimeParent);
      if (!directory.isDirectory() || ![0, process.getuid?.()].includes(directory.uid) ||
        ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0)) throw new Error('unsafe-runtime-parent');
    }
    const runtime = lstatSync(options.pythonPath);
    // macOS's root-owned developer-tool launcher legitimately has multiple hardlinks. A caller-
    // owned runtime must be a single inode link; neither kind may be writable by other principals.
    if (!runtime.isFile() || (runtime.nlink !== 1 && runtime.uid !== 0) || (runtime.mode & 0o022) !== 0 ||
      (runtime.mode & 0o111) === 0 || ![0, process.getuid?.()].includes(runtime.uid)) throw new Error('unsafe-runtime');
  } catch { return { ...result, blockers: ['reviewed-absolute-python-runtime-required'] }; }
  // The complete manifest is already pinned and strictly parsed by the planner. Construct only its
  // accepted schema; the native helper binds these fields to a fresh digest before any writes.
  const artifact = plan.artifact!;
  const request = { artifactRoot: options.artifactRoot, destinationRoot: options.destinationRoot,
    manifestPath: options.manifestPath, trustedManifestSha256: options.trustedManifestSha256,
    targetName: `${artifact.tool}-${artifact.version}-${artifact.platform}`,
    manifest: { schemaVersion: 1, ...artifact,
      releaseUrl: COMPANION_RELEASES.find(item => item.id === artifact.tool)!.releaseUrl, format: 'expanded-file-set',
      qualification: 'qualified', files: plan.files.map(({ path, sha256, bytes, mode }) => ({ path, sha256, bytes, mode })) } };
  return new Promise(resolveResult => {
    let stdout = ''; let settled = false;
    // -B prevents stdlib bytecode-cache writes outside the explicit destination anchor.
    const child = spawn(options.pythonPath, ['-I', '-S', '-B', '-c', INSTALLER], {
      env: { LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'ignore'], cwd: '/' });
    const finish = (value: CompanionInstallationResult): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolveResult(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ...result, status: 'indeterminate', blockers: ['native-installer-timeout'], effects: ['native-installation-outcome-unknown'] });
    }, 60_000);
    child.on('error', () => finish({ ...result, blockers: ['native-installer-unavailable'] }));
    child.stdin.on('error', () => { /* A child exit is accounted for by close. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 16_384) {
        child.kill('SIGKILL');
        finish({ ...result, status: 'indeterminate', blockers: ['invalid-native-installer-receipt'], effects: ['native-installation-outcome-unknown'] });
      }
    });
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error('native-exit');
        const receipt = JSON.parse(stdout) as Partial<CompanionInstallationResult>;
        if (!['installed', 'blocked', 'indeterminate'].includes(receipt.status ?? '') ||
          receipt.installed !== (receipt.status === 'installed') || !Array.isArray(receipt.blockers) ||
          !Array.isArray(receipt.effects) || !receipt.blockers.every(item => typeof item === 'string') ||
          !receipt.effects.every(item => typeof item === 'string')) throw new Error('native-receipt');
        finish({ ...result, ...receipt, entrypoint: receipt.installed ? join(plan.destination!, artifact.entrypoint) : null });
      } catch {
        finish({ ...result, status: 'indeterminate', blockers: ['native-installer-outcome-unavailable'], effects: ['native-installation-outcome-unknown'] });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

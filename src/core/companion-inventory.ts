/** Value-blind executable inventory. Version/help evidence never grants execution authority. */
import { execFile } from 'node:child_process';
import { constants, accessSync, closeSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

export type CompanionId = 'secrets' | 'locus' | 'lexicon';
export type CompanionStatus = 'missing' | 'ambiguous' | 'unsupported-launcher' | 'probe-failed' | 'wrong-product' | 'unsupported-version' | 'known-interface';
interface CompanionRelease {
  id: CompanionId;
  name: string;
  binary: string;
  version: string;
  sourceCommit: string;
  releaseUrl: string;
  contract: string;
}

/** Exact reviewed release surfaces; newer versions require their own contract review. */
export const COMPANION_RELEASES: readonly CompanionRelease[] = Object.freeze([
  { id: 'secrets', name: 'Phantom Secrets', binary: 'phantom', version: '0.7.9',
    sourceCommit: '7a51ce512ec4aee12cc29ff859036af63fbe93db',
    releaseUrl: 'https://github.com/ashlrai/phantom-secrets/releases/tag/v0.7.9',
    contract: 'Separate phantom CLI; metadata readiness and supervised exec require separate verification.' },
  { id: 'locus', name: 'Locus', binary: 'locus', version: '0.5.0',
    sourceCommit: 'e7bced3cd4cb4adf08bbba020f2e05f163b55941',
    releaseUrl: 'https://github.com/ashlrai/locus/releases/tag/v0.5.0',
    contract: 'Identity CLI; pin, tenant, MCP and session readiness are not inspected.' },
  { id: 'lexicon', name: 'Lexicon', binary: 'lexicon', version: '0.5.4',
    sourceCommit: '6ebc0721e33de2dafafbb54d89a6af50a362046a',
    releaseUrl: 'https://github.com/ashlrai/lexicon/releases/tag/v0.5.4',
    contract: 'Voice correction CLI; project trust and native service availability are not inspected.' },
]);

export interface CompanionInfo {
  id: CompanionId;
  name: string;
  binary: string;
  installed: boolean;
  bundled: false;
  path: string | null;
  candidates: string[];
  version: string | null;
  status: CompanionStatus;
  compatibility: 'known-cli-surface' | 'unknown';
  runtimeCapability: 'not-inspected';
  guidance: string;
  reviewedRelease: { version: string; sourceCommit: string; url: string; contract: string };
}

export interface CompanionInventory {
  schemaVersion: 1;
  bundled: false;
  probe: 'version-help-only';
  companions: CompanionInfo[];
}

export interface CompanionInventoryOptions {
  /** Overrides PATH discovery entirely. Empty means no implicit candidates. */
  searchPaths?: string[];
  /** Overrides discovery for one tool, including an intentionally missing path. */
  binaries?: Partial<Record<CompanionId, string>>;
}

function candidatePaths(binary: string, directories: string[], explicit?: string): string[] {
  const paths = explicit !== undefined ? [explicit] : directories.flatMap(directory =>
    process.platform === 'win32' ? [join(directory, `${binary}.exe`), join(directory, `${binary}.cmd`)] : [join(directory, binary)]);
  const unique = new Set<string>();
  for (const path of paths) {
    try {
      if (!isAbsolute(path) || !statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      unique.add(realpathSync(path));
    } catch { /* A missing, dangling or unreadable candidate is unavailable. */ }
  }
  return [...unique];
}

/** Legacy npm bootstrap launchers install/download even for --version; do not execute them. */
function executableKind(path: string): 'native' | 'script' | 'bootstrap' | 'unknown' {
  if (/\.(?:cmd|bat)$/iu.test(path)) return 'bootstrap';
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, 4).toString('hex');
    if (header === '7f454c46' || ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe',
      'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header) ||
      buffer.subarray(0, 2).toString('ascii') === 'MZ') return 'native';
    const source = buffer.subarray(0, length).toString('utf8');
    if (!source.startsWith('#!')) return 'unknown';
    if (/downloadReleaseBinary|INSTALL_FROM_SOURCE|cargo\s+install\s+--git|npm\s+install|npx\s+/u.test(source)) return 'bootstrap';
    return /^#![^\r\n]*(?:\bnode|\bnodejs)(?:\s|$)/u.test(source) ? 'script' : 'unknown';
  } catch { return 'unknown'; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Never inherit provider credentials, user config roots or executable discovery PATH. */
function probeEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'data'),
    ASHLR_HOME: join(root, 'ashlr'), LOCUS_HOME: join(root, 'locus'),
    TMPDIR: root, TMP: root, TEMP: root, NO_COLOR: '1',
    PATH: [dirname(process.execPath), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(delimiter),
  };
  if (process.platform === 'win32' && process.env.SystemRoot && isAbsolute(process.env.SystemRoot)) {
    env.SystemRoot = process.env.SystemRoot;
    env.PATH += delimiter + join(process.env.SystemRoot, 'System32');
  }
  return env;
}

function probe(path: string, flag: '--version' | '--help', root: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise(resolve => {
    execFile(path, [flag], { cwd: root, env, encoding: 'utf8', timeout: 2_000,
      killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      // No raw stdout, stderr or exception is retained in the report.
      resolve(error ? null : stdout);
    });
  });
}

async function inspect(release: CompanionRelease, paths: string[], root: string, env: NodeJS.ProcessEnv,
  syntheticNativeCheck?: (path: string) => boolean): Promise<CompanionInfo> {
  const info: CompanionInfo = {
    id: release.id, name: release.name, binary: release.binary,
    installed: false, bundled: false, path: paths.length === 1 ? paths[0]! : null,
    candidates: paths, version: null, status: 'missing', compatibility: 'unknown',
    runtimeCapability: 'not-inspected',
    guidance: 'Install separately from the reviewed release after verifying its artifacts; this command installs nothing.',
    reviewedRelease: { version: release.version, sourceCommit: release.sourceCommit, url: release.releaseUrl, contract: release.contract },
  };
  if (paths.length === 0) return info;
  if (paths.length > 1) {
    info.status = 'ambiguous';
    info.guidance = `Multiple ${release.binary} executables found; select one absolute path with --${release.id}-bin.`;
    return info;
  }
  const kind = executableKind(paths[0]!);
  // Native-only for Secrets/Locus. The synthetic check is an internal fixture
  // seam and cannot override known bootstrap refusal; CLI callers never pass it.
  const native = kind === 'native' || (kind === 'script' && syntheticNativeCheck?.(paths[0]!) === true);
  if (kind === 'bootstrap' || (!native && !(release.id === 'lexicon' && kind === 'script'))) {
    info.status = 'unsupported-launcher';
    info.guidance = `Unsupported launcher. Select an installed native Secrets/Locus executable or trusted installed Lexicon Node entrypoint with --${release.id}-bin.`;
    return info;
  }
  const versionOutput = await probe(paths[0]!, '--version', root, env);
  if (versionOutput === null) {
    info.status = 'probe-failed';
    info.guidance = 'Version probe failed, exceeded its bounds or uses an unsupported launcher; select a trusted executable explicitly.';
    return info;
  }
  const helpOutput = await probe(paths[0]!, '--help', root, env);
  if (helpOutput === null) {
    info.status = 'probe-failed';
    info.guidance = 'Help probe failed or exceeded its bounds; compatibility remains unknown.';
    return info;
  }
  const versionPattern = release.id === 'lexicon'
    ? /^(?:lexicon\s+)?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)\s*$/u
    : new RegExp(`^${release.binary}\\s+(\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?)\\s*$`, 'u');
  const version = versionOutput.trim().match(versionPattern)?.[1] ?? null;
  const helpPattern = new RegExp(`^Usage:\\s+${release.binary}(?:\\s|$)`, 'imu');
  if (!helpPattern.test(helpOutput) || version === null) {
    info.status = 'wrong-product';
    info.guidance = `The executable did not identify the expected ${release.name} CLI; inspect its ownership before selecting a replacement.`;
    return info;
  }
  info.installed = true;
  info.version = version;
  if (version !== release.version) {
    info.status = 'unsupported-version';
    info.guidance = `Installed version has no reviewed contract here; compare with ${release.releaseUrl}. Do not infer runtime readiness.`;
    return info;
  }
  info.status = 'known-interface';
  info.compatibility = 'known-cli-surface';
  info.guidance = 'Version/help match the reviewed CLI identity. Runtime, MCP, credentials, project trust and authority remain uninspected.';
  return info;
}

export async function inventoryCompanions(options: CompanionInventoryOptions = {},
  syntheticNativeCheck?: (path: string) => boolean): Promise<CompanionInventory> {
  const directories = options.searchPaths ?? (process.env.PATH ?? '').split(delimiter).filter(isAbsolute);
  if (directories.length > 256 || directories.some(path => !isAbsolute(path)) ||
      Object.values(options.binaries ?? {}).some(path => path !== undefined && !isAbsolute(path))) {
    throw new Error('Companion paths must be absolute, with at most 256 search directories.');
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phm-companion-probe-')));
  try {
    const env = probeEnvironment(root);
    const companions = await Promise.all(COMPANION_RELEASES.map(release =>
      inspect(release, candidatePaths(release.binary, directories, options.binaries?.[release.id]), root, env, syntheticNativeCheck)));
    return { schemaVersion: 1, bundled: false, probe: 'version-help-only', companions };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

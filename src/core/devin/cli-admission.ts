/** Host-issued native CLI evidence. It is never an operator setting or a billing balance. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { devinCliCredentialsPath, probeDevinCli } from './cli-probe.js';
import { parseDevinModelsList } from './models.js';
import { DEVIN_CLI_FREE_MODELS, DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY } from './cli-engine.js';

const METADATA_MAX_AGE_MS = 60_000;
const RETRY_MS = 10 * 60_000;
// A conservative HOST evidence boundary, not the vendor's reset or expiry timezone.
// https://devin.ai/pricing promises SWE-2 Free through October 16, 2026, without a timezone.
const PROMOTIONAL_MODELS = new Set(DEVIN_CLI_FREE_MODELS);
const issued = new WeakSet<object>();
const entries = new Map<string, DevinCliExecutionBinding>();
const flights = new Map<string, Promise<DevinCliExecutionBinding | null>>();
const failures = new Map<string, number>();
let selected: DevinCliExecutionBinding | null = null;

export interface DevinCliExecutionBinding {
  readonly selectedPath: string;
  readonly executable: string;
  readonly executableSha256: string;
  readonly executableEpoch: string;
  readonly credentialsPath: string;
  readonly credentialsEpoch: string;
  /** Native principal consistency only. Never interpreted as the cloud organization or billing account. */
  readonly principalDigest: string;
  readonly principalBasis: 'user-id' | 'email';
  readonly teamDigest: string | null;
  readonly originDigest: string;
  readonly model: string;
  readonly contextTokens: number;
  readonly observedAt: number;
  readonly validUntil: number;
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function epoch(path: string, executable: boolean): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n ||
    stat.size > BigInt(executable ? 512 * 1024 * 1024 : 2 * 1024 * 1024) ||
    (stat.mode & 18n) !== 0n || (!executable && typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())) ||
    (executable && (stat.mode & 73n) === 0n) || realpathSync(path) !== path) throw new Error('unqualified native file');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].map(String).join(':');
}

/** Parse only identity metadata from the supported plaintext native status. No raw output survives. */
export function parseDevinCliPrincipal(text: string): Pick<DevinCliExecutionBinding, 'principalDigest' | 'principalBasis' | 'teamDigest' | 'originDigest'> | null {
  const clean = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''); // eslint-disable-line no-control-regex
  if (!/logged\s+in/i.test(clean) || /not\s+logged\s+in|logged\s+out/i.test(clean)) return null;
  const fields = new Map<string, string>();
  for (const line of clean.split(/\r?\n/)) {
    const match = /^\s*(User ID|Team ID|Email|API server|Devin API):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (fields.has(match[1]!) || Buffer.byteLength(match[2]!) > 4096 || /[\u0000-\u001f\u007f]/.test(match[2]!)) return null; // eslint-disable-line no-control-regex
    fields.set(match[1]!, match[2]!);
  }
  const usable = (s: string | undefined): s is string => Boolean(s && !['none', 'null', 'n/a', '-', '(none)'].includes(s.toLowerCase()));
  const user = fields.get('User ID'); const email = fields.get('Email');
  const principal = usable(user) ? user : usable(email) && /^[^\s@]+@[^\s@]+$/.test(email) ? email.toLowerCase() : null;
  if (!principal) return null;
  const origins: string[] = [];
  for (const key of ['API server', 'Devin API']) {
    const raw = fields.get(key);
    if (!usable(raw)) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !/^(?:[a-z0-9-]+\.)*(?:devin\.ai|codeium\.com)$/.test(url.hostname)) return null;
      origins.push(url.origin);
    } catch { return null; }
  }
  const team = fields.get('Team ID');
  return { principalDigest: digest(JSON.stringify(['devin-native-principal-v1', origins, usable(user) ? 'user-id' : 'email', principal])),
    principalBasis: usable(user) ? 'user-id' : 'email', teamDigest: usable(team) ? digest(team) : null,
    originDigest: digest(JSON.stringify(origins)) };
}

export interface DevinCliAdmissionOptions {
  /** Renew native metadata before a long-running role crosses its evidence TTL. */
  forceRefresh?: boolean;
  cliPath?: string;
  credentialsPath?: string;
  now?: () => number;
  signal?: AbortSignal;
  /** Existing caller-owned Stop/revision fence; never persisted. */
  admitted?: () => boolean;
  /** Hermetic subprocess seam; production uses the exact native executable. */
  runMetadata?: (executable: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

function admitted(opts: DevinCliAdmissionOptions): boolean {
  try { return !opts.signal?.aborted && (opts.admitted === undefined || opts.admitted() === true); } catch { return false; }
}
function nativeMetadata(executable: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, [...args], {
    env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...(signal ? { signal } : {}),
  }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
}

/** Cheap contact-time continuity. No provider request, credential contents or binary rehash. */
export function devinCliIdentityCurrent(binding: DevinCliExecutionBinding | null | undefined, model: string): binding is DevinCliExecutionBinding {
  if (!binding || !issued.has(binding) || binding.model !== model) return false;
  try { return realpathSync(binding.selectedPath) === binding.executable && epoch(binding.executable, true) === binding.executableEpoch &&
    epoch(binding.credentialsPath, false) === binding.credentialsEpoch; } catch { return false; }
}
/** Historical run settlement only. This proves launch continuity, never fresh
 * pricing, quota or permission to contact the provider again. */
export function peekDevinCliIdentityBinding(model: string): DevinCliExecutionBinding | null {
  if (selected?.credentialsPath !== devinCliCredentialsPath()) return null;
  for (const binding of entries.values()) {
    if (binding.executable === selected.executable && binding.credentialsPath === selected.credentialsPath &&
      devinCliIdentityCurrent(binding, model)) return binding;
  }
  return null;
}
export function devinCliBindingCurrent(binding: DevinCliExecutionBinding | null | undefined, model: string, now = Date.now()): binding is DevinCliExecutionBinding {
  return devinCliIdentityCurrent(binding, model) && Number.isFinite(now) && now >= binding.observedAt && now < binding.validUntil;
}
export function peekDevinCliExecutionBinding(model: string, now = Date.now()): DevinCliExecutionBinding | null {
  if (selected?.credentialsPath !== devinCliCredentialsPath()) return null;
  for (const binding of entries.values()) {
    if (binding.executable === selected.executable && binding.credentialsPath === selected.credentialsPath && devinCliBindingCurrent(binding, model, now)) return binding;
  }
  return null;
}

/** One same-tuple native auth/catalog refresh. Failed/unknown/fallback evidence cannot admit a spawn. */
export async function refreshDevinCliExecutionBinding(model: string, opts: DevinCliAdmissionOptions = {}): Promise<DevinCliExecutionBinding | null> {
  const now = opts.now ?? Date.now;
  // Tests must supply a hermetic metadata transport; never probe the operator's native account.
  if (!admitted(opts) || (process.env['VITEST'] && !opts.runMetadata)) return null;
  try {
    const selectedPath = opts.cliPath ?? (await probeDevinCli()).cliPath;
    if (!selectedPath) return null;
    const executable = realpathSync(selectedPath);
    const credentialsPath = opts.credentialsPath ?? devinCliCredentialsPath();
    if (basename(credentialsPath) !== 'credentials.toml' || basename(dirname(credentialsPath)) !== 'devin') return null;
    const executableEpoch = epoch(executable, true); const credentialsEpoch = epoch(credentialsPath, false);
    const key = JSON.stringify([selectedPath, executable, executableEpoch, credentialsPath, credentialsEpoch, model]);
    const cached = entries.get(key);
    if (!opts.forceRefresh && cached && devinCliBindingCurrent(cached, model, now()) && admitted(opts)) { selected = cached; return cached; }
    const failed = failures.get(key);
    if (failed !== undefined && now() >= failed && now() - failed < RETRY_MS) return null;
    if (!flights.has(key)) {
      const flight = (async () => {
        const startedAt = now();
        const env: NodeJS.ProcessEnv = {};
        for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'SYSTEMROOT', 'WINDIR']) if (process.env[name] !== undefined) env[name] = process.env[name];
        env['XDG_DATA_HOME'] = dirname(dirname(credentialsPath)); env['NO_COLOR'] = '1';
        const run = opts.runMetadata ?? ((bin, args, e) => nativeMetadata(bin, args, e, opts.signal));
        if (!admitted(opts)) return null;
        const principal = parseDevinCliPrincipal(await run(executable, ['auth', 'status'], env));
        if (!principal || !admitted(opts) || epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch) return null;
        // UI parsing normally de-duplicates IDs. Admission must retain contradictions.
        const catalog = parseDevinModelsList(await run(executable, ['models', 'list'], env), { retainDuplicateIds:true });
        if (catalog.declaredFamilyCount === null || catalog.declaredFamilyCount !== catalog.families.length) return null;
        const rows = catalog.families.flatMap(f => f.models).filter(m => m.id === model);
        if (rows.length !== 1 || !admitted(opts) || epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch) return null;
        const afterPrincipal = parseDevinCliPrincipal(await run(executable, ['auth', 'status'], env));
        if (!afterPrincipal || JSON.stringify(afterPrincipal) !== JSON.stringify(principal)) return null;
        const row = rows[0];
        const observedAt = now();
        if (!admitted(opts) || !row?.pricing.free || [row.pricing.inPerM, row.pricing.outPerM, row.pricing.cachedPerM].some(n => n !== null && n !== 0) ||
          !row.contextTokens || !Number.isSafeInteger(row.contextTokens) || observedAt < startedAt ||
          epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch || realpathSync(selectedPath) !== executable) return null;
        const validUntil = PROMOTIONAL_MODELS.has(model) ? Math.min(observedAt + METADATA_MAX_AGE_MS, DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY) : observedAt + METADATA_MAX_AGE_MS;
        if (!Number.isFinite(observedAt) || observedAt >= validUntil) return null;
        const executableSha256 = createHash('sha256').update(readFileSync(executable)).digest('hex');
        if (epoch(executable, true) !== executableEpoch || epoch(credentialsPath, false) !== credentialsEpoch) return null;
        const binding: DevinCliExecutionBinding = Object.freeze({ selectedPath, executable, executableSha256, executableEpoch,
          credentialsPath, credentialsEpoch, ...principal, model, contextTokens: row.contextTokens, observedAt, validUntil });
        issued.add(binding); entries.set(key, binding); return binding;
      })().catch(() => null).then(binding => {
        if (!binding && admitted(opts)) failures.set(key, now());
        return binding;
      }).finally(() => { flights.delete(key); });
      flights.set(key, flight);
    }
    const binding = await flights.get(key)!;
    if (!binding || !admitted(opts) || !devinCliBindingCurrent(binding, model, now())) return null;
    selected = binding; return binding;
  } catch { return null; }
}

export function resetDevinCliAdmissionForTest(): void { entries.clear(); flights.clear(); failures.clear(); selected = null; }

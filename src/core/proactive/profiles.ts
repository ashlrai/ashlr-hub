/** Private profile metadata. Editing a profile never qualifies an external adapter. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomicallyAsync } from '../util/private-file-write.js';
import { PROACTIVE_PROVIDERS, type ProactiveProfile, type ProactiveProfileInput,
  type ProactiveProfilePatch, type ProactiveOperationReadiness, type ProactiveProfilesResponse } from './types.js';

export class ProactiveProfileError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND' | 'UNAVAILABLE', message: string) {
    super(message); this.name = 'ProactiveProfileError';
  }
}
const MAX_BYTES = 1024 * 1024;
const EDITABLE = ['displayName', 'avatar', 'responsibility', 'computer', 'services', 'fundingReference', 'enabled'];
const ID = /^pa_[a-f0-9]{24}$/;
function invalid(message = 'Invalid proactive agent profile.'): never { throw new ProactiveProfileError('INVALID_INPUT', message); }
function unavailable(): never { throw new ProactiveProfileError('UNAVAILABLE', 'Proactive agent profiles are unavailable; existing data was preserved.'); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).some(key => !keys.includes(key))) invalid('Unexpected proactive agent profile field.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || !empty && !value.trim()) invalid();
  if ([...value].some(character => {
    const code = character.charCodeAt(0);
    return code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code));
  })) invalid();
  return value.trim();
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (!options.includes(value as T)) invalid(); return value as T;
}
function nullableId(value: unknown): string | null { return value === null ? null : text(value, 256); }
function avatar(value: unknown): ProactiveProfile['avatar'] {
  const raw = object(value, ['color', 'variant']);
  if (typeof raw['color'] !== 'string' || !/^#[a-f0-9]{6}$/iu.test(raw['color'])) invalid('Use a six-digit avatar color.');
  return { color: raw['color'].toLowerCase(), variant: choice(raw['variant'], ['classic', 'round', 'pixel']) };
}
export function parseProactiveProfileInput(value: unknown): ProactiveProfileInput {
  const raw = object(value, ['identity', ...EDITABLE]);
  const identity = object(raw['identity'], ['provider', 'accountId', 'agentId']);
  const result: ProactiveProfileInput = {
    identity: { provider: choice(identity['provider'], PROACTIVE_PROVIDERS), accountId: text(identity['accountId'], 256), agentId: text(identity['agentId'], 256) },
    displayName: text(raw['displayName'], 120),
  };
  if ('avatar' in raw) result.avatar = avatar(raw['avatar']);
  if ('responsibility' in raw) result.responsibility = text(raw['responsibility'], 4000, true, true);
  if ('computer' in raw) {
    const computer = object(raw['computer'], ['kind', 'label', 'providerComputerId']);
    result.computer = { kind: choice(computer['kind'], ['hosted', 'connected-local', 'unknown']), label: text(computer['label'], 120, true), providerComputerId: nullableId(computer['providerComputerId']) };
  }
  if ('services' in raw) {
    if (!Array.isArray(raw['services']) || raw['services'].length > 100) invalid();
    result.services = raw['services'].map(value => { const service = object(value, ['id', 'label']); return { id: text(service['id'], 128), label: text(service['label'], 120) }; });
    if (new Set(result.services.map(service => service.id)).size !== result.services.length) invalid('Connected service IDs must be unique.');
  }
  if ('fundingReference' in raw) {
    if (raw['fundingReference'] === null) result.fundingReference = null;
    else {
      const funding = object(raw['fundingReference'], ['kind', 'accountId', 'poolId']);
      result.fundingReference = { kind: choice(funding['kind'], ['subscription', 'promotional-api', 'unknown']), accountId: text(funding['accountId'], 256), poolId: nullableId(funding['poolId']) };
      if (result.fundingReference.accountId !== result.identity.accountId) invalid('Funding reference must match the profile account.');
    }
  }
  if ('enabled' in raw) { if (typeof raw['enabled'] !== 'boolean') invalid(); result.enabled = raw['enabled']; }
  return result;
}
function profileId(input: ProactiveProfileInput): string {
  const { provider, accountId, agentId } = input.identity;
  return `pa_${createHash('sha256').update(JSON.stringify([provider, accountId, agentId])).digest('hex').slice(0, 24)}`;
}
function readiness(provider: ProactiveProfile['identity']['provider']): ProactiveProfile['operations'] {
  const unverified = (note: string): ProactiveOperationReadiness => ({ state: 'unverified', verifiedAt: null, note });
  const unsupported = (): ProactiveOperationReadiness => ({ state: 'unsupported', verifiedAt: null, note: 'No qualified Phantom adapter implements this operation.' });
  return {
    dispatch: unverified(provider === 'grok-bot' ? 'A documented routine webhook exists; this profile has no qualified connection.'
      : provider === 'openai-dot' ? 'Documented plugin events can notify a Dot; this profile has no qualified plugin connection.'
      : 'Personal-agent dispatch has not been qualified.'),
    status: unsupported(), cancel: unsupported(), result: unsupported(),
  };
}
function materialize(input: ProactiveProfileInput, version: number, createdAt: string, updatedAt: string): ProactiveProfile {
  return { id: profileId(input), version, identity: input.identity, displayName: input.displayName,
    avatar: input.avatar ?? { color: '#6554ff', variant: 'classic' }, responsibility: input.responsibility ?? '',
    computer: input.computer ?? { kind: 'unknown', label: '', providerComputerId: null }, services: input.services ?? [],
    fundingReference: input.fundingReference ?? null, enabled: input.enabled ?? true, connection: 'configured',
    operations: readiness(input.identity.provider), lastRun: null, createdAt, updatedAt };
}
function parseSaved(value: unknown): ProactiveProfile {
  const raw = object(value, ['id', 'version', 'identity', ...EDITABLE, 'connection', 'operations', 'lastRun', 'createdAt', 'updatedAt']);
  const input = parseProactiveProfileInput(Object.fromEntries(['identity', ...EDITABLE].map(key => [key, raw[key]])));
  if (!Number.isSafeInteger(raw['version']) || Number(raw['version']) < 1 || raw['id'] !== profileId(input) || raw['connection'] !== 'configured' || raw['lastRun'] !== null) invalid();
  const createdAt = text(raw['createdAt'], 32), updatedAt = text(raw['updatedAt'], 32);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt)) || Date.parse(updatedAt) < Date.parse(createdAt)) invalid();
  const profile = materialize(input, Number(raw['version']), createdAt, updatedAt);
  // Saved metadata cannot promote itself to a working adapter or fake successful work.
  const operations = object(raw['operations'], ['dispatch', 'status', 'cancel', 'result']);
  for (const key of ['dispatch', 'status', 'cancel', 'result'] as const) {
    const operation = object(operations[key], ['state', 'verifiedAt', 'note']);
    if (operation['state'] !== profile.operations[key].state || operation['verifiedAt'] !== null || typeof operation['note'] !== 'string') invalid();
  }
  return profile;
}
export interface ProactiveProfilesStore {
  list(): Promise<ProactiveProfilesResponse>;
  create(input: unknown): Promise<ProactiveProfile>;
  update(id: string, patch: unknown): Promise<ProactiveProfile>;
  remove(id: string, expectedVersion: number): Promise<void>;
}
export function createProactiveProfilesStore(options: { directory?: () => string; now?: () => Date } = {}): ProactiveProfilesStore {
  const defaultDirectory = join(ashlrHome(), 'proactive-agents');
  const directory = options.directory ?? (() => defaultDirectory);
  const now = options.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();
  async function safeDirectory(create: boolean): Promise<boolean> {
    const dir = directory();
    try {
      const anchor = dirname(dir);
      let parent;
      try { parent = await lstat(anchor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
        await mkdir(anchor, { mode: 0o700, recursive: true }); parent = await lstat(anchor);
      }
      if (!parent.isDirectory() || parent.isSymbolicLink() || typeof process.getuid === 'function' && parent.uid !== process.getuid() || process.platform !== 'win32' && (parent.mode & 0o022) !== 0) unavailable();
      let created = false;
      if (create) {
        try { await mkdir(dir, { mode: 0o700 }); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid === 'function' && stat.uid !== process.getuid() || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) unavailable();
      if (!assurePrivateStoragePath(dir, 'directory', created ? 'secure-created' : 'inspect-existing', { anchorPath: dirname(dir) }).ok) unavailable();
      return true;
    } catch (error) { if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false; return unavailable(); }
  }
  async function read(): Promise<ProactiveProfile[]> {
    if (!await safeDirectory(false)) return [];
    let file;
    try { file = await open(join(directory(), 'profiles.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return unavailable(); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES || typeof process.getuid === 'function' && stat.uid !== process.getuid() || process.platform !== 'win32' && (stat.mode & 0o077) !== 0) unavailable();
      // A growing or replaced file cannot make this metadata read unbounded.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const chunk = await file.read(buffer, length, buffer.length - length, length);
        if (chunk.bytesRead === 0) break;
        length += chunk.bytesRead;
      }
      const after = await file.stat();
      if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) unavailable();
      const raw = object(JSON.parse(buffer.subarray(0, length).toString('utf8')), ['schemaVersion', 'profiles']);
      if (raw['schemaVersion'] !== 1 || !Array.isArray(raw['profiles'])) unavailable();
      const profiles = raw['profiles'].map(parseSaved);
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) unavailable();
      return profiles;
    } catch { return unavailable(); } finally { await file.close(); }
  }
  function mutate<T>(change: (profiles: ProactiveProfile[]) => T): Promise<T> {
    const action = chain.then(async () => {
      await safeDirectory(true);
      const dir = directory(), lock = acquireLocalStoreLock(join(dir, '.profiles.lock'), 0, { anchorPath: dirname(dir), exactPrivateStorage: true });
      if (!lock) throw new ProactiveProfileError('CONFLICT', 'Proactive agent profiles are busy. Retry after reading the current version.');
      try {
        const profiles = await read(), result = change(profiles);
        const bytes = `${JSON.stringify({ schemaVersion: 1, profiles })}\n`;
        if (Buffer.byteLength(bytes) > MAX_BYTES) invalid('Profile metadata exceeds its storage byte allowance.');
        await writePrivateFileAtomicallyAsync(join(dir, `.profiles.${randomBytes(8).toString('hex')}.tmp`), join(dir, 'profiles.json'), bytes,
          { anchorPath: dirname(dir), label: 'Proactive profiles', beforePublish: () => { if (!ownsLocalStoreLock(lock)) unavailable(); } });
        return structuredClone(result);
      } finally { releaseLocalStoreLock(lock); }
    });
    const guarded = action.catch(error => {
      if (error instanceof ProactiveProfileError) throw error;
      return unavailable();
    });
    chain = guarded.catch(() => undefined); return guarded;
  }
  function find(profiles: ProactiveProfile[], id: string, version: unknown): ProactiveProfile {
    if (!ID.test(id) || !Number.isSafeInteger(version) || Number(version) < 1) invalid();
    const profile = profiles.find(profile => profile.id === id);
    if (!profile) throw new ProactiveProfileError('NOT_FOUND', 'Proactive agent profile not found.');
    if (profile.version !== version) throw new ProactiveProfileError('CONFLICT', 'This profile changed. Read it again before saving.');
    return profile;
  }
  return {
    list: async () => ({ schemaVersion: 1, profiles: await read() }),
    create: async value => { const input = parseProactiveProfileInput(value); return mutate(profiles => {
      if (profiles.some(profile => profile.id === profileId(input))) throw new ProactiveProfileError('CONFLICT', 'This provider/account/agent identity already has a profile.');
      const at = now().toISOString(), profile = materialize(input, 1, at, at); profiles.push(profile); return profile;
    }); },
    update: async (id, value) => { const patch = object(value, ['expectedVersion', ...EDITABLE]) as ProactiveProfilePatch; return mutate(profiles => {
      const previous = find(profiles, id, patch.expectedVersion);
      if (previous.version === Number.MAX_SAFE_INTEGER) throw new ProactiveProfileError('CONFLICT', 'Profile version cannot advance.');
      const input = parseProactiveProfileInput({ ...Object.fromEntries(['identity', ...EDITABLE].map(key => [key, previous[key as keyof ProactiveProfile]])), ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'expectedVersion')) });
      const at = new Date(Math.max(now().getTime(), Date.parse(previous.updatedAt))).toISOString();
      const profile = materialize(input, previous.version + 1, previous.createdAt, at);
      profiles[profiles.indexOf(previous)] = profile; return profile;
    }); },
    remove: async (id, expectedVersion) => mutate(profiles => { const profile = find(profiles, id, expectedVersion); profiles.splice(profiles.indexOf(profile), 1); }),
  };
}
let singleton: { home: string; store: ProactiveProfilesStore } | null = null;
export function getProactiveProfilesStore(): ProactiveProfilesStore {
  const home = ashlrHome();
  if (!singleton || singleton.home !== home) singleton = { home, store: createProactiveProfilesStore() };
  return singleton.store;
}

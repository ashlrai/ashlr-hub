/**
 * core/verse/agents/store.ts — the agent records, one private JSON file:
 * `~/.ashlr/verse/agents/agents.json` (0600, directory 0700).
 *
 * The file is small (one record per agent; archived ones are pruned past
 * KEEP_ARCHIVED) and read once per process, then served from memory. Every
 * change is written with an atomic rename, and writes are SERIALIZED through
 * one promise chain, so two quick toggles can never interleave into a torn
 * file. All I/O is async — this store sits behind request handlers.
 *
 * A file that is present but unreadable is NOT silently replaced: reads
 * answer the empty set and every write is refused until it is fixed or
 * moved, so a bad parse cannot erase every agent's settings.
 *
 * The HOME is resolved per call (tests relocate it).
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentRecord } from './types.js';

const FILE_VERSION = 1;
/** Archived agents kept (for Restore) — the oldest beyond this are dropped from the file. */
export const KEEP_ARCHIVED = 200;
const AGENT_ID_RE = /^ag_[a-z0-9]{8,32}$/;

export function agentsDir(): string {
  return join(homedir(), '.ashlr', 'verse', 'agents');
}

export function agentsFile(): string {
  return join(agentsDir(), 'agents.json');
}

export function isAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value);
}

export function newAgentId(): string {
  return `ag_${randomBytes(8).toString('hex')}`;
}

export class AgentStoreUnreadableError extends Error {
  constructor() {
    super('The agents file could not be read, so it is not being overwritten. Move ~/.ashlr/verse/agents/agents.json aside to start fresh.');
    this.name = 'AgentStoreUnreadableError';
  }
}

interface FileShape {
  version: number;
  agents: AgentRecord[];
  /** Board-level "resolved" marks for chats that have no agent record: sessionId → turnCount. */
  resolved: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tolerant field-by-field repair: a record from an older build gains the defaults it lacks. */
export function normalizeAgentRecord(raw: unknown): AgentRecord | null {
  if (!isRecord(raw) || !isAgentId(raw['id'])) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const planRaw = isRecord(raw['plan']) ? raw['plan'] : {};
  const planState = planRaw['state'];
  const ws = isRecord(raw['workspace']) ? raw['workspace'] : null;
  const arch = isRecord(raw['archived']) ? raw['archived'] : null;
  const now = new Date().toISOString();
  return {
    id: raw['id'],
    sessionId: str(raw['sessionId']),
    title: str(raw['title'])?.slice(0, 200) ?? 'Agent',
    createdAt: str(raw['createdAt']) ?? now,
    updatedAt: str(raw['updatedAt']) ?? now,
    pinned: bool(raw['pinned']),
    workspace: ws && typeof ws['path'] === 'string' && typeof ws['rootPath'] === 'string' && typeof ws['branch'] === 'string'
      ? {
          rootPath: ws['rootPath'],
          path: ws['path'],
          branch: ws['branch'],
          name: str(ws['name']) ?? ws['branch'].replace(/^verse\//, ''),
          portBase: num(ws['portBase']) ?? 0,
          portCount: num(ws['portCount']) ?? 0,
          baseSha: str(ws['baseSha']),
        }
      : null,
    pendingPrompt: str(raw['pendingPrompt']),
    plan: {
      enabled: bool(planRaw['enabled']),
      state: planState === 'drafting' || planState === 'awaiting-approval' || planState === 'approved' ? planState : 'none',
      text: str(planRaw['text']),
      turn: num(planRaw['turn']),
    },
    spendCapUsd: num(raw['spendCapUsd']),
    spendWarnedAt: num(raw['spendWarnedAt']),
    spendStoppedAt: num(raw['spendStoppedAt']),
    autoFix: bool(raw['autoFix']),
    autoMerge: bool(raw['autoMerge']),
    autoFixSentFor: Array.isArray(raw['autoFixSentFor']) ? raw['autoFixSentFor'].filter((s): s is string => typeof s === 'string').slice(-20) : [],
    autoFixAttempts: num(raw['autoFixAttempts']) ?? 0,
    loopNote: str(raw['loopNote']),
    scripts: Array.isArray(raw['scripts'])
      ? raw['scripts'].filter(isRecord).map((s) => ({
          id: str(s['id']) ?? 'run',
          kind: s['kind'] === 'setup' || s['kind'] === 'archive' ? s['kind'] : 'run',
          name: str(s['name']) ?? 'Run',
          via: s['via'] === 'terminal' ? 'terminal' : 'process',
          tabId: str(s['tabId']),
          // A run the previous process was watching cannot still be watched: it ended with it.
          state: s['state'] === 'ok' || s['state'] === 'failed' ? s['state'] : 'failed',
          exitCode: num(s['exitCode']),
          startedAt: str(s['startedAt']) ?? now,
          endedAt: str(s['endedAt']),
        }) as AgentRecord['scripts'][number]).slice(-20)
      : [],
    archived: arch
      ? {
          at: str(arch['at']) ?? now,
          ref: str(arch['ref']),
          sha: str(arch['sha']),
          headSha: str(arch['headSha']),
          reason: arch['reason'] === 'merged' || arch['reason'] === 'cap' ? arch['reason'] : 'manual',
          branchDeleted: bool(arch['branchDeleted']),
        }
      : null,
    resolvedFailureTurn: num(raw['resolvedFailureTurn']),
  };
}

export interface AgentStore {
  list(): Promise<AgentRecord[]>;
  get(id: string): Promise<AgentRecord | null>;
  bySession(sessionId: string): Promise<AgentRecord | null>;
  /** Insert or replace. */
  put(record: AgentRecord): Promise<AgentRecord>;
  /** Read-modify-write under the write chain; null when the id is unknown. */
  update(id: string, fn: (record: AgentRecord) => AgentRecord): Promise<AgentRecord | null>;
  remove(id: string): Promise<void>;
  resolvedTurn(sessionId: string): Promise<number | null>;
  setResolved(sessionId: string, turnCount: number): Promise<void>;
}

export function createAgentStore(opts: { file?: () => string; now?: () => Date } = {}): AgentStore {
  const fileOf = opts.file ?? agentsFile;
  const now = opts.now ?? (() => new Date());
  let loaded: { file: string; data: FileShape; unreadable: boolean } | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<{ data: FileShape; unreadable: boolean }> {
    const file = fileOf();
    if (loaded && loaded.file === file) return loaded;
    let data: FileShape = { version: FILE_VERSION, agents: [], resolved: {} };
    let unreadable = false;
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      if (!isRecord(raw) || !Array.isArray(raw['agents'])) throw new Error('shape');
      const agents = raw['agents'].map(normalizeAgentRecord).filter((a): a is AgentRecord => a !== null);
      const resolved: Record<string, number> = {};
      if (isRecord(raw['resolved'])) {
        for (const [k, v] of Object.entries(raw['resolved'])) if (typeof v === 'number' && Number.isFinite(v)) resolved[k] = v;
      }
      data = { version: FILE_VERSION, agents, resolved };
    } catch (err) {
      if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') unreadable = true;
    }
    loaded = { file, data, unreadable };
    return loaded;
  }

  async function persist(data: FileShape): Promise<void> {
    const file = fileOf();
    const dir = join(file, '..');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    // Prune archived records past the keep limit, oldest first.
    const archived = data.agents.filter((a) => a.archived !== null).sort((a, b) => (a.archived!.at < b.archived!.at ? 1 : -1));
    const drop = new Set(archived.slice(KEEP_ARCHIVED).map((a) => a.id));
    if (drop.size > 0) data.agents = data.agents.filter((a) => !drop.has(a.id));
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: FILE_VERSION, agents: data.agents, resolved: data.resolved }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  function write<T>(fn: (data: FileShape) => T): Promise<T> {
    const job = chain.then(async () => {
      const state = await load();
      if (state.unreadable) throw new AgentStoreUnreadableError();
      const result = fn(state.data);
      await persist(state.data);
      return result;
    });
    chain = job.catch(() => undefined);
    return job;
  }

  return {
    async list() {
      await chain;
      return (await load()).data.agents.map((a) => ({ ...a }));
    },
    async get(id) {
      await chain;
      const found = (await load()).data.agents.find((a) => a.id === id);
      return found ? { ...found } : null;
    },
    async bySession(sessionId) {
      await chain;
      const found = (await load()).data.agents.find((a) => a.sessionId === sessionId);
      return found ? { ...found } : null;
    },
    put(record) {
      return write((data) => {
        const next = { ...record, updatedAt: now().toISOString() };
        const i = data.agents.findIndex((a) => a.id === record.id);
        if (i >= 0) data.agents[i] = next;
        else data.agents.push(next);
        return { ...next };
      });
    },
    update(id, fn) {
      return write((data) => {
        const i = data.agents.findIndex((a) => a.id === id);
        if (i < 0) return null;
        const next = { ...fn({ ...data.agents[i]! }), id, updatedAt: now().toISOString() };
        data.agents[i] = next;
        return { ...next };
      });
    },
    remove(id) {
      return write((data) => {
        data.agents = data.agents.filter((a) => a.id !== id);
      });
    },
    async resolvedTurn(sessionId) {
      await chain;
      return (await load()).data.resolved[sessionId] ?? null;
    },
    setResolved(sessionId, turnCount) {
      return write((data) => {
        data.resolved[sessionId] = turnCount;
        // Bounded: the oldest marks go first (insertion order).
        const keys = Object.keys(data.resolved);
        for (const key of keys.slice(0, Math.max(0, keys.length - 2_000))) delete data.resolved[key];
      });
    },
  };
}

let singleton: { home: string; store: AgentStore } | null = null;

/** The process's store for the CURRENT home (a relocated HOME gets its own). */
export function getAgentStore(): AgentStore {
  const home = homedir();
  if (!singleton || singleton.home !== home) singleton = { home, store: createAgentStore() };
  return singleton.store;
}

export function setAgentStoreForTest(store: AgentStore | null): void {
  singleton = store ? { home: homedir(), store } : null;
}

/** An empty record with every default, for a new agent. */
export function blankAgent(input: { id: string; title: string; at: string }): AgentRecord {
  return {
    id: input.id,
    sessionId: null,
    title: input.title,
    createdAt: input.at,
    updatedAt: input.at,
    pinned: false,
    workspace: null,
    pendingPrompt: null,
    plan: { enabled: false, state: 'none', text: null, turn: null },
    spendCapUsd: null,
    spendWarnedAt: null,
    spendStoppedAt: null,
    autoFix: false,
    autoMerge: false,
    autoFixSentFor: [],
    autoFixAttempts: 0,
    loopNote: null,
    scripts: [],
    archived: null,
    resolvedFailureTurn: null,
  };
}

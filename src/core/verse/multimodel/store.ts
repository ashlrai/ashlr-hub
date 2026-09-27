/**
 * Multi-model chat state on disk — private, bounded, async.
 *
 *   ~/.ashlr/verse/multimodel/outcomes.jsonl  what Mason did with answers and
 *                                             suggestions (learning.ts input)
 *   ~/.ashlr/verse/multimodel/links.json      thread links (compare / review /
 *                                             draft / escalate) for the meter
 *
 * 0700 directory, 0600 files, next to the session store. Reads are bounded
 * (the last OUTCOMES_READ_MAX_BYTES of the log; LINKS_MAX links, oldest
 * dropped) so neither can grow into a slow request. All IO is async: this runs
 * in the Verse sidecar, where a synchronous read can park the event loop.
 *
 * Nothing here holds prompt text — only seat ids, kinds and signals.
 */
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { OUTCOME_SIGNALS, PROMPT_KINDS, THREAD_RELATIONS, type SeatOutcome, type ThreadLink } from './types.js';

export const OUTCOMES_READ_MAX_BYTES = 1024 * 1024;
export const LINKS_MAX = 2_000;

export interface MultimodelStore {
  appendOutcome(outcome: SeatOutcome): Promise<void>;
  readOutcomes(): Promise<SeatOutcome[]>;
  addLink(link: ThreadLink): Promise<void>;
  readLinks(): Promise<ThreadLink[]>;
}

function isOutcome(v: unknown): v is SeatOutcome {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['at'] === 'string' && typeof o['seatId'] === 'string' && typeof o['engine'] === 'string'
    && (PROMPT_KINDS as readonly unknown[]).includes(o['kind']) && (OUTCOME_SIGNALS as readonly unknown[]).includes(o['signal']);
}

function isLink(v: unknown): v is ThreadLink {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['parentSessionId'] === 'string' && typeof o['childSessionId'] === 'string' && typeof o['at'] === 'string'
    && (THREAD_RELATIONS as readonly unknown[]).includes(o['relation']);
}

async function readTail(file: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString('utf8');
    // A cut read starts mid-line: drop the partial first line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await handle.close();
  }
}

export function defaultMultimodelRoot(): string {
  return join(homedir(), '.ashlr', 'verse', 'multimodel');
}

export function createMultimodelStore(root: string = defaultMultimodelRoot()): MultimodelStore {
  const outcomesFile = join(root, 'outcomes.jsonl');
  const linksFile = join(root, 'links.json');
  let ready: Promise<void> | null = null;
  const ensure = () => (ready ??= mkdir(root, { recursive: true, mode: 0o700 }).then(() => undefined));
  // Link writes are read-modify-write: serialise them in-process.
  let linkChain: Promise<void> = Promise.resolve();

  async function readLinks(): Promise<ThreadLink[]> {
    try {
      const parsed = JSON.parse(await readFile(linksFile, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isLink) : [];
    } catch {
      return [];
    }
  }

  return {
    async appendOutcome(outcome) {
      await ensure();
      await appendFile(outcomesFile, `${JSON.stringify(outcome)}\n`, { mode: 0o600 });
    },
    async readOutcomes() {
      const text = await readTail(outcomesFile, OUTCOMES_READ_MAX_BYTES);
      const out: SeatOutcome[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (isOutcome(parsed)) out.push(parsed);
        } catch { /* a torn line is skipped */ }
      }
      return out;
    },
    addLink(link) {
      const run = linkChain.then(async () => {
        await ensure();
        const links = (await readLinks()).filter((l) => !(l.parentSessionId === link.parentSessionId && l.childSessionId === link.childSessionId));
        links.push(link);
        const kept = links.slice(-LINKS_MAX);
        const tmp = `${linksFile}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(kept), { mode: 0o600 });
        await rename(tmp, linksFile);
      });
      linkChain = run.catch(() => undefined);
      return run;
    },
    readLinks,
  };
}

/**
 * wiki/genome.ts — an async, bounded, scrubbed snapshot of a repo's genome
 * (`<repo>/.ashlrcode/genome/**.md`) for Ask retrieval.
 *
 * genome/store.ts has the canonical reader, but it is synchronous — fine for
 * the CLI, not for the Verse sidecar, where a sync read into ~/Desktop can
 * freeze every route behind a macOS privacy prompt. So the wiki build takes a
 * snapshot here (async) and Ask reads the snapshot from ~/.ashlr (private).
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { scrubSecrets } from '../../util/scrub.js';
import type { WikiGenomeNote } from './store.js';

const MAX_NOTES = 80;
const MAX_NOTE_BYTES = 48 * 1024;
const MAX_NOTE_CHARS = 4_000;

export interface GenomeSnapshot {
  notes: WikiGenomeNote[];
  /** rel path -> line count, merged into the wiki's citation index. */
  lines: Record<string, number>;
}

export async function snapshotGenome(repo: string): Promise<GenomeSnapshot> {
  const root = path.join(repo, '.ashlrcode', 'genome');
  const notes: WikiGenomeNote[] = [];
  const lines: Record<string, number> = {};
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && notes.length < MAX_NOTES) {
    const { dir, depth } = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (notes.length >= MAX_NOTES) break;
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 2 && !ent.name.startsWith('.')) queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile() || !/\.(md|markdown|txt)$/i.test(ent.name)) continue;
      try {
        const st = await lstat(abs);
        if (!st.isFile() || st.size > MAX_NOTE_BYTES) continue;
        const raw = await readFile(abs, 'utf8');
        const rel = path.relative(repo, abs).split(path.sep).join('/');
        const heading = /^#{1,3}\s+(.+)$/m.exec(raw)?.[1]?.trim();
        const text = scrubSecrets(raw).slice(0, MAX_NOTE_CHARS);
        if (!text.trim()) continue;
        notes.push({ title: (heading ?? ent.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')).slice(0, 160), text, file: rel });
        lines[rel] = raw.split('\n').length;
      } catch {
        // unreadable note — skip
      }
    }
  }
  return { notes, lines };
}

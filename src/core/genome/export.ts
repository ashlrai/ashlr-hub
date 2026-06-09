/**
 * export.ts — Genome export for M16 (no lock-in).
 *
 * Loads the full aggregated genome and writes it to a destination file as
 * either portable JSON (array of GenomeEntry) or Markdown (one section per
 * entry). READ-ONLY on the genome — never mutates hub.jsonl or any source.
 *
 * GUARDRAILS:
 *  - Read-only: genome sources are never modified.
 *  - Never throws: all errors are caught; ok:false returned on failure.
 *  - No lock-in: JSON output is a plain array; Markdown is human-readable.
 *  - Local-only: no network calls; no new runtime deps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadGenome } from './store.js';
import type { AshlrConfig, GenomeEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render a single GenomeEntry as a Markdown section.
 *
 * Format:
 *   ## <title>
 *
 *   **Project:** <project>  **Tags:** tag1, tag2  **Date:** <ts>
 *
 *   <text>
 *
 *   ---
 */
function entryToMarkdown(entry: GenomeEntry): string {
  const lines: string[] = [];

  lines.push(`## ${entry.title}`);
  lines.push('');

  const meta: string[] = [];
  if (entry.project) meta.push(`**Project:** ${entry.project}`);
  if (entry.tags.length > 0) meta.push(`**Tags:** ${entry.tags.join(', ')}`);
  meta.push(`**Date:** ${entry.ts}`);
  meta.push(`**Source:** ${entry.source}`);
  lines.push(meta.join('  '));
  lines.push('');

  lines.push(entry.text);
  lines.push('');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

/**
 * Render all entries as a Markdown document.
 */
function entriesToMarkdown(entries: GenomeEntry[]): string {
  const header = [
    '# Genome Export',
    '',
    `Exported ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from the ashlr genome.`,
    '',
    '---',
    '',
  ].join('\n');

  return header + entries.map(entryToMarkdown).join('');
}

// ---------------------------------------------------------------------------
// Public: exportGenome
// ---------------------------------------------------------------------------

/**
 * Export the full aggregated genome to `dest` in the requested format.
 *
 * - `'json'`: pretty-printed JSON array of GenomeEntry objects.
 * - `'md'`:   Markdown document with one section per entry.
 *
 * Creates the destination directory if it does not exist.
 * Returns `{ ok: true, count, path }` on success.
 * Returns `{ ok: false, count: 0, path: dest }` on any error — never throws.
 */
export function exportGenome(
  cfg: AshlrConfig,
  dest: string,
  format: 'json' | 'md',
): { ok: boolean; count: number; path: string } {
  const absPath = path.resolve(dest);

  try {
    // Load the genome (never throws).
    const entries = loadGenome(cfg);

    // Ensure destination directory exists.
    const dir = path.dirname(absPath);
    fs.mkdirSync(dir, { recursive: true });

    // Render output.
    let content: string;
    if (format === 'json') {
      content = JSON.stringify(entries, null, 2) + '\n';
    } else {
      content = entriesToMarkdown(entries);
    }

    // Write (overwrite if exists — this is an export, not an append).
    fs.writeFileSync(absPath, content, 'utf8');

    return { ok: true, count: entries.length, path: absPath };
  } catch {
    return { ok: false, count: 0, path: absPath };
  }
}

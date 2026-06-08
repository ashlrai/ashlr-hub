/**
 * Interactive item picker for the ashlr CLI.
 *
 * Strategy:
 *   1. If stdout/stdin are not a TTY → return null (headless / piped).
 *   2. If `fzf` is on PATH → pipe formatted lines into fzf and map the
 *      selection back to the originating IndexedItem.
 *   3. Otherwise → built-in readline picker: numbered list with optional
 *      type-to-filter, arrow-free, works in every terminal.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import type { IndexedItem } from '../core/types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** True when both stdin and stdout are connected to a real terminal. */
function isTTY(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** True when `fzf` can be found on PATH without throwing. */
function hasFzf(): boolean {
  try {
    execFileSync('which', ['fzf'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a single item into the line shown to the user.
 * Format: "<name>  [<category>]  <description>"
 * Each segment is tab-separated so fzf column alignment works.
 */
function formatLine(item: IndexedItem): string {
  const cat = item.category ?? 'uncategorized';
  const desc = item.description ?? item.kind;
  return `${item.name}\t[${cat}]\t${desc}`;
}

// ── fzf picker ───────────────────────────────────────────────────────────────

/**
 * Run the selection through fzf.
 * Returns the chosen IndexedItem or null on cancel / error.
 */
function pickWithFzf(items: IndexedItem[]): IndexedItem | null {
  const lines = items.map(formatLine);
  const input = lines.join('\n');

  const result = spawnSync('fzf', ['--ansi', '--with-nth=1,2,3', '--delimiter=\t', '--height=40%', '--reverse', '--prompt=ashlr> '], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  // Exit code 130 = user cancelled (Ctrl-C / Esc); 1 = no match.
  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  const chosen = result.stdout.trim();
  if (!chosen) return null;

  // Map the selected line back to the item by matching the formatted line.
  const idx = lines.findIndex((l) => l === chosen);
  return idx >= 0 ? items[idx] ?? null : null;
}

// ── Built-in readline picker ─────────────────────────────────────────────────

/**
 * Simple numbered list picker with optional filter query.
 * Renders up to `PAGE_SIZE` items at a time; user types a number or a
 * filter string and presses Enter.
 */
const PAGE_SIZE = 20;

async function pickWithReadline(items: IndexedItem[]): Promise<IndexedItem | null> {
  return new Promise((resolve) => {
    // We open /dev/tty explicitly so the picker works even when stdin is
    // redirected — though we already guard against non-TTY above.
    // All picker UI is written to stderr so that stdout stays clean for
    // capture (e.g. `cd $(ashlr go foo --cd)` must only ever see the chosen
    // path on stdout, never the interactive prompt chrome).
    const ttyIn = process.stdin;
    const ttyOut = process.stderr;

    /** Print a filtered, numbered list and the prompt. */
    function renderList(filtered: IndexedItem[], filter: string): void {
      ttyOut.write('\x1B[2J\x1B[H'); // clear screen
      ttyOut.write('\x1B[1mashlr picker\x1B[0m');
      if (filter) ttyOut.write(`  filter: \x1B[33m${filter}\x1B[0m`);
      ttyOut.write(`  (${filtered.length} / ${items.length})\n\n`);

      const page = filtered.slice(0, PAGE_SIZE);
      for (let i = 0; i < page.length; i++) {
        const item = page[i]!;
        const num = String(i + 1).padStart(3, ' ');
        const cat = item.category ? `\x1B[36m[${item.category}]\x1B[0m ` : '';
        const desc = item.description ? `\x1B[2m— ${item.description}\x1B[0m` : '';
        ttyOut.write(`  ${num}.  \x1B[1m${item.name}\x1B[0m  ${cat}${desc}\n`);
      }

      if (filtered.length > PAGE_SIZE) {
        ttyOut.write(`\n  … and ${filtered.length - PAGE_SIZE} more. Narrow your filter.\n`);
      }

      ttyOut.write('\nType a number to select, text to filter, or Enter to cancel: ');
    }

    const rl = readline.createInterface({
      input: ttyIn,
      output: ttyOut,
      terminal: true,
    });

    let currentFilter = '';
    let filtered = [...items];

    /** Re-render and ask for the next input. */
    function prompt(): void {
      renderList(filtered, currentFilter);
      rl.question('', (answer) => {
        const trimmed = answer.trim();

        // Empty input → cancel
        if (!trimmed) {
          rl.close();
          resolve(null);
          return;
        }

        // Numeric input → pick by displayed index (1-based)
        const num = parseInt(trimmed, 10);
        const isAllDigits = /^\d+$/.test(trimmed);
        if (!isNaN(num) && num >= 1 && num <= Math.min(filtered.length, PAGE_SIZE)) {
          rl.close();
          resolve(filtered[num - 1] ?? null);
          return;
        }

        // All-digit input that is out of the visible selection range is clearly
        // a (mis-typed) selection, not a filter. Tell the user and re-prompt
        // WITHOUT clobbering their current filter.
        if (isAllDigits) {
          ttyOut.write(
            `\n  \x1B[31mNo item #${trimmed} on this page.\x1B[0m Narrow your filter and pick again.\n`,
          );
          prompt();
          return;
        }

        // Text input → update filter and re-render
        currentFilter = trimmed.toLowerCase();
        filtered = items.filter((item) => {
          const haystack = [item.name, item.category, item.description, item.kind]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return haystack.includes(currentFilter);
        });

        if (filtered.length === 0) {
          // No matches — reset filter and let user try again
          ttyOut.write('\n  \x1B[31mNo matches for that filter.\x1B[0m Press Enter to cancel or type another query.\n');
          currentFilter = '';
          filtered = [...items];
        }

        prompt();
      });
    }

    // Handle Ctrl-C gracefully
    rl.on('close', () => {
      resolve(null);
    });

    prompt();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Present an interactive picker over `items`.
 *
 * - Returns the chosen {@link IndexedItem}, or
 * - `null` if the user cancelled, there are no items, or the process is
 *   not running in a TTY (headless / piped context).
 *
 * Prefers `fzf` when available; falls back to a built-in readline picker.
 */
export async function pick(items: IndexedItem[]): Promise<IndexedItem | null> {
  if (items.length === 0) return null;
  if (!isTTY()) return null;

  if (hasFzf()) {
    return pickWithFzf(items);
  }

  return pickWithReadline(items);
}

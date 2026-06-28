/**
 * M181: `ashlr invent [repo] [--n N] [--direction <text>] [--emit]`
 *
 * Runs the generative engine for a repo — invents bold, net-new features using
 * a frontier model and prints them. With --emit, files them into the backlog.
 *
 * This is "rip mode": the fleet stops scanning for rot and starts inventing
 * things worth building.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AshlrConfig, WorkItem, Backlog } from '../core/types.js';
import { inventWorkItems } from '../core/generative/invent.js';

// ---------------------------------------------------------------------------
// Config loader (best-effort, never throws)
// ---------------------------------------------------------------------------

async function loadCfg(): Promise<AshlrConfig> {
  try {
    const { loadConfig } = await import('../core/config.js');
    return loadConfig();
  } catch {
    return {
      provider: 'anthropic',
      models: { ollama: 'http://127.0.0.1:11434' },
    } as unknown as AshlrConfig;
  }
}

// ---------------------------------------------------------------------------
// Latest direction from strategist briefing (best-effort)
// StrategicBriefing has recommendedDirection[] and proposedEvolution.northStar
// ---------------------------------------------------------------------------

async function resolveDirection(directionArg?: string): Promise<string> {
  if (directionArg) return directionArg;

  try {
    const { loadLatestBriefing } = await import('../core/vision/strategist.js');
    const briefing = loadLatestBriefing(null);
    if (briefing) {
      // Try proposedEvolution.northStar first
      const ns = (briefing.proposedEvolution as Record<string, unknown> | undefined)?.['northStar'];
      if (typeof ns === 'string' && ns.trim()) return ns.trim();
      // Fall back to recommendedDirection joined
      if (briefing.recommendedDirection?.length) {
        return briefing.recommendedDirection.join('; ');
      }
      // Fall back to proposedGoals objectives
      if (briefing.proposedGoals?.length) {
        return briefing.proposedGoals.map((g) => g.objective).filter(Boolean).join('; ');
      }
    }
  } catch { /* no briefing — use default */ }

  return 'Build an incredible, autonomous AI engineering fleet that ships real features at scale with minimal human intervention.';
}

// ---------------------------------------------------------------------------
// Repo state summary (lightweight)
// ---------------------------------------------------------------------------

async function buildRepoState(repo: string): Promise<string> {
  try {
    const { execSync } = await import('node:child_process');
    const pkgPath = join(repo, 'package.json');
    let name = repo;
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
          description?: string;
        };
        name = pkg.name ?? repo;
        if (pkg.description) name += ` — ${pkg.description}`;
      } catch { /* ignore */ }
    }
    const log = execSync('git log --oneline -20', {
      cwd: repo,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    return `Repo: ${name}\nRecent commits:\n${log}`;
  } catch {
    return `Repo: ${repo}`;
  }
}

// ---------------------------------------------------------------------------
// Emit to backlog (append invented items to persisted backlog.json)
// persistBacklog is not exported from backlog.ts, so we write directly.
// ---------------------------------------------------------------------------

function backlogFilePath(): string {
  return join(homedir(), '.ashlr', 'backlog.json');
}

function emitToBacklog(items: WorkItem[]): void {
  try {
    const bPath = backlogFilePath();
    let existing: Backlog | null = null;
    try {
      const raw = readFileSync(bPath, 'utf8');
      existing = JSON.parse(raw) as Backlog;
    } catch { /* absent or corrupt — start fresh */ }

    const existingItems = existing?.items ?? [];
    const existingIds = new Set(existingItems.map((x) => x.id));
    const fresh = items.filter((i) => !existingIds.has(i.id));
    if (fresh.length === 0) return;

    const merged = [...existingItems, ...fresh];
    const backlog: Backlog = {
      generatedAt: new Date().toISOString(),
      repos: [...new Set(merged.map((i) => i.repo))],
      items: merged,
    };

    const dir = join(homedir(), '.ashlr');
    mkdirSync(dir, { recursive: true });
    writeFileSync(bPath, JSON.stringify(backlog, null, 2), 'utf8');
  } catch (err) {
    console.error(
      '[invent --emit] failed to write backlog:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderItems(items: WorkItem[], repo: string): void {
  if (items.length === 0) {
    console.log('No items invented (check frontier model availability or try --direction).');
    return;
  }
  console.log(`\n  GENERATIVE ENGINE — ${items.length} bold item(s) for ${repo}\n`);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const lines = item.detail.split('\n');
    console.log(`  [${i + 1}] ${item.title}`);
    console.log(`      ${lines[0]}`);
    if (lines.length > 1) {
      console.log(`      ${lines.slice(1).join(' ').slice(0, 120)}...`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function usage(): void {
  console.log(`usage: ashlr invent [<repo>] [--n <N>] [--direction <text>] [--emit] [--json]

  Invent bold, net-new improvements for a repo using a frontier model.

  <repo>              Repo path (default: cwd)
  --n <N>             Number of items to invent (default: 6)
  --direction <text>  High-level north star / direction override
  --emit              File invented items into the work queue/backlog
  --json              Print raw JSON array of WorkItems
  --skip-dedup        Bypass the dedup ledger (re-invent freely)
`);
}

export async function cmdInvent(args: string[]): Promise<number> {
  const positional: string[] = [];
  let n = 6;
  let directionArg: string | undefined;
  let emit = false;
  let jsonOut = false;
  let skipDedup = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      return 0;
    }
    if (arg === '--emit') { emit = true; continue; }
    if (arg === '--json') { jsonOut = true; continue; }
    if (arg === '--skip-dedup') { skipDedup = true; continue; }
    if (arg === '--n' || arg === '-n') {
      const val = parseInt(args[++i] ?? '', 10);
      if (isNaN(val) || val < 1) {
        console.error('error: --n requires a positive integer');
        return 2;
      }
      n = val;
      continue;
    }
    if (arg === '--direction') {
      directionArg = args[++i];
      if (!directionArg) {
        console.error('error: --direction requires a value');
        return 2;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      console.error(`error: unknown flag ${arg}`);
      return 2;
    }
    positional.push(arg);
  }

  const repoArg = positional[0];
  const repo = repoArg ? resolve(repoArg) : process.cwd();

  if (!existsSync(repo)) {
    console.error(`error: repo not found: ${repo}`);
    return 1;
  }

  const cfg = await loadCfg();

  // Generative flag gate — warn but proceed (CLI always available for manual trigger)
  const foundryRaw = cfg.foundry as Record<string, unknown> | undefined;
  if (foundryRaw?.['generative'] === false) {
    console.error(
      '[invent] note: cfg.foundry.generative is false (daemon auto-wiring disabled); running CLI invent anyway.',
    );
  }

  const [direction, repoState] = await Promise.all([
    resolveDirection(directionArg),
    buildRepoState(repo),
  ]);

  const items = await inventWorkItems(
    { repo, repoState, direction },
    { cfg },
    { n, skipDedup },
  );

  if (jsonOut) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    renderItems(items, repo);
  }

  if (emit && items.length > 0) {
    emitToBacklog(items);
    console.log(`[invent] filed ${items.length} item(s) into backlog.`);
  }

  return 0;
}

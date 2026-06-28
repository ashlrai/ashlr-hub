/**
 * M181: Generative Engine — "rip mode"
 *
 * CREATION, not maintenance. This module invents bold, net-new features for a
 * tool given its current state and a high-level direction. Every output is a
 * concrete, buildable WorkItem tagged source:'invent'. This is the difference
 * between a fleet that patches rot and one that ships things worth shipping.
 *
 * Never throws. Secret-scrubbed. Deduped via ~/.ashlr/generative/invented.json.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, WorkItem } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_DEFAULT_STRATEGIST_MODEL = 'claude-opus-4-8';
const DEFAULT_N = 6;
const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Secret scrubbing — inline, no external dep. Redacts token/key-shaped strings.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-[A-Za-z0-9\-_]{20,})/g,
  /\b(AKIA[A-Z0-9]{16})/g,
  /(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi,
  /((?:token|key|secret|password|passwd|pwd)\s*[:=]\s*["']?)[^\s"',\n]{8,}(["']?)/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    out = out.replace(re, (match) => {
      // Keep first 4 chars of structural prefix, redact value
      const eqIdx = match.search(/[:=]\s*/);
      if (eqIdx > 0) {
        return match.slice(0, eqIdx + 1) + '[REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedup ledger
// ---------------------------------------------------------------------------

interface InventedEntry {
  hash: string;   // sha256(repo + '::' + normalizedTitle) — first 16 hex chars
  repo: string;
  title: string;
  ts: number;     // epoch ms
}

interface InventedLedger {
  entries: InventedEntry[];
}

function ledgerPath(): string {
  return join(homedir(), '.ashlr', 'generative', 'invented.json');
}

function loadLedger(): InventedLedger {
  try {
    const raw = readFileSync(ledgerPath(), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'entries' in parsed &&
      Array.isArray((parsed as InventedLedger).entries)
    ) {
      return parsed as InventedLedger;
    }
  } catch { /* absent or corrupt — start fresh */ }
  return { entries: [] };
}

function saveLedger(ledger: InventedLedger): void {
  try {
    const dir = join(homedir(), '.ashlr', 'generative');
    mkdirSync(dir, { recursive: true });
    writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function entryHash(repo: string, title: string): string {
  return createHash('sha256')
    .update(`${repo}::${normalizeTitle(title)}`)
    .digest('hex')
    .slice(0, 16);
}

function isRecentlyInvented(ledger: InventedLedger, hash: string): boolean {
  const now = Date.now();
  return ledger.entries.some((e) => e.hash === hash && now - e.ts < DEDUP_TTL_MS);
}

function recordInvented(ledger: InventedLedger, repo: string, title: string): void {
  const hash = entryHash(repo, title);
  ledger.entries = ledger.entries.filter((e) => e.hash !== hash);
  ledger.entries.push({ hash, repo, title, ts: Date.now() });
  if (ledger.entries.length > 2000) {
    ledger.entries = ledger.entries.slice(-2000);
  }
}

// ---------------------------------------------------------------------------
// Frontier client resolution
// Mirrors the strategist.ts M162 pattern: access foundry fields via cast to
// Record<string, unknown> since they're not declared on the TS interface.
// ---------------------------------------------------------------------------

type CompleteFn = (system: string, user: string) => Promise<string>;

async function buildInventComplete(cfg: AshlrConfig): Promise<CompleteFn | null> {
  const foundryRaw = cfg.foundry as Record<string, unknown> | undefined;
  const model =
    (foundryRaw?.['strategistModel'] as string | undefined) ??
    CLAUDE_DEFAULT_STRATEGIST_MODEL;
  const managerJudgeEngine =
    (foundryRaw?.['managerJudgeEngine'] as string | undefined) ?? 'auto';
  const localFallbackModel =
    (foundryRaw?.['managerJudgeModel'] as string | undefined) ?? 'qwen2.5:72b-instruct-q4_K_M';

  // Try Claude CLI (mirrors buildClaudeCliCompleteStrategist in strategist.ts)
  try {
    const { engineInstalled, spawnEngine } = await import('../run/engines.js');
    const wantClaude = managerJudgeEngine === 'auto' || managerJudgeEngine === 'claude';
    const allowedBackends = (foundryRaw?.['allowedBackends'] as string[] | undefined) ?? ['builtin'];
    const claudeAllowed = allowedBackends.includes('claude') || allowedBackends.includes('builtin');
    const claudeInstalled = engineInstalled('claude');

    if (wantClaude && claudeAllowed && claudeInstalled) {
      // Use a minimal EngineCommand directly (spawnEngine accepts EngineCommand)
      const { spawnSync } = await import('node:child_process');
      return async (system: string, user: string): Promise<string> => {
        const prompt = `${system}\n\n${user}`;
        const result = spawnSync('claude', ['--model', model, '--print', '--no-cache'], {
          input: prompt,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        if (result.error || result.status !== 0) {
          throw new Error(result.stderr ?? 'claude CLI failed');
        }
        return result.stdout ?? '';
      };
    }
    // Suppress unused import warning — spawnEngine may be used later
    void spawnEngine;
  } catch { /* fall through to Ollama */ }

  // Ollama fallback
  try {
    const ollamaBaseUrl = (cfg.models as Record<string, unknown> | undefined)?.['ollama'] as string | undefined
      ?? 'http://127.0.0.1:11434';
    return async (system: string, user: string): Promise<string> => {
      const resp = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: localFallbackModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
      const data = (await resp.json()) as { message?: { content?: string } };
      return data?.message?.content ?? '';
    };
  } catch { /* no client available */ }

  return null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You are a world-class product engineer and founder. Your job is to invent BOLD, SPECIFIC, HIGH-LEVERAGE improvements for developer tools.

RULES — you MUST follow these absolutely:
1. CREATION ONLY. Every item must be a net-new capability, UX leap, or bold feature.
2. STRICTLY FORBIDDEN: dependency bumps, lint fixes, doc comments, README updates, TODO restoration, test coverage for existing code, version bumps, formatting, CI tweaks. If you generate any of these, you have failed.
3. Be SPECIFIC and CONCRETE. "Add real-time diff previews in the TUI" is good. "Improve UX" is not.
4. Be AMBITIOUS. Think 10x, not 10%. What would make this tool genuinely incredible vs the competition?
5. Output ONLY valid JSON — no markdown fences, no prose outside the JSON.

Output format (JSON array, exactly):
[
  {
    "title": "Short imperative title (≤10 words)",
    "rationale": "Why this is high-leverage and what capability gap it closes (2-3 sentences)",
    "boldness": "What makes this ambitious / non-obvious",
    "sketch": "Rough build sketch: key files/APIs/approaches (2-4 sentences)"
  }
]`;

function buildUserPrompt(repo: string, repoState: string, direction: string, n: number): string {
  return `Tool: ${repo}

Current state:
${repoState}

Direction / north star:
${direction}

Generate exactly ${n} BOLD, SPECIFIC, BUILDABLE improvements. Remember: NET-NEW capabilities only. No maintenance. No deps/lint/docs.`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface RawInventedItem {
  title?: unknown;
  rationale?: unknown;
  boldness?: unknown;
  sketch?: unknown;
}

// Phrases that indicate a maintenance item slipped through the prompt filter.
const MAINTENANCE_PATTERNS: RegExp[] = [
  /\bdep(endency|endencies)?\s*(bump|upgrad|updat)/i,
  /\bupgrad.*\bdep(endenc)/i,
  /\bbump\s+dep/i,
  /\blint\s+(fix|error|clean)/i,
  /\bdoc.?comment/i,
  /\breadme\b/i,
  /\bformatting?\b/i,
  /\btest.?coverage\b/i,
  /\bci.?tweak/i,
  /\bversion.?bump/i,
  /\btodo.?restor/i,
];

export function isMaintenanceItem(title: string, rationale: string): boolean {
  const combined = `${title} ${rationale}`;
  return MAINTENANCE_PATTERNS.some((re) => re.test(combined));
}

export function extractJsonArray(raw: string): RawInventedItem[] {
  // Strip markdown fences if present
  const stripped = raw.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed as RawInventedItem[];
  } catch { /* fall through */ }
  // Try to find a JSON array anywhere in the response
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed as RawInventedItem[];
    } catch { /* give up */ }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InventInput {
  repo: string;         // absolute path of the repo
  repoState: string;    // short description of current capabilities/state
  direction: string;    // high-level north-star direction
}

export interface InventConfig {
  cfg: AshlrConfig;
}

export interface InventOptions {
  n?: number;           // number of items to invent (default 6)
  skipDedup?: boolean;  // bypass dedup ledger (useful in tests)
  /** Injected complete fn for tests — bypasses real frontier client */
  _testComplete?: CompleteFn;
}

/**
 * Invent bold, net-new WorkItems for a repo.
 *
 * Never throws. Returns [] on any failure.
 * Secret-scrubbed. Deduplicates via ~/.ashlr/generative/invented.json.
 */
export async function inventWorkItems(
  input: InventInput,
  config: InventConfig,
  opts: InventOptions = {},
): Promise<WorkItem[]> {
  const { repo, repoState, direction } = input;
  const { cfg } = config;
  const n = opts.n ?? DEFAULT_N;

  try {
    const complete = opts._testComplete ?? (await buildInventComplete(cfg));
    if (!complete) return [];

    const system = SYSTEM_PROMPT;
    const user = buildUserPrompt(
      repo,
      scrubSecrets(repoState),
      scrubSecrets(direction),
      n,
    );

    let raw: string;
    try {
      raw = await complete(system, user);
    } catch {
      return [];
    }

    raw = scrubSecrets(raw);
    const rawItems = extractJsonArray(raw);

    const ledger: InventedLedger = opts.skipDedup ? { entries: [] } : loadLedger();
    const now = new Date().toISOString();
    const items: WorkItem[] = [];
    const deduped: string[] = [];

    for (const ri of rawItems) {
      const title = typeof ri.title === 'string' ? ri.title.trim() : '';
      const rationale = typeof ri.rationale === 'string' ? ri.rationale.trim() : '';
      const boldness = typeof ri.boldness === 'string' ? ri.boldness.trim() : '';
      const sketch = typeof ri.sketch === 'string' ? ri.sketch.trim() : '';

      if (!title) continue;

      if (isMaintenanceItem(title, rationale)) {
        console.error(`[invent] filtered maintenance item: "${title}"`);
        continue;
      }

      const hash = entryHash(repo, title);
      if (!opts.skipDedup && isRecentlyInvented(ledger, hash)) {
        deduped.push(title);
        continue;
      }

      const detail = scrubSecrets(
        [
          rationale,
          boldness ? `Boldness: ${boldness}` : '',
          sketch ? `Sketch: ${sketch}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );

      const value = 4;
      const effort = 3;
      const score = Math.round((value * 2) / effort * 10) / 10;

      const workItem: WorkItem = {
        id: `${repo}:invent:${hash}`,
        repo,
        source: 'invent',
        title: scrubSecrets(title),
        detail,
        value,
        effort,
        score,
        tags: ['generative', 'bold', 'net-new'],
        ts: now,
      };

      items.push(workItem);

      if (!opts.skipDedup) {
        recordInvented(ledger, repo, title);
      }
    }

    if (deduped.length > 0) {
      console.error(
        `[invent] deduped ${deduped.length} recently-invented item(s): ${deduped.join(', ')}`,
      );
    }

    if (!opts.skipDedup) {
      saveLedger(ledger);
    }

    return items;
  } catch {
    return [];
  }
}

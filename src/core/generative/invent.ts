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
import { resolveFrontierJudgeClient } from '../fleet/manager.js';
import { ecosystemSummary, northStarDocSummary } from '../ecosystem/map.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
// Delegates to resolveFrontierJudgeClient from manager.ts — the PROVEN path
// that returns a working Opus client (model=claude-opus-4-8, hasComplete=true).
// ---------------------------------------------------------------------------

type CompleteFn = (system: string, user: string) => Promise<string>;

function buildInventComplete(cfg: AshlrConfig): CompleteFn | null {
  const client = resolveFrontierJudgeClient(cfg);
  if (!client) return null;
  return client.complete;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// M231: Lazily-evaluated NORTH-STAR distillation injected into the system prompt.
// Called once per process (northStarDocSummary caches internally).
// M270: updated to request per-item self-scored value+effort so bold items
// naturally clear isFrontierItem thresholds (effort≥4 or score≥8) in the router.
function buildSystemPrompt(): string {
  const northStarSection = northStarDocSummary();
  const nsBlock = northStarSection
    ? `\n\nGRAND VISION GROUNDING (orient every idea here — not incremental plumbing):\n${northStarSection}`
    : '';
  return `You are a world-class product engineer and founder. Your job is to invent BOLD, SPECIFIC, HIGH-LEVERAGE improvements for developer tools.${nsBlock}

RULES — you MUST follow these absolutely:
1. CREATION ONLY. Every item must be a net-new capability, UX leap, or bold feature.
2. STRICTLY FORBIDDEN: dependency bumps, lint fixes, doc comments, README updates, TODO restoration, test coverage for existing code, version bumps, formatting, CI tweaks. If you generate any of these, you have failed.
3. Be SPECIFIC and CONCRETE. "Add real-time diff previews in the TUI" is good. "Improve UX" is not.
4. Be AMBITIOUS. Think 10x, not 10%. What would make this tool genuinely incredible vs the competition?
5. Every invented item MUST be substantive, bound to a concrete enrolled repo, and decomposable into shippable milestones — aligned to one of the three pillars: recursive self-improvement, ecosystem product factory, or composition flywheel.
6. Output ONLY valid JSON — no markdown fences, no prose outside the JSON.

SCORING — for each item, self-score honestly:
- value (1–10): impact on the grand vision. 8+ means frontier-class (architecturally novel, compounds capabilities across the fleet). 5–7 is solid. ≤4 is incremental.
- effort (1–5): engineering work required. 4–5 means a skilled engineer needs multiple days of focused work (architectural). 1–2 is a simple addition. 3 is a medium feature.
GUIDE: Bold architectural items should have value≥7 AND effort≥4. Simple additions: value≤5, effort≤2. Be honest — the router uses these scores to assign work to the right engine tier.

Output format (JSON array, exactly):
[
  {
    "title": "Short imperative title (≤10 words)",
    "rationale": "Why this is high-leverage and what capability gap it closes (2-3 sentences)",
    "boldness": "What makes this ambitious / non-obvious",
    "sketch": "Rough build sketch: key files/APIs/approaches (2-4 sentences)",
    "value": 8,
    "effort": 4
  }
]`;
}

export const SYSTEM_PROMPT: string = buildSystemPrompt();

function buildUserPrompt(repo: string, repoState: string, direction: string, n: number, ecoSummary?: string): string {
  const ecosystemSection = ecoSummary
    ? `
=== ECOSYSTEM CONTEXT ===
${ecoSummary}

Composing across the ecosystem creates the best ideas. Look for A×B improvements: e.g. features that wire this tool to phantom/pulse/binshield/ashlrcode/stack/core-efficiency. Reference specific repos from the ecosystem map above.
`
    : '';
  return `Tool: ${repo}

Current state:
${repoState}

Direction / north star:
${direction}${ecosystemSection}
Generate exactly ${n} BOLD, SPECIFIC, BUILDABLE improvements. Remember: NET-NEW capabilities only. No maintenance. No deps/lint/docs.`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface RawInventedItem {
  title?: unknown;
  rationale?: unknown;
  why?: unknown;       // Opus sometimes returns "why" instead of "rationale"
  boldness?: unknown;
  sketch?: unknown;
  // M270: model-reported self-scores. When present, used instead of flat defaults.
  value?: unknown;
  effort?: unknown;
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
    const complete = opts._testComplete ?? buildInventComplete(cfg);
    if (!complete) {
      console.error('[invent] no frontier client available — check claude CLI or Ollama');
      return [];
    }

    const system = SYSTEM_PROMPT;
    // M184: inject ecosystem summary so invented items can reference + compose
    // the 13-repo platform — the CLI proved compositional ideas are best when
    // the direction already mentions tools; now make it automatic.
    const ecoCtx = ecosystemSummary();
    const user = buildUserPrompt(
      repo,
      scrubSecrets(repoState),
      scrubSecrets(direction),
      n,
      ecoCtx || undefined,
    );

    let raw: string;
    try {
      raw = await complete(system, user);
    } catch {
      return [];
    }

    raw = scrubSecrets(raw);
    const rawItems = extractJsonArray(raw);
    console.error(`[invent] parsed ${rawItems.length} raw item(s) from model response`);

    const ledger: InventedLedger = opts.skipDedup ? { entries: [] } : loadLedger();
    const now = new Date().toISOString();
    const items: WorkItem[] = [];
    const deduped: string[] = [];

    for (const ri of rawItems) {
      const title = typeof ri.title === 'string' ? ri.title.trim() : '';
      // Accept "why" as a synonym for "rationale" (Opus sometimes uses either)
      const rationale = typeof ri.rationale === 'string'
        ? ri.rationale.trim()
        : typeof ri.why === 'string' ? ri.why.trim() : '';
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

      // M270: use model-reported self-scores when present; fall back to defaults.
      // Clamped to valid ranges: value 1–10, effort 1–5.
      // Bold items (value≥8, effort≥4) naturally clear isFrontierItem thresholds
      // (effort≥4 or score≥8) so they route to frontier engines automatically.
      const rawValue = typeof ri.value === 'number' ? ri.value : 4;
      const rawEffort = typeof ri.effort === 'number' ? ri.effort : 3;
      const value = Math.max(1, Math.min(10, Math.round(rawValue)));
      const effort = Math.max(1, Math.min(5, Math.round(rawEffort)));
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

    const dropped = rawItems.length - items.length - deduped.length;
    console.error(
      `[invent] accepted ${items.length} item(s)` +
      (dropped > 0 ? `, dropped ${dropped} maintenance item(s)` : '') +
      (deduped.length > 0 ? `, deduped ${deduped.length}` : ''),
    );

    if (!opts.skipDedup) {
      saveLedger(ledger);
    }

    return items;
  } catch {
    return [];
  }
}

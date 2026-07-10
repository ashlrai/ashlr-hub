/**
 * M31: Native MCP tools — ashlr's own intelligence served by the gateway.
 *
 * SDK-FREE by contract: this module returns plain objects; mcp-gateway.ts is
 * the only adapter (and, with mcp-registry, the only module allowed to import
 * @modelcontextprotocol/sdk). Everything here is independently unit-testable
 * without a transport.
 *
 * Safety model (CONTRACT-M31) — the gate is STRUCTURAL, enforced in
 * callNativeTool before any handler runs:
 *   'read'     — pure read of local stores; allowed even when KILL is on.
 *   'append'   — append-only write under ~/.ashlr/ (genome hub); REFUSED on KILL.
 *   'proposal' — creates a PENDING inbox Proposal; REFUSED on KILL.
 *
 * There is deliberately NO approve/reject/apply tool: approval stays human-only
 * via `ashlr inbox`. `ashlr_ask` hardcodes allowCloud:false — agent sessions
 * bring their own model; ashlr code never leaves the machine via this surface.
 *
 * Every call (ok / refused / error) is audited as 'mcp:native-call' with the
 * tool name + argument KEYS only (never values). Output is secret-scrubbed and
 * size-capped so a tool reply can never blow agent context or leak credentials.
 */

import type { AshlrConfig, NativeToolDef, ProposalStatus } from './types.js';
import { loadConfig } from './config.js';
import { killSwitchOn } from './sandbox/policy.js';
import { audit } from './sandbox/audit.js';
import { scrubSecrets } from './knowledge/index.js';
import { recall } from './genome/recall.js';
import { ask } from './knowledge/ask.js';
import { impact } from './knowledge/graph.js';
import { computeHealth } from './quality/health.js';
import { loadPreviousReport } from './quality/store.js';
import { buildRollup } from './observability/rollup.js';
import { buildSnapshot } from './dashboard.js';
import { buildOrientation } from './orient.js';
import { selectGenomeSync, selectInboxStore, selectBacklogSource } from './seams/index.js';
import { loadDaemonState } from './daemon/state.js';
import { buildFleetDigest } from './fleet/digest.js';
import { computeQualityMetrics } from './fleet/quality-metrics.js';
import { buildOversightSnapshot, type OversightSnapshot } from './fleet/oversight-export.js';
import { readDecisions } from './fleet/decisions-ledger.js';
import { listProposals } from './inbox/store.js';

// M169: best-effort imports for new elite-state tools
// Each is wrapped in a lazy async import inside the handler so module-level
// import failures never crash mcp-native at load time.
// (Types only — runtime imports done lazily in handlers below.)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on a serialized tool result (chars ≈ bytes for ASCII JSON). */
const MAX_OUTPUT_CHARS = 32 * 1024;

/** Cap on an individual proposal diff echoed back through ashlr_inbox_list. */
const MAX_DIFF_CHARS = 4 * 1024;

/** Marker inserted where output was truncated. */
const TRUNCATION_MARK = '\n…[ashlr: output truncated]…\n';

/** Internal privilege tags that external MCP callers may not persist. */
const RESERVED_LEARN_TAGS = new Set(['m243:skill']);

function externalLearnTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(String)
    .filter((tag) => !RESERVED_LEARN_TAGS.has(tag.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------
// Routing data derivation (M131)
// ---------------------------------------------------------------------------

export interface RoutingRow {
  ts: string;
  repo: string;
  task: string;
  engine: string;
  model: string;
  reason?: string;
}

export interface RoutingData {
  recent: RoutingRow[];
  modelSplit: Record<string, number>;
}

/**
 * Derive real routing history from proposal records (engineModel is always
 * populated by M127) and merge any routing-tagged decisions-ledger entries
 * that carry a reason field. Sorted newest-first, bounded to `limit`.
 * Never throws — returns empty data on any failure.
 */
export function deriveRoutingData(limit = 50): RoutingData {
  const rows: RoutingRow[] = [];

  // 1. Source from proposals — each proposal carries engineModel (e.g. "codex:gpt-5.5")
  try {
    const proposals = listProposals();
    for (const p of proposals) {
      const em = p.engineModel;
      if (!em || typeof em !== 'string') continue;
      const colonIdx = em.indexOf(':');
      const engine = colonIdx >= 0 ? em.slice(0, colonIdx) : em;
      const model = colonIdx >= 0 ? em.slice(colonIdx + 1) : '';
      if (!engine) continue;
      rows.push({
        ts: p.createdAt ?? '',
        repo: p.repo ?? '',
        task: (p.title ?? '').slice(0, 120),
        engine,
        model,
      });
    }
  } catch { /* degrade gracefully */ }

  // 2. Merge routing-tagged decisions-ledger entries (carry a reason when present).
  //    These are sparse — only add entries whose ts is NOT already covered by proposals.
  const proposalTs = new Set(rows.map((r) => r.ts));
  try {
    const decisions = readDecisions({ limit: 200 });
    for (const d of decisions) {
      if (typeof d.engine !== 'string') continue;
      if (proposalTs.has(d.ts)) continue; // already covered
      // Normalize engine the same way as proposals: split "engine:model" if combined.
      const ci = d.engine.indexOf(':');
      const dEngine = ci >= 0 ? d.engine.slice(0, ci) : d.engine;
      const dModel = ci >= 0 ? d.engine.slice(ci + 1) : (typeof d.model === 'string' ? d.model : '');
      if (!dEngine) continue;
      rows.push({
        ts: d.ts,
        repo: '',
        task: '',
        engine: dEngine,
        model: dModel,
        reason: typeof d.reason === 'string' ? d.reason : undefined,
      });
    }
  } catch { /* degrade gracefully */ }

  // 3. Sort newest-first, bound to limit.
  rows.sort((a, b) => b.ts.localeCompare(a.ts));
  const recent = rows.slice(0, limit);

  // 4. Compute modelSplit: count proposals per "engine:model" key.
  const modelSplit: Record<string, number> = {};
  for (const r of rows) {
    const key = r.model ? `${r.engine}:${r.model}` : r.engine;
    modelSplit[key] = (modelSplit[key] ?? 0) + 1;
  }

  return { recent, modelSplit };
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** A native tool definition plus its handler (handler kept out of types.ts). */
interface NativeToolImpl extends NativeToolDef {
  handler: (args: Record<string, unknown>, cfg: AshlrConfig) => Promise<unknown>;
}

const TOOLS: NativeToolImpl[] = [
  {
    name: 'ashlr_orient',
    description:
      'Session-start orientation: genome memory hits, repo health, top backlog items, ' +
      'pending proposal count, and portfolio attention. Call this once when starting ' +
      'work in a repo. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Absolute repo path to scope to (optional).' },
      },
    },
    safety: 'read',
    handler: async (args, cfg) =>
      buildOrientation(cfg, typeof args['repo'] === 'string' ? args['repo'] : undefined),
  },
  {
    name: 'ashlr_ask',
    description:
      'Ask a question about the indexed portfolio (local RAG, cites repo/file:line). ' +
      'Runs entirely on local models — code never leaves the machine. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to answer.' },
        repo: { type: 'string', description: 'Limit retrieval to one repo (optional).' },
      },
      required: ['question'],
    },
    safety: 'read',
    handler: async (args) =>
      // allowCloud is HARDCODED false (CONTRACT-M31 invariant 3).
      ask(String(args['question']), {
        repo: typeof args['repo'] === 'string' ? args['repo'] : undefined,
        allowCloud: false,
      }),
  },
  {
    name: 'ashlr_recall',
    description:
      'Search ashlr shared memory (genome) for prior decisions, conventions, and ' +
      'learnings relevant to a query. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall.' },
        limit: { type: 'number', description: 'Max hits, 1–20 (default 5).' },
      },
      required: ['query'],
    },
    safety: 'read',
    handler: async (args, cfg) => {
      const rawLimit = typeof args['limit'] === 'number' ? args['limit'] : 5;
      const limit = Math.max(1, Math.min(20, Math.floor(rawLimit)));
      const hits = await recall(String(args['query']), cfg, { limit });
      return hits.map((h) => ({
        title: h.entry.title,
        text: h.entry.text,
        tags: h.entry.tags,
        project: h.entry.project,
        score: h.score,
        method: h.method,
      }));
    },
  },
  {
    name: 'ashlr_learn',
    description:
      'Append a learning/decision/convention to ashlr shared memory (genome hub). ' +
      'Append-only; writes ONLY under ~/.ashlr/ — never into a repo working tree.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The learning to store.' },
        title: { type: 'string', description: 'Short title (derived when omitted).' },
        project: { type: 'string', description: 'Project name to scope to (optional).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags (optional).' },
      },
      required: ['text'],
    },
    safety: 'append',
    handler: async (args, cfg) => {
      const genome = selectGenomeSync(cfg);
      // hubOnly FORCED true: an agent can never drop a note file into a repo
      // working tree via this surface (CONTRACT-M31 invariant 4).
      const entry = genome.append({
        text: String(args['text']),
        title: typeof args['title'] === 'string' ? args['title'] : undefined,
        project: typeof args['project'] === 'string' ? args['project'] : undefined,
        tags: externalLearnTags(args['tags']),
        hubOnly: true,
      });
      return { stored: true, id: entry.id, title: entry.title };
    },
  },
  {
    name: 'ashlr_backlog',
    description:
      'Top scored work items from the persisted portfolio backlog (issues, TODOs, ' +
      'failing tests, dep/security findings). Read-only; never scans — run ' +
      '`ashlr backlog refresh` to rebuild.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Filter to one repo (optional).' },
        limit: { type: 'number', description: 'Max items (default 10).' },
      },
    },
    safety: 'read',
    handler: async (args, cfg) => {
      const backlog = selectBacklogSource(cfg).load();
      if (!backlog) {
        return {
          items: [],
          note: 'No backlog persisted — run `ashlr backlog refresh` (CLI) to build one.',
        };
      }
      const rawLimit = typeof args['limit'] === 'number' ? args['limit'] : 10;
      const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
      const repo = typeof args['repo'] === 'string' ? args['repo'] : null;
      const items = (repo ? backlog.items.filter((it) => it.repo === repo || it.repo.endsWith(`/${repo}`)) : backlog.items)
        .slice(0, limit)
        .map((it) => ({
          id: it.id,
          repo: it.repo,
          source: it.source,
          title: it.title,
          score: it.score,
          value: it.value,
          effort: it.effort,
        }));
      return { generatedAt: backlog.generatedAt, items };
    },
  },
  {
    name: 'ashlr_health',
    description:
      'Quality/health score for an enrolled repo (tests, docs, deps, security, debt), ' +
      'or the latest portfolio report when no repo is given. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Absolute path of an ENROLLED repo (optional).' },
      },
    },
    safety: 'read',
    handler: async (args) => {
      const repo = typeof args['repo'] === 'string' ? args['repo'] : null;
      if (repo) {
        // computeHealth hard-errors on non-enrolled repos (core invariant);
        // surface that as a normal message, not a tool crash.
        try {
          const score = await computeHealth(repo);
          return {
            repo: score.repo,
            score: score.score,
            grade: score.grade,
            dimensions: score.dimensions.map((d) => ({
              dimension: d.dimension,
              score: d.score,
              summary: d.summary,
            })),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
      const report = loadPreviousReport();
      if (!report) {
        return { note: 'No health report recorded — run `ashlr health` (CLI) first.' };
      }
      return {
        generatedAt: report.generatedAt,
        averageScore: report.averageScore,
        averageGrade: report.averageGrade,
        repos: report.scores.map((s) => ({ repo: s.repo, score: s.score, grade: s.grade })),
      };
    },
  },
  {
    name: 'ashlr_status',
    description:
      'Portfolio snapshot: repo counts (dirty/stale), recent runs and swarms, ' +
      'activity roll-up. Read-only metadata.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, cfg) => {
      const snap = await buildSnapshot(cfg);
      return {
        generatedAt: snap.generatedAt,
        repos: snap.repos,
        tools: snap.tools,
        activity: snap.activity,
        runs: snap.runs.slice(0, 5),
        swarms: snap.swarms.slice(0, 5),
      };
    },
  },
  {
    name: 'ashlr_impact',
    description:
      'Impact analysis for a file or symbol: references and dependents within and ' +
      'across enrolled repos (from the knowledge graph). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path or symbol name.' },
      },
      required: ['target'],
    },
    safety: 'read',
    handler: async (args) => impact(String(args['target'])),
  },
  {
    name: 'ashlr_pulse',
    description:
      'Token/cost/activity roll-up for a time window (sessions, tokens, est. cost, ' +
      'commits). Read-only metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: ['1d', '7d', '30d'], description: "Window (default '7d')." },
      },
    },
    safety: 'read',
    handler: async (args, cfg) => {
      const w = args['window'];
      const window = w === '1d' || w === '7d' || w === '30d' ? w : '7d';
      return buildRollup(window, cfg);
    },
  },
  {
    name: 'ashlr_inbox_list',
    description:
      'List inbox proposals (the human approval gate). Read-only — approval and ' +
      'rejection are HUMAN-ONLY via the `ashlr inbox` CLI.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'approved', 'rejected', 'awaiting-host-merge', 'applied', 'failed'],
          description: 'Filter by status (optional).',
        },
      },
    },
    safety: 'read',
    handler: async (args, cfg) => {
      const status = typeof args['status'] === 'string' ? (args['status'] as ProposalStatus) : undefined;
      const proposals = selectInboxStore(cfg).list(status ? { status } : undefined);
      return proposals.map((p) => ({
        id: p.id,
        repo: p.repo,
        origin: p.origin,
        kind: p.kind,
        title: p.title,
        summary: p.summary,
        status: p.status,
        createdAt: p.createdAt,
        // M107 (P0): scrub secrets from the diff before returning it over
        // the MCP surface. The stored proposal may have been created via the
        // swarm/builtin path before M107 — scrub defensively on read so
        // no previously-stored secret leaks via ashlr_inbox_list.
        diff: (() => {
          const raw = p.diff ?? '';
          const scrubbed = scrubSecrets(raw);
          return scrubbed.length > MAX_DIFF_CHARS
            ? scrubbed.slice(0, MAX_DIFF_CHARS) + TRUNCATION_MARK
            : scrubbed || undefined;
        })(),
      }));
    },
  },
  {
    name: 'ashlr_inbox_propose',
    description:
      'Propose an outward action (patch / pr / note) into the approval inbox. The ' +
      'proposal is created PENDING and applies ONLY after explicit human approval ' +
      'via `ashlr inbox`. Nothing is executed by this call.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          // 'deploy' is deliberately EXCLUDED from the agent surface.
          enum: ['patch', 'pr', 'note'],
          description: 'What kind of outward action is proposed.',
        },
        title: { type: 'string', description: 'Short title for the inbox list.' },
        summary: { type: 'string', description: 'What + why (no secrets).' },
        repo: { type: 'string', description: 'Absolute target repo path (optional for notes).' },
        diff: { type: 'string', description: 'Unified diff for patch/pr proposals (optional).' },
      },
      required: ['kind', 'title', 'summary'],
    },
    safety: 'proposal',
    handler: async (args, cfg) => {
      const kind = String(args['kind']);
      if (kind !== 'patch' && kind !== 'pr' && kind !== 'note') {
        return { error: `invalid kind "${kind}" — agent proposals may be patch | pr | note` };
      }
      const proposal = selectInboxStore(cfg).create({
        repo: typeof args['repo'] === 'string' ? args['repo'] : null,
        origin: 'agent',
        kind,
        title: String(args['title']),
        summary: String(args['summary']),
        ...(typeof args['diff'] === 'string' ? { diff: args['diff'] } : {}),
      });
      return {
        created: true,
        id: proposal.id,
        status: proposal.status,
        note: 'Pending human review — approve/reject via `ashlr inbox` (CLI).',
      };
    },
  },

  // ── M105: Browser-action proposal tool ─────────────────────────────────
  {
    name: 'ashlr_browser_task',
    description:
      'Propose a browser automation task (navigate to a URL and/or run instructions ' +
      'via the Claude-in-Chrome MCP server). Creates a PENDING browser-action proposal ' +
      '— NEVER executes directly. The action runs ONLY after the user explicitly ' +
      'approves via `ashlr inbox`. Requires a Claude-in-Chrome (or compatible) MCP ' +
      'server to be configured; browser tasks are refused cleanly in headless / ' +
      'daemon contexts where no browser MCP is reachable. ' +
      'Requires the repo to be enrolled and the kill switch to be off.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Absolute path of an enrolled repo. Required — action is scoped to it.',
        },
        url: {
          type: 'string',
          description: 'Optional URL to navigate to before running instructions.',
        },
        instructions: {
          type: 'string',
          description: 'Natural-language instructions describing what to do in the browser (no secrets).',
        },
        title: {
          type: 'string',
          description: 'Short title for the inbox list.',
        },
        summary: {
          type: 'string',
          description: 'Why this browser task is being proposed (no secrets).',
        },
      },
      required: ['repo', 'instructions', 'title', 'summary'],
    },
    safety: 'proposal',
    handler: async (args, cfg) => {
      const repo = typeof args['repo'] === 'string' ? args['repo'] : null;
      const instructions = typeof args['instructions'] === 'string' ? args['instructions'] : '';
      const url = typeof args['url'] === 'string' ? args['url'] : undefined;

      if (!instructions.trim()) {
        return { error: 'instructions must be a non-empty string' };
      }

      // Enrollment check — refuse without creating a proposal.
      const { isEnrolled } = await import('./sandbox/policy.js');
      if (!repo || !isEnrolled(repo)) {
        return {
          error: `repo '${repo ?? '(none)'}' is not enrolled — enroll it first with \`ashlr enroll add <path>\``,
        };
      }

      // Create a PENDING proposal — NEVER execute here.
      const proposal = selectInboxStore(cfg).create({
        repo,
        origin: 'agent',
        kind: 'browser-action',
        title: String(args['title']),
        summary: String(args['summary']),
        action: {
          type: 'browser-task',
          instructions,
          ...(url !== undefined ? { url } : {}),
        },
      });

      return {
        created: true,
        id: proposal.id,
        status: 'pending',
        note:
          'Pending human approval — approve via `ashlr inbox` (CLI). ' +
          'The browser task will NOT execute until you approve it. ' +
          'A Claude-in-Chrome MCP server must be configured and reachable at apply time.',
      };
    },
  },

  // ── M129: Fleet-state read tools ───────────────────────────────────────

  {
    name: 'ashlr_fleet_status',
    description:
      'Live fleet status: daemon running/pid, last tick, today\'s spend vs budget, ' +
      'items processed, recent tick history (concurrency + per-backend dispatch counts), ' +
      'and pending-proposal count. Combines daemon state + fleet digest. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, _cfg) => {
      // loadDaemonState and buildFleetDigest both never throw.
      const ds = loadDaemonState();
      const digest = await buildFleetDigest('7d');
      // Bound ticks to last 20 for output size.
      const recentTicks = Array.isArray(ds.ticks) ? ds.ticks.slice(-20) : [];
      return {
        running: ds.running,
        pid: ds.pid,
        startedAt: ds.startedAt,
        lastTickAt: ds.lastTickAt,
        todaySpentUsd: ds.todaySpentUsd,
        itemsProcessed: ds.itemsProcessed,
        recentTicks,
        pendingProposals: digest.totalPending,
        digest: {
          totalProposed: digest.totalProposed,
          totalAutoMerged: digest.totalAutoMerged,
          totalDeclined: digest.totalDeclined,
          repos: digest.repos.slice(0, 10),
        },
      };
    },
  },

  {
    name: 'ashlr_scorecard',
    description:
      'Quality metrics scorecard for the autonomous fleet: proposals created, merged, ' +
      'rejected, accept/reject rates, verify pass rate, avg diff size, per-engine and ' +
      'per-repo breakdowns, and trend data. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          enum: ['7d', '30d', 'all'],
          description: "Time window for metrics (default '7d').",
        },
      },
    },
    safety: 'read',
    handler: async (args, _cfg) => {
      const w = args['window'];
      const window = w === '7d' || w === '30d' || w === 'all' ? w : '7d';
      return computeQualityMetrics(window);
    },
  },

  {
    name: 'ashlr_oversight',
    description:
      'Full fleet oversight snapshot: quality scorecard (30d), latest Manager-agent ' +
      'verdict summary (shipped/review/noise/harmful + recommendations), current vision ' +
      '(north-star, end-state, ambition level, progress %), and goals progress summary ' +
      '(active/done/progressPct). Read-only.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, cfg) => {
      // buildOversightSnapshot accepts PulseExportCfg; AshlrConfig is structurally
      // compatible (both have optional pulse?: { enabled?, endpoint? }).
      // The cfg arg is currently void'd inside the function but passed for future scoping.
      const snap: OversightSnapshot = buildOversightSnapshot(cfg as { pulse?: { enabled?: boolean; endpoint?: string } });
      return snap;
    },
  },

  {
    name: 'ashlr_routing',
    description:
      'Recent routing decisions: which engine:model handled which task and the reason. ' +
      'Derives history from proposal engineModel fields (always populated by M127) and ' +
      'merges any routing-tagged decisions-ledger entries that carry a reason. ' +
      'Returns { recent: RoutingRow[], modelSplit: Record<string,number> }. ' +
      'Best-effort — recent is [] when no proposals exist yet. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Max entries to return in recent[], 1–100 (default 50).',
        },
      },
    },
    safety: 'read',
    handler: async (args, _cfg) => {
      const rawLimit = typeof args['limit'] === 'number' ? args['limit'] : 50;
      const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
      return deriveRoutingData(limit);
    },
  },

  // ── M169: Elite fleet state ────────────────────────────────────────────

  {
    name: 'ashlr_north_star',
    description:
      'Human-leverage north-star metric for the autonomous fleet (7d window): ' +
      'substantive merges, estimated engineering hours saved, leverage score (0–100), ' +
      'and week-over-week trend. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, cfg) => {
      try {
        const { computeNorthStar, northStarSummary } = await import('./vision/north-star.js');
        const metric = computeNorthStar(cfg);
        return {
          substantiveMerges7d: metric.substantiveMerges7d,
          engHoursSaved7d: metric.engHoursSaved7d,
          leverageScore: metric.leverageScore,
          trend: metric.trend,
          computedAt: metric.computedAt,
          summary: northStarSummary(metric),
          raw: metric.raw,
        };
      } catch {
        return {
          substantiveMerges7d: 0,
          engHoursSaved7d: 0,
          leverageScore: 0,
          trend: 'flat',
          computedAt: new Date().toISOString(),
          summary: '=== NORTH-STAR: HUMAN LEVERAGE ===\nMetric unavailable.',
          raw: null,
          _unavailable: true,
        };
      }
    },
  },

  {
    name: 'ashlr_self_heal',
    description:
      'Read-only self-heal queue summary: how many repos are being monitored, ' +
      'which are currently broken, and the queued high-priority heal work items. ' +
      'Never triggers a heal cycle — purely observational. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, cfg) => {
      try {
        const { homedir } = await import('node:os');
        const { join } = await import('node:path');
        const { existsSync, readFileSync } = await import('node:fs');
        const { listEnrolled } = await import('./sandbox/policy.js');

        const qPath = join(homedir(), '.ashlr', 'self-heal-queue.json');
        let queue: unknown[] = [];
        if (existsSync(qPath)) {
          try {
            const raw = JSON.parse(readFileSync(qPath, 'utf8'));
            queue = Array.isArray(raw) ? raw : [];
          } catch {
            queue = [];
          }
        }

        const enrolled = (() => { try { return listEnrolled(); } catch { return []; } })();
        const selfHealEnabled = ((cfg as unknown) as { foundry?: Record<string, unknown> })
          .foundry?.selfHeal !== false;

        return {
          enabled: selfHealEnabled,
          enrolledRepos: enrolled.length,
          queuedHealItems: queue.length,
          healQueue: (queue as Array<Record<string, unknown>>).slice(0, 10).map((item) => ({
            id: item['id'],
            repo: item['repo'],
            title: item['title'],
            tags: item['tags'],
            score: item['score'],
            ts: item['ts'],
          })),
        };
      } catch {
        return {
          enabled: false,
          enrolledRepos: 0,
          queuedHealItems: 0,
          healQueue: [],
          _unavailable: true,
        };
      }
    },
  },

  {
    name: 'ashlr_racing',
    description:
      'Model-racing distillation stats: total races persisted, frontier-engine win rate, ' +
      'average score delta (frontier − local), and local win count. ' +
      'Reads from ~/.ashlr/racing/. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, _cfg) => {
      try {
        const { racingStats } = await import('./fleet/model-racing.js');
        const stats = racingStats();
        return {
          races: stats.races,
          frontierWinRate: stats.frontierWinRate,
          avgScoreDelta: stats.avgScoreDelta,
          localWins: stats.localWins,
        };
      } catch {
        return {
          races: 0,
          frontierWinRate: 0,
          avgScoreDelta: 0,
          localWins: 0,
          _unavailable: true,
        };
      }
    },
  },

  {
    name: 'ashlr_comms',
    description:
      'Comms channel status: whether the channel is enabled, which transport is ' +
      'configured (imessage/telegram/none), and pending/outstanding request counts. ' +
      'Secret-safe — the bot token and handle are NEVER included in the output. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    safety: 'read',
    handler: async (_args, cfg) => {
      try {
        const { listRequests, outstanding } = await import('./comms/requests.js');

        const comms = ((cfg as unknown) as { comms?: { enabled?: boolean; channel?: string } }).comms;
        const enabled = comms?.enabled === true;
        // channel derived from config — never expose token/handle/credentials
        const channel = comms?.channel ?? 'none';

        const pending = (() => {
          try { return listRequests({ status: 'pending' }).length; } catch { return 0; }
        })();
        const outstandingReq = (() => {
          try { return outstanding(); } catch { return undefined; }
        })();

        return {
          enabled,
          channel,
          pendingRequests: pending,
          hasOutstanding: outstandingReq !== undefined,
          outstandingKind: outstandingReq?.kind ?? null,
          outstandingType: outstandingReq?.type ?? null,
        };
      } catch {
        return {
          enabled: false,
          channel: 'none',
          pendingRequests: 0,
          hasOutstanding: false,
          outstandingKind: null,
          outstandingType: null,
          _unavailable: true,
        };
      }
    },
  },

  // ── M103: Desktop-action proposal tool ─────────────────────────────────
  {
    name: 'ashlr_desktop_open',
    description:
      'Propose a desktop UI action (open a path in editor / Finder / terminal). ' +
      'Creates a PENDING desktop-action proposal — NEVER executes directly. ' +
      'The action runs only after the user explicitly approves via `ashlr inbox`. ' +
      'Requires the repo to be enrolled and the kill switch to be off.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: 'Absolute path of an enrolled repo. Required — target must reside within it.',
        },
        action_type: {
          type: 'string',
          enum: ['open-editor', 'open-finder', 'open-terminal'],
          description: 'Which UI launcher to invoke.',
        },
        target: {
          type: 'string',
          description: 'Absolute path to open (must be within the enrolled repo).',
        },
        title: {
          type: 'string',
          description: 'Short title for the inbox list.',
        },
        summary: {
          type: 'string',
          description: 'Why this desktop action is being proposed (no secrets).',
        },
      },
      required: ['repo', 'action_type', 'target', 'title', 'summary'],
    },
    safety: 'proposal',
    handler: async (args, cfg) => {
      // Vocabulary guard (belt-and-suspenders — JSON Schema enum already checked).
      const actionType = String(args['action_type']);
      const allowed = ['open-editor', 'open-finder', 'open-terminal'];
      if (!allowed.includes(actionType)) {
        return {
          error: `invalid action_type "${actionType}" — must be one of: ${allowed.join(' | ')}`,
        };
      }

      const repo = typeof args['repo'] === 'string' ? args['repo'] : null;
      const target = typeof args['target'] === 'string' ? args['target'] : '';

      // Enrollment check — refuse without creating a proposal.
      const { isEnrolled } = await import('./sandbox/policy.js');
      if (!repo || !isEnrolled(repo)) {
        return {
          error: `repo '${repo ?? '(none)'}' is not enrolled — enroll it first with \`ashlr enroll add <path>\``,
        };
      }

      // Create a PENDING proposal — NEVER execute here.
      const proposal = selectInboxStore(cfg).create({
        repo,
        origin: 'agent',
        kind: 'desktop-action',
        title: String(args['title']),
        summary: String(args['summary']),
        action: {
          type: actionType as 'open-editor' | 'open-finder' | 'open-terminal',
          target,
        },
      });

      return {
        created: true,
        id: proposal.id,
        status: 'pending',
        note: 'Pending human approval — approve via `ashlr inbox` (CLI). The action will NOT execute until you approve it.',
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Public registry surface
// ---------------------------------------------------------------------------

/** The native tool definitions (no handlers) for diagnostics/docs surfaces. */
export function nativeToolDefs(): NativeToolDef[] {
  return TOOLS.map(({ name, description, inputSchema, safety }) => ({
    name,
    description,
    inputSchema,
    safety,
  }));
}

/** tools/list shape: name + description + inputSchema (gateway prepends these). */
export function listNativeTools(): { name: string; description: string; inputSchema: object }[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

/** True when `name` is a native tool (used by the gateway router). */
export function isNativeTool(name: string): boolean {
  return TOOLS.some((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Argument validation (lightweight, zero-dep)
// ---------------------------------------------------------------------------

/**
 * Validate args against the tool's JSON Schema: required presence + primitive
 * type checks + enum membership. Returns an error message or null. Unknown
 * properties are tolerated (forward compatibility).
 */
function validateArgs(schema: object, args: Record<string, unknown>): string | null {
  const s = schema as {
    properties?: Record<string, { type?: string; enum?: unknown[] }>;
    required?: string[];
  };
  for (const req of s.required ?? []) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return `missing required argument "${req}"`;
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = s.properties?.[key];
    if (!prop || value === undefined || value === null) continue;
    if (prop.type === 'string' && typeof value !== 'string') {
      return `argument "${key}" must be a string`;
    }
    if (prop.type === 'number' && typeof value !== 'number') {
      return `argument "${key}" must be a number`;
    }
    if (prop.type === 'array' && !Array.isArray(value)) {
      return `argument "${key}" must be an array`;
    }
    if (prop.enum && !prop.enum.includes(value)) {
      return `argument "${key}" must be one of: ${prop.enum.join(', ')}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// callNativeTool — the gated pipeline
// ---------------------------------------------------------------------------

/**
 * MCP-style text result (plain object; the SDK validates it gateway-side).
 * A `type` alias (not an interface) so it picks up an implicit index signature
 * and stays assignable to the SDK's CallToolResult without importing the SDK.
 */
export type NativeToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/** Exported for tests: serialize + scrub + cap exactly as tool results do. */
export function renderToolText(payload: unknown): string {
  return textResult(payload).content[0]?.text ?? '';
}

function textResult(payload: unknown, isError = false): NativeToolResult {
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  } catch {
    text = String(payload);
  }
  // Scrub BEFORE capping so a secret straddling the cap boundary can't survive.
  text = scrubSecrets(text);
  if (text.length > MAX_OUTPUT_CHARS) {
    const head = text.slice(0, Math.floor(MAX_OUTPUT_CHARS * 0.75));
    const tail = text.slice(-Math.floor(MAX_OUTPUT_CHARS * 0.2));
    text = head + TRUNCATION_MARK + tail;
  }
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * Audit one native-tool outcome. Every call site shares the same
 * 'mcp:native-call' action with null repo/sandbox and a `${tool} keys=${keys}`
 * summary prefix; only the trailing detail + result class vary.
 */
function auditNativeCall(summary: string, result: 'ok' | 'refused' | 'error'): void {
  audit({
    action: 'mcp:native-call',
    repo: null,
    sandboxId: null,
    summary,
    result,
  });
}

/**
 * Execute a native tool through the full safety pipeline. NEVER throws:
 * unknown tools, invalid args, kill-switch refusals, and handler failures all
 * surface as isError text results. Every outcome is audited.
 */
export async function callNativeTool(name: string, rawArgs: unknown): Promise<NativeToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  const args: Record<string, unknown> =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  const argKeys = Object.keys(args).sort().join(',') || '(none)';

  if (!tool) {
    auditNativeCall(`${name} keys=${argKeys} — unknown native tool`, 'error');
    return textResult(`Unknown native tool "${name}".`, true);
  }

  // ── Validate ───────────────────────────────────────────────────────────────
  const invalid = validateArgs(tool.inputSchema, args);
  if (invalid) {
    auditNativeCall(`${tool.name} keys=${argKeys} — invalid args: ${invalid}`, 'error');
    return textResult(`Invalid arguments for ${tool.name}: ${invalid}`, true);
  }

  // ── Safety gate: KILL refuses all writes (CONTRACT-M31 invariant 2) ───────
  if (tool.safety !== 'read' && killSwitchOn()) {
    auditNativeCall(`${tool.name} keys=${argKeys} — refused: kill switch on`, 'refused');
    return textResult(
      `${tool.name} refused: the ashlr kill switch is engaged (~/.ashlr/KILL). ` +
      'Read-only tools still work; writes are disabled until `ashlr enroll kill off`.',
      true,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  let cfg: AshlrConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    auditNativeCall(`${tool.name} keys=${argKeys} — config load failed`, 'error');
    return textResult(
      `${tool.name} failed: could not load ~/.ashlr/config.json (${err instanceof Error ? err.message : String(err)})`,
      true,
    );
  }

  try {
    const payload = await tool.handler(args, cfg);
    auditNativeCall(`${tool.name} keys=${argKeys} — ok`, 'ok');
    return textResult(payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    auditNativeCall(`${tool.name} keys=${argKeys} — error: ${msg}`, 'error');
    return textResult(`${tool.name} failed: ${msg}`, true);
  }
}

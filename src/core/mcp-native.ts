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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on a serialized tool result (chars ≈ bytes for ASCII JSON). */
const MAX_OUTPUT_CHARS = 32 * 1024;

/** Cap on an individual proposal diff echoed back through ashlr_inbox_list. */
const MAX_DIFF_CHARS = 4 * 1024;

/** Marker inserted where output was truncated. */
const TRUNCATION_MARK = '\n…[ashlr: output truncated]…\n';

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
        tags: Array.isArray(args['tags']) ? args['tags'].map(String) : undefined,
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
          enum: ['pending', 'approved', 'rejected', 'applied', 'failed'],
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
        diff:
          p.diff && p.diff.length > MAX_DIFF_CHARS
            ? p.diff.slice(0, MAX_DIFF_CHARS) + TRUNCATION_MARK
            : p.diff,
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

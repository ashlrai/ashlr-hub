/**
 * cli/help.ts — agent-facing docs surface (M31).
 *
 * `ashlr docs --agent [--json]` emits a compact, llms.txt-style cheat sheet of
 * the agent-relevant commands: what each does, its safety class, the --json
 * contract, and exit-code discipline. Generated from AGENT_COMMANDS so the
 * docs can never drift from one source of truth.
 *
 * `claudeMdSnippet()` renders a ready-to-paste CLAUDE.md block teaching agents
 * the CLI-first usage (consumed by `ashlr wire --claude-md`).
 *
 * Safety classes mirror CONTRACT-M31:
 *   read       — read-only of local stores; always safe.
 *   append     — append-only write under ~/.ashlr/ (genome hub).
 *   proposal   — creates a PENDING inbox proposal; never applies anything.
 *   human-gate — listed for awareness only; agents must NOT run it.
 */

import { makeColors, isTty, pad } from './ui.js';

export type AgentSafety = 'read' | 'append' | 'proposal' | 'human-gate';

export interface AgentCommandDoc {
  /** Invocation shape, e.g. `ashlr ask "<question>" --json`. */
  usage: string;
  /** One-line purpose. */
  description: string;
  /** Safety classification (CONTRACT-M31). */
  safety: AgentSafety;
  /** Name of the stable --json output shape (types.ts), or a short note. */
  jsonShape: string;
}

/**
 * The agent-relevant command registry — the CLI-first contract. Every entry's
 * --json output is stable (typed in src/core/types.ts) and ANSI-free.
 * Exit codes everywhere: 0 success, 1 runtime error, 2 bad usage.
 */
export const AGENT_COMMANDS: AgentCommandDoc[] = [
  {
    usage: 'ashlr orient [--repo <path>] --json',
    description: 'Session-start context: genome hits, health, backlog, pending proposals, attention. Run once when starting work.',
    safety: 'read',
    jsonShape: 'OrientResult',
  },
  {
    usage: 'ashlr ask "<question>" [--json]',
    description: 'Local RAG over the indexed portfolio; cites repo/file:line. Local models only unless --allow-cloud.',
    safety: 'read',
    jsonShape: 'AskResult',
  },
  {
    usage: 'ashlr recall "<query>" [--json]',
    description: 'Search shared genome memory for prior decisions/conventions/learnings.',
    safety: 'read',
    jsonShape: 'RecallHit[]',
  },
  {
    usage: 'ashlr learn "<text>" [--title t] [--project p] [--tags a,b]',
    description: 'Append a learning to shared memory (append-only, hub store under ~/.ashlr/).',
    safety: 'append',
    jsonShape: 'GenomeEntry (created)',
  },
  {
    usage: 'ashlr backlog [--repo <path>] [--limit N] --json',
    description: 'Top scored work items from the persisted portfolio backlog (read; refresh is a separate human step).',
    safety: 'read',
    jsonShape: 'Backlog',
  },
  {
    usage: 'ashlr health [<repo>] --json',
    description: 'Quality score for an enrolled repo (tests/docs/deps/security/debt) or the latest portfolio report.',
    safety: 'read',
    jsonShape: 'HealthScore | HealthReport',
  },
  {
    usage: 'ashlr status',
    description: 'Attention board: dirty/stale repos + ecosystem summary.',
    safety: 'read',
    jsonShape: '(human-oriented; use orient --json)',
  },
  {
    usage: 'ashlr knowledge impact <target> [--json]',
    description: 'References + dependents of a file/symbol within and across enrolled repos.',
    safety: 'read',
    jsonShape: 'ImpactResult',
  },
  {
    usage: 'ashlr pulse [--window 1d|7d|30d] --json',
    description: 'Token/cost/activity roll-up (sessions, tokens, est. cost, commits).',
    safety: 'read',
    jsonShape: 'ActivityRollup',
  },
  {
    usage: 'ashlr inbox --json',
    description: 'List proposals in the approval inbox. LISTING ONLY for agents — approve/reject is human-only.',
    safety: 'read',
    jsonShape: 'Proposal[]',
  },
  {
    usage: 'ashlr inbox approve|reject <id>',
    description: 'HUMAN-ONLY: the single gate through which every outward action passes. Agents must never run this.',
    safety: 'human-gate',
    jsonShape: 'ApplyResult',
  },
];

/** Render the cheat sheet as plain text (llms.txt-style; no ANSI). */
export function agentDocsText(): string {
  const lines: string[] = [
    '# ashlr — agent contract (CLI-first)',
    '',
    'ashlr is a local-first command center: portfolio memory (genome), local RAG,',
    'work discovery (backlog), repo health, and a human-gated approval inbox.',
    'Use the CLI below from any agent session. Every --json shape is stable and',
    'ANSI-free; exit codes are 0 success / 1 error / 2 bad usage.',
    '',
    'Safety classes: read = always safe · append = append-only under ~/.ashlr/ ·',
    'proposal = creates a PENDING inbox item (never applies) · human-gate = NEVER',
    'run from an agent; the human approves via `ashlr inbox`.',
    '',
  ];
  for (const c of AGENT_COMMANDS) {
    lines.push(`## ${c.usage}`);
    lines.push(`safety: ${c.safety} · json: ${c.jsonShape}`);
    lines.push(c.description);
    lines.push('');
  }
  lines.push('Equivalent MCP tools (when wired via `ashlr wire`): ashlr_orient,');
  lines.push('ashlr_ask, ashlr_recall, ashlr_learn, ashlr_backlog, ashlr_health,');
  lines.push('ashlr_status, ashlr_impact, ashlr_pulse, ashlr_inbox_list,');
  lines.push('ashlr_inbox_propose. There is NO approve/apply tool by design.');
  lines.push('');
  return lines.join('\n');
}

/** Ready-to-paste CLAUDE.md block (for `ashlr wire --claude-md`). */
export function claudeMdSnippet(): string {
  return [
    '## ashlr (portfolio command center)',
    '',
    'This machine runs ashlr — local-first portfolio memory, RAG, and work',
    'discovery. Use it via Bash:',
    '',
    '- **Session start:** `ashlr orient --repo <repo> --json` — prior decisions,',
    '  repo health, top backlog items, pending proposals. Read it before working.',
    '- **Questions about any repo:** `ashlr ask "<question>" --json` (cites file:line).',
    '- **Search prior learnings:** `ashlr recall "<query>" --json`.',
    '- **Save a learning** (architecture decision, gotcha, convention):',
    '  `ashlr learn "<text>" --project <name>` — append-only, safe.',
    '- **Find work:** `ashlr backlog --repo <repo> --json`.',
    '- **NEVER run** `ashlr inbox approve|reject` or `ashlr enroll` — those are',
    '  human-only gates.',
    '',
  ].join('\n');
}

function printDocsHelp(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  ashlr docs') + c.dim(' — generated documentation surfaces'));
  console.log('');
  console.log(`    ${c.cyan('ashlr docs --agent')}          ${c.dim('agent cheat sheet (llms.txt-style, plain text)')}`);
  console.log(`    ${c.cyan('ashlr docs --agent --json')}   ${c.dim('the same registry as JSON')}`);
  console.log(`    ${c.cyan('ashlr wire --claude-md')}      ${c.dim('CLAUDE.md snippet for agent configs')}`);
  console.log('');
}

export async function cmdDocs(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const agent = args.includes('--agent');

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    printDocsHelp();
    return 0;
  }

  if (!agent) {
    printDocsHelp();
    return 2;
  }

  if (json) {
    process.stdout.write(JSON.stringify({ commands: AGENT_COMMANDS }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(agentDocsText());
  return 0;
}

/** Human-facing summary table for `ashlr docs` discoverability surfaces. */
export function renderAgentTable(): string {
  const c = makeColors(isTty());
  const w = Math.max(...AGENT_COMMANDS.map((x) => x.usage.length));
  return AGENT_COMMANDS
    .map((x) => `    ${c.cyan(pad(x.usage, w))}  ${c.dim(`[${x.safety}]`)} ${x.description}`)
    .join('\n');
}

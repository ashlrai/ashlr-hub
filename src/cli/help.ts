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
import { BACKLOG_SOURCE_FILTER_HELP } from './backlog.js';

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
  {
    usage: 'ashlr invent [<repo>] [--n N] [--direction <text>] [--emit] [--json]',
    description: 'Generative engine: invent bold, net-new features for a repo using a frontier model. --emit files them into the backlog.',
    safety: 'read',
    jsonShape: 'WorkItem[]',
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
  lines.push('ashlr_inbox_propose. Fleet-state read tools (M129): ashlr_fleet_status,');
  lines.push('ashlr_scorecard, ashlr_oversight, ashlr_routing.');
  lines.push('Elite fleet-state read tools (M169): ashlr_north_star (north-star metric,');
  lines.push('7d window), ashlr_self_heal (self-heal queue summary), ashlr_racing');
  lines.push('(model-racing distillation stats), ashlr_comms (comms channel status).');
  lines.push('There is NO approve/apply tool by design.');
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

// ---------------------------------------------------------------------------
// M32: topic-grouped help — `ashlr help [<topic>] [--search <term>] [--all]`
// ---------------------------------------------------------------------------

export type HelpTopic =
  | 'core' | 'run' | 'swarm' | 'memory' | 'knowledge' | 'autonomy'
  | 'observability' | 'integrations' | 'safety' | 'web' | 'scaffold';

export interface HelpEntry {
  cmd: string;
  desc: string;
  topic: HelpTopic;
}

const TOPIC_LABELS: Record<HelpTopic, string> = {
  core: 'Core — index, navigate, configure',
  run: 'Run — local-first agent runs',
  swarm: 'Swarm — specs + multi-agent fleets',
  memory: 'Memory — shared genome',
  knowledge: 'Knowledge — portfolio RAG + graph',
  autonomy: 'Autonomy — enrollment, backlog, daemon, inbox, goals',
  observability: 'Observability — cost, telemetry, audit',
  integrations: 'Integrations — MCP, GitHub, Vercel, editors',
  safety: 'Safety — sandboxes, invariants, activation',
  web: 'Surfaces — TUI + web dashboard',
  scaffold: 'Scaffold — new projects + shipping',
};

/** The full command table (the former inline cmdHelp list), topic-tagged. */
export const HELP_ENTRIES: HelpEntry[] = [
  { cmd: 'index [--refresh]',            desc: 'Build or refresh the desktop index; show counts by category.', topic: 'core' },
  { cmd: 'go [query] [--open|--cd]',     desc: 'Find a repo or item; open in editor (--open) or print path for cd (--cd).', topic: 'core' },
  { cmd: 'status',                       desc: 'Attention board: dirty, off-sync, and stale repos; ecosystem summary.', topic: 'core' },
  { cmd: 'ls [category]',                desc: 'List all indexed items, optionally filtered by category.', topic: 'core' },
  { cmd: 'open [query]',                 desc: 'Open the best match in your editor; no query opens an interactive picker.', topic: 'core' },
  { cmd: 'tidy [--apply]',               desc: 'Show (or apply) tidy moves for loose Desktop files.', topic: 'core' },
  { cmd: 'config [get <k>|set <k> <v>]', desc: 'Read/write a config value. No args prints a summary.', topic: 'core' },
  { cmd: 'config effective [--json]',     desc: 'Read-only effective autonomy/daemon/foundry/backend settings.', topic: 'core' },
  { cmd: 'config set <k> --json <v>',    desc: 'Set a structured (array/object) config value as JSON.', topic: 'core' },
  { cmd: 'config path',                  desc: 'Print the path to config.json.', topic: 'core' },
  { cmd: 'doctor',                       desc: 'One-glance health check: config, phantom, providers, ecosystem.', topic: 'core' },
  { cmd: 'init [--yes]',                 desc: 'Idempotent onboarding: ensure config, detect phantom + models, set editor.', topic: 'core' },
  { cmd: 'update [--check] [--json]',    desc: 'Safe self-update: git pull --ff-only + rebuild. --check reports only.', topic: 'core' },
  { cmd: 'orient [--repo <r>] [--json]', desc: 'Session-start context: genome hits, health, backlog, pending proposals, attention (read-only).', topic: 'core' },
  { cmd: 'docs --agent [--json]',        desc: 'Agent cheat sheet: the CLI-first contract (commands, safety classes, JSON shapes).', topic: 'core' },
  { cmd: 'completions zsh|bash',         desc: 'Print a shell completion script to stdout.', topic: 'core' },
  { cmd: 'plugins init|list|info|enable|disable', desc: 'Scaffold + manage plugins (~/.ashlr/plugins/) — default-off, integrity-pinned, audited (see docs/PLUGINS.md).', topic: 'core' },
  { cmd: 'x <name> [args...]',           desc: "Run an enabled plugin's command.", topic: 'core' },
  { cmd: 'help [<topic>] [--all]',       desc: 'Topic-grouped help; --all prints every command; --search <term> filters.', topic: 'core' },

  { cmd: 'run "<goal>" [opts]',          desc: 'Decompose goal into tasks; execute via local model (Ollama/LM Studio).', topic: 'run' },
  { cmd: 'run show <id>',                desc: 'Print a past run in detail.', topic: 'run' },
  { cmd: 'runs [--json]',                desc: 'List past runs (newest first).', topic: 'run' },
  { cmd: 'models [--json]',              desc: 'List local models (Ollama/LM Studio); marks the active one.', topic: 'run' },
  { cmd: 'models pull <name> [--yes]',   desc: 'Explicitly pull an Ollama model (large download; confirm first).', topic: 'run' },
  { cmd: 'models start',                 desc: 'Best-effort start a locally-installed Ollama (never downloads).', topic: 'run' },

  { cmd: 'spec new "<goal>" [--project]', desc: 'Author a versioned end-state spec artifact (local-first model).', topic: 'swarm' },
  { cmd: 'spec list [--project <path>]', desc: 'List all spec artifacts, newest version per spec.', topic: 'swarm' },
  { cmd: 'spec show <id>',               desc: 'Print a spec artifact in full.', topic: 'swarm' },
  { cmd: 'spec refine <id> "<note>"',    desc: 'Produce a new version of a spec incorporating the note.', topic: 'swarm' },
  { cmd: 'swarm "<goal>" [opts]',        desc: 'Decompose goal into a contracts-first DAG; run a fleet of agents.', topic: 'swarm' },
  { cmd: 'swarm <specId> [opts]',        desc: 'Run a swarm against an existing spec artifact.', topic: 'swarm' },
  { cmd: 'swarm show <id>',              desc: 'Print a past swarm run in detail.', topic: 'swarm' },
  { cmd: 'swarms [--json]',              desc: 'List past swarm runs (newest first).', topic: 'swarm' },

  { cmd: 'recall "<query>"',             desc: 'Search shared genome memory; return top relevant entries with scores.', topic: 'memory' },
  { cmd: 'learn "<text>" [opts]',        desc: 'Append a note to shared genome memory (local-first, append-only).', topic: 'memory' },
  { cmd: 'genome',                       desc: 'Genome status/health: entry count, projects covered, store size.', topic: 'memory' },

  { cmd: 'knowledge build',              desc: 'Index enrolled repos locally (read-only, secret-scrubbed) for portfolio RAG.', topic: 'knowledge' },
  { cmd: 'ask "<question>"',             desc: 'Local RAG across the indexed portfolio; cites repo/file:line. --allow-cloud opt-in.', topic: 'knowledge' },
  { cmd: 'knowledge impact <target>',    desc: 'Show references + dependents of a file/symbol within and across enrolled repos.', topic: 'knowledge' },
  { cmd: 'knowledge graph',              desc: 'Print the portfolio knowledge graph (repos/modules/deps + cross-repo findings).', topic: 'knowledge' },

  { cmd: 'enroll list',                  desc: 'List enrolled repos + kill switch state.', topic: 'autonomy' },
  { cmd: 'enroll add <repo>',            desc: 'Enroll a repo for autonomous work.', topic: 'autonomy' },
  { cmd: 'enroll remove <repo>',         desc: 'Remove a repo from the enrollment registry.', topic: 'autonomy' },
  { cmd: 'enroll kill on|off',           desc: 'Toggle the global autonomous kill switch.', topic: 'autonomy' },
  { cmd: 'backlog',                      desc: 'Scored work queue across enrolled repos (issues, TODOs, tests, deps, docs, security, plugins, goals, hygiene, invention).', topic: 'autonomy' },
  { cmd: 'backlog refresh',              desc: 'Re-scan all enrolled repos and rebuild the backlog.', topic: 'autonomy' },
  { cmd: 'backlog --source <src>',       desc: `Filter backlog by source: ${BACKLOG_SOURCE_FILTER_HELP}.`, topic: 'autonomy' },
  { cmd: 'backlog --repo <path>',        desc: 'Filter backlog to a specific enrolled repo.', topic: 'autonomy' },
  { cmd: 'backlog --limit <n>',          desc: 'Show only the top N items.', topic: 'autonomy' },
  { cmd: 'backlog --json',               desc: 'Emit raw JSON backlog.', topic: 'autonomy' },
  { cmd: 'inbox',                        desc: 'Approval inbox: list pending proposals (the outward-action gate).', topic: 'autonomy' },
  { cmd: 'inbox show <id>',              desc: 'Full detail of a proposal incl. diff (read-only).', topic: 'autonomy' },
  { cmd: 'inbox approve <id>',           desc: 'Confirm + apply an approved proposal (the ONLY outward path).', topic: 'autonomy' },
  { cmd: 'inbox approve <id> --yes',     desc: 'Approve without interactive prompt (non-TTY safe).', topic: 'autonomy' },
  { cmd: 'inbox reject <id>',            desc: 'Discard a pending proposal; applies nothing.', topic: 'autonomy' },
  { cmd: 'inbox --json',                 desc: 'Emit raw JSON for inbox list / show / approve result.', topic: 'autonomy' },
  { cmd: 'daemon start --once',          desc: 'Autonomous operator: one tick — propose-only, sandboxed, enrolled repos.', topic: 'autonomy' },
  { cmd: 'daemon start --once --dry-run', desc: 'Plan only: which backlog items WOULD be worked (no swarm/proposal).', topic: 'autonomy' },
  { cmd: 'daemon stop',                  desc: 'Halt the daemon: set kill switch + clear running state.', topic: 'autonomy' },
  { cmd: 'daemon status',                desc: "Daemon roll-up: running?, today's spend vs cap, pending proposals.", topic: 'autonomy' },
  { cmd: 'fleet status [--json]',        desc: 'Read-only fleet snapshot: daemon, per-backend dispatches+quota, queue, proposals, merges, paused state.', topic: 'autonomy' },
  { cmd: 'fleet direction [--json]',     desc: 'Read-only autonomous direction report: mode, resource posture, guard blocks, and next actions.', topic: 'autonomy' },
  { cmd: 'fleet pause',                  desc: 'Pause the fleet: engage the global kill switch (idempotent).', topic: 'autonomy' },
  { cmd: 'fleet resume',                 desc: 'Resume the fleet: release the global kill switch (idempotent).', topic: 'autonomy' },
  { cmd: 'goals add <objective>',        desc: 'Register a high-level OBJECTIVE (goal); decomposed into ordered milestones (local, no LLM by default).', topic: 'autonomy' },
  { cmd: 'goals plan <id>',              desc: 'Decompose a goal into ordered milestones + author/link each milestone spec (LOCAL-FIRST; --allow-cloud to use cloud).', topic: 'autonomy' },
  { cmd: 'goals advance <id>',           desc: 'Advance the next actionable milestone via a SANDBOXED, proposal-only swarm (ENROLLED repos only; emits a PENDING proposal).', topic: 'autonomy' },
  { cmd: 'goals status [id]',            desc: 'Read-only roll-up of goal/milestone progress + linked swarm/proposal state (mutates nothing).', topic: 'autonomy' },
  { cmd: 'roadmap <run|resume|status>',  desc: 'Goal Loop: run a roadmap of milestone files, one FRESH agent process per milestone; resumable from state.json (LOCAL-FIRST; --allow-cloud for API engines).', topic: 'autonomy' },
  { cmd: 'reflect [--since <Nd>]',       desc: 'Score your OWN past runs/swarms locally; report effectiveness/cost deltas (read-only).', topic: 'autonomy' },
  { cmd: 'reflect playbooks [--persist]', desc: 'Distill repeatable playbooks from past swarms (report-only; --persist writes them to the genome).', topic: 'autonomy' },
  { cmd: 'reflect propose',              desc: 'Emit routing/policy/prompt tuning suggestions as PENDING inbox proposals (never auto-applies).', topic: 'autonomy' },
  { cmd: 'health',                       desc: 'Score every ENROLLED repo on quality (tests/docs/deps/security/debt/CI/conventions); ranked, read-only.', topic: 'autonomy' },
  { cmd: 'health <repo>',                desc: 'Per-repo health detail with the per-dimension breakdown + worst offenders (ENROLLED only).', topic: 'autonomy' },
  { cmd: 'health propose',               desc: 'Emit deterministic safe-fix advisories as PENDING inbox proposals (never auto-applies).', topic: 'autonomy' },
  { cmd: 'digest',                       desc: 'Write an ORG-LEVEL portfolio digest (health, goals, costs, today) to ~/.ashlr/digests/ (LOCAL-FIRST; reads only).', topic: 'autonomy' },
  { cmd: 'digest --notify',              desc: 'Also deliver the digest via a configured Slack/Discord webhook (OPT-IN; no-op when unconfigured).', topic: 'autonomy' },

  { cmd: 'pulse [--window 1d|7d|30d]',   desc: 'Local observability dashboard: tokens, cost, sessions, commits.', topic: 'observability' },
  { cmd: 'pulse --json',                 desc: 'Machine-readable ActivityRollup (+ additive .forecast field; Raycast Pulse view).', topic: 'observability' },
  { cmd: 'pulse --project <name>',       desc: 'Restrict pulse rollup to a single project.', topic: 'observability' },
  { cmd: 'telemetry [status]',           desc: 'M19: endpoint+PAT configured (bool), sink mode, local JSONL count, governance.', topic: 'observability' },
  { cmd: 'telemetry test',               desc: 'Emit a synthetic metadata-only test span; report sink+ok.', topic: 'observability' },
  { cmd: 'audit [N] [--json] [--action <verb>] [--result <r>] [--since <when>]', desc: 'Tail the append-only audit trail (newest-first); filter by action/result/since (read-only).', topic: 'observability' },

  { cmd: 'mcp',                          desc: 'Run the MCP aggregation gateway on stdio (point any agent here; includes 11 native ashlr_* tools).', topic: 'integrations' },
  { cmd: 'mcp list',                     desc: 'List native ashlr tools + discovered MCP servers with per-server tool counts.', topic: 'integrations' },
  { cmd: 'mcp doctor',                   desc: 'Per-server MCP health: does it start? how many tools?', topic: 'integrations' },
  { cmd: 'mcp install <claude|ashlrcode>', desc: 'Add the ashlr gateway to a target mcpServers config (backs up first).', topic: 'integrations' },
  { cmd: 'gh <pr|issue|ci>',             desc: 'Read GitHub open PRs, issues, or CI status for the current repo (read-only).', topic: 'integrations' },
  { cmd: 'gh pr create',                 desc: 'Create a PR via gh CLI — explicit + confirm-gated (the only gh mutation).', topic: 'integrations' },
  { cmd: 'vercel <ls|logs>',             desc: 'Read recent Vercel deployments or latest build logs (read-only).', topic: 'integrations' },
  { cmd: 'wire [claude|codex|cursor|all]', desc: 'Wire ashlr MCP gateway into editor config(s); defaults to detected editors.', topic: 'integrations' },
  { cmd: 'wire --claude-md',             desc: 'Print a CLAUDE.md snippet teaching agents the CLI-first ashlr usage (read-only).', topic: 'integrations' },
  { cmd: 'notify test',                  desc: 'Send a test ping to the configured webhook(s); no-op if none are set.', topic: 'integrations' },

  { cmd: 'sandbox list',                 desc: 'List active git-worktree sandboxes (M21 safety foundation).', topic: 'safety' },
  { cmd: 'sandbox diff <id>',            desc: 'Show diff of a sandbox vs its base HEAD.', topic: 'safety' },
  { cmd: 'sandbox cleanup <id>',         desc: 'Remove a sandbox worktree and scratch branch.', topic: 'safety' },
  { cmd: 'sandbox gc',                   desc: 'Reclaim STALE orphan sandboxes (crash leftovers); H5 explicit human repair surface for the orphan sweep.', topic: 'safety' },
  { cmd: 'seams',                        desc: 'Cloud-ready seam diagnostic: every v2 store, active=local, cloud=gated (read-only).', topic: 'safety' },
  { cmd: 'seams status',                 desc: 'Same as `seams`: list seams + active impl; proves local-first + cloud gated on Mason.', topic: 'safety' },
  { cmd: 'verify-safety',                desc: 'Read-only self-check of the hard safety invariants (enrollment/kill-switch/daemon/scrub/cloud-gate); mutates nothing.', topic: 'safety' },
  { cmd: 'preflight [--json]',           desc: 'Read-only first-activation readiness check: ready=true|false + blockers/warnings (model/enrollment/kill/daemon/writeable/sandbox/git/phantom); mutates nothing.', topic: 'safety' },
  { cmd: 'onboard',                      desc: 'Guided first safe activation: preflight → enroll ONE repo → dry-run PLAN → point at `ashlr inbox`. TTY-aware; --yes/non-TTY prints steps. NEVER auto-applies.', topic: 'safety' },
  { cmd: 'onboard --rollback <repo>',    desc: 'One-command undo of a first activation: unenroll + sweep orphan sandboxes + optional --kill. Inward cleanup only; H6-audited.', topic: 'safety' },
  { cmd: 'demo [--no-cleanup] [--json]', desc: 'Watch the FULL autonomous chain run on a DISPOSABLE tmp repo (isolated tmp ~/.ashlr; proposal-only; auto-cleans). NEVER touches your portfolio or applies anything.', topic: 'safety' },

  { cmd: 'tui [--once]',                 desc: 'Interactive terminal dashboard (alias: dash). --once renders one frame and exits.', topic: 'web' },
  { cmd: 'serve [--port N]',             desc: 'Start local web dashboard + JSON API on 127.0.0.1 (default port 7777).', topic: 'web' },
  { cmd: 'serve --open',                 desc: 'Start dashboard and open browser automatically.', topic: 'web' },
  { cmd: 'serve --allow-dispatch',       desc: 'Enable guarded POST /api/run + web inbox approve/reject (prints session token).', topic: 'web' },

  { cmd: 'new <name> [opts]',            desc: 'Scaffold a project from a template (next-app, node-cli, mcp-server, minimal).', topic: 'scaffold' },
  { cmd: 'ship [path] [opts]',           desc: 'Pre-ship gate (lint/test/build) + optional confirm-gated deploy.', topic: 'scaffold' },
];

/** Per-topic example blocks (relocated from the former inline cmdHelp). */
const TOPIC_EXAMPLES: Partial<Record<HelpTopic, string[]>> = {
  run: [
    'ashlr run "list all open GitHub issues in this repo"',
    'ashlr run "summarize recent commits" --budget 8000 --max-steps 5',
    'ashlr run "audit TODOs" --no-memory          # skip genome injection',
    'ashlr run show <id>                          # inspect a past run',
    'ashlr run "x" --estimate                     # predict cost before running',
  ],
  swarm: [
    'ashlr spec new "build a REST API with auth and tests"',
    'ashlr swarm "build a REST API with auth" --dry-run   # plan only',
    'ashlr swarm spec-abc123 --budget 40000 --parallel 3',
    'ashlr swarm "refactor auth module" --background      # detached',
  ],
  memory: [
    'ashlr recall "how does the orchestrator work"',
    'ashlr learn "prefer bge-m3 for embeddings" --tags embeddings,ollama',
    'ashlr learn "ashlr-hub uses NodeNext ESM" --project ashlr-hub',
  ],
  scaffold: [
    'ashlr new my-app --template next-app',
    'ashlr new my-tool --template node-cli --category dev-tools',
    'ashlr ship --deploy vercel --confirm                 # gate + REAL deploy',
  ],
  autonomy: [
    'ashlr enroll add ~/code/my-repo && ashlr backlog refresh',
    'ashlr daemon start --once --dry-run                  # plan only',
    'ashlr fleet direction --json                         # resource-aware mode recommendation',
    'ashlr inbox && ashlr inbox approve <id>',
  ],
};

/** Flag reference lines printed with `help run` / `help swarm` / `help --all`. */
const FLAG_LINES: Partial<Record<HelpTopic, string[]>> = {
  run: ['--budget N  --max-steps N  --parallel N  --engine builtin|ashlrcode|aw  --allow-cloud  --no-tools  --no-memory  --resume <id>  --estimate  --json  --over-budget'],
  swarm: ['--budget N  --parallel N (default 3, max 8)  --background  --resume <id>  --dry-run  --estimate  --allow-cloud  --project <path>  --over-budget'],
};

const TOPICS: HelpTopic[] = [
  'core', 'run', 'swarm', 'memory', 'knowledge', 'autonomy',
  'observability', 'integrations', 'safety', 'web', 'scaffold',
];

function renderEntries(entries: HelpEntry[]): string {
  const c = makeColors(isTty());
  const w = Math.max(...entries.map((e) => e.cmd.length));
  return entries.map((e) => `    ${c.cyan(pad(e.cmd, w))}  ${e.desc}`).join('\n');
}

/** All command entries tagged with a given topic (single source of truth). */
function entriesForTopic(topic: HelpTopic): HelpEntry[] {
  return HELP_ENTRIES.filter((e) => e.topic === topic);
}

function renderTopic(topic: HelpTopic): void {
  const c = makeColors(isTty());
  const entries = entriesForTopic(topic);
  console.log('');
  console.log('  ' + c.bold(TOPIC_LABELS[topic]));
  console.log('');
  console.log(renderEntries(entries));
  const flags = FLAG_LINES[topic];
  if (flags) {
    console.log('');
    for (const f of flags) console.log('  ' + c.bold('flags:') + ' ' + c.dim(f));
  }
  const examples = TOPIC_EXAMPLES[topic];
  if (examples) {
    console.log('');
    console.log('  ' + c.bold('Examples:'));
    for (const ex of examples) console.log(`    ${c.cyan(ex)}`);
  }
  console.log('');
}

function renderSummary(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  ashlr') + c.dim(' — local-first command center for agentic engineers'));
  console.log('');
  for (const topic of TOPICS) {
    const entries = entriesForTopic(topic);
    const headliners = entries.slice(0, 3).map((e) => e.cmd.split(' ')[0]);
    const unique = [...new Set(headliners)].join(', ');
    console.log(`    ${c.cyan(pad(topic, 14))}  ${TOPIC_LABELS[topic]} ${c.dim(`(${unique}, …)`)}`);
  }
  console.log('');
  console.log('  ' + c.dim('ashlr help <topic>') + '      full table for one topic');
  console.log('  ' + c.dim('ashlr help --search <t>') + ' find a command by keyword');
  console.log('  ' + c.dim('ashlr help --all') + '        every command (the legacy full table)');
  console.log('  ' + c.dim('ashlr docs --agent') + '      the agent contract cheat sheet');
  console.log('');
}

function renderAll(): void {
  const c = makeColors(isTty());
  console.log('');
  console.log(c.bold('  ashlr') + c.dim(' — every command'));
  for (const topic of TOPICS) {
    console.log('');
    console.log('  ' + c.bold(TOPIC_LABELS[topic]));
    console.log(renderEntries(entriesForTopic(topic)));
  }
  console.log('');
  for (const [t, lines] of Object.entries(FLAG_LINES)) {
    for (const f of lines ?? []) console.log('  ' + c.bold(`${t} flags:`) + ' ' + c.dim(f));
  }
  console.log('');
}

/** `ashlr help [<topic>] [--search <term>] [--all]` — exit 0 always (help never fails the shell). */
export async function cmdHelp(args: string[]): Promise<number> {
  const c = makeColors(isTty());

  if (args.includes('--all')) {
    renderAll();
    return 0;
  }

  const searchIdx = args.indexOf('--search');
  if (searchIdx !== -1) {
    const term = (args[searchIdx + 1] ?? '').toLowerCase();
    if (!term) {
      console.log(c.dim('usage: ashlr help --search <term>'));
      return 0;
    }
    const hits = HELP_ENTRIES.filter(
      (e) => e.cmd.toLowerCase().includes(term) || e.desc.toLowerCase().includes(term),
    );
    console.log('');
    if (hits.length === 0) {
      console.log(c.dim(`  no commands match "${term}" — try \`ashlr help --all\``));
    } else {
      console.log(renderEntries(hits));
    }
    console.log('');
    return 0;
  }

  const topicArg = args.find((a) => !a.startsWith('-'));
  if (topicArg) {
    if ((TOPICS as string[]).includes(topicArg)) {
      renderTopic(topicArg as HelpTopic);
      return 0;
    }
    console.log('');
    console.log(c.dim(`  unknown topic "${topicArg}" — topics: ${TOPICS.join(', ')}`));
    console.log('');
    return 0;
  }

  renderSummary();
  return 0;
}

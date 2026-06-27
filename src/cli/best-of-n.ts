/**
 * best-of-n.ts — CLI for M142 best-of-N candidate generation + critic selection.
 *
 * Usage:
 *   ashlr best-of-n <workItemId>             Run best-of-N on an existing work item
 *   ashlr best-of-n --repo <R> --title <T>   Construct a synthetic item on-the-fly
 *   ashlr best-of-n ... -n <N>               Override N (default: cfg.foundry.bestOfN ?? 1)
 *
 * Prints per-candidate scores and the winner. Exit 0 = winner found; 1 = no winner.
 */

// Cmd type matches index.ts: (args: string[]) => Promise<number>
type Cmd = (args: string[]) => Promise<number>;

// Re-export so lazyCmd can pick it up
export { cmdBestOfN };

// ---------------------------------------------------------------------------
// ANSI helpers — prefixed to avoid shadowing builtins
// ---------------------------------------------------------------------------
const _reset  = '\x1b[0m';
const _dim    = (s: string): string => `\x1b[2m${s}${_reset}`;
const _bold_s = '\x1b[1m';
const _green  = (s: string): string => `\x1b[32m${s}${_reset}`;
const _yellow = (s: string): string => `\x1b[33m${s}${_reset}`;
const _red    = (s: string): string => `\x1b[31m${s}${_reset}`;
const _cyan   = (s: string): string => `\x1b[36m${s}${_reset}`;

function printUsage(): void {
  console.error(`${_bold_s}ashlr best-of-n${_reset} — M142 best-of-N generation + critic selection

${_bold_s}Usage:${_reset}
  ashlr best-of-n <workItemId> [-n N]
  ashlr best-of-n --repo <R> --title <T> [--detail <D>] [-n N]

${_bold_s}Options:${_reset}
  -n, --n <N>        Override number of candidates (default: cfg.foundry.bestOfN ?? 1)
  --repo <path>      Repo for a synthetic work item (requires --title)
  --title <text>     Title for a synthetic work item
  --detail <text>    Detail/body for a synthetic work item
  --json             Emit JSON instead of pretty output

${_bold_s}Exit codes:${_reset}
  0  Winner found
  1  No winner (all candidates empty/failing)
  2  Usage error`);
}

const cmdBestOfN: Cmd = async (args: string[]): Promise<number> => {
  // ── Parse args ────────────────────────────────────────────────────────────
  let workItemId: string | undefined;
  let repo: string | undefined;
  let title: string | undefined;
  let detail: string | undefined;
  let nOverride: number | undefined;
  let jsonMode = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-n' || a === '--n') {
      const v = parseInt(args[++i] ?? '', 10);
      if (!isNaN(v) && v >= 1) nOverride = v;
    } else if (a === '--repo') {
      repo = args[++i];
    } else if (a === '--title') {
      title = args[++i];
    } else if (a === '--detail') {
      detail = args[++i];
    } else if (a === '--json') {
      jsonMode = true;
    } else if (a != null && !a.startsWith('-')) {
      workItemId = a;
    }
  }

  // ── Validate ──────────────────────────────────────────────────────────────
  if (!workItemId && !(repo && title)) {
    printUsage();
    return 2;
  }

  // ── Load config ───────────────────────────────────────────────────────────
  let cfg: import('../core/types.js').AshlrConfig;
  try {
    const { loadConfig } = await import('../core/config.js');
    cfg = loadConfig();
  } catch (err) {
    console.error(_red('Error: could not load ashlr config: ' + String(err)));
    return 2;
  }

  // ── Resolve work item ─────────────────────────────────────────────────────
  let item: import('../core/types.js').WorkItem;
  if (workItemId) {
    try {
      const { loadBacklog } = await import('../core/portfolio/backlog.js');
      const backlog = loadBacklog();
      const items = (backlog as Record<string, unknown> | null)?.['items'] as import('../core/types.js').WorkItem[] | undefined ?? [];
      const found = items.find((w) => w.id === workItemId);
      if (!found) {
        console.error(_red(`Error: work item '${workItemId}' not found in backlog.`));
        console.error(_dim('Tip: use --repo + --title to construct a synthetic item.'));
        return 2;
      }
      item = found;
    } catch (err) {
      console.error(_red(`Error resolving work item: ${String(err)}`));
      return 2;
    }
  } else {
    // Synthetic item from --repo + --title
    const now = new Date().toISOString();
    item = {
      id: `synthetic-${Date.now().toString(36)}`,
      repo: repo!,
      source: 'manual' as import('../core/types.js').WorkSource,
      title: title!,
      detail: detail ?? '',
      value: 3,
      effort: 3,
      score: 3,
      tags: [],
      ts: now,
    };
  }

  // ── Run best-of-N ────────────────────────────────────────────────────────
  const { runBestOfN } = await import('../core/run/best-of-n.js');

  if (!jsonMode) {
    const foundryAny = (cfg as unknown as Record<string, unknown>)['foundry'] as Record<string, unknown> | undefined;
    const n = nOverride ?? (foundryAny?.['bestOfN'] as number | undefined) ?? 1;
    console.log(`\n${_bold_s}ashlr best-of-N${_reset}  ${_dim('M142 — Rubric-Supervised critic selection')}`);
    console.log(`${_dim('Item:')}  ${item.title}`);
    console.log(`${_dim('Repo:')}  ${item.repo}`);
    console.log(`${_dim('N:')}     ${n}\n`);
  }

  let result: Awaited<ReturnType<typeof runBestOfN>>;
  try {
    result = await runBestOfN(item, cfg, nOverride != null ? { n: nOverride } : undefined);
  } catch (err) {
    console.error(_red('Error: ' + String(err)));
    return 1;
  }

  const { candidates, critique } = result;

  if (jsonMode) {
    console.log(JSON.stringify({ winner: result.winner ?? null, candidates, critique }, null, 2));
    return result.winner ? 0 : 1;
  }

  // ── Pretty output ─────────────────────────────────────────────────────────
  console.log(`${_bold_s}Candidates${_reset}  (${critique.nonEmpty}/${critique.n} non-empty, ${critique.judged} judged)\n`);

  for (const c of candidates) {
    const tag = c.error
      ? _red('  ERR ')
      : !c.proposalId
        ? _dim(' EMPTY')
        : c.index === critique.winnerIndex
          ? _green('  WIN ')
          : _yellow('  ---  ');

    const scoreStr = c.verdict
      ? `score=${c.score.toFixed(0).padStart(2)}  ` +
        `val=${c.verdict.value} corr=${c.verdict.correctness} scope=${c.verdict.scope} align=${c.verdict.alignment}`
      : 'unjudged';

    const testStr = c.testsPassed === true
      ? _green('tests=pass')
      : c.testsPassed === false
        ? _red('tests=fail')
        : '';

    console.log(
      `  [${c.index}] ${tag}  ${scoreStr}  ${testStr}  ` +
      (c.error ? _red(c.error) : _dim(c.proposalId ?? 'no proposal')),
    );
  }

  console.log('');

  if (result.winner) {
    const w = result.winner;
    console.log(`${_bold_s}Winner${_reset}  candidate[${w.index}]  score=${w.score.toFixed(0)}`);
    if (w.proposalId) {
      console.log(`  ${_dim('proposalId:')} ${_cyan(w.proposalId)}`);
    }
    if (w.verdict) {
      console.log(
        `  ${_dim('verdict:')} ${w.verdict.verdict}  ` +
        `value=${w.verdict.value} correctness=${w.verdict.correctness} ` +
        `scope=${w.verdict.scope} alignment=${w.verdict.alignment}`,
      );
      if (w.verdict.rationale) {
        console.log(`  ${_dim('rationale:')} ${w.verdict.rationale}`);
      }
    }
    console.log('');
    return 0;
  } else {
    console.log(_red('No winner — all candidates were empty or failing.'));
    console.log(_dim('The caller should skip proposing for this item.\n'));
    return 1;
  }
};

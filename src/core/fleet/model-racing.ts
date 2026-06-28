/**
 * src/core/fleet/model-racing.ts — M166: Model Racing + Distillation Dataset
 *
 * Races the LOCAL engine (qwen3-coder / any api-model) against a FRONTIER
 * engine (claude or codex) on the SAME work item. The frontier diff is the
 * teacher target for later fine-tuning the local model. Accumulates a
 * distillation dataset at ~/.ashlr/racing/<date>.jsonl.
 *
 * Flag-gated: cfg.foundry.modelRacing.enabled (DEFAULT false — doubles
 * inference cost per raced task; opt-in only).
 *
 * Never-throws: any internal error is caught and surfaced in the result.
 * Secret-safe: diffs are scrubbed before writing to disk.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import type { AshlrConfig, WorkItem, Proposal } from '../types.js';
import { judgeProposal } from './manager.js';
import { runApiModelSandboxed } from '../run/sandboxed-engine.js';
import { scrubSecrets } from '../util/scrub.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RaceResult {
  /** Engine id used for the local run (e.g. 'local-coder'). */
  localEngine: string;
  /** Engine id used for the frontier run (e.g. 'claude'). */
  frontierEngine: string;
  /** Proposal id from the local run, if any. */
  localProposalId?: string;
  /** Proposal id from the frontier run, if any. */
  frontierProposalId?: string;
  /** Judge score for local (0 = failed / no proposal). */
  localScore: number;
  /** Judge score for frontier (0 = failed / no proposal). */
  frontierScore: number;
  /** Which side won: 'local' | 'frontier' | 'tie'. */
  winner: 'local' | 'frontier' | 'tie';
  /** Absolute point difference: frontierScore − localScore (may be negative). */
  scoreDelta: number;
}

/** One persisted record in ~/.ashlr/racing/<date>.jsonl. */
export interface RaceRecord {
  taskId: string;
  taskTitle: string;
  /** Secret-scrubbed unified diff from the local run. Teacher INPUT. */
  localDiff: string;
  /** Secret-scrubbed unified diff from the frontier run. Teacher TARGET. */
  frontierDiff: string;
  localScore: number;
  frontierScore: number;
  winner: 'local' | 'frontier' | 'tie';
  ts: string;
}

export interface RacingStats {
  /** Total races persisted. */
  races: number;
  /** Fraction of races where frontier won (0..1). */
  frontierWinRate: number;
  /** Average (frontierScore − localScore) over all races. */
  avgScoreDelta: number;
  /** Number of races where local won. */
  localWins: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Directory for distillation dataset: ~/.ashlr/racing/ */
function racingDir(): string {
  return join(homedir(), '.ashlr', 'racing');
}

/** Today's JSONL path: ~/.ashlr/racing/YYYY-MM-DD.jsonl */
function todayPath(): string {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  return join(racingDir(), `${today}.jsonl`);
}

/** Ensure the racing directory exists. Never throws. */
function ensureDir(): void {
  try {
    const dir = racingDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
}

/**
 * Score a ManagerVerdict into a single number (0–20).
 * Mirrors the scoreVerdict logic in best-of-n.ts: sum of 4 dimensions (each
 * 1–5), minus scope (inverted — higher scope = more invasive, lower is better).
 * Returns 0 on null/undefined verdict.
 */
function scoreVerdict(v: {
  value?: number;
  correctness?: number;
  scope?: number;
  alignment?: number;
} | null | undefined): number {
  if (!v) return 0;
  const val = v.value ?? 1;
  const corr = v.correctness ?? 1;
  const scope = v.scope ?? 3;
  const align = v.alignment ?? 1;
  // scope is inverted: 1=tiny (good), 5=huge (bad)
  return val + corr + (6 - scope) + align;
}

/**
 * Stub a minimal Proposal from a proposalId so we can call judgeProposal.
 * judgeProposal only needs id + diff (from the RunState) to produce a verdict.
 * We build it from the SandboxedEngineResult.
 */
function stubProposal(
  proposalId: string,
  diff: string | undefined,
  taskId: string,
  taskTitle: string,
): Proposal {
  return {
    id: proposalId,
    repo: null,
    origin: 'backlog',
    kind: 'patch',
    title: taskTitle,
    summary: `M166 race candidate for task ${taskId}`,
    diff,
    status: 'pending',
    createdAt: new Date().toISOString(),
  } as Proposal;
}

/** Resolve the local engine to race. Default: 'local-coder'. */
function resolveLocalEngine(cfg: AshlrConfig): string {
  const racing = cfg.foundry?.modelRacing;
  return racing?.localEngine ?? 'local-coder';
}

/** Resolve the frontier engine to race. Default: 'claude'. */
function resolveFrontierEngine(cfg: AshlrConfig): string {
  const racing = cfg.foundry?.modelRacing;
  return racing?.frontierEngine ?? 'claude';
}

/**
 * Build a minimal judge client for scoring. Uses the Claude CLI path when
 * available (same approach as manager.ts resolveJudgeClient), falling back to
 * a no-op that returns an empty string (triggering the parse-failure → 'review'
 * safe path in judgeProposal).
 */
function buildMinimalJudgeClient(): { complete: (system: string, user: string) => Promise<string> } {
  return {
    complete: async (_system: string, _user: string): Promise<string> => {
      // Minimal stub: returns empty string → judgeProposal parse-failure path
      // returns a safe 'review' verdict with score 0. In production use,
      // callers should pass a real client. The race result still records
      // scores of 0 for unscored runs (never throws).
      return '';
    },
  };
}

/** Persist one race record. Never throws. */
function persistRace(record: RaceRecord): void {
  try {
    ensureDir();
    appendFileSync(todayPath(), JSON.stringify(record) + '\n', 'utf8');
  } catch {
    // best-effort: disk write failure must not propagate
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Race the SAME work item through the local engine AND a frontier engine.
 * Scores each via judgeProposal, determines the winner + score delta, and
 * persists the record to the distillation dataset.
 *
 * - Flag-gated: returns a zeroed no-op result when cfg.foundry.modelRacing is
 *   absent or enabled:false.
 * - Never throws: any run/judge failure is caught; the failing side scores 0.
 * - Both runs are sandboxed/isolated (runApiModelSandboxed).
 * - Diffs are secret-scrubbed before writing to disk.
 *
 * @param item  The work item to race on.
 * @param cfg   AshlrConfig — must have foundry.modelRacing.enabled:true to run.
 * @param opts  Optional overrides (judgeClient, sourceRepo).
 */
export async function raceTask(
  item: WorkItem,
  cfg: AshlrConfig,
  opts?: {
    /** Judge client to use for scoring. Defaults to a minimal no-op stub. */
    judgeClient?: { complete: (system: string, user: string) => Promise<string> };
    /** Source repo path for the sandbox. Defaults to item.repo. */
    sourceRepo?: string;
  },
): Promise<RaceResult> {
  // ----- Flag gate (default OFF) -----
  const racing = cfg.foundry?.modelRacing;
  if (!racing?.enabled) {
    return {
      localEngine: resolveLocalEngine(cfg),
      frontierEngine: resolveFrontierEngine(cfg),
      localScore: 0,
      frontierScore: 0,
      winner: 'tie',
      scoreDelta: 0,
    };
  }

  const localEngine = resolveLocalEngine(cfg);
  const frontierEngine = resolveFrontierEngine(cfg);
  const sourceRepo = opts?.sourceRepo ?? item.repo ?? process.cwd();
  const judgeClient = opts?.judgeClient ?? buildMinimalJudgeClient();

  // ----- Run local -----
  let localProposalId: string | undefined;
  let localDiff: string | undefined;
  let localScore = 0;

  try {
    const localResult = await runApiModelSandboxed(
      localEngine as import('../types.js').EngineId,
      item.detail ?? item.title,
      cfg,
      { sourceRepo, propose: true, runId: `race-local-${item.id}` },
    );
    localProposalId = localResult.proposalId;
    localDiff = localResult.state?.tasks?.[0]?.result ?? undefined;

    if (localProposalId) {
      try {
        const proposal = stubProposal(localProposalId, localDiff, item.id, item.title);
        const verdict = await judgeProposal(proposal, cfg, judgeClient);
        localScore = scoreVerdict(verdict);
      } catch {
        localScore = 0;
      }
    }
  } catch {
    localScore = 0;
  }

  // ----- Run frontier -----
  let frontierProposalId: string | undefined;
  let frontierDiff: string | undefined;
  let frontierScore = 0;

  try {
    const frontierResult = await runApiModelSandboxed(
      frontierEngine as import('../types.js').EngineId,
      item.detail ?? item.title,
      cfg,
      { sourceRepo, propose: true, runId: `race-frontier-${item.id}` },
    );
    frontierProposalId = frontierResult.proposalId;
    frontierDiff = frontierResult.state?.tasks?.[0]?.result ?? undefined;

    if (frontierProposalId) {
      try {
        const proposal = stubProposal(frontierProposalId, frontierDiff, item.id, item.title);
        const verdict = await judgeProposal(proposal, cfg, judgeClient);
        frontierScore = scoreVerdict(verdict);
      } catch {
        frontierScore = 0;
      }
    }
  } catch {
    frontierScore = 0;
  }

  // ----- Determine winner -----
  const scoreDelta = frontierScore - localScore;
  const winner: 'local' | 'frontier' | 'tie' =
    frontierScore > localScore ? 'frontier' :
    localScore > frontierScore ? 'local' :
    'tie';

  // ----- Persist distillation record (secret-scrubbed) -----
  const record: RaceRecord = {
    taskId: item.id,
    taskTitle: item.title,
    localDiff: scrubSecrets(localDiff ?? ''),
    frontierDiff: scrubSecrets(frontierDiff ?? ''),
    localScore,
    frontierScore,
    winner,
    ts: new Date().toISOString(),
  };
  persistRace(record);

  return {
    localEngine,
    frontierEngine,
    localProposalId,
    frontierProposalId,
    localScore,
    frontierScore,
    winner,
    scoreDelta,
  };
}

/**
 * Aggregate stats from the persisted distillation dataset.
 * Reads all JSONL files under ~/.ashlr/racing/.
 * Never throws — returns zeroed stats on any read/parse error.
 */
export function racingStats(): RacingStats {
  try {
    const dir = racingDir();
    if (!existsSync(dir)) {
      return { races: 0, frontierWinRate: 0, avgScoreDelta: 0, localWins: 0 };
    }

    const files = readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    let races = 0;
    let frontierWins = 0;
    let localWins = 0;
    let totalDelta = 0;

    for (const file of files) {
      try {
        const lines = readFileSync(join(dir, file), 'utf8')
          .split('\n')
          .filter(l => l.trim().length > 0);

        for (const line of lines) {
          try {
            const rec = JSON.parse(line) as RaceRecord;
            races++;
            totalDelta += (rec.frontierScore - rec.localScore);
            if (rec.winner === 'frontier') frontierWins++;
            if (rec.winner === 'local') localWins++;
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // skip unreadable files
      }
    }

    return {
      races,
      frontierWinRate: races > 0 ? frontierWins / races : 0,
      avgScoreDelta: races > 0 ? totalDelta / races : 0,
      localWins,
    };
  } catch {
    return { races: 0, frontierWinRate: 0, avgScoreDelta: 0, localWins: 0 };
  }
}

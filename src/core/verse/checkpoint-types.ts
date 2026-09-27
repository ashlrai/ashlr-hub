/**
 * core/verse/checkpoint-types.ts — wire shapes for per-turn checkpoints, the
 * Changes pane and Undo/Redo (server: checkpoints.ts, checkpoint-service.ts,
 * checkpoints-api.ts; page: web-ui/routes/verse/changes/**).
 *
 * Browser-safe: types and constants only, no Node imports, so the page can
 * `import type` from here exactly like it does from workbench-types.ts.
 *
 * VOCABULARY
 *   - A CHECKPOINT is a snapshot of one repository's working tree (tracked
 *     files as they are on disk plus untracked, non-ignored files) stored as a
 *     commit object under a hidden ref:
 *       refs/ashlr/checkpoints/<chat>/<turnId>/pre   — before the agent's turn
 *       refs/ashlr/checkpoints/<chat>/<turnId>/post  — after it ended
 *       refs/ashlr/checkpoints/<chat>/<turnId>/undo  — just before an Undo (Redo target)
 *       refs/ashlr/checkpoints/<chat>/<turnId>/undone — just after that Undo
 *     Built with a temporary index; the operator's index, stash list and
 *     branches are never touched.
 *   - A ROOT is one git repository a chat works in (its project folder, or an
 *     extra root). Roots are addressed on the wire by an opaque `rootId`, never
 *     a path the page could substitute.
 */

export const VERSE_CHECKPOINTS_PATH = '/api/verse/checkpoints';
export const VERSE_CHECKPOINTS_DIFF_PATH = `${VERSE_CHECKPOINTS_PATH}/diff`;
export const VERSE_CHECKPOINTS_REVIEW_PATH = `${VERSE_CHECKPOINTS_PATH}/review`;
export const VERSE_CHECKPOINTS_UNDO_PREVIEW_PATH = `${VERSE_CHECKPOINTS_PATH}/undo/preview`;
export const VERSE_CHECKPOINTS_REDO_PREVIEW_PATH = `${VERSE_CHECKPOINTS_PATH}/redo/preview`;
export const VERSE_CHECKPOINTS_APPLY_PATH = `${VERSE_CHECKPOINTS_PATH}/apply`;

/** The hidden ref namespace. Nothing under refs/heads, refs/tags or refs/stash. */
export const VERSE_CHECKPOINT_REF_ROOT = 'refs/ashlr/checkpoints';

/** One changed file larger than this is not captured (listed as `skipped`). */
export const VERSE_CHECKPOINT_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Bytes hashed into one checkpoint; past it, further changed files are skipped. */
export const VERSE_CHECKPOINT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** More changed paths than this and the checkpoint is refused outright (recorded as unavailable). */
export const VERSE_CHECKPOINT_MAX_CHANGED_PATHS = 20_000;
/** How long a turn waits for its checkpoint before starting without one. */
export const VERSE_CHECKPOINT_TIMEOUT_MS = 8_000;
/** A three-way merge preview is computed only for files up to this size. */
export const VERSE_CHECKPOINT_MERGE_MAX_BYTES = 1024 * 1024;
/** An Undo/Redo preview is valid this long. */
export const VERSE_CHECKPOINT_PREVIEW_TTL_MS = 15 * 60_000;

export type VerseCheckpointSkipReason = 'too-large' | 'budget' | 'not-a-file';

export interface VerseCheckpointSkipped {
  path: string;
  reason: VerseCheckpointSkipReason;
}

/** One root's snapshot at one moment (pre or post a turn). */
export interface VerseCheckpointSnap {
  /** The checkpoint commit (hidden ref target); null when it could not be taken. */
  commit: string | null;
  /** Operator sentence when `commit` is null. */
  error: string | null;
  /** Files NOT captured (too large etc.). Undo never touches them. */
  skipped: number;
  at: string;
  ms: number;
}

export interface VerseCheckpointRootInfo {
  /** Opaque, stable per repository; what the page sends back. */
  rootId: string;
  /** Repository top level (home shown as `~` by sanitizePublicJson). */
  path: string;
  /** Short display name (the folder name). */
  name: string;
}

export interface VerseCheckpointTurnRoot {
  rootId: string;
  pre: VerseCheckpointSnap | null;
  post: VerseCheckpointSnap | null;
}

export type VerseCheckpointTurnState = 'running' | 'done' | 'undone';

export interface VerseCheckpointTurn {
  turnId: string;
  /** 1-based, in the order this chat's turns started. */
  index: number;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  state: VerseCheckpointTurnState;
  roots: VerseCheckpointTurnRoot[];
  /** Number of files this turn changed across roots (pre → post), null while unknown. */
  filesChanged: number | null;
}

export interface VerseCheckpointRedo {
  /** The turn whose Undo can be redone. */
  turnId: string;
  at: string;
}

/** GET /api/verse/checkpoints?chatId= */
export interface VerseCheckpointListResponse {
  chatId: string;
  running: boolean;
  roots: VerseCheckpointRootInfo[];
  turns: VerseCheckpointTurn[];
  /** Set when the most recent action was an Undo that can still be redone. */
  redo: VerseCheckpointRedo | null;
}

export type VerseCheckpointDiffMode = 'since' | 'turn';
export type VerseCheckpointFileStatus = 'M' | 'A' | 'D' | 'R';

export interface VerseCheckpointDiffFile {
  path: string;
  oldPath: string | null;
  status: VerseCheckpointFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  /** False when either side of the comparison skipped this file (too large). */
  captured: boolean;
  /** The file differs from what the agent left at the end of its last turn: someone edited it since. */
  editedAfterTurn: boolean;
  /** The operator marked the whole file reviewed. */
  accepted: boolean;
}

export interface VerseCheckpointHunkInfo {
  index: number;
  /** Content hash; the page sends it back so a stale hunk is refused, never misapplied. */
  hash: string;
  header: string;
  accepted: boolean;
}

export interface VerseCheckpointPatch {
  path: string;
  text: string;
  truncated: boolean;
  binary: boolean;
  hunks: VerseCheckpointHunkInfo[];
}

/** GET /api/verse/checkpoints/diff?chatId=&turnId=&rootId=&mode=since|turn[&file=] */
export interface VerseCheckpointDiffResponse {
  chatId: string;
  turnId: string;
  rootId: string;
  mode: VerseCheckpointDiffMode;
  /** Base and target commit shas (the target of `since` is a fresh snapshot). */
  base: string;
  target: string;
  files: VerseCheckpointDiffFile[];
  patch: VerseCheckpointPatch | null;
  /**
   * Reject/accept work only on a `since` view (checkpoint → the files on disk
   * now) while no turn runs; `turn` views are the historical record.
   */
  actionable: boolean;
}

export type VerseCheckpointDecision = 'accept' | 'reject';

/** POST /api/verse/checkpoints/review */
export interface VerseCheckpointReviewRequest {
  chatId: string;
  turnId: string;
  rootId: string;
  file: string;
  /** Hunk hash from the diff response; absent = the whole file. */
  hunk?: string;
  decision: VerseCheckpointDecision;
}

export interface VerseCheckpointReviewResponse {
  ok: true;
  decision: VerseCheckpointDecision;
  /** Files written or removed on disk (empty for accept). */
  changed: string[];
}

export type VerseCheckpointResolution = 'keep' | 'checkpoint' | 'merge';

export interface VerseCheckpointMergePreview {
  /** The three-way merge applied cleanly: `text` keeps the later edits AND restores the checkpoint. */
  clean: boolean;
  /** Merged text (with conflict markers when not clean); null when not computable (binary, too large, deleted). */
  text: string | null;
  conflicts: number;
}

export interface VerseCheckpointPlanFile {
  path: string;
  /** What restoring does to the file on disk. */
  action: 'restore' | 'delete';
}

export interface VerseCheckpointPlanConflict {
  path: string;
  action: 'restore' | 'delete';
  /** `edited-after`: changed by the agent AND edited since; `unverified`: no after-turn snapshot to tell. */
  kind: 'edited-after' | 'unverified';
  merge: VerseCheckpointMergePreview;
  /** Short unified diff: what is on disk now → the checkpoint version. */
  diff: string;
}

export interface VerseCheckpointPlanRoot {
  rootId: string;
  /** Written without asking: nobody touched them since the agent did. */
  apply: VerseCheckpointPlanFile[];
  /** Need a decision: keep what is there, take the checkpoint, or merge. */
  conflicts: VerseCheckpointPlanConflict[];
  /** Edited only by someone else since; left alone. */
  kept: string[];
  /** Not captured in a snapshot; left alone. */
  uncaptured: string[];
  /** Why this root cannot be restored (no checkpoint); null when it can. */
  unavailable: string | null;
}

/** POST /api/verse/checkpoints/undo/preview {chatId, turnId} and /redo/preview {chatId} */
export interface VerseCheckpointPreviewResponse {
  previewId: string;
  kind: 'undo' | 'redo';
  chatId: string;
  turnId: string;
  expiresAt: string;
  roots: VerseCheckpointPlanRoot[];
}

/** POST /api/verse/checkpoints/apply */
export interface VerseCheckpointApplyRequest {
  previewId: string;
  /** rootId → path → resolution, for every conflict in the preview. */
  resolutions?: Record<string, Record<string, VerseCheckpointResolution>>;
}

export interface VerseCheckpointApplyRoot {
  rootId: string;
  written: string[];
  deleted: string[];
  merged: string[];
  kept: string[];
}

export interface VerseCheckpointApplyResponse {
  ok: true;
  kind: 'undo' | 'redo';
  turnId: string;
  roots: VerseCheckpointApplyRoot[];
  /** After an Undo: Redo is available. */
  redo: VerseCheckpointRedo | null;
}

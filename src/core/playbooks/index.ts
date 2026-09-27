/**
 * Versioned playbooks — the public API other subsystems use (the Leader's
 * playbook actions, automations, the CLI, Verse). Ids are stable path-safe
 * names (`PLAYBOOK_ID_PATTERN`); a run pins `id@vN` (+ sha) via PlaybookRef.
 *
 *   list      listPlaybooks()                        latest of each, summaries
 *   get       getPlaybook(id, version?)              one version (latest when omitted)
 *   create    createPlaybook(source, opts)           v1 of a new id (refuses an existing id)
 *   version   newPlaybookVersion(source, opts)       v<N+1> of an existing id (never rewrites)
 *   resolve   resolvePlaybook / resolvePlaybookSync  by id, `!macro`, `id@v3`, or auto-match
 *   render    renderPlaybookBlock(pb)                the block an engine reads
 */
import { savePlaybook, type SavePlaybookOptions, type SavePlaybookResult } from './store.js';

export * from './types.js';
export { canonicalizePlaybook, parsePlaybook, playbookTemplate, serializePlaybook } from './parse.js';
export {
  builtinPlaybooks,
  getPlaybook,
  getPlaybookSync,
  listLatestPlaybooks,
  listLatestPlaybooksSync,
  listPlaybookSummaries as listPlaybooks,
  listPlaybookVersions,
  readPlaybookUses,
  recordPlaybookUse,
  savePlaybook,
  summarizePlaybook,
  type PlaybookLane,
  type PlaybookUseV1,
  type SavePlaybookOptions,
  type SavePlaybookResult,
} from './store.js';
export {
  appendPlaybookBlock,
  choosePlaybook,
  findMacroMentions,
  refOf,
  registerPlaybookAutoMatcher,
  renderPlaybookBlock,
  resolvePlaybook,
  resolvePlaybookSync,
  type PlaybookAutoMatcher,
  type PlaybookTarget,
  type ResolvedPlaybook,
} from './resolve.js';
export { leaderPlaybookCatalog, playbookForLaunch, withFleetPlaybook, type LaunchPlaybook } from './lanes.js';
export { countPlaybookOutcomes, playbookOutcomes } from './stats.js';

/** Create v1 of a new playbook. Refuses an id that already exists. */
export function createPlaybook(source: string, opts: Omit<SavePlaybookOptions, 'createOnly' | 'editOnly'> = {}): Promise<SavePlaybookResult> {
  return savePlaybook(source, { ...opts, createOnly: true });
}

/** Write v<N+1> of an existing playbook. Refuses an unknown id; never rewrites a version. */
export function newPlaybookVersion(source: string, opts: Omit<SavePlaybookOptions, 'createOnly' | 'editOnly'> = {}): Promise<SavePlaybookResult> {
  return savePlaybook(source, { ...opts, editOnly: true });
}
